// AppContext: the services every module receives (ARCHITECTURE §3.1).
import { mkdirSync } from 'node:fs';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import { type Db, openDb } from './db/db';
import { migrate } from './db/migrate';
import { deriveKey, loadOrCreateServerSecret } from './lib/secret';
import { type Clock, systemClock } from './lib/time';
import { AuditLog } from './modules/audit/audit';
import { AiOrchestrator } from './modules/ai/orchestrator';
import { createProviderFromConfig } from './modules/ai/providers';
import type { AiProvider } from './modules/ai/types';
import { FileStore } from './modules/files/store';
import { JobQueue } from './modules/jobs/queue';
import { CapabilityRegistry } from './modules/settings/capabilities';
import { SettingsService } from './modules/settings/service';
import { SyncRegistry } from './modules/sync/registry';

export interface AppContext {
  config: AppConfig;
  db: Db;
  files: FileStore;
  jobs: JobQueue;
  audit: AuditLog;
  sync: SyncRegistry;
  ai: AiOrchestrator;
  capabilities: CapabilityRegistry;
  /** owner settings (merged with defaults) */
  settings: SettingsService;
  clock: Clock;
  log: FastifyBaseLogger;
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
  /** an already-open database (otherwise opened at config.dbPath and migrated) */
  db?: Db;
  /** job queue tuning (tests) */
  jobs?: { backoffBaseMs?: number; backoffMaxMs?: number };
}

export function createContext(config: AppConfig, log: FastifyBaseLogger, overrides: ContextOverrides = {}): AppContext {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
  const clock = overrides.clock ?? systemClock;

  let db = overrides.db;
  if (!db) {
    db = openDb(config.dbPath);
    migrate(db, { now: () => clock.now() });
  }

  const secret = loadOrCreateServerSecret(config.dataDir);
  const files = new FileStore(db, config.filesDir, config.tmpDir, deriveKey(secret, 'file-token'), clock);
  const audit = new AuditLog(db, clock);
  const jobs = new JobQueue(db, clock, log.child({ module: 'jobs' }), {
    concurrency: config.jobs.concurrency,
    pollIntervalMs: config.jobs.pollIntervalMs,
    heartbeatMs: config.jobs.heartbeatMs,
    staleAfterMs: config.jobs.staleAfterMs,
    defaultTimeoutMs: config.jobs.defaultTimeoutMs,
    ...overrides.jobs,
  });
  const sync = new SyncRegistry(db, clock, log.child({ module: 'sync' }));
  const provider = overrides.aiProvider === undefined ? createProviderFromConfig(config) : overrides.aiProvider;
  const ai = new AiOrchestrator(db, clock, log.child({ module: 'ai' }), {
    provider,
    monthlyBudgetUsd: config.ai.monthlyBudgetUsd,
    timezone: config.timezone,
  });
  const capabilities = new CapabilityRegistry(ai, clock, config.appVersion);
  const settings = new SettingsService(db, clock);

  return { config, db, files, jobs, audit, sync, ai, capabilities, settings, clock, log };
}
