// Mark-and-sweep blob GC (P1-T1 step 2; ARCHITECTURE_DELTA §4.1 `2250_ops`, ADR-0003 §3.3) — the only way bytes of a
// blob shared by several databases are ever deleted.
//
//   1. MARK — read `stored_file.sha256` of EVERY registered vault and space (by path, read-only: a sweep never opens
//      or migrates a vault through the pool), plus the system DB's own references and the content of upload sessions
//      in flight, into `blob_mark`. A database that cannot be read makes the sweep INCOMPLETE: it decides nothing (fail
//      closed). References made while the sweep runs are marked in it too (BlobService.onReference).
//   2. a registered blob without a mark that existed before the sweep started is set ORPHANED;
//   3. a blob orphaned in two consecutive sweeps at least 7 days apart is moved to QUARANTINE (DATA_DIR/quarantine);
//   4. a quarantined blob is DELETED after 30 more days only if a fresh mark still misses it; a blob marked again is
//      put back.
// A mark pass alone (kind 'mark') also rebuilds every `blob_ref` hint; it runs at boot — so after any restore, which
// always produces a data directory that boots — and after a vault restore. Blob files on disk that the registry does
// not know (leftovers of a crash between writing the bytes and their row, or of P1-T1 step 1) are registered by a
// sweep, so they enter the same orphan → quarantine → delete path instead of staying forever.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import { openDb } from '../../db/db';
import type { Clock } from '../../lib/time';
import type { BlobSweepRow } from '../../system/ops';
import type { DatabasePool } from '../../system/pool';
import type { SystemRepos } from '../../system/repos';
import { type BlobService, storageKeyFor } from './blobs';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface GcOptions {
  /** an orphan is quarantined only when a sweep at least this long after the first one still misses it */
  orphanGraceMs: number;
  /** a quarantined blob is deleted only this long after it was quarantined (and a fresh mark misses it) */
  quarantineMs: number;
  /** tests only: runs between the mark and the decisions (a reference made while a sweep runs) */
  beforeDecide?: () => Promise<void>;
}

export const DEFAULT_GC_OPTIONS: GcOptions = { orphanGraceMs: 7 * DAY_MS, quarantineMs: 30 * DAY_MS };

interface MarkResult {
  complete: boolean;
  databases: number;
  blobs: number;
  registered: number;
  problems: string[];
}

const SHA_RE = /^[0-9a-f]{64}$/;

export class BlobGc {
  private running: { id: string; startedAt: number } | null = null;
  private current: Promise<BlobSweepRow> | null = null;

  constructor(
    private readonly deps: { system: SystemRepos; pool: DatabasePool; blobs: BlobService; filesDir: string; clock: Clock; log: FastifyBaseLogger },
    private readonly opts: GcOptions = DEFAULT_GC_OPTIONS,
  ) {
    deps.blobs.onReference = (sha, dbId) => {
      if (this.running) this.deps.system.blobs.markInternal(this.running.id, [sha], dbId);
    };
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Resolves when no sweep or mark pass is running (a vault restore swaps its file only then — step 2 review). */
  async idle(): Promise<void> {
    while (this.current) await this.current.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Run a sweep (or a mark pass only). One at a time: a second call while one runs gets the running one. */
  run(kind: 'sweep' | 'mark' = 'sweep'): Promise<BlobSweepRow> {
    if (this.current) return this.current;
    this.current = this.runOnce(kind).finally(() => {
      this.running = null;
      this.current = null;
    });
    return this.current;
  }

  private async runOnce(kind: 'sweep' | 'mark'): Promise<BlobSweepRow> {
    const reg = this.deps.system.blobs;
    const sweep = reg.startSweepInternal(kind);
    this.running = { id: sweep.id, startedAt: sweep.started_at };
    try {
      const m = await this.mark(sweep.id, sweep.started_at, kind === 'sweep');
      if (!m.complete) {
        reg.finishSweepInternal(sweep.id, 'incomplete', { databases_marked: m.databases, blobs_marked: m.blobs, registered: m.registered, error: m.problems.slice(0, 10).join('; ').slice(0, 1000) });
        this.deps.log.warn({ sweep: sweep.id, problems: m.problems.slice(0, 10) }, 'blob sweep incomplete: nothing was decided');
        return reg.sweepInternal(sweep.id)!;
      }
      if (this.opts.beforeDecide) await this.opts.beforeDecide();
      reg.rebuildHintsFromMarkInternal(sweep.id);
      const counts = { orphaned: 0, quarantined: 0, deleted: 0, restored: 0 };
      if (kind === 'sweep') await this.decide(sweep.id, sweep.started_at, counts);
      reg.finishSweepInternal(sweep.id, 'completed', { databases_marked: m.databases, blobs_marked: m.blobs, registered: m.registered, ...counts });
      return reg.sweepInternal(sweep.id)!;
    } catch (e) {
      reg.finishSweepInternal(sweep.id, 'failed', { error: (e as Error).message.slice(0, 1000) });
      this.deps.log.error({ err: e, sweep: sweep.id }, 'blob sweep failed');
      return reg.sweepInternal(sweep.id)!;
    }
  }

  /** Read every registered database's stored_file content addresses into blob_mark. */
  private async mark(sweepId: string, startedAt: number, adoptDisk: boolean): Promise<MarkResult> {
    const { system, pool } = this.deps;
    const out: MarkResult = { complete: true, databases: 0, blobs: 0, registered: 0, problems: [] };
    for (const d of system.vaults.liveDatabasesInternal()) {
      let path: string;
      try {
        path = pool.pathOfFile(d.kind, d.db_file);
      } catch {
        out.problems.push(`${d.kind} ${d.id}: invalid file name`);
        continue;
      }
      if (!existsSync(path)) {
        // a vault being deleted loses its file on purpose; anything else missing must stop the sweep
        if (d.status !== 'deleting') out.problems.push(`${d.kind} ${d.id}: database file missing`);
        continue;
      }
      let rows: Array<{ sha256: string; size: number; mime: string; storage_key: string }>;
      try {
        const db = openDb(path, { readOnly: true });
        try {
          rows = db.all('SELECT sha256, size, mime, storage_key FROM stored_file');
        } finally {
          db.close();
        }
      } catch (e) {
        out.problems.push(`${d.kind} ${d.id}: ${(e as Error).message.slice(0, 120)}`);
        continue;
      }
      const shas = rows.filter((r) => SHA_RE.test(r.sha256));
      out.blobs += system.blobs.markInternal(sweepId, shas.map((r) => r.sha256), d.id);
      for (const r of shas) {
        if (system.blobs.registerInternal({ sha256: r.sha256, size: r.size, mime: r.mime, storageKey: r.storage_key }, this.deps.clock.now())) out.registered++;
      }
      out.databases++;
      await yieldToEventLoop(); // never hold the event loop for a whole deployment
    }
    // the system DB's own references (profile pictures) and the content of upload sessions in flight
    const avatars = system.blobs.systemReferencesInternal().filter((s) => SHA_RE.test(s));
    out.blobs += system.blobs.markInternal(sweepId, avatars, 'system');
    out.blobs += system.blobs.markInternal(sweepId, system.uploads.inFlightShasInternal().filter((s) => SHA_RE.test(s)), 'upload');
    if (adoptDisk) out.registered += await this.adoptUnregistered(startedAt);
    out.complete = out.problems.length === 0;
    return out;
  }

  /**
   * Blob files on disk the registry does not know: registered now (so later sweeps can decide about them). It yields to
   * the event loop after each top-level folder (1/256 of the store) — a large store is never walked in one block.
   */
  private async adoptUnregistered(_startedAt: number): Promise<number> {
    const reg = this.deps.system.blobs;
    let n = 0;
    const root = this.deps.filesDir;
    if (!existsSync(root)) return 0;
    for (const a of readdirSync(root)) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue;
      await yieldToEventLoop();
      for (const b of readdirSync(join(root, a))) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue;
        for (const sha of readdirSync(join(root, a, b))) {
          if (!SHA_RE.test(sha) || sha.slice(0, 2) !== a || sha.slice(2, 4) !== b) continue;
          if (reg.getInternal(sha)) continue;
          let size = 0;
          try {
            const st = statSync(join(root, a, b, sha));
            if (!st.isFile()) continue;
            size = st.size;
          } catch {
            continue;
          }
          // created now: never orphaned by THIS sweep (a write in progress has its row in a moment)
          if (reg.registerInternal({ sha256: sha, size, mime: 'application/octet-stream', storageKey: storageKeyFor(sha) }, this.deps.clock.now())) n++;
        }
      }
    }
    return n;
  }

  private async decide(sweepId: string, startedAt: number, counts: { orphaned: number; quarantined: number; deleted: number; restored: number }): Promise<void> {
    const reg = this.deps.system.blobs;
    const blobs = this.deps.blobs;
    const now = this.deps.clock.now();
    // found again: back from quarantine, orphan mark cleared
    for (const b of reg.markedButFlaggedInternal(sweepId)) {
      if (b.quarantined_at !== null) counts.restored++;
      blobs.unquarantine(b);
    }
    const toDelete = [];
    for (const b of reg.unmarkedInternal(sweepId, startedAt)) {
      if (b.quarantined_at !== null) {
        if (now - b.quarantined_at >= this.opts.quarantineMs) toDelete.push(b);
      } else if (b.orphaned_at !== null) {
        // the second sweep (≥ 7 days after the first) that agrees: out of the store, into quarantine
        if (now - b.orphaned_at >= this.opts.orphanGraceMs) {
          blobs.quarantine(b, now);
          counts.quarantined++;
        }
      } else {
        reg.setOrphanedInternal(b.sha256, now);
        counts.orphaned++;
      }
    }
    for (const b of toDelete) {
      try {
        if (await blobs.deleteQuarantined(b, () => !reg.isMarkedInternal(sweepId, b.sha256))) counts.deleted++;
      } catch (e) {
        this.deps.log.warn({ err: e, sha256: b.sha256.slice(0, 12) }, 'could not delete a quarantined blob (kept for the next sweep)');
      }
    }
  }
}
