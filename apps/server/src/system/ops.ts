// System DB repositories for operations (P1-T1 step 2; ARCHITECTURE_DELTA §4.1 `2250_ops`, §14; ADR-0003 §3.3, §3.8):
// the blob registry (rows + reference hints + sweep history), per-user and per-space quotas, the AI budget ledger
// (atomic reservations) and chunked upload sessions.
//
// Same rules as ./repos.ts: methods that act on one user's rows take the viewer; the rest are internal APIs of the
// files module, the GC, the AI orchestrator and platform routes (`…Internal`), kept out of feature modules by
// test/tenancy/import-boundary.test.ts.
import { fromJson, toJson, type Db } from '../db/db';
import { newId } from '../lib/ids';
import type { Clock } from '../lib/time';
import type { Viewer } from './binding';

// ───────── blob registry ─────────

export interface BlobRow {
  sha256: string;
  size: number;
  mime: string;
  storage: 'local' | 'r2';
  storage_key: string;
  created_at: number;
  orphaned_at: number | null;
  quarantined_at: number | null;
}

export interface BlobSweepRow {
  id: string;
  kind: 'sweep' | 'mark';
  status: 'running' | 'completed' | 'incomplete' | 'failed';
  started_at: number;
  finished_at: number | null;
  databases_marked: number;
  blobs_marked: number;
  registered: number;
  orphaned: number;
  quarantined: number;
  deleted: number;
  restored: number;
  error: string | null;
}

export interface BlobMeta {
  sha256: string;
  size: number;
  mime: string;
  storageKey: string;
}

/**
 * The registry of content-addressed blobs. A row exists for every blob the store holds that some database referenced;
 * `blob_ref` is a HINT (quota display, fast checks) — never the reason bytes are deleted: only the mark-and-sweep GC
 * (modules/files/gc.ts) deletes, after two sweeps agree and a quarantine period.
 */
export class BlobRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  getInternal(sha256: string): BlobRow | null {
    return this.db.get<BlobRow>('SELECT * FROM blob WHERE sha256 = ?', [sha256]) ?? null;
  }

  /**
   * A database now holds a stored_file row for this blob: make sure the blob is registered and set the hint for that
   * database. Idempotent (a database holds at most one stored_file row per sha256). A blob that a sweep had found
   * orphaned is referenced again: the orphan mark is cleared (the next sweep would clear it too).
   */
  recordReferenceInternal(meta: BlobMeta, dbId: string): void {
    const now = this.clock.now();
    this.db.tx(() => {
      this.db.run(`INSERT OR IGNORE INTO blob (sha256, size, mime, storage, storage_key, created_at) VALUES (?, ?, ?, 'local', ?, ?)`, [
        meta.sha256,
        meta.size,
        meta.mime,
        meta.storageKey,
        now,
      ]);
      this.db.run('UPDATE blob SET orphaned_at = NULL WHERE sha256 = ? AND orphaned_at IS NOT NULL', [meta.sha256]);
      this.db.run(
        `INSERT INTO blob_ref (sha256, db_id, ref_count) VALUES (?, ?, 1) ON CONFLICT (sha256, db_id) DO UPDATE SET ref_count = 1`,
        [meta.sha256, dbId],
      );
    });
  }

  /** A database dropped its stored_file row: clear its hint (bytes stay for the sweep). */
  dropReferenceInternal(sha256: string, dbId: string): void {
    this.db.run('DELETE FROM blob_ref WHERE sha256 = ? AND db_id = ?', [sha256, dbId]);
  }

  /** Every hint of one database (account deletion drops them all). */
  dropDatabaseInternal(dbId: string): number {
    return this.db.run('DELETE FROM blob_ref WHERE db_id = ?', [dbId]).changes;
  }

  /** Register a blob found on disk or referenced by a database but missing from the registry (sweep, restore). */
  registerInternal(meta: BlobMeta, createdAt: number): boolean {
    return (
      this.db.run(`INSERT OR IGNORE INTO blob (sha256, size, mime, storage, storage_key, created_at) VALUES (?, ?, ?, 'local', ?, ?)`, [
        meta.sha256,
        meta.size,
        meta.mime,
        meta.storageKey,
        createdAt,
      ]).changes > 0
    );
  }

  setStorageInternal(sha256: string, storage: 'local' | 'r2'): void {
    this.db.run('UPDATE blob SET storage = ? WHERE sha256 = ?', [storage, sha256]);
  }

  /**
   * Blobs waiting to be copied to the object store, in content-address order after `afterSha` (the replicator keeps a
   * cursor, so a blob it cannot copy never blocks the ones behind it — P1-T1 step 2 review). Orphaned and quarantined
   * blobs are not copied.
   */
  pendingReplicationInternal(limit: number, afterSha = ''): BlobRow[] {
    return this.db.all<BlobRow>(
      `SELECT * FROM blob WHERE storage = 'local' AND quarantined_at IS NULL AND orphaned_at IS NULL AND sha256 > ? ORDER BY sha256 LIMIT ?`,
      [afterSha, limit],
    );
  }

  /**
   * AOS-21.34: blobs whose encrypted remote copy is confirmed and that the GC does not hold (not orphaned, not
   * quarantined) — the only ones whose LOCAL copy may be evicted from the cache.
   */
  evictableInternal(): BlobRow[] {
    return this.db.all<BlobRow>(`SELECT * FROM blob WHERE storage = 'r2' AND quarantined_at IS NULL AND orphaned_at IS NULL ORDER BY sha256`);
  }

  /** AOS-21.34: every registered blob that is not in quarantine (what may have a local copy in the store). */
  liveInternal(): BlobRow[] {
    return this.db.all<BlobRow>(`SELECT * FROM blob WHERE quarantined_at IS NULL ORDER BY sha256`);
  }

  /** How many databases reference this blob, according to the hints. */
  hintCountInternal(sha256: string): number {
    return this.db.get<{ n: number }>('SELECT COALESCE(SUM(ref_count), 0) AS n FROM blob_ref WHERE sha256 = ?', [sha256])!.n;
  }

  /** Rebuild every hint from a completed mark pass (restore-verify and the boot mark pass). */
  rebuildHintsFromMarkInternal(sweepId: string): number {
    return this.db.tx(() => {
      this.db.run('DELETE FROM blob_ref');
      return this.db.run(
        `INSERT INTO blob_ref (sha256, db_id, ref_count) SELECT m.sha256, m.db_id, 1 FROM blob_mark m JOIN blob b ON b.sha256 = m.sha256
          WHERE m.sweep_id = ? AND m.db_id <> 'upload'`,
        [sweepId],
      ).changes;
    });
  }

  // ── sweeps ──

  startSweepInternal(kind: 'sweep' | 'mark'): BlobSweepRow {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run(`INSERT INTO blob_sweep (id, kind, status, started_at) VALUES (?, ?, 'running', ?)`, [id, kind, now]);
    return this.sweepInternal(id)!;
  }

  sweepInternal(id: string): BlobSweepRow | null {
    return this.db.get<BlobSweepRow>('SELECT * FROM blob_sweep WHERE id = ?', [id]) ?? null;
  }

  lastSweepsInternal(limit = 10): BlobSweepRow[] {
    return this.db.all<BlobSweepRow>('SELECT * FROM blob_sweep ORDER BY started_at DESC, id DESC LIMIT ?', [limit]);
  }

  /** The last COMPLETED full sweep before `beforeMs` (two sweeps must agree before anything is quarantined). */
  lastCompletedSweepInternal(): BlobSweepRow | null {
    return this.db.get<BlobSweepRow>(`SELECT * FROM blob_sweep WHERE kind = 'sweep' AND status = 'completed' ORDER BY started_at DESC, id DESC LIMIT 1`) ?? null;
  }

  markInternal(sweepId: string, sha256s: Iterable<string>, dbId: string): number {
    let n = 0;
    for (const sha of sha256s) n += this.db.run('INSERT OR IGNORE INTO blob_mark (sweep_id, sha256, db_id) VALUES (?, ?, ?)', [sweepId, sha, dbId]).changes;
    return n;
  }

  finishSweepInternal(id: string, status: BlobSweepRow['status'], counts: Partial<Omit<BlobSweepRow, 'id' | 'kind' | 'status' | 'started_at' | 'finished_at'>>): void {
    this.db.run(
      `UPDATE blob_sweep SET status = ?, finished_at = ?, databases_marked = ?, blobs_marked = ?, registered = ?, orphaned = ?, quarantined = ?,
         deleted = ?, restored = ?, error = ? WHERE id = ?`,
      [
        status,
        this.clock.now(),
        counts.databases_marked ?? 0,
        counts.blobs_marked ?? 0,
        counts.registered ?? 0,
        counts.orphaned ?? 0,
        counts.quarantined ?? 0,
        counts.deleted ?? 0,
        counts.restored ?? 0,
        counts.error ?? null,
        id,
      ],
    );
    // marks of older sweeps are not needed any more (the newest completed pass keeps its marks for hint rebuilds)
    this.db.run('DELETE FROM blob_mark WHERE sweep_id NOT IN (SELECT id FROM blob_sweep ORDER BY started_at DESC, id DESC LIMIT 2)');
  }

  /** Registered blobs with no mark in this sweep that existed before it started. */
  unmarkedInternal(sweepId: string, startedAt: number): BlobRow[] {
    return this.db.all<BlobRow>(
      `SELECT b.* FROM blob b WHERE b.created_at < ? AND NOT EXISTS (SELECT 1 FROM blob_mark m WHERE m.sweep_id = ? AND m.sha256 = b.sha256)
        ORDER BY b.sha256`,
      [startedAt, sweepId],
    );
  }

  /** Registered blobs that ARE marked in this sweep but carry an orphan or quarantine mark (found again). */
  markedButFlaggedInternal(sweepId: string): BlobRow[] {
    return this.db.all<BlobRow>(
      `SELECT b.* FROM blob b WHERE (b.orphaned_at IS NOT NULL OR b.quarantined_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM blob_mark m WHERE m.sweep_id = ? AND m.sha256 = b.sha256) ORDER BY b.sha256`,
      [sweepId],
    );
  }

  /** Is this blob marked in the given sweep (live references made while it runs mark it too)? */
  isMarkedInternal(sweepId: string, sha256: string): boolean {
    return this.db.get('SELECT 1 AS x FROM blob_mark WHERE sweep_id = ? AND sha256 = ? LIMIT 1', [sweepId, sha256]) !== undefined;
  }

  setOrphanedInternal(sha256: string, at: number | null): void {
    this.db.run('UPDATE blob SET orphaned_at = ? WHERE sha256 = ?', [at, sha256]);
  }

  setQuarantinedInternal(sha256: string, at: number | null): void {
    this.db.run('UPDATE blob SET quarantined_at = ? WHERE sha256 = ?', [at, sha256]);
  }

  /** The registry row goes with the bytes (only the GC and the single-database purge call this). */
  forgetInternal(sha256: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM blob_ref WHERE sha256 = ?', [sha256]);
      this.db.run('DELETE FROM blob_mark WHERE sha256 = ?', [sha256]);
      this.db.run('DELETE FROM blob WHERE sha256 = ?', [sha256]);
    });
  }

  /** The system DB's own blob references (profile pictures). */
  systemReferencesInternal(): string[] {
    return this.db.all<{ s: string }>('SELECT DISTINCT avatar_sha256 AS s FROM user_profile WHERE avatar_sha256 IS NOT NULL').map((r) => r.s);
  }

  countsInternal(): { blobs: number; bytes: number; orphaned: number; quarantined: number; in_object_store: number } {
    return this.db.get(
      `SELECT COUNT(*) AS blobs, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(orphaned_at IS NOT NULL), 0) AS orphaned,
              COALESCE(SUM(quarantined_at IS NOT NULL), 0) AS quarantined, COALESCE(SUM(storage = 'r2'), 0) AS in_object_store FROM blob`,
    )!;
  }
}

// ───────── quotas ─────────

export interface UserQuotaRow {
  user_id: string;
  storage_bytes_limit: number | null;
  ai_monthly_usd_limit: number | null;
  asr_monthly_minutes_limit: number | null;
  asr_monthly_cpu_minutes_limit: number | null;
  live_session_usd_cap: number | null;
  rooms_concurrent_limit: number | null;
  updated_by: string | null;
  updated_at: number;
}

export interface SpaceQuotaRow {
  space_id: string;
  storage_bytes_limit: number | null;
  ai_monthly_usd_limit: number | null;
  asr_monthly_cpu_minutes_limit: number | null;
  updated_by: string | null;
  updated_at: number;
}

/** A field set to `undefined` is left as it is; `null` clears it (back to the default). */
export interface UserQuotaPatch {
  storage_bytes_limit?: number | null;
  ai_monthly_usd_limit?: number | null;
}
export interface SpaceQuotaPatch {
  storage_bytes_limit?: number | null;
  ai_monthly_usd_limit?: number | null;
}

export class QuotaRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The viewer's own explicit limits (null = defaults apply). */
  mine(viewer: Viewer): UserQuotaRow | null {
    return this.userInternal(viewer.userId);
  }

  userInternal(userId: string): UserQuotaRow | null {
    return this.db.get<UserQuotaRow>('SELECT * FROM user_quota WHERE user_id = ?', [userId]) ?? null;
  }

  spaceInternal(spaceId: string): SpaceQuotaRow | null {
    return this.db.get<SpaceQuotaRow>('SELECT * FROM space_quota WHERE space_id = ?', [spaceId]) ?? null;
  }

  /** Platform admin only (routes check it): set one user's limits. */
  setUserInternal(userId: string, patch: UserQuotaPatch, updatedBy: string): UserQuotaRow {
    const now = this.clock.now();
    return this.db.tx(() => {
      this.db.run('INSERT OR IGNORE INTO user_quota (user_id, updated_by, updated_at) VALUES (?, ?, ?)', [userId, updatedBy, now]);
      if (patch.storage_bytes_limit !== undefined) this.db.run('UPDATE user_quota SET storage_bytes_limit = ? WHERE user_id = ?', [patch.storage_bytes_limit, userId]);
      if (patch.ai_monthly_usd_limit !== undefined) this.db.run('UPDATE user_quota SET ai_monthly_usd_limit = ? WHERE user_id = ?', [patch.ai_monthly_usd_limit, userId]);
      this.db.run('UPDATE user_quota SET updated_by = ?, updated_at = ? WHERE user_id = ?', [updatedBy, now, userId]);
      return this.userInternal(userId)!;
    });
  }

  setSpaceInternal(spaceId: string, patch: SpaceQuotaPatch, updatedBy: string): SpaceQuotaRow {
    const now = this.clock.now();
    return this.db.tx(() => {
      this.db.run('INSERT OR IGNORE INTO space_quota (space_id, updated_by, updated_at) VALUES (?, ?, ?)', [spaceId, updatedBy, now]);
      if (patch.storage_bytes_limit !== undefined) this.db.run('UPDATE space_quota SET storage_bytes_limit = ? WHERE space_id = ?', [patch.storage_bytes_limit, spaceId]);
      if (patch.ai_monthly_usd_limit !== undefined) this.db.run('UPDATE space_quota SET ai_monthly_usd_limit = ? WHERE space_id = ?', [patch.ai_monthly_usd_limit, spaceId]);
      this.db.run('UPDATE space_quota SET updated_by = ?, updated_at = ? WHERE space_id = ?', [updatedBy, now, spaceId]);
      return this.spaceInternal(spaceId)!;
    });
  }
}

// ───────── AI budget ledger (atomic reservations) ─────────

export interface LedgerRow {
  id: string;
  user_id: string;
  space_id: string | null;
  month: string;
  kind: 'ai' | 'asr';
  reserved_usd: number;
  actual_usd: number | null;
  status: 'reserved' | 'settled' | 'released';
  usage_ref: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface ReserveRequest {
  userId: string;
  spaceId: string | null;
  month: string;
  kind: 'ai' | 'asr';
  amountUsd: number;
  /** the allowance being charged (the user's, or the space's when spaceId is set) */
  limitUsd: number;
  /** spending of the charged party this month that the ledger does not hold (usage recorded before the ledger existed) */
  outsideLedgerUsd: number;
  /** the deployment ceiling (MEDLEVO_AI_MONTHLY_BUDGET_USD) and the start of its month */
  deploymentLimitUsd: number;
  deploymentSinceMs: number;
}

export type ReserveResult =
  | { ok: true; id: string; usedUsd: number; limitUsd: number }
  | { ok: false; reason: 'allowance' | 'deployment'; usedUsd: number; limitUsd: number };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class AiBudgetLedger {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** settled actual + outstanding reservations of one user (personal allowance) or one space this month */
  usedInternal(who: { userId: string } | { spaceId: string }, month: string, kind: 'ai' | 'asr' = 'ai'): { settled: number; reserved: number } {
    const where = 'spaceId' in who ? 'space_id = ?' : 'user_id = ? AND space_id IS NULL';
    const r = this.db.get<{ settled: number | null; reserved: number | null }>(
      `SELECT SUM(CASE WHEN status = 'settled' THEN actual_usd ELSE 0 END) AS settled,
              SUM(CASE WHEN status = 'reserved' THEN reserved_usd ELSE 0 END) AS reserved
         FROM ai_budget_ledger WHERE ${where} AND month = ? AND kind = ?`,
      ['spaceId' in who ? who.spaceId : who.userId, month, kind],
    )!;
    return { settled: round6(r.settled ?? 0), reserved: round6(r.reserved ?? 0) };
  }

  /** the whole deployment since the start of its month (settled actual + outstanding reservations) */
  deploymentUsedInternal(sinceMs: number, kind: 'ai' | 'asr' = 'ai'): number {
    const r = this.db.get<{ n: number | null }>(
      `SELECT SUM(CASE WHEN status = 'settled' THEN actual_usd WHEN status = 'reserved' THEN reserved_usd ELSE 0 END) AS n
         FROM ai_budget_ledger WHERE created_at >= ? AND kind = ?`,
      [sinceMs, kind],
    )!;
    return round6(r.n ?? 0);
  }

  /**
   * Reserve `amountUsd` atomically (one BEGIN IMMEDIATE transaction on the system DB): the charged allowance and the
   * deployment ceiling are both checked against settled + outstanding amounts inside the same transaction, so two
   * concurrent calls can never both pass a check that only one of them fits in.
   */
  reserveInternal(r: ReserveRequest): ReserveResult {
    return this.db.tx(() => {
      const who = r.spaceId ? { spaceId: r.spaceId } : { userId: r.userId };
      const u = this.usedInternal(who, r.month, r.kind);
      const used = round6(Math.max(u.settled, r.outsideLedgerUsd) + u.reserved);
      if (r.limitUsd <= 0 || used + r.amountUsd > r.limitUsd + 1e-9) return { ok: false, reason: 'allowance', usedUsd: used, limitUsd: r.limitUsd };
      const dep = round6(this.deploymentUsedInternal(r.deploymentSinceMs, r.kind) + Math.max(0, r.outsideLedgerUsd - u.settled));
      if (r.deploymentLimitUsd <= 0 || dep + r.amountUsd > r.deploymentLimitUsd + 1e-9) {
        return { ok: false, reason: 'deployment', usedUsd: dep, limitUsd: r.deploymentLimitUsd };
      }
      const now = this.clock.now();
      const id = newId(now);
      this.db.run(
        `INSERT INTO ai_budget_ledger (id, user_id, space_id, month, kind, reserved_usd, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        [id, r.userId, r.spaceId, r.month, r.kind, round6(r.amountUsd), now],
      );
      return { ok: true, id, usedUsd: used, limitUsd: r.limitUsd };
    });
  }

  /** The call happened: keep its ESTIMATED cost (it may exceed the reservation only by the provider's own variance). */
  settleInternal(id: string, actualUsd: number, usageRef: string | null): void {
    this.db.run(`UPDATE ai_budget_ledger SET status = 'settled', actual_usd = ?, usage_ref = ?, settled_at = ? WHERE id = ? AND status = 'reserved'`, [
      round6(Math.max(0, actualUsd)),
      usageRef,
      this.clock.now(),
      id,
    ]);
  }

  /** The call never reached the provider (or cost nothing): give the reservation back. */
  releaseInternal(id: string): void {
    this.db.run(`UPDATE ai_budget_ledger SET status = 'released', actual_usd = 0, settled_at = ? WHERE id = ? AND status = 'reserved'`, [this.clock.now(), id]);
  }

  /** Reservations a crash left open (no call can still be running for them after a restart): released. */
  releaseStaleInternal(olderThanMs: number): number {
    return this.db.run(`UPDATE ai_budget_ledger SET status = 'released', actual_usd = 0, settled_at = ? WHERE status = 'reserved' AND created_at < ?`, [
      this.clock.now(),
      olderThanMs,
    ]).changes;
  }

  getInternal(id: string): LedgerRow | null {
    return this.db.get<LedgerRow>('SELECT * FROM ai_budget_ledger WHERE id = ?', [id]) ?? null;
  }
}

// ───────── chunked upload sessions ─────────

export interface UploadSessionRow {
  id: string;
  user_id: string;
  target_db: string;
  expected_sha256: string;
  expected_size: number;
  chunk_size: number;
  mime: string | null;
  original_name: string | null;
  received_json: string;
  status: 'open' | 'completed' | 'expired' | 'failed';
  file_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export class UploadSessionRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  create(viewer: Viewer, s: { targetDb: string; sha256: string; size: number; chunkSize: number; mime: string | null; name: string | null; ttlMs: number }): UploadSessionRow {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run(
      `INSERT INTO upload_session (id, user_id, target_db, expected_sha256, expected_size, chunk_size, mime, original_name, received_json, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?, ?)`,
      [id, viewer.userId, s.targetDb, s.sha256, s.size, s.chunkSize, s.mime, s.name, now, now, now + s.ttlMs],
    );
    return this.get(viewer, id)!;
  }

  /** One of the viewer's own sessions (another user's id is simply not found). */
  get(viewer: Viewer, id: string): UploadSessionRow | null {
    return this.db.get<UploadSessionRow>('SELECT * FROM upload_session WHERE id = ? AND user_id = ?', [id, viewer.userId]) ?? null;
  }

  /** The viewer's open session for exactly these bytes and target (an interrupted upload resumes it). */
  findOpen(viewer: Viewer, targetDb: string, sha256: string, size: number): UploadSessionRow | null {
    return (
      this.db.get<UploadSessionRow>(
        `SELECT * FROM upload_session WHERE user_id = ? AND target_db = ? AND expected_sha256 = ? AND expected_size = ? AND status = 'open' AND expires_at > ?
          ORDER BY created_at DESC LIMIT 1`,
        [viewer.userId, targetDb, sha256, size, this.clock.now()],
      ) ?? null
    );
  }

  static received(row: UploadSessionRow): number[] {
    return (fromJson<number[]>(row.received_json, []) ?? []).filter((n) => Number.isInteger(n));
  }

  addChunk(viewer: Viewer, id: string, index: number, ttlMs: number): UploadSessionRow {
    return this.db.tx(() => {
      const row = this.get(viewer, id)!;
      const set = new Set(UploadSessionRepo.received(row));
      set.add(index);
      const now = this.clock.now();
      this.db.run('UPDATE upload_session SET received_json = ?, updated_at = ?, expires_at = MAX(expires_at, ?) WHERE id = ?', [
        toJson([...set].sort((a, b) => a - b)),
        now,
        now + ttlMs,
        id,
      ]);
      return this.get(viewer, id)!;
    });
  }

  complete(viewer: Viewer, id: string, fileId: string): void {
    this.db.run(`UPDATE upload_session SET status = 'completed', file_id = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [fileId, this.clock.now(), id, viewer.userId]);
  }

  fail(viewer: Viewer, id: string): void {
    this.db.run(`UPDATE upload_session SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'open'`, [this.clock.now(), id, viewer.userId]);
  }

  /** Bytes the viewer's open sessions may still add (counted against the storage quota while they run). */
  openBytes(viewer: Viewer): number {
    return this.db.get<{ n: number }>(`SELECT COALESCE(SUM(expected_size), 0) AS n FROM upload_session WHERE user_id = ? AND status = 'open' AND expires_at > ?`, [
      viewer.userId,
      this.clock.now(),
    ])!.n;
  }

  /** Internal (GC mark pass): the content of sessions in flight is protected from the sweep. */
  inFlightShasInternal(): string[] {
    return this.db.all<{ s: string }>(`SELECT DISTINCT expected_sha256 AS s FROM upload_session WHERE status = 'open' AND expires_at > ?`, [this.clock.now()]).map((r) => r.s);
  }

  /** Internal (cleanup timer): sessions past their expiry → 'expired'; returns their ids (their chunk folders go). */
  expireInternal(): string[] {
    const now = this.clock.now();
    const ids = this.db.all<{ id: string }>(`SELECT id FROM upload_session WHERE status = 'open' AND expires_at <= ?`, [now]).map((r) => r.id);
    if (ids.length) this.db.run(`UPDATE upload_session SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at <= ?`, [now, now]);
    return ids;
  }

  /** Internal (account deletion, after their chunk folders are gone): the rows go too — they hold file names. */
  deleteAllInternal(userId: string): number {
    return this.db.run('DELETE FROM upload_session WHERE user_id = ?', [userId]).changes;
  }

  /** Internal (account deletion): every session of a user. */
  ofUserInternal(userId: string): UploadSessionRow[] {
    return this.db.all<UploadSessionRow>('SELECT * FROM upload_session WHERE user_id = ?', [userId]);
  }

  /** Internal (cleanup): ids of sessions still open (their chunk folders stay). */
  openIdsInternal(): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM upload_session WHERE status = 'open'`).map((r) => r.id);
  }
}
