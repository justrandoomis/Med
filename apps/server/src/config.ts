// Server configuration, parsed and validated from the environment (see .env.example).
// Secrets (AI provider keys) are NOT stored as plain properties: they are only reachable through
// `config.secrets.*()` functions, so serializing/logging the config can never include them.
// Only provider adapters (modules/ai/providers) may call those functions.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { OffsiteConfigError, parseOffsiteConfig, parseSchedule, type OffsiteConfig, type OffsiteSchedule } from './lib/objectstore/offsite-config';
import { describeProxy, parseClientIpHeader, parseTrustProxy, ProxyConfigError, type ProxyConfig } from './lib/proxy';
import { isValidTimeZone } from './lib/time';

export type RuntimeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  env: RuntimeEnv;
  appVersion: string;
  /** absolute */
  dataDir: string;
  /** DATA_DIR/medlevo.sqlite — the single-owner database of releases up to R1-a (read only by the layout check and
   *  the owner migration of P1-T1 step 3; never opened as a default database) */
  dbPath: string;
  /** DATA_DIR/system.sqlite (P1-T1): identity, sessions, devices, registry, job index */
  systemDbPath: string;
  /** DATA_DIR/vaults — one database per user */
  vaultsDir: string;
  /** DATA_DIR/spaces — one database per subject (R1-c) */
  spacesDir: string;
  filesDir: string;
  tmpDir: string;
  host: string;
  port: number;
  /** canonical web origin (CSRF Origin check) */
  origin: string;
  /** all accepted Origins (MEDLEVO_ORIGIN may be a comma-separated list; first one is canonical) */
  allowedOrigins: string[];
  /** where the origin came from: MEDLEVO_ORIGIN, the platform's RENDER_EXTERNAL_URL (PL-0), or the local default */
  originSource: 'MEDLEVO_ORIGIN' | 'RENDER_EXTERNAL_URL' | 'default';
  cookieSecure: boolean;
  /** true when ANY proxy is trusted (MEDLEVO_TRUST_PROXY not false): the server is reachable through a proxy */
  trustProxy: boolean;
  /** which proxies are trusted and how the client address is found (lib/proxy.ts) */
  proxy: ProxyConfig;
  logLevel: string;
  timezone: string;
  limits: {
    maxUploadBytes: number;
    maxJsonBodyBytes: number;
    maxZipEntries: number;
    maxZipUncompressedBytes: number;
    /** max inflate ratio per ZIP entry (uncompressed / compressed) */
    maxZipRatio: number;
  };
  auth: {
    /** log2 of scrypt N for password + recovery code hashing */
    scryptLogN: number;
    sessionTtlMs: number;
    passwordMinLength: number;
    /** per-IP ceiling of failed sign-ins per hour (a campus NAT puts a whole class behind one address) */
    loginIpFailuresPerHour: number;
  };
  /** open vault / space connections kept in the LRU pool (lowered at boot to fit the open-file limit) */
  dbPoolSize: number;
  jobs: {
    concurrency: number;
    pollIntervalMs: number;
    heartbeatMs: number;
    staleAfterMs: number;
    defaultTimeoutMs: number;
  };
  ai: {
    /** true when a provider key is present on the server (value never exposed here) */
    anthropicKeyPresent: boolean;
    models: { generation: string | null; verification: string | null; vision: string | null };
    monthlyBudgetUsd: number;
  };
  allowExternalFetch: boolean;
  /** built SPA to serve in production (null → API only) */
  webDistDir: string | null;
  /** PL-0: off-site backups to Cloudflare R2 (S3 API), encrypted on this server first (lib/objectstore) */
  offsite: OffsiteConfig;
  /** P1-T1 step 2: default storage quotas (PRD Q22) */
  quota: {
    /** a vault other than user #1's (MEDLEVO_USER_STORAGE_QUOTA_MB, default 2048) */
    userStorageBytes: number;
    /** a subject space (MEDLEVO_SPACE_STORAGE_QUOTA_MB, default 20480) */
    spaceStorageBytes: number;
  };
  /** P1-T1 step 2: where blobs live — 'local' (the disk only, default) or 'r2' (the disk + an encrypted copy in R2) */
  /** cacheBytes (AOS-21.34): with r2, keep at most this many bytes of local blob copies (null: the disk is a full cache) */
  blobStore: { kind: 'local' | 'r2'; cacheBytes: number | null };
  /** P1-T1 step 2: the daily mark-and-sweep of the blob store (MEDLEVO_BLOB_GC_SCHEDULE, deployment timezone) */
  blobGc: { schedule: OffsiteSchedule | null };
  /** P1-T1 step 2: chunked, resumable uploads */
  uploads: { chunkBytes: number; ttlMs: number };
  /**
   * P1-T1 step 3: what the boot does with a single-owner data directory (MEDLEVO_OWNER_MIGRATION) — 'off' (default):
   * the maintenance page waits for the owner to start the migration with their password; 'apply': start it at boot;
   * 'rollback': undo a completed (or unfinished) migration at boot, then wait for the previous release to be deployed.
   */
  ownerMigration: 'off' | 'apply' | 'rollback';
  /**
   * secret accessors — functions so they never serialize. Only provider adapters may call anthropicApiKey; only the
   * off-site backup module (modules/data/offsite*.ts and its CLI) may call the R2 secret and the encryption key.
   */
  secrets: {
    anthropicApiKey(): string | null;
    r2SecretAccessKey(): string | null;
    backupEncryptionKey(): Buffer | null;
  };
}

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'production', 'test']).optional()),
  MEDLEVO_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('./data')),
  MEDLEVO_HOST: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
  MEDLEVO_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).default(8787)),
  MEDLEVO_ORIGIN: z.preprocess(emptyToUndefined, z.string().optional()),
  // set by Render for every web service (https://<name>.onrender.com); the origin when MEDLEVO_ORIGIN is unset
  RENDER_EXTERNAL_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_COOKIE_SECURE: z.preprocess(emptyToUndefined, boolish.optional()),
  // false | true | <hop count 1–10> | <comma-separated addresses / CIDR ranges / loopback, linklocal, uniquelocal>
  MEDLEVO_TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().optional()),
  // a header the platform's edge sets to the client address (Render: cf-connecting-ip); needs MEDLEVO_TRUST_PROXY
  MEDLEVO_CLIENT_IP_HEADER: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional()),
  MEDLEVO_MAX_UPLOAD_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(4096).default(200)),
  MEDLEVO_MAX_JSON_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(64).default(8)),
  MEDLEVO_MAX_ZIP_ENTRIES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().max(100_000).default(500)),
  MEDLEVO_MAX_ZIP_UNCOMPRESSED_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(65536).default(1024)),
  MEDLEVO_MAX_ZIP_RATIO: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(10_000).default(100)),
  MEDLEVO_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default('Asia/Baghdad')),
  MEDLEVO_SCRYPT_LOG_N: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(20).default(15)),
  MEDLEVO_JOB_CONCURRENCY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(16).default(2)),
  // P1-T1: tenancy
  MEDLEVO_DB_POOL_SIZE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(4).max(20_000).default(500)),
  MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100_000).default(300)),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_GENERATION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_VERIFICATION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_VISION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_AI_MONTHLY_BUDGET_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(100_000).default(20)),
  MEDLEVO_ALLOW_EXTERNAL_FETCH: z.preprocess(emptyToUndefined, boolish.default(false)),
  MEDLEVO_WEB_DIST: z.preprocess(emptyToUndefined, z.string().optional()),
  // PL-0 off-site backups (lib/objectstore/offsite-config.ts). Missing R2 values never stop the server.
  MEDLEVO_R2_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_R2_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_R2_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_R2_PREFIX: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_BACKUP_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_BACKUP_SCHEDULE: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_BACKUP_KEEP_DAILY: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  MEDLEVO_BACKUP_KEEP_WEEKLY: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  MEDLEVO_BACKUP_KEEP_LOCAL: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  // P1-T1 step 2: quotas, blob store, blob GC, chunked uploads
  MEDLEVO_USER_STORAGE_QUOTA_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(10_000_000).default(2048)),
  MEDLEVO_SPACE_STORAGE_QUOTA_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(100_000_000).default(20_480)),
  MEDLEVO_BLOB_STORE: z.preprocess(emptyToUndefined, z.enum(['local', 'r2']).default('local')),
  // AOS-21.34: with the r2 blob store, a budget for the LOCAL copies (the rest is fetched back on demand)
  MEDLEVO_BLOB_CACHE_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(100_000_000).optional()),
  MEDLEVO_BLOB_GC_SCHEDULE: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_UPLOAD_CHUNK_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(64).default(8)),
  // P1-T1 step 3: the owner migration at boot (off = the maintenance page waits for the owner)
  MEDLEVO_OWNER_MIGRATION: z.preprocess(emptyToUndefined, z.enum(['off', 'apply', 'rollback']).default('off')),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '..', '..');

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function normalizeOrigin(raw: string, name = 'MEDLEVO_ORIGIN'): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError(`${name} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${name} must be http(s)`);
  return u.origin;
}

/**
 * MEDLEVO_ORIGIN (comma-separated, first canonical) → RENDER_EXTERNAL_URL → the local development default.
 * `MEDLEVO_ORIGIN=auto` says the same explicitly (render.yaml): use the address Render gives the service.
 */
function resolveOrigins(e: { MEDLEVO_ORIGIN?: string; RENDER_EXTERNAL_URL?: string }): { origins: string[]; source: AppConfig['originSource'] } {
  if (e.MEDLEVO_ORIGIN !== undefined && e.MEDLEVO_ORIGIN.trim().toLowerCase() === 'auto') {
    if (e.RENDER_EXTERNAL_URL === undefined) throw new ConfigError('MEDLEVO_ORIGIN=auto needs RENDER_EXTERNAL_URL (set by Render); elsewhere set MEDLEVO_ORIGIN to the exact https address');
    return { origins: [normalizeOrigin(e.RENDER_EXTERNAL_URL, 'RENDER_EXTERNAL_URL')], source: 'RENDER_EXTERNAL_URL' };
  }
  if (e.MEDLEVO_ORIGIN !== undefined) {
    return { origins: e.MEDLEVO_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean).map((o) => normalizeOrigin(o)), source: 'MEDLEVO_ORIGIN' };
  }
  if (e.RENDER_EXTERNAL_URL !== undefined) return { origins: [normalizeOrigin(e.RENDER_EXTERNAL_URL, 'RENDER_EXTERNAL_URL')], source: 'RENDER_EXTERNAL_URL' };
  return { origins: ['http://localhost:5173'], source: 'default' };
}

function resolveProxy(e: { MEDLEVO_TRUST_PROXY?: string; MEDLEVO_CLIENT_IP_HEADER?: string }): ProxyConfig {
  try {
    const trust = parseTrustProxy(e.MEDLEVO_TRUST_PROXY);
    const clientIpHeader = parseClientIpHeader(e.MEDLEVO_CLIENT_IP_HEADER, trust);
    return { trust, clientIpHeader, description: describeProxy(trust, clientIpHeader) };
  } catch (err) {
    if (err instanceof ProxyConfigError) throw new ConfigError(err.message);
    throw err;
  }
}

export interface LoadConfigOptions {
  /** base directory for relative MEDLEVO_DATA_DIR (default: process.cwd()) */
  cwd?: string;
}

/**
 * Parse configuration from an env-like record. Throws ConfigError with a precise message.
 * Relative MEDLEVO_DATA_DIR is resolved against `cwd` (default process.cwd()).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, opts: LoadConfigOptions = {}): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Invalid configuration: ${fields}`);
  }
  const e = parsed.data;
  const nodeEnv: RuntimeEnv = e.NODE_ENV ?? 'development';
  if (!isValidTimeZone(e.MEDLEVO_TIMEZONE)) throw new ConfigError(`MEDLEVO_TIMEZONE is not a valid IANA zone: ${e.MEDLEVO_TIMEZONE}`);

  const cwd = opts.cwd ?? process.cwd();
  const dataDir = isAbsolute(e.MEDLEVO_DATA_DIR) ? e.MEDLEVO_DATA_DIR : resolve(cwd, e.MEDLEVO_DATA_DIR);
  const { origins, source: originSource } = resolveOrigins(e);
  if (origins.length === 0) throw new ConfigError('MEDLEVO_ORIGIN is required');
  // AOS-21.35 (NFR-S2): the server is multi-user (release R1-b on). A session cookie without `Secure` on an https
  // deployment can leave in clear on a downgraded request — refuse to start rather than serve accounts that way.
  if (e.MEDLEVO_COOKIE_SECURE === false && origins.some((o) => o.startsWith('https://'))) {
    throw new ConfigError(
      'MEDLEVO_COOKIE_SECURE=false is refused with an https origin: session cookies of a multi-user server must be Secure over https. Remove MEDLEVO_COOKIE_SECURE (https makes it true) or set it to true.',
    );
  }
  const proxy = resolveProxy(e);

  let webDistDir: string | null = null;
  if (e.MEDLEVO_WEB_DIST) webDistDir = isAbsolute(e.MEDLEVO_WEB_DIST) ? e.MEDLEVO_WEB_DIST : resolve(cwd, e.MEDLEVO_WEB_DIST);
  else if (nodeEnv === 'production') webDistDir = join(REPO_ROOT, 'apps', 'web', 'dist');

  const anthropicKey = e.ANTHROPIC_API_KEY?.trim() || null;
  const MB = 1024 * 1024;
  let offsite: ReturnType<typeof parseOffsiteConfig>;
  try {
    offsite = parseOffsiteConfig(e);
  } catch (err) {
    if (err instanceof OffsiteConfigError) throw new ConfigError(err.message);
    throw err;
  }

  let blobGcSchedule: OffsiteSchedule | null;
  try {
    blobGcSchedule = parseSchedule(e.MEDLEVO_BLOB_GC_SCHEDULE ?? '04:20');
  } catch {
    throw new ConfigError(`MEDLEVO_BLOB_GC_SCHEDULE must be HH:MM (24-hour, in MEDLEVO_TIMEZONE) or off (got "${e.MEDLEVO_BLOB_GC_SCHEDULE}")`);
  }
  // an explicit opt-in must be complete: blobs are never «silently local only» when r2 was asked for
  if (e.MEDLEVO_BLOB_CACHE_MB !== undefined && e.MEDLEVO_BLOB_STORE !== 'r2') {
    throw new ConfigError('MEDLEVO_BLOB_CACHE_MB needs MEDLEVO_BLOB_STORE=r2: without the remote copy the local disk is the only copy and is never evicted');
  }
  if (e.MEDLEVO_BLOB_STORE === 'r2' && !offsite.offsite.configured) {
    throw new ConfigError(
      `MEDLEVO_BLOB_STORE=r2 needs the R2 settings and the encryption key of the off-site backups: ${offsite.offsite.missing.join(', ') || offsite.offsite.problems_ar.join(' ')}`,
    );
  }

  const config: AppConfig = {
    env: nodeEnv,
    appVersion: readAppVersion(),
    dataDir,
    dbPath: join(dataDir, 'medlevo.sqlite'),
    systemDbPath: join(dataDir, 'system.sqlite'),
    vaultsDir: join(dataDir, 'vaults'),
    spacesDir: join(dataDir, 'spaces'),
    filesDir: join(dataDir, 'files'),
    tmpDir: join(dataDir, 'tmp'),
    host: e.MEDLEVO_HOST,
    port: e.MEDLEVO_PORT,
    origin: origins[0]!,
    allowedOrigins: origins,
    originSource,
    // Secure cookies by default whenever the app is served over https; explicit env value wins.
    cookieSecure: e.MEDLEVO_COOKIE_SECURE ?? origins[0]!.startsWith('https://'),
    trustProxy: proxy.trust.mode !== 'none',
    proxy,
    logLevel: e.MEDLEVO_LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    timezone: e.MEDLEVO_TIMEZONE,
    limits: {
      maxUploadBytes: Math.floor(e.MEDLEVO_MAX_UPLOAD_MB * MB),
      maxJsonBodyBytes: Math.floor(e.MEDLEVO_MAX_JSON_MB * MB),
      maxZipEntries: e.MEDLEVO_MAX_ZIP_ENTRIES,
      maxZipUncompressedBytes: Math.floor(e.MEDLEVO_MAX_ZIP_UNCOMPRESSED_MB * MB),
      maxZipRatio: e.MEDLEVO_MAX_ZIP_RATIO,
    },
    auth: {
      scryptLogN: e.MEDLEVO_SCRYPT_LOG_N,
      sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
      passwordMinLength: 10,
      loginIpFailuresPerHour: e.MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR,
    },
    dbPoolSize: e.MEDLEVO_DB_POOL_SIZE,
    jobs: {
      concurrency: e.MEDLEVO_JOB_CONCURRENCY,
      pollIntervalMs: 1000,
      heartbeatMs: 5000,
      staleAfterMs: 60_000,
      defaultTimeoutMs: 10 * 60 * 1000,
    },
    ai: {
      anthropicKeyPresent: anthropicKey !== null,
      models: {
        generation: e.MEDLEVO_MODEL_GENERATION ?? null,
        verification: e.MEDLEVO_MODEL_VERIFICATION ?? null,
        vision: e.MEDLEVO_MODEL_VISION ?? null,
      },
      monthlyBudgetUsd: e.MEDLEVO_AI_MONTHLY_BUDGET_USD,
    },
    allowExternalFetch: e.MEDLEVO_ALLOW_EXTERNAL_FETCH,
    webDistDir,
    offsite: offsite.offsite,
    quota: {
      userStorageBytes: Math.floor(e.MEDLEVO_USER_STORAGE_QUOTA_MB * MB),
      spaceStorageBytes: Math.floor(e.MEDLEVO_SPACE_STORAGE_QUOTA_MB * MB),
    },
    blobStore: { kind: e.MEDLEVO_BLOB_STORE, cacheBytes: e.MEDLEVO_BLOB_CACHE_MB !== undefined ? Math.floor(e.MEDLEVO_BLOB_CACHE_MB * MB) : null },
    blobGc: { schedule: blobGcSchedule },
    uploads: { chunkBytes: Math.floor(e.MEDLEVO_UPLOAD_CHUNK_MB * MB), ttlMs: 24 * 60 * 60 * 1000 },
    ownerMigration: e.MEDLEVO_OWNER_MIGRATION,
    secrets: Object.freeze({
      anthropicApiKey: () => anthropicKey,
      r2SecretAccessKey: offsite.secrets.r2SecretAccessKey,
      backupEncryptionKey: offsite.secrets.backupEncryptionKey,
    }),
  };
  // Make the secrets accessor non-enumerable as well (belt and braces for serializers/loggers).
  Object.defineProperty(config, 'secrets', { enumerable: false, writable: false, value: config.secrets });
  return config;
}

/** Load `.env` from the working directory or the repository root (Node ≥ 22 built-in). */
export function loadDotEnv(cwd = process.cwd()): string | null {
  for (const candidate of [join(cwd, '.env'), join(REPO_ROOT, '.env')]) {
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // missing file → try next
    }
  }
  return null;
}
