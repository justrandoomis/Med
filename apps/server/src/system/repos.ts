// System DB repositories (ADR-0003 §3.1, ARCHITECTURE_DELTA §1.1 `ctx.system`; P1-T1 step 1).
//
// The system DB is the only file that knows several users exist. Code reaches it only through these repositories:
// a method that returns or changes a user's rows takes the `viewer` and acts on THAT viewer only; the few methods
// without a viewer are internal APIs of auth (before a session exists), the job worker and the registry — their
// names say so (`…ForAuth`, `…Internal`) and an import-boundary test keeps them out of feature modules.
import { fromJson, toJson, type Db } from '../db/db';
import { newId } from '../lib/ids';
import type { Clock } from '../lib/time';
import type { Viewer } from './binding';
import { AiBudgetLedger, BlobRegistry, QuotaRepo, UploadSessionRepo } from './ops';
import { ConsentRepo } from './consent';
import { AclGrantRepo } from './acl';

/** NFKC + trim + lower-case: the login key (ARCHITECTURE_DELTA §4.1 user_account.username_norm). */
export function normalizeUsername(u: string): string {
  return u.normalize('NFKC').trim().toLowerCase();
}

export interface UserRow {
  id: string;
  username: string;
  username_norm: string;
  display_name: string;
  password_hash: string;
  recovery_codes_json: string;
  password_changed_at: number;
  status: 'active' | 'suspended' | 'deletion_pending' | 'deleted';
  is_platform_admin: number;
  legacy_owner: number;
  timezone: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface VaultRow {
  id: string;
  user_id: string;
  db_file: string;
  status: 'active' | 'locked' | 'deleting' | 'deleted';
  bytes_db: number;
  bytes_files: number;
  created_at: number;
  last_opened_at: number | null;
}

export interface SpaceRow {
  id: string;
  title: string;
  db_file: string;
  status: 'active' | 'read_only' | 'migrating' | 'archived';
  created_at: number;
  updated_at: number;
}

export interface DeviceRow {
  user_id: string;
  device_id: string;
  device_uid: string;
  label: string | null;
  platform: 'web' | 'ios' | 'android' | 'other' | null;
  public_key: string | null;
  key_registered_at: number | null;
  shared_device: number;
  first_seen_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface JobIndexRow {
  db_kind: 'vault' | 'space';
  db_id: string;
  job_id: string;
  kind: string;
  status: string;
  run_after: number;
  updated_at: number;
  actor_user_id: string | null;
}

export class UserRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Internal (auth): how many accounts exist — first-run setup is possible only at 0. */
  countInternal(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_account')!.n;
  }

  /** Internal (auth): the account for a login name, or null. */
  findForAuth(username: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM user_account WHERE username_norm = ?', [normalizeUsername(username)]) ?? null;
  }

  /** Internal (auth, binding): an account by id. */
  byIdInternal(id: string): UserRow | null {
    return this.db.get<UserRow>('SELECT * FROM user_account WHERE id = ?', [id]) ?? null;
  }

  /** The viewer's own account. */
  me(viewer: Viewer): UserRow | null {
    return this.byIdInternal(viewer.userId);
  }

  /** Internal (setup, admin-created accounts, the owner migration): create an account. */
  createInternal(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    recoveryHashes: string[];
    isPlatformAdmin: boolean;
    legacyOwner?: boolean;
    timezone: string;
    id?: string;
  }): UserRow {
    const now = this.clock.now();
    const id = input.id ?? newId(now);
    this.db.run(
      `INSERT INTO user_account (id, username, username_norm, display_name, password_hash, recovery_codes_json, password_changed_at,
         status, is_platform_admin, legacy_owner, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        id,
        input.username.normalize('NFC'),
        normalizeUsername(input.username),
        input.displayName,
        input.passwordHash,
        toJson(input.recoveryHashes),
        now,
        input.isPlatformAdmin ? 1 : 0,
        input.legacyOwner ? 1 : 0,
        input.timezone,
        now,
        now,
      ],
    );
    this.db.run('INSERT INTO user_profile (user_id, updated_at) VALUES (?, ?)', [id, now]);
    return this.byIdInternal(id)!;
  }

  setPassword(viewer: Viewer, hash: string): void {
    const now = this.clock.now();
    this.db.run('UPDATE user_account SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', [hash, now, now, viewer.userId]);
  }

  /** Internal (recover: no session yet — the recovery code is the credential). */
  setPasswordAndCodesForAuth(userId: string, hash: string, codes: string[]): void {
    const now = this.clock.now();
    this.db.run('UPDATE user_account SET password_hash = ?, recovery_codes_json = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', [
      hash,
      toJson(codes),
      now,
      now,
      userId,
    ]);
  }

  setRecoveryCodes(viewer: Viewer, codes: string[]): void {
    this.db.run('UPDATE user_account SET recovery_codes_json = ?, updated_at = ? WHERE id = ?', [toJson(codes), this.clock.now(), viewer.userId]);
  }

  /**
   * Internal (quotas, AI allowance): user #1 — the first account ever created (first-run setup, or the owner migrated
   * from the single-owner installation). Defaults that keep today's single-owner behaviour apply to this account only.
   */
  firstUserIdInternal(): string | null {
    return this.db.get<{ id: string }>('SELECT id FROM user_account ORDER BY created_at, id LIMIT 1')?.id ?? null;
  }

  /**
   * Is the viewer user #1 — the first account (the owner migrated from the single-owner installation, or the first-run
   * account)? It alone claims what a device kept from before accounts (P1-T1 step 3, `owns_legacy_device_data`).
   */
  isUserOne(viewer: Viewer): boolean {
    return this.firstUserIdInternal() === viewer.userId;
  }

  /** Internal (account deletion): active platform admins other than this user. */
  otherActiveAdminsInternal(userId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM user_account WHERE is_platform_admin = 1 AND status = 'active' AND id <> ?`, [userId])!.n;
  }

  /** Internal (account deletion, step 1): the account can no longer sign in; its sessions are revoked by the caller. */
  markDeletionPendingInternal(userId: string): void {
    const now = this.clock.now();
    this.db.run(`UPDATE user_account SET status = 'deletion_pending', updated_at = ? WHERE id = ? AND status IN ('active','suspended','deletion_pending')`, [now, userId]);
  }

  /**
   * Internal (account deletion, last step): the row stays (ledger, audit and authorship references point at it) but
   * nothing personal does — the login name is freed, the password and recovery codes can never match, the profile is
   * cleared. Names are rendered at read time, so the account shows as «طالب سابق» everywhere at once (PRD Q14).
   */
  finalizeDeletionInternal(userId: string): void {
    const now = this.clock.now();
    this.db.tx(() => {
      // P1-T1 step 2 review: nothing that identifies the person stays behind — their sessions (IP addresses, browser
      // strings, device labels) and the sign-in attempts recorded under their OLD login name go with the account
      const old = this.db.get<{ username_norm: string }>('SELECT username_norm FROM user_account WHERE id = ?', [userId]);
      this.db.run('DELETE FROM auth_session WHERE user_id = ?', [userId]);
      if (old && !old.username_norm.startsWith('deleted:')) this.db.run('DELETE FROM login_attempt WHERE username_norm = ?', [old.username_norm]);
      this.db.run(
        `UPDATE user_account SET status = 'deleted', username = ?, username_norm = ?, display_name = '', password_hash = 'deleted', recovery_codes_json = '[]',
           is_platform_admin = 0, updated_at = ?, deleted_at = COALESCE(deleted_at, ?) WHERE id = ?`,
        [`deleted:${userId}`, `deleted:${userId}`, now, now, userId],
      );
      this.db.run(`UPDATE user_profile SET bio = NULL, avatar_sha256 = NULL, academic_json = '{}', field_visibility_json = '{}', profile_visibility = 'only_me', updated_at = ? WHERE user_id = ?`, [now, userId]);
    });
  }

  /** Internal (boot): deletions a crash interrupted, to finish. */
  pendingDeletionsInternal(): UserRow[] {
    return this.db.all<UserRow>(`SELECT * FROM user_account WHERE status = 'deletion_pending' ORDER BY updated_at, id`);
  }

  static recoveryHashes(row: UserRow): string[] {
    return fromJson<string[]>(row.recovery_codes_json, []) ?? [];
  }
}

export class VaultRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** The vault of a user (binding hook, after the session resolved the user). */
  ofUserInternal(userId: string): VaultRow | null {
    return this.db.get<VaultRow>(`SELECT * FROM vault WHERE user_id = ?`, [userId]) ?? null;
  }

  ofViewer(viewer: Viewer): VaultRow | null {
    return this.ofUserInternal(viewer.userId);
  }

  /** Internal (pool resolver, job worker, platform backups): a vault by id. */
  byIdInternal(id: string): VaultRow | null {
    return this.db.get<VaultRow>('SELECT * FROM vault WHERE id = ?', [id]) ?? null;
  }

  /** Internal (platform operations: whole-instance backup, job reconciliation). */
  listInternal(): VaultRow[] {
    return this.db.all<VaultRow>('SELECT * FROM vault ORDER BY created_at, id');
  }

  /** Internal (blob lifecycle): how many registered databases (vaults not deleted + spaces) share the blob store. */
  /** Every database ever registered, deleted ones included (whole-instance archives made back then hold them). */
  everRegisteredCountInternal(): number {
    return this.db.get<{ n: number }>(`SELECT (SELECT COUNT(*) FROM vault) + (SELECT COUNT(*) FROM space) AS n`)!.n;
  }

  databaseCountInternal(): number {
    return this.db.get<{ n: number }>(`SELECT (SELECT COUNT(*) FROM vault WHERE status <> 'deleted') + (SELECT COUNT(*) FROM space) AS n`)!.n;
  }

  registerInternal(input: { id: string; userId: string; dbFile: string }): VaultRow {
    this.db.run(`INSERT INTO vault (id, user_id, db_file, status, created_at) VALUES (?, ?, ?, 'active', ?)`, [input.id, input.userId, input.dbFile, this.clock.now()]);
    return this.byIdInternal(input.id)!;
  }

  /** Internal (account deletion, vault restore): lock / unlock / mark deleting or deleted. */
  setStatusInternal(id: string, status: VaultRow['status']): void {
    this.db.run('UPDATE vault SET status = ? WHERE id = ?', [status, id]);
  }

  /** Internal (quota hint): the vault's database and file bytes as last measured. */
  setBytesInternal(id: string, bytesDb: number, bytesFiles: number): void {
    this.db.run('UPDATE vault SET bytes_db = ?, bytes_files = ? WHERE id = ?', [bytesDb, bytesFiles, id]);
  }

  /** Internal (GC): every registered database whose file must be read by a mark pass (not deleted). */
  liveDatabasesInternal(): { kind: 'vault' | 'space'; id: string; db_file: string; status: string }[] {
    return this.db.all(
      `SELECT 'vault' AS kind, id, db_file, status FROM vault WHERE status <> 'deleted'
       UNION ALL SELECT 'space' AS kind, id, db_file, status FROM space ORDER BY kind, id`,
    );
  }

  touchOpenedInternal(id: string): void {
    this.db.run('UPDATE vault SET last_opened_at = ? WHERE id = ?', [this.clock.now(), id]);
  }

  /** Internal (quota views, per-space backups): every registered subject space. */
  listSpacesInternal(): SpaceRow[] {
    return this.db.all<SpaceRow>('SELECT * FROM space ORDER BY created_at, id');
  }

  spaceByIdInternal(id: string): SpaceRow | null {
    return this.db.get<SpaceRow>('SELECT * FROM space WHERE id = ?', [id]) ?? null;
  }

  registerSpaceInternal(input: { id: string; title: string; dbFile: string }): SpaceRow {
    const now = this.clock.now();
    this.db.run(`INSERT INTO space (id, title, db_file, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`, [input.id, input.title, input.dbFile, now, now]);
    return this.spaceByIdInternal(input.id)!;
  }
}

export interface DeviceInput {
  device_id: string;
  label?: string | null;
  platform?: DeviceRow['platform'];
}

export class DeviceRepo {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  list(viewer: Viewer): DeviceRow[] {
    return this.db.all<DeviceRow>('SELECT * FROM device WHERE user_id = ? ORDER BY last_seen_at DESC, device_id', [viewer.userId]);
  }

  get(viewer: Viewer, deviceId: string): DeviceRow | null {
    return this.db.get<DeviceRow>('SELECT * FROM device WHERE user_id = ? AND device_id = ?', [viewer.userId, deviceId]) ?? null;
  }

  /**
   * Register (or refresh) one of the viewer's devices. Idempotent per (user, device_id); the server issues the
   * globally unique device_uid once. A device id another user registered gets its own row and its own uid.
   * A revoked device is NOT revived by a later registration (it must be a new client device id).
   */
  register(viewer: Viewer, input: DeviceInput): { device: DeviceRow; created: boolean } {
    return this.db.tx(() => {
      const now = this.clock.now();
      const existing = this.get(viewer, input.device_id);
      if (existing) {
        if (existing.revoked_at === null) {
          this.db.run('UPDATE device SET last_seen_at = ?, label = COALESCE(?, label), platform = COALESCE(?, platform) WHERE user_id = ? AND device_id = ?', [
            now,
            input.label ?? null,
            input.platform ?? null,
            viewer.userId,
            input.device_id,
          ]);
        }
        return { device: this.get(viewer, input.device_id)!, created: false };
      }
      this.db.run(
        `INSERT INTO device (user_id, device_id, device_uid, label, platform, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [viewer.userId, input.device_id, newId(now), input.label ?? null, input.platform ?? null, now, now],
      );
      return { device: this.get(viewer, input.device_id)!, created: true };
    });
  }

  /** Revoking a device also revokes its key. Returns false when the viewer has no such active device. */
  revoke(viewer: Viewer, deviceId: string): boolean {
    const r = this.db.run('UPDATE device SET revoked_at = ?, public_key = NULL, key_registered_at = NULL WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL', [
      this.clock.now(),
      viewer.userId,
      deviceId,
    ]);
    return r.changes > 0;
  }

  setKey(viewer: Viewer, deviceId: string, publicKey: string): boolean {
    const r = this.db.run('UPDATE device SET public_key = ?, key_registered_at = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL', [
      publicKey,
      this.clock.now(),
      viewer.userId,
      deviceId,
    ]);
    return r.changes > 0;
  }

  /** (AOS-4.7, Q26) mark one of the viewer's ACTIVE devices as shared (cleared at every sign-out) or not. */
  setShared(viewer: Viewer, deviceId: string, shared: boolean): boolean {
    const r = this.db.run('UPDATE device SET shared_device = ? WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL', [shared ? 1 : 0, viewer.userId, deviceId]);
    return r.changes > 0;
  }

  /** Internal (account deletion): every device row of the user goes (with its key). */
  deleteAllInternal(userId: string): number {
    return this.db.run('DELETE FROM device WHERE user_id = ?', [userId]).changes;
  }

  /** Active (not revoked) devices of the viewer — a cap keeps one account from filling the table. */
  activeCount(viewer: Viewer): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device WHERE user_id = ? AND revoked_at IS NULL', [viewer.userId])!.n;
  }

  /** Internal (sync, step 3): is this an active registered device of that user? */
  isActiveInternal(userId: string, deviceId: string): boolean {
    return this.db.get<{ x: number }>('SELECT 1 AS x FROM device WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL', [userId, deviceId]) !== undefined;
  }
}

export class JobIndex {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Internal (job queue): record / refresh where a job lives and its state. */
  upsertInternal(row: Omit<JobIndexRow, 'updated_at'>): void {
    this.db.run(
      `INSERT INTO job_index (db_kind, db_id, job_id, kind, status, run_after, updated_at, actor_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (db_id, job_id) DO UPDATE SET kind = excluded.kind, status = excluded.status, run_after = excluded.run_after,
         updated_at = excluded.updated_at, actor_user_id = COALESCE(job_index.actor_user_id, excluded.actor_user_id)`,
      [row.db_kind, row.db_id, row.job_id, row.kind, row.status, row.run_after, this.clock.now(), row.actor_user_id],
    );
  }

  removeInternal(dbId: string, jobId: string): void {
    this.db.run('DELETE FROM job_index WHERE db_id = ? AND job_id = ?', [dbId, jobId]);
  }

  /** Internal (worker): due queued entries of the given kinds, oldest first. */
  dueInternal(now: number, kinds: string[], limit = 20, exclude: ReadonlySet<string> = new Set()): JobIndexRow[] {
    if (kinds.length === 0) return [];
    const rows = this.db.all<JobIndexRow>(
      `SELECT * FROM job_index WHERE status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => '?').join(',')})
       ORDER BY run_after, job_id LIMIT ?`,
      [now, ...kinds, limit + exclude.size],
    );
    return rows.filter((r) => !exclude.has(`${r.db_id}/${r.job_id}`)).slice(0, limit);
  }

  /** Internal (worker): entries the index believes are running (stale-heartbeat reconciliation). */
  runningInternal(): JobIndexRow[] {
    return this.db.all<JobIndexRow>(`SELECT * FROM job_index WHERE status = 'running' ORDER BY db_id, job_id`);
  }

  /** Internal (worker): databases with any non-terminal job (drain / boot reconciliation). */
  databasesWithWorkInternal(): { db_kind: 'vault' | 'space'; db_id: string }[] {
    return this.db.all(`SELECT DISTINCT db_kind, db_id FROM job_index WHERE status IN ('queued','running') ORDER BY db_id`);
  }

  /** Internal (worker): every entry of one database (reconciliation with that database's own job rows). */
  ofDbInternal(dbId: string): JobIndexRow[] {
    return this.db.all<JobIndexRow>('SELECT * FROM job_index WHERE db_id = ? ORDER BY job_id', [dbId]);
  }

  /** Internal (worker heartbeat): databases whose entries the worker could not reach («unavailable»), to re-check. */
  unavailableDatabasesInternal(): { db_kind: 'vault' | 'space'; db_id: string }[] {
    return this.db.all(`SELECT DISTINCT db_kind, db_id FROM job_index WHERE status = 'unavailable' ORDER BY db_id`);
  }

  /** Internal (account deletion): forget every entry of a database that no longer exists. */
  removeDbInternal(dbId: string): number {
    return this.db.run('DELETE FROM job_index WHERE db_id = ?', [dbId]).changes;
  }

  /** The viewer's own jobs (Control Center «المعالجة»: my jobs only, ARCHITECTURE_DELTA §5.8). */
  ofVault(vaultId: string): JobIndexRow[] {
    return this.db.all<JobIndexRow>('SELECT * FROM job_index WHERE db_kind = ? AND db_id = ? ORDER BY job_id DESC', ['vault', vaultId]);
  }
}

export interface SecurityAuditInput {
  actorUserId: string | null;
  actorRole?: string | null;
  scopeNodeId?: string | null;
  action: string;
  targetDb?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

const SECRETISH = /(password|secret|token|hash|code|key|cookie)/i;

export class SecurityAudit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  record(e: SecurityAuditInput): void {
    const details = e.details ? Object.fromEntries(Object.entries(e.details).filter(([k]) => !SECRETISH.test(k))) : null;
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO security_audit (id, actor_user_id, actor_role, scope_node_id, action, target_db, target_type, target_id, summary, details_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(now), e.actorUserId, e.actorRole ?? null, e.scopeNodeId ?? null, e.action, e.targetDb ?? null, e.targetType ?? null, e.targetId ?? null, e.summary.slice(0, 500), details ? toJson(details) : null, e.ip ?? null, now],
    );
  }

  /** The viewer's own security history (sign-ins, password changes, devices). */
  mine(viewer: Viewer, limit = 50): { action: string; summary: string; ip: string | null; created_at: number }[] {
    return this.db.all('SELECT action, summary, ip, created_at FROM security_audit WHERE actor_user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [viewer.userId, Math.min(Math.max(limit, 1), 200)]);
  }
}

export interface SystemRepos {
  /**
   * The system DB handle. Only `src/system/*`, `src/context.ts`, `src/app.ts` (health), `modules/auth` (limiter,
   * session transactions), `modules/platform` (counts) and the instance backup (`modules/data/backups.ts`) use it
   * directly — test/tenancy/import-boundary.test.ts enforces the list; everything else goes through the repositories.
   */
  readonly db: Db;
  readonly users: UserRepo;
  readonly vaults: VaultRegistry;
  readonly devices: DeviceRepo;
  readonly jobIndex: JobIndex;
  readonly securityAudit: SecurityAudit;
  // P1-T1 step 2 (./ops.ts)
  readonly blobs: BlobRegistry;
  readonly quotas: QuotaRepo;
  readonly aiLedger: AiBudgetLedger;
  readonly uploads: UploadSessionRepo;
  // Phase 1 completion C1 (./consent.ts): the consent registry (ai_processing, AOS-21.42)
  readonly consents: ConsentRepo;
  // Phase 1 completion C1 (./acl.ts): per-resource grants read by the one policy (AOS-21.18)
  readonly acl: AclGrantRepo;
}

export function createSystemRepos(db: Db, clock: Clock): SystemRepos {
  return {
    db,
    users: new UserRepo(db, clock),
    vaults: new VaultRegistry(db, clock),
    devices: new DeviceRepo(db, clock),
    jobIndex: new JobIndex(db, clock),
    securityAudit: new SecurityAudit(db, clock),
    blobs: new BlobRegistry(db, clock),
    quotas: new QuotaRepo(db, clock),
    aiLedger: new AiBudgetLedger(db, clock),
    uploads: new UploadSessionRepo(db, clock),
    consents: new ConsentRepo(db, clock),
    acl: new AclGrantRepo(db, clock),
  };
}
