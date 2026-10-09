// Server configuration, parsed and validated from the environment (see .env.example).
// Secrets (AI provider keys) are NOT stored as plain properties: they are only reachable through
// `config.secrets.*()` functions, so serializing/logging the config can never include them.
// Only provider adapters (modules/ai/providers) may call those functions.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isValidTimeZone } from './lib/time';

export type RuntimeEnv = 'development' | 'production' | 'test';

export interface AppConfig {
  env: RuntimeEnv;
  appVersion: string;
  /** absolute */
  dataDir: string;
  dbPath: string;
  filesDir: string;
  tmpDir: string;
  host: string;
  port: number;
  /** canonical web origin (CSRF Origin check) */
  origin: string;
  /** all accepted Origins (MEDLEVO_ORIGIN may be a comma-separated list; first one is canonical) */
  allowedOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
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
  };
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
  /** secret accessors — functions so they never serialize. Only provider adapters may call them. */
  secrets: {
    anthropicApiKey(): string | null;
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
  MEDLEVO_ORIGIN: z.preprocess(emptyToUndefined, z.string().default('http://localhost:5173')),
  MEDLEVO_COOKIE_SECURE: z.preprocess(emptyToUndefined, boolish.optional()),
  MEDLEVO_TRUST_PROXY: z.preprocess(emptyToUndefined, boolish.default(false)),
  MEDLEVO_LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional()),
  MEDLEVO_MAX_UPLOAD_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(4096).default(200)),
  MEDLEVO_MAX_JSON_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(64).default(8)),
  MEDLEVO_MAX_ZIP_ENTRIES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().max(100_000).default(500)),
  MEDLEVO_MAX_ZIP_UNCOMPRESSED_MB: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(65536).default(1024)),
  MEDLEVO_MAX_ZIP_RATIO: z.preprocess(emptyToUndefined, z.coerce.number().positive().max(10_000).default(100)),
  MEDLEVO_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default('Asia/Baghdad')),
  MEDLEVO_SCRYPT_LOG_N: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(20).default(15)),
  MEDLEVO_JOB_CONCURRENCY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(16).default(2)),
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_GENERATION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_VERIFICATION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_MODEL_VISION: z.preprocess(emptyToUndefined, z.string().optional()),
  MEDLEVO_AI_MONTHLY_BUDGET_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(100_000).default(20)),
  MEDLEVO_ALLOW_EXTERNAL_FETCH: z.preprocess(emptyToUndefined, boolish.default(false)),
  MEDLEVO_WEB_DIST: z.preprocess(emptyToUndefined, z.string().optional()),
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

function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ConfigError(`MEDLEVO_ORIGIN is not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('MEDLEVO_ORIGIN must be http(s)');
  return u.origin;
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
  const origins = e.MEDLEVO_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean).map(normalizeOrigin);
  if (origins.length === 0) throw new ConfigError('MEDLEVO_ORIGIN is required');

  let webDistDir: string | null = null;
  if (e.MEDLEVO_WEB_DIST) webDistDir = isAbsolute(e.MEDLEVO_WEB_DIST) ? e.MEDLEVO_WEB_DIST : resolve(cwd, e.MEDLEVO_WEB_DIST);
  else if (nodeEnv === 'production') webDistDir = join(REPO_ROOT, 'apps', 'web', 'dist');

  const anthropicKey = e.ANTHROPIC_API_KEY?.trim() || null;
  const MB = 1024 * 1024;

  const config: AppConfig = {
    env: nodeEnv,
    appVersion: readAppVersion(),
    dataDir,
    dbPath: join(dataDir, 'medlevo.sqlite'),
    filesDir: join(dataDir, 'files'),
    tmpDir: join(dataDir, 'tmp'),
    host: e.MEDLEVO_HOST,
    port: e.MEDLEVO_PORT,
    origin: origins[0]!,
    allowedOrigins: origins,
    // Secure cookies by default whenever the app is served over https; explicit env value wins.
    cookieSecure: e.MEDLEVO_COOKIE_SECURE ?? origins[0]!.startsWith('https://'),
    trustProxy: e.MEDLEVO_TRUST_PROXY,
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
    },
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
    secrets: Object.freeze({ anthropicApiKey: () => anthropicKey }),
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
