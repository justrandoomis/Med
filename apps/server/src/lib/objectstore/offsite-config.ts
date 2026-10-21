// Off-site backup settings (PL-0): Cloudflare R2 (or any S3-compatible store) + client-side encryption + schedule +
// retention. Parsed from the environment by config.ts. Missing or invalid R2 credentials / key never stop the server:
// off-site backups are then «not configured» and the Control Center names what is missing (variable names only, never
// values). A malformed schedule, prefix or retention number does stop it (OffsiteConfigError → ConfigError): a typo
// there must not silently change when or how many backups are kept.
import { backupKeyId, parseBackupKey } from './encryption';

export interface OffsiteSchedule {
  hour: number;
  minute: number;
}

export interface OffsiteConfig {
  /** every required setting is present and valid */
  configured: boolean;
  /** what is missing or invalid, in Arabic, naming variables only */
  problems_ar: string[];
  /** names of required variables that are not set */
  missing: string[];
  /** https://<account id>.r2.cloudflarestorage.com (or MEDLEVO_R2_ENDPOINT) */
  endpoint: string | null;
  bucket: string | null;
  region: string;
  accessKeyId: string | null;
  /** object key prefix, ends with «/» */
  prefix: string;
  /** daily time in MEDLEVO_TIMEZONE; null = no schedule (manual «نسخ احتياطي الآن» only) */
  schedule: OffsiteSchedule | null;
  keepDaily: number;
  keepWeekly: number;
  /** local archives made by off-site runs that stay on the server disk after a successful upload */
  keepLocal: number;
  /** fingerprint of the encryption key (never the key) */
  keyId: string | null;
  /** multipart part size in bytes (R2 minimum 5 MiB) */
  partSizeBytes: number;
}

export interface OffsiteSecrets {
  r2SecretAccessKey(): string | null;
  backupEncryptionKey(): Buffer | null;
}

export const OFFSITE_ENV = {
  accountId: 'MEDLEVO_R2_ACCOUNT_ID',
  endpoint: 'MEDLEVO_R2_ENDPOINT',
  bucket: 'MEDLEVO_R2_BUCKET',
  accessKeyId: 'MEDLEVO_R2_ACCESS_KEY_ID',
  secret: 'MEDLEVO_R2_SECRET_ACCESS_KEY',
  encryptionKey: 'MEDLEVO_BACKUP_ENCRYPTION_KEY',
} as const;

export interface OffsiteEnv {
  MEDLEVO_R2_ACCOUNT_ID?: string;
  MEDLEVO_R2_ENDPOINT?: string;
  MEDLEVO_R2_BUCKET?: string;
  MEDLEVO_R2_ACCESS_KEY_ID?: string;
  MEDLEVO_R2_SECRET_ACCESS_KEY?: string;
  MEDLEVO_BACKUP_ENCRYPTION_KEY?: string;
  MEDLEVO_R2_PREFIX?: string;
  MEDLEVO_BACKUP_SCHEDULE?: string;
  MEDLEVO_BACKUP_KEEP_DAILY?: number;
  MEDLEVO_BACKUP_KEEP_WEEKLY?: number;
  MEDLEVO_BACKUP_KEEP_LOCAL?: number;
}

export class OffsiteConfigError extends Error {}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

function parseEndpoint(env: OffsiteEnv, problems: string[]): string | null {
  if (env.MEDLEVO_R2_ENDPOINT) {
    let u: URL;
    try {
      u = new URL(env.MEDLEVO_R2_ENDPOINT.trim());
    } catch {
      problems.push('MEDLEVO_R2_ENDPOINT ليس عنوانًا صالحًا.');
      return null;
    }
    const insecureOk = u.protocol === 'http:' && LOOPBACK.test(u.hostname);
    if (u.protocol !== 'https:' && !insecureOk) {
      problems.push('MEDLEVO_R2_ENDPOINT يجب أن يبدأ بـ https://');
      return null;
    }
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.username || u.password) {
      problems.push('MEDLEVO_R2_ENDPOINT يجب أن يكون عنوان الخدمة فقط، دون اسم الحاوية أو مسار.');
      return null;
    }
    return u.origin;
  }
  if (env.MEDLEVO_R2_ACCOUNT_ID) {
    const id = env.MEDLEVO_R2_ACCOUNT_ID.trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(id)) {
      problems.push('MEDLEVO_R2_ACCOUNT_ID ليس معرّف حساب Cloudflare صالحًا (32 حرفًا من 0–9 و a–f عادة).');
      return null;
    }
    return `https://${id.toLowerCase()}.r2.cloudflarestorage.com`;
  }
  return null;
}

/** 'HH:MM' (24 h) or 'off'. Throws OffsiteConfigError on anything else (a typo must not silently disable backups). */
export function parseSchedule(raw: string | undefined): OffsiteSchedule | null {
  const v = (raw ?? '03:15').trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === 'none') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
  if (!m) throw new OffsiteConfigError(`MEDLEVO_BACKUP_SCHEDULE must be HH:MM (24-hour, in MEDLEVO_TIMEZONE) or off (got "${raw}")`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parsePrefix(raw: string | undefined): string {
  const v = (raw ?? 'medlevo/').trim().replace(/^\/+/, '');
  if (v === '') return '';
  if (!/^[A-Za-z0-9._\-/]{1,200}$/.test(v) || v.includes('..') || v.includes('//')) {
    throw new OffsiteConfigError('MEDLEVO_R2_PREFIX may only contain letters, digits, . _ - and /');
  }
  return v.endsWith('/') ? v : `${v}/`;
}

export function parseOffsiteConfig(env: OffsiteEnv, opts: { partSizeBytes?: number } = {}): { offsite: OffsiteConfig; secrets: OffsiteSecrets } {
  const problems: string[] = [];
  const endpoint = parseEndpoint(env, problems);
  const bucketRaw = env.MEDLEVO_R2_BUCKET?.trim() || null;
  let bucket: string | null = bucketRaw;
  if (bucketRaw && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketRaw)) {
    problems.push('MEDLEVO_R2_BUCKET ليس اسم حاوية صالحًا (3–63 حرفًا: حروف إنجليزية صغيرة وأرقام و -).');
    bucket = null;
  }
  const accessKeyId = env.MEDLEVO_R2_ACCESS_KEY_ID?.trim() || null;
  const secret = env.MEDLEVO_R2_SECRET_ACCESS_KEY?.trim() || null;
  let key: Buffer | null = null;
  if (env.MEDLEVO_BACKUP_ENCRYPTION_KEY?.trim()) {
    try {
      key = parseBackupKey(env.MEDLEVO_BACKUP_ENCRYPTION_KEY);
    } catch {
      problems.push('MEDLEVO_BACKUP_ENCRYPTION_KEY غير صالح: يجب أن يكون 32 بايتًا عشوائيًا بترميز base64 (44 حرفًا) أو 64 حرفًا ست عشريًا.');
    }
  }
  const missing: string[] = [];
  if (!env.MEDLEVO_R2_ENDPOINT && !env.MEDLEVO_R2_ACCOUNT_ID) missing.push(OFFSITE_ENV.accountId);
  if (!bucketRaw) missing.push(OFFSITE_ENV.bucket);
  if (!accessKeyId) missing.push(OFFSITE_ENV.accessKeyId);
  if (!secret) missing.push(OFFSITE_ENV.secret);
  if (!env.MEDLEVO_BACKUP_ENCRYPTION_KEY?.trim()) missing.push(OFFSITE_ENV.encryptionKey);
  const anySet = missing.length < 5 || Boolean(env.MEDLEVO_R2_ENDPOINT);
  if (missing.length) {
    problems.unshift(
      anySet
        ? `إعداد النسخ خارج الخادم ناقص: ${missing.join('، ')} غير مضبوط.`
        : 'النسخ الاحتياطي خارج الخادم (Cloudflare R2) غير مُعدّ: لم يُضبط أي من متغيرات R2 ومفتاح التشفير.',
    );
  }
  const schedule = parseSchedule(env.MEDLEVO_BACKUP_SCHEDULE);
  const prefix = parsePrefix(env.MEDLEVO_R2_PREFIX);
  const int = (v: number | undefined, dflt: number, min: number, max: number, name: string) => {
    const n = v ?? dflt;
    if (!Number.isInteger(n) || n < min || n > max) throw new OffsiteConfigError(`${name} must be an integer ${min}–${max}`);
    return n;
  };
  const offsite: OffsiteConfig = {
    configured: problems.length === 0 && endpoint !== null && bucket !== null && accessKeyId !== null && secret !== null && key !== null,
    problems_ar: problems,
    missing,
    endpoint,
    bucket,
    region: 'auto',
    accessKeyId,
    prefix,
    schedule,
    keepDaily: int(env.MEDLEVO_BACKUP_KEEP_DAILY, 7, 1, 90, 'MEDLEVO_BACKUP_KEEP_DAILY'),
    keepWeekly: int(env.MEDLEVO_BACKUP_KEEP_WEEKLY, 4, 0, 104, 'MEDLEVO_BACKUP_KEEP_WEEKLY'),
    keepLocal: int(env.MEDLEVO_BACKUP_KEEP_LOCAL, 1, 0, 30, 'MEDLEVO_BACKUP_KEEP_LOCAL'),
    keyId: key ? backupKeyId(key) : null,
    partSizeBytes: opts.partSizeBytes ?? 16 * 1024 * 1024,
  };
  const secrets: OffsiteSecrets = Object.freeze({
    r2SecretAccessKey: () => secret,
    backupEncryptionKey: () => (key ? Buffer.from(key) : null),
  });
  return { offsite, secrets };
}
