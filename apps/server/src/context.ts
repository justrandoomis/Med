// AppContext: the services every module receives (ARCHITECTURE §3.1, ARCHITECTURE_DELTA §1.1).
//
// P1-T1 step 1 (ADR-0003 §3.2): `db`, `files`, `sync`, `audit` and `settings` keep their types and their ~1,500 call
// sites, but `db` is now a PROXY bound through AsyncLocalStorage — every statement goes to the database of the current
// binding (the request's own vault, a job's database) and there is NO default database: an unbound access throws
// NO_TENANT_BOUND, also from timers. The other services are built on that proxy, so they follow the binding too.
// `ai`, `jobs`, `capabilities`, `clock` and `config` stay process-wide; `system` is the system DB (identity, sessions,
// devices, registry, job index) reached through repositories; `authz` is the one policy.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import { type Db, openDb } from './db/db';
import { migrate } from './db/migrate';
import { deriveKey, loadOrCreateServerSecret } from './lib/secret';
import { type Clock, systemClock } from './lib/time';
import { AuditLog } from './modules/audit/audit';
import { AiBudgetService } from './modules/ai/budget';
import { AiOrchestrator } from './modules/ai/orchestrator';
import { createProviderFromConfig } from './modules/ai/providers';
import type { AiProvider } from './modules/ai/types';
import { SessionStore } from './modules/auth/sessions';
import { type Authz, createAuthz } from './modules/authz/policy';
import { BlobService } from './modules/files/blobs';
import { BlobGc, DEFAULT_GC_OPTIONS, type GcOptions } from './modules/files/gc';
import { type ObjectBlobStore, R2BlobStore, type R2BlobStoreOptions } from './modules/files/r2';
import { FileStore } from './modules/files/store';
import { JobQueue } from './modules/jobs/queue';
import { CapabilityRegistry } from './modules/settings/capabilities';
import { SettingsService } from './modules/settings/service';
import { SyncRegistry } from './modules/sync/registry';
import { createBoundDb, TenantBinding } from './system/binding';
import { prepareDataDir } from './system/layout';
import { DatabasePool } from './system/pool';
import { QuotaService } from './system/quota';
import { createSystemRepos, type SystemRepos } from './system/repos';
import { Tenancy } from './system/tenancy';

export type { Binding, Viewer } from './system/binding';

/** System repositories plus the session store (auth only). */
export interface SystemContext extends SystemRepos {
  readonly sessions: SessionStore;
}

export interface AppContext {
  config: AppConfig;
  /** the bound database of the current request / job (proxy; NO_TENANT_BOUND when unbound) */
  db: Db;
  files: FileStore;
  jobs: JobQueue;
  audit: AuditLog;
  sync: SyncRegistry;
  ai: AiOrchestrator;
  capabilities: CapabilityRegistry;
  /** owner settings (merged with defaults) — of the bound vault */
  settings: SettingsService;
  clock: Clock;
  log: FastifyBaseLogger;
  // ── P1-T1 tenancy ──
  /** the system DB through its repositories (every user-facing method takes the viewer) */
  system: SystemContext;
  /** current() / run(b, fn) / runRoot(fn) — the request hook and the job worker use it */
  binding: TenantBinding;
  /** the open vault / space connections (LRU) */
  pool: DatabasePool;
  /** accounts with their vaults; session user → own-vault binding */
  tenancy: Tenancy;
  /** the one policy (ARCHITECTURE_DELTA §5.5) */
  authz: Authz;
  // ── P1-T1 step 2 ──
  /** the blob registry and the ONLY code that deletes bytes (modules/files/blobs.ts) */
  blobs: BlobService;
  /** the mark-and-sweep GC over every vault and space (modules/files/gc.ts) */
  gc: BlobGc;
  /** storage and AI allowances (system/quota.ts) */
  quota: QuotaService;
  /**
   * An explicit second database in the same request — ONLY for the copy services of later tracks (forks, channels,
   * social, search, evidence, studybook, data; ARCHITECTURE_DELTA §1.1, import-boundary test). Every cross-database
   * write goes through a job with an idempotency key.
   */
  dbs: { vault(vaultId: string): Db; space(spaceId: string): Db };
}

/** Options every module plugin receives: `export default async function register(app, opts: ModuleOptions)`. */
export interface ModuleOptions {
  ctx: AppContext;
}

export type ModulePlugin = (app: FastifyInstance, opts: ModuleOptions) => Promise<void>;

export interface ContextOverrides {
  clock?: Clock;
  /** undefined → createProviderFromConfig(config); null → explicitly no provider (tests) */
  aiProvider?: AiProvider | null;
  /** job queue tuning (tests) */
  jobs?: { backoffBaseMs?: number; backoffMaxMs?: number };
  /** where new-vault templates are kept (tests share one per process); default DATA_DIR/tmp */
  templateDir?: string;
  /** tests: pretend this open-file limit (null = unknown) */
  openFileLimit?: number | null;
  /** tests: pool size override */
  dbPoolSize?: number;
  /** tests: GC timings (default 7 days orphan grace, 30 days quarantine) */
  gc?: GcOptions;
  /** tests: R2 blob store tuning (client retries, small frames and parts against the S3 fake) */
  blobStore?: R2BlobStoreOptions;
  /**
   * A throwaway, single-account tool process (the evaluation harness, the restore boot check): code outside every
   * request may use that one account's vault by default. Never set by the server itself.
   */
  singleTenantTool?: boolean;
}

export function createContext(config: AppConfig, log: FastifyBaseLogger, overrides: ContextOverrides = {}): AppContext {
  const clock = overrides.clock ?? systemClock;
  const now = () => clock.now();

  // the boot guard FIRST: refuses — without creating or touching anything, not even DATA_DIR/tmp — a single-owner data
  // dir, an unfinished migration, or vault files without their registry; a fresh dir gets its system DB, then the marker
  prepareDataDir(
    { dataDir: config.dataDir, legacyDbPath: config.dbPath, systemDbPath: config.systemDbPath, vaultsDir: config.vaultsDir, spacesDir: config.spacesDir },
    now,
  );
  mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
  const systemDb = openDb(config.systemDbPath);
  try {
    migrate(systemDb, { sets: ['system'], now });
  } catch (e) {
    systemDb.close();
    throw e;
  }
  const repos = createSystemRepos(systemDb, clock);
  const system: SystemContext = { ...repos, sessions: new SessionStore(systemDb, clock, config.auth.sessionTtlMs) };

  let pool: DatabasePool | null = null;
  const binding = new TenantBinding({
    resolve: (b) => (b.kind === 'vault' ? pool!.get('vault', b.vaultId) : pool!.get('space', b.spaceId)),
    allowHarnessDefault: config.env === 'test' || overrides.singleTenantTool === true,
  });
  pool = new DatabasePool({
    vaultsDir: config.vaultsDir,
    spacesDir: config.spacesDir,
    templateDir: overrides.templateDir ?? config.tmpDir,
    maxOpen: overrides.dbPoolSize ?? config.dbPoolSize,
    now,
    openFileLimit: overrides.openFileLimit,
    warn: (msg, data) => log.warn(data ?? {}, msg),
    resolver: {
      fileOf(kind, id) {
        if (kind === 'vault') {
          const v = repos.vaults.byIdInternal(id);
          return v && v.status === 'active' ? v.db_file : null;
        }
        const s = repos.vaults.spaceByIdInternal(id);
        return s && (s.status === 'active' || s.status === 'read_only') ? s.db_file : null;
      },
    },
  });
  pool.runBound = (kind, id, fn) =>
    binding.run(kind === 'vault' ? { kind: 'vault', vaultId: id, viewer: null } : { kind: 'space', spaceId: id, subjectNodeId: '', viewer: null, access: 'moderator', route: null }, fn);
  const db = createBoundDb(binding);
  const tenancy = new Tenancy(repos, pool, binding, clock);
  // test runs only: code outside every context (test bodies) uses user #1's vault unless the harness says otherwise
  if (config.env === 'test') binding.setHarnessDefault(() => tenancy.platformVaultBinding());
  const authz = createAuthz();

  const secret = loadOrCreateServerSecret(config.dataDir);
  // P1-T1 step 2: quotas, the blob registry (+ the R2 copy when MEDLEVO_BLOB_STORE=r2) and the GC
  const quota = new QuotaService(repos, pool, binding, clock, {
    userStorageBytes: config.quota.userStorageBytes,
    spaceStorageBytes: config.quota.spaceStorageBytes,
    deploymentAiUsd: config.ai.monthlyBudgetUsd,
    timezone: config.timezone,
  });
  const objectStore: ObjectBlobStore | null =
    config.blobStore.kind === 'r2'
      ? new R2BlobStore(config.offsite, config.secrets.r2SecretAccessKey, config.secrets.backupEncryptionKey, config.tmpDir, overrides.blobStore)
      : null;
  const blobs = new BlobService({
    registry: repos.blobs,
    binding,
    filesDir: config.filesDir,
    quarantineDir: join(config.dataDir, 'quarantine'),
    tmpDir: config.tmpDir,
    log: log.child({ module: 'blobs' }),
    databaseCount: () => repos.vaults.databaseCountInternal(),
    inFlight: (sha) => repos.uploads.inFlightShasInternal().includes(sha),
    objectStore,
  });
  const files = new FileStore(db, config.filesDir, config.tmpDir, deriveKey(secret, 'file-token'), clock, () => tenancy.fileTokenScope(), {
    beforeNewFile: (size) => quota.checkStorageForNewFile(size),
    referenced: (meta) => blobs.referenced(meta),
    ...(objectStore ? { ensureLocal: (sha: string, size: number) => blobs.ensureLocal(sha, size) } : {}),
  });
  const gc = new BlobGc({ system: repos, pool, blobs, filesDir: config.filesDir, clock, log: log.child({ module: 'blob-gc' }) }, overrides.gc ?? DEFAULT_GC_OPTIONS);
  const audit = new AuditLog(db, clock);
  const p = pool;
  const jobs = new JobQueue(
    db,
    clock,
    log.child({ module: 'jobs' }),
    {
      concurrency: config.jobs.concurrency,
      pollIntervalMs: config.jobs.pollIntervalMs,
      heartbeatMs: config.jobs.heartbeatMs,
      staleAfterMs: config.jobs.staleAfterMs,
      defaultTimeoutMs: config.jobs.defaultTimeoutMs,
      ...overrides.jobs,
    },
    {
      binding,
      index: repos.jobIndex,
      lease: (ref) => p.acquire(ref.kind, ref.id),
      usable: (ref) => {
        try {
          return p.pathOf(ref.kind, ref.id) !== null;
        } catch {
          return false;
        }
      },
    },
  );
  // the job index (system DB) and each database's own job rows are two files: bring them into agreement the first time
  // a database is opened in this process (a restored system DB predates its vaults' newest jobs) — review of step 1
  pool.onOpen('vault', 'jobs.reconcile-index', (_kind, id) => void jobs.reconcileIndex({ kind: 'vault', id }));
  pool.onOpen('space', 'jobs.reconcile-index-space', (_kind, id) => void jobs.reconcileIndex({ kind: 'space', id }));
  const sync = new SyncRegistry(db, clock, log.child({ module: 'sync' }));
  const provider = overrides.aiProvider === undefined ? createProviderFromConfig(config) : overrides.aiProvider;
  // P1-T1 step 2: per-user / per-space allowances, reserved atomically in the system ledger before every call
  const aiBudget = new AiBudgetService(repos, quota, binding, db, clock, { deploymentUsd: config.ai.monthlyBudgetUsd, timezone: config.timezone });
  aiBudget.releaseStale();
  const ai = new AiOrchestrator(db, clock, log.child({ module: 'ai' }), {
    provider,
    monthlyBudgetUsd: config.ai.monthlyBudgetUsd,
    timezone: config.timezone,
    charge: aiBudget,
  });
  const capabilities = new CapabilityRegistry(ai, clock, config.appVersion);
  const settings = new SettingsService(db, clock);

  const dbs = {
    vault: (vaultId: string) => p.get('vault', vaultId),
    space: (spaceId: string) => p.get('space', spaceId),
  };

  return { config, db, files, jobs, audit, sync, ai, capabilities, settings, clock, log, system, binding, pool: p, tenancy, authz, dbs, blobs, gc, quota };
}

/** Close every connection the context opened (pool, then the system DB). */
export function closeContextDatabases(ctx: AppContext): void {
  ctx.pool.closeAll();
  if (ctx.system.db.isOpen) ctx.system.db.close();
}
