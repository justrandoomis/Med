// The notification fan-out worker (P1-T4 step 2; ARCHITECTURE_DELTA §12 «a job that writes notification rows in the
// system DB in batches of 500, with dedupe_key»; NFR-OP2 «heavy work never runs on the request event loop»).
//
// Publishing (service.ts) writes ONE `notification_fanout` row — in the caller's transaction — and pokes this worker.
// The worker runs in the ROOT context (never inside a request's binding), takes the oldest due fan-out, pages its audience
// (keyset by user id), keeps the recipients who should be told, and in ONE system transaction inserts at most
// NOTIFICATION_BATCH_SIZE rows (INSERT OR IGNORE on (user_id, dedupe_key)) and moves the cursor. Then it yields
// (setImmediate) before the next step, so requests are served between batches. A step that throws is retried with
// back-off from the same cursor; a replayed step writes nothing twice. After MAX_ATTEMPTS failures the fan-out is
// marked `failed` with a short error code (never a payload) and the log says so.
import { NOTIFICATION_BATCH_SIZE, type NotificationKind } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { newId } from '../../lib/ids';
import type { Viewer } from '../../system/binding';
import { type NotificationAccess, accessMemo } from './access';
import { type AudienceSpec, type Audiences, PLATFORM_ADMINS_CURSOR, ROLE_AUDIENCES } from './audiences';

export const MAX_FANOUT_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
/** finished fan-outs are kept this long (diagnostics), then pruned */
const KEEP_DONE_MS = 30 * 24 * 60 * 60_000;
/** the longest the worker sleeps before looking again for work a back-off postponed */
const MAX_SLEEP_MS = 10 * 60_000;

export interface FanoutRow {
  id: string;
  kind: NotificationKind;
  payload_json: string;
  actor_user_id: string | null;
  subject_db: string | null;
  subject_type: string | null;
  subject_id: string | null;
  link: string | null;
  access: NotificationAccess;
  scope_node_id: string | null;
  dedupe_key: string;
  audience_json: string;
  exclude_json: string;
  cursor: string | null;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  batches: number;
  delivered: number;
  run_after: number;
  created_at: number;
}

export class NotificationFanout {
  private scheduled = false;
  private stopped = false;
  private sleeper: NodeJS.Timeout | null = null;
  private steps = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly audiences: Audiences,
  ) {}

  private get db() {
    return this.ctx.system.db;
  }

  /**
   * Process ONE batch of the oldest due fan-out. True when there was work (whether it succeeded or was postponed).
   * Synchronous: tests and the boot path call it directly; the worker calls it once per event-loop turn.
   */
  step(): boolean {
    if (!this.db.isOpen) return false;
    const now = this.ctx.clock.now();
    if (++this.steps % 500 === 0) this.prune(now);
    const row = this.db.get<FanoutRow>(`SELECT * FROM notification_fanout WHERE status = 'pending' AND run_after <= ? ORDER BY created_at, rowid LIMIT 1`, [now]);
    if (!row) return false;
    try {
      this.batch(row, now);
    } catch (e) {
      this.fail(row, now, e);
    }
    return true;
  }

  /** Run every due batch now (tests; never called on a request path). Returns the number of steps taken. */
  drain(maxSteps = 100_000): number {
    let n = 0;
    while (n < maxSteps && this.step()) n++;
    return n;
  }

  /** Wake the worker: one batch per event-loop turn, in the root context, until nothing is due. */
  poke(): void {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    this.ctx.binding.runRoot(() =>
      setImmediate(() => {
        this.scheduled = false;
        this.loop();
      }),
    );
  }

  private loop(): void {
    if (this.stopped) return;
    let worked = false;
    try {
      worked = this.step();
    } catch (e) {
      this.ctx.log.warn({ err: e }, 'notification fan-out step failed');
    }
    if (worked) this.poke();
    else this.sleepUntilDue();
  }

  /** Nothing due now: wake up when the earliest postponed fan-out is due (bounded), or not at all. */
  private sleepUntilDue(): void {
    if (this.stopped || !this.db.isOpen) return;
    const next = this.db.get<{ run_after: number }>(`SELECT run_after FROM notification_fanout WHERE status = 'pending' ORDER BY run_after LIMIT 1`);
    if (!next) return;
    if (this.sleeper) clearTimeout(this.sleeper);
    const delay = Math.min(Math.max(next.run_after - this.ctx.clock.now(), 1000), MAX_SLEEP_MS);
    this.ctx.binding.runRoot(() => {
      this.sleeper = setTimeout(() => {
        this.sleeper = null;
        this.poke();
      }, delay);
      this.sleeper.unref();
    });
  }

  /** Resolves once no fan-out is due (tests and shutdown diagnostics). */
  async idle(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.db.isOpen && this.db.get(`SELECT 1 AS x FROM notification_fanout WHERE status = 'pending' AND run_after <= ? LIMIT 1`, [this.ctx.clock.now()])) {
      if (Date.now() > until) throw new Error('notification fan-out did not become idle');
      this.poke();
      await new Promise((r) => setImmediate(r));
    }
  }

  start(): void {
    this.stopped = false;
    this.poke();
  }

  stop(): void {
    this.stopped = true;
    if (this.sleeper) clearTimeout(this.sleeper);
    this.sleeper = null;
  }

  // ───────────────────────── one batch ─────────────────────────

  private batch(row: FanoutRow, now: number): void {
    const audience = fromJson<AudienceSpec>(row.audience_json);
    if (!audience) throw new Error('fan-out audience unreadable');
    const exclude = new Set(fromJson<string[]>(row.exclude_json, []) ?? []);
    const page = this.audiences.page(audience, row.cursor, NOTIFICATION_BATCH_SIZE);
    const { told, eligible } = this.recipients(row, page.ids.filter((id) => !exclude.has(id)));
    let next = page.next;
    // a role audience whose holders exist but none of whom may be told — the only moderator wrote the reported content,
    // or holds the role on a suspended account — continues with the platform admins: someone must hear about a join
    // request or a report (review P1-T4 step 2, R1). Opting out of the kind is a choice, not «nobody left».
    if (next === null && row.cursor === null && !page.fallback && eligible === 0 && ROLE_AUDIENCES.has(audience.kind)) next = PLATFORM_ADMINS_CURSOR;
    const done = next === null;
    this.db.tx(() => {
      let inserted = 0;
      for (const userId of told) {
        inserted += this.db.run(
          `INSERT OR IGNORE INTO notification (id, user_id, kind, actor_user_id, subject_db, subject_type, subject_id, payload_json, link, access, scope_node_id, dedupe_key, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(seq), 0) + 1 FROM notification WHERE user_id = ?), ?)`,
          [newId(now), userId, row.kind, row.actor_user_id, row.subject_db, row.subject_type, row.subject_id, row.payload_json, row.link, row.access, row.scope_node_id, row.dedupe_key, userId, row.created_at],
        ).changes;
      }
      this.db.run(
        `UPDATE notification_fanout SET cursor = ?, batches = batches + 1, delivered = delivered + ?, status = ?, finished_at = ?, last_error = NULL WHERE id = ? AND status = 'pending'`,
        [next, inserted, done ? 'done' : 'pending', done ? now : null, row.id],
      );
    });
  }

  /**
   * The candidates who should be told: an active account, the kind not switched off, may still open the subject.
   * `eligible` counts those who could be told whatever their preferences (the role-audience fallback asks it).
   */
  private recipients(row: FanoutRow, candidates: string[]): { told: string[]; eligible: number } {
    if (candidates.length === 0) return { told: [], eligible: 0 };
    const marks = candidates.map(() => '?').join(',');
    const accounts = this.db.all<{ id: string; is_platform_admin: number }>(`SELECT id, is_platform_admin FROM user_account WHERE status = 'active' AND id IN (${marks})`, candidates);
    const off = new Set(
      this.db
        .all<{ user_id: string }>(`SELECT user_id FROM notification_pref WHERE kind = ? AND channel = 'in_app' AND enabled = 0 AND user_id IN (${marks})`, [row.kind, ...candidates])
        .map((r) => r.user_id),
    );
    const out: string[] = [];
    let eligible = 0;
    for (const a of accounts) {
      const viewer: Viewer = { userId: a.id, deviceId: null, isPlatformAdmin: a.is_platform_admin === 1 };
      if (row.access !== 'self' && !accessMemo(this.ctx, viewer)(row.access, row.scope_node_id)) continue;
      eligible++;
      if (off.has(a.id)) continue;
      out.push(a.id);
    }
    return { told: out, eligible };
  }

  private fail(row: FanoutRow, now: number, e: unknown): void {
    const attempts = row.attempts + 1;
    const code = e instanceof Error ? e.message.slice(0, 120) : 'unknown';
    const failed = attempts >= MAX_FANOUT_ATTEMPTS;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
    this.db.run(`UPDATE notification_fanout SET attempts = ?, last_error = ?, status = ?, run_after = ?, finished_at = ? WHERE id = ?`, [
      attempts,
      code,
      failed ? 'failed' : 'pending',
      now + delay,
      failed ? now : null,
      row.id,
    ]);
    this.ctx.log.warn({ fanout: row.id, kind: row.kind, attempts, failed, error: code }, failed ? 'notification fan-out failed for good' : 'notification fan-out step failed; will retry');
  }

  private prune(now: number): void {
    this.db.run(`DELETE FROM notification_fanout WHERE status IN ('done','failed') AND finished_at < ?`, [now - KEEP_DONE_MS]);
  }
}
