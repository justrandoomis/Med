// Off-site backups (PL-0, AOS-OC.7 backup part; docs/BACKUP_RESTORE.md §6). One run =
//   1. a local backup (the same archive as «أنشئ نسخة احتياطية الآن», recorded in data_backup),
//   2. the same restore verification as `npm run restore:verify` (separate temp dir, every check, app boot),
//   3. client-side encryption (lib/objectstore/encryption.ts) streamed into a resumable multipart upload to
//      Cloudflare R2 (lib/objectstore/s3.ts + upload.ts), confirmed by a HEAD of the stored size,
//   4. retention: the newest of each of the last N days and M weeks stay off-site; older MedLevo objects are deleted;
//      on the server disk only the newest `keepLocal` archives of off-site runs stay.
// Runs come from the daily schedule (MEDLEVO_BACKUP_SCHEDULE, in MEDLEVO_TIMEZONE) or from «نسخ احتياطي الآن».
// Nothing is uploaded unverified or unencrypted. A crash or a lost connection resumes: the job retries (3 attempts),
// the upload id and the salt are stored, and the parts R2 already holds are skipped.
// Restore from R2 is a Render-Shell command (cli/restore-offsite.ts), deliberately not a web action (see the doc).
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { JobView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { DecryptError, encryptedSize, EncryptStream, ENC_DEFAULT_CHUNK, ENC_SUFFIX } from '../../lib/objectstore/encryption';
import { S3Client, S3Error, type S3ClientOptions } from '../../lib/objectstore/s3';
import { uploadObject } from '../../lib/objectstore/upload';
import { AppError, isJobError, JobError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { JobRun } from '../jobs/queue';
import { archivePath, deleteBackup, performBackup, type BackupRow } from './backups';
import { lastSlotAt, nextSlotAt, parseObjectName, planRetention } from './offsite-schedule';
import { verifyBackup } from './restore';
import type { AppConfig } from '../../config';

export const OFFSITE_JOB_KIND = 'data_backup_offsite';
export const OFFSITE_MAX_ATTEMPTS = 3;
export const OFFSITE_RESTORE_COMMAND = 'medlevo-restore-offsite --latest';

export type OffsiteStatus = 'running' | 'uploaded' | 'failed';
export type OffsiteStage = 'backup' | 'verify' | 'upload' | 'retention' | 'done';
export type OffsiteTrigger = 'schedule' | 'manual';

const STATUS_AR: Record<OffsiteStatus, string> = { running: 'جارية', uploaded: 'رُفعت مشفّرة بعد التحقق منها', failed: 'فشلت' };
const STAGE_AR: Record<OffsiteStage, string> = {
  backup: 'إنشاء نسخة على الخادم',
  verify: 'تجربة استعادتها في مجلد منفصل',
  upload: 'تشفيرها ورفعها إلى Cloudflare R2',
  retention: 'حذف النسخ الأقدم حسب سياسة الاحتفاظ',
  done: 'اكتملت',
};

interface OffsiteRow {
  id: string;
  trigger: OffsiteTrigger;
  status: OffsiteStatus;
  stage: OffsiteStage | null;
  backup_id: string | null;
  archive_size: number | null;
  archive_sha256: string | null;
  object_key: string | null;
  upload_id: string | null;
  salt_hex: string | null;
  key_id: string | null;
  size: number | null;
  parts: number | null;
  parts_resumed: number | null;
  verify_status: 'passed' | 'failed' | null;
  retention_json: string | null;
  warnings_json: string | null;
  error_detail: string | null;
  job_id: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface OffsiteRetentionResult {
  kept: number;
  deleted: number;
  deleted_local: number;
  errors_ar: string[];
}

export interface OffsiteRunView {
  id: string;
  trigger: OffsiteTrigger;
  status: OffsiteStatus;
  status_label_ar: string;
  stage: OffsiteStage | null;
  stage_label_ar: string | null;
  created_at: number;
  finished_at: number | null;
  /** encrypted bytes stored off-site */
  size: number | null;
  archive_size: number | null;
  object_key: string | null;
  parts: number | null;
  parts_resumed: number | null;
  verify_status: 'passed' | 'failed' | null;
  retention: OffsiteRetentionResult | null;
  warnings_ar: string[];
  error_ar: string | null;
  job: JobView | null;
}

export interface OffsiteStatusResponse {
  configured: boolean;
  problems_ar: string[];
  target: { bucket: string; endpoint_host: string; prefix: string } | null;
  encryption: { key_id: string } | null;
  schedule: { time: string; timezone: string; next_run_at: number | null } | null;
  retention: { keep_daily: number; keep_weekly: number; keep_local: number };
  running: OffsiteRunView | null;
  last: OffsiteRunView | null;
  last_success: OffsiteRunView | null;
  recent: OffsiteRunView[];
  restore_command: string;
  notes_ar: string[];
}

export interface RemoteBackupView {
  key: string;
  file_name: string;
  size: number;
  created_at: number;
  last_modified: number | null;
  restore_command: string;
}

export interface OffsiteServiceOptions {
  client?: S3ClientOptions;
  /** encryption frame size (tests use small frames) */
  encChunkSize?: number;
  /** multipart part size override (tests; production comes from config) */
  partSizeBytes?: number;
  /** boot the app on the restored copy during verification (default true) */
  verifyBoot?: boolean;
  /** first scheduler tick after the server starts listening (default 2 min) and the tick interval (default 1 min) */
  firstTickMs?: number;
  tickMs?: number;
}

/** An S3 client for the configured bucket (also used by the restore CLI). */
export function createOffsiteClient(config: AppConfig, opts: S3ClientOptions = {}): S3Client {
  const o = config.offsite;
  if (!o.configured || !o.endpoint || !o.bucket || !o.accessKeyId) throw new Error('off-site backups are not configured');
  const secret = config.secrets.r2SecretAccessKey;
  return new S3Client(
    { endpoint: o.endpoint, bucket: o.bucket, region: o.region, credentials: { accessKeyId: o.accessKeyId, secretAccessKey: () => secret() ?? '' } },
    opts,
  );
}

/** Arabic, specific and actionable; never a stack trace, a key or a signature. */
export function describeOffsiteError(e: unknown): { code: string; reasonAr: string; retryable: boolean } {
  if (isJobError(e)) return { code: e.code, reasonAr: e.messageAr, retryable: e.retryable };
  if (e instanceof DecryptError) return { code: 'OFFSITE_DECRYPT', reasonAr: e.reasonAr, retryable: false };
  if (e instanceof S3Error) {
    const map: Record<string, string> = {
      AccessDenied: 'رفض Cloudflare R2 الطلب (AccessDenied): تأكد أن رمز API يملك صلاحية «Object Read & Write» على هذه الحاوية بالذات.',
      InvalidAccessKeyId: 'معرّف مفتاح R2 غير صحيح: راجع MEDLEVO_R2_ACCESS_KEY_ID في إعدادات Render.',
      SignatureDoesNotMatch: 'المفتاح السري لـ R2 غير صحيح: راجع MEDLEVO_R2_SECRET_ACCESS_KEY في إعدادات Render.',
      NoSuchBucket: 'الحاوية غير موجودة في R2: راجع MEDLEVO_R2_BUCKET ومعرّف الحساب MEDLEVO_R2_ACCOUNT_ID.',
      RequestTimeTooSkewed: 'رفض R2 الطلب لأن ساعة الخادم غير مضبوطة. أعد تشغيل الخدمة، وإن تكرر فأبلغ مزوّد الاستضافة.',
      SourceChanged: 'تغيّر ملف النسخة المحلية أثناء رفعه؛ لم تُرفع نسخة ناقصة. أعد المحاولة.',
      EntityTooSmall: 'رفض R2 أجزاء الرفع (EntityTooSmall). أبلغ عن هذا الخطأ.',
    };
    const reason = map[e.code] ?? (e.retryable ? `تعذّر الوصول إلى Cloudflare R2 (${e.code}${e.status ? `، HTTP ${e.status}` : ''}).` : `رفض Cloudflare R2 الطلب (${e.code}${e.status ? `، HTTP ${e.status}` : ''}).`);
    return { code: `OFFSITE_${e.code.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, 60), reasonAr: reason, retryable: e.retryable };
  }
  if ((e as NodeJS.ErrnoException)?.code === 'ENOSPC') return { code: 'OFFSITE_NO_SPACE', reasonAr: 'لا توجد مساحة كافية على قرص الخادم للنسخة المحلية أو للتحقق منها. كبّر القرص من Render أو قلّل MEDLEVO_BACKUP_KEEP_LOCAL.', retryable: false };
  if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError') return { code: 'OFFSITE_INTERRUPTED', reasonAr: 'توقف الرفع قبل اكتماله (أُعيد تشغيل الخادم أو انتهت المهلة). سيُستأنف من حيث توقف.', retryable: true };
  return { code: 'OFFSITE_FAILED', reasonAr: 'تعذّر إكمال النسخ الاحتياطي خارج الخادم لسبب غير متوقع. راجع سجل الخادم.', retryable: false };
}

const services = new WeakMap<AppContext, OffsiteService>();

/** The off-site service of a context (created by the data module). */
export function offsiteService(ctx: AppContext): OffsiteService {
  let s = services.get(ctx);
  if (!s) {
    s = new OffsiteService(ctx);
    services.set(ctx, s);
  }
  return s;
}

export class OffsiteService {
  opts: OffsiteServiceOptions = {};
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** tests: tune client retries, frame / part sizes and the verification boot */
  configure(o: OffsiteServiceOptions): this {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  private get cfg() {
    return this.ctx.config.offsite;
  }

  private row(id: string): OffsiteRow | undefined {
    return this.ctx.db.get<OffsiteRow>('SELECT * FROM data_offsite_backup WHERE id = ?', [id]);
  }

  private update(id: string, fields: Partial<OffsiteRow>): void {
    const keys = Object.keys(fields) as Array<keyof OffsiteRow>;
    if (!keys.length) return;
    this.ctx.db.run(`UPDATE data_offsite_backup SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k] ?? null), id]);
  }

  view(r: OffsiteRow): OffsiteRunView {
    return {
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      status_label_ar: STATUS_AR[r.status],
      stage: r.stage,
      stage_label_ar: r.stage ? STAGE_AR[r.stage] : null,
      created_at: r.created_at,
      finished_at: r.finished_at,
      size: r.size,
      archive_size: r.archive_size,
      object_key: r.object_key,
      parts: r.parts,
      parts_resumed: r.parts_resumed,
      verify_status: r.verify_status,
      retention: fromJson<OffsiteRetentionResult | null>(r.retention_json ?? 'null') ?? null,
      warnings_ar: fromJson<string[]>(r.warnings_json ?? '[]', []) ?? [],
      error_ar: r.error_detail,
      job: r.job_id ? this.ctx.jobs.get(r.job_id) : null,
    };
  }

  status(): OffsiteStatusResponse {
    this.markInterrupted();
    const cfg = this.cfg;
    const now = this.ctx.clock.now();
    const recentRows = this.ctx.db.all<OffsiteRow>('SELECT * FROM data_offsite_backup ORDER BY created_at DESC, id DESC LIMIT 10');
    const running = recentRows.find((r) => r.status === 'running') ?? this.ctx.db.get<OffsiteRow>(`SELECT * FROM data_offsite_backup WHERE status = 'running' ORDER BY created_at DESC LIMIT 1`);
    const last = this.ctx.db.get<OffsiteRow>(`SELECT * FROM data_offsite_backup WHERE status <> 'running' ORDER BY created_at DESC, id DESC LIMIT 1`);
    const lastOk = this.ctx.db.get<OffsiteRow>(`SELECT * FROM data_offsite_backup WHERE status = 'uploaded' ORDER BY created_at DESC, id DESC LIMIT 1`);
    const hh = (n: number) => String(n).padStart(2, '0');
    const notes = [
      'تُشفَّر كل نسخة على هذا الخادم قبل أن تغادره (AES-256-GCM) بالمفتاح MEDLEVO_BACKUP_ENCRYPTION_KEY. من دون هذا المفتاح لا يمكن فتح أي نسخة — احفظه خارج Render.',
      'لا تُرفع نسخة إلا بعد نجاح الاستعادة التجريبية لها على الخادم.',
      // no «Render ← Shell»: two English words around an arrow form one LTR run and read reversed in RTL (review fix)
      `الاستعادة من R2 تتم بأمر واحد في نافذة Shell من لوحة Render: ${OFFSITE_RESTORE_COMMAND} — ثم إضافة المتغير MEDLEVO_DATA_DIR في صفحة Environment من لوحة Render بقيمة المجلد الذي يطبعه الأمر. لا توجد استعادة من داخل التطبيق عمدًا.`,
    ];
    if (lastOk && now - lastOk.created_at > 36 * 3600_000 && cfg.configured && cfg.schedule) {
      notes.unshift('آخر نسخة ناجحة خارج الخادم أقدم من يوم ونصف. راجع سبب فشل المحاولات الأخيرة.');
    }
    return {
      configured: cfg.configured,
      problems_ar: cfg.problems_ar,
      target: cfg.configured && cfg.bucket && cfg.endpoint ? { bucket: cfg.bucket, endpoint_host: new URL(cfg.endpoint).host, prefix: cfg.prefix } : null,
      encryption: cfg.keyId ? { key_id: cfg.keyId } : null,
      schedule: cfg.schedule
        ? { time: `${hh(cfg.schedule.hour)}:${hh(cfg.schedule.minute)}`, timezone: this.ctx.config.timezone, next_run_at: cfg.configured ? nextSlotAt(now, cfg.schedule, this.ctx.config.timezone) : null }
        : null,
      retention: { keep_daily: cfg.keepDaily, keep_weekly: cfg.keepWeekly, keep_local: cfg.keepLocal },
      running: running ? this.view(running) : null,
      last: last ? this.view(last) : null,
      last_success: lastOk ? this.view(lastOk) : null,
      recent: recentRows.map((r) => this.view(r)),
      restore_command: OFFSITE_RESTORE_COMMAND,
      notes_ar: notes,
    };
  }

  /** «نسخ احتياطي الآن» or a scheduled slot. 409 with the reason when not configured or one is already running. */
  start(trigger: OffsiteTrigger): OffsiteRunView {
    if (!this.cfg.configured) {
      throw new AppError('FEATURE_DISABLED', `النسخ الاحتياطي خارج الخادم غير مُعدّ. ${this.cfg.problems_ar.join(' ')}`.trim(), 409, { problems_ar: this.cfg.problems_ar });
    }
    this.markInterrupted();
    const running = this.ctx.db.get<{ id: string }>(`SELECT id FROM data_offsite_backup WHERE status = 'running'`);
    if (running) throw new AppError('CONFLICT', 'هناك نسخ احتياطي خارج الخادم جارٍ الآن. انتظر اكتماله.', 409, { running_id: running.id });
    const now = this.ctx.clock.now();
    const id = newId(now);
    this.ctx.db.run(`INSERT INTO data_offsite_backup (id, trigger, status, stage, created_at) VALUES (?, ?, 'running', 'backup', ?)`, [id, trigger, now]);
    const job = this.ctx.jobs.enqueue(OFFSITE_JOB_KIND, { run_id: id }, { idempotencyKey: `${OFFSITE_JOB_KIND}:${id}` });
    this.update(id, { job_id: job.id });
    this.ctx.audit.record({
      entityType: 'backup_offsite',
      entityId: id,
      action: 'create',
      summary: trigger === 'manual' ? 'بدء نسخ احتياطي خارج الخادم بطلب المالك' : 'بدء النسخ الاحتياطي اليومي خارج الخادم',
      actor: trigger === 'manual' ? 'owner' : 'system',
    });
    return this.view(this.row(id)!);
  }

  /**
   * A run left 'running' by a crash or a restore is not running any more unless its job still is. Called at boot AND
   * before every status / start / scheduler tick (PL-0 review): at boot the data module registers before
   * jobs.start() → requeueStale(), so a job killed on its last attempt (e.g. out of memory during the verification
   * boot) is failed by the queue only AFTER this ran — and the run then stayed «running» for good, refusing
   * «نسخ احتياطي الآن» (409) and skipping every scheduled slot. One indexed query; nothing else changes.
   */
  markInterrupted(): void {
    for (const r of this.ctx.db.all<OffsiteRow>(`SELECT * FROM data_offsite_backup WHERE status = 'running'`)) {
      const job = r.job_id ? this.ctx.jobs.get(r.job_id) : null;
      if (job && (job.status === 'queued' || job.status === 'running')) continue;
      this.update(r.id, { status: 'failed', error_detail: 'انقطع هذا النسخ قبل اكتماله ولم يعد له مهمة جارية. ستحاول النسخة المجدولة التالية من جديد، أو اضغط «نسخ احتياطي الآن».', finished_at: this.ctx.clock.now() });
    }
  }

  register(): void {
    this.ctx.jobs.register<{ run_id: string }, { object_key: string; size: number }>(OFFSITE_JOB_KIND, {
      version: 'offsite-1',
      maxAttempts: OFFSITE_MAX_ATTEMPTS,
      timeoutMs: 12 * 60 * 60 * 1000,
      concurrency: 1,
      handler: (run) => this.handle(run),
    });
  }

  private async handle(run: JobRun<{ run_id: string }>): Promise<{ object_key: string; size: number }> {
    const id = run.input.run_id;
    const r0 = this.row(id);
    if (!r0) throw new JobError('OFFSITE_NOT_FOUND', 'سجل النسخ خارج الخادم غير موجود.', { retryable: false });
    // a run closed meanwhile (marked interrupted, or ended by a restore) is never resurrected by a re-queued job
    if (r0.status !== 'running') throw new JobError('OFFSITE_CLOSED', 'انتهى هذا النسخ من قبل؛ لم يُستأنف. يبدأ النسخ التالي من جديد.', { retryable: false });
    try {
      if (!this.cfg.configured) throw new JobError('OFFSITE_NOT_CONFIGURED', `النسخ الاحتياطي خارج الخادم غير مُعدّ. ${this.cfg.problems_ar.join(' ')}`, { retryable: false });
      const master = this.ctx.config.secrets.backupEncryptionKey();
      if (!master) throw new JobError('OFFSITE_NOT_CONFIGURED', 'مفتاح التشفير MEDLEVO_BACKUP_ENCRYPTION_KEY غير مضبوط.', { retryable: false });
      this.update(id, { status: 'running', error_detail: null, job_id: run.id });

      // 1. local archive (kept from an earlier attempt when it is still on disk)
      let r = this.row(id)!;
      let backup = r.backup_id ? this.ctx.db.get<BackupRow>('SELECT * FROM data_backup WHERE id = ? AND deleted_at IS NULL', [r.backup_id]) : undefined;
      let path = backup ? archivePath(this.ctx, backup) : null;
      if (!backup || !path || !existsSync(path) || (backup.status !== 'completed' && backup.status !== 'completed_with_warnings')) {
        this.update(id, { stage: 'backup' });
        const now = this.ctx.clock.now();
        const backupId = newId(now);
        this.ctx.db.run(`INSERT INTO data_backup (id, file_name, status, origin, job_id, created_at) VALUES (?, '', 'running', 'api', ?, ?)`, [backupId, run.id, now]);
        const res = await performBackup(this.ctx, backupId, { jobId: run.id, signal: run.signal, onProgress: (p) => run.progress({ ...p, stage: `backup:${p.stage}` }) });
        this.update(id, {
          backup_id: backupId,
          archive_size: res.size,
          archive_sha256: res.sha256,
          warnings_json: toJson(res.warnings_ar),
          verify_status: null,
          // a new archive is a new object: never resume an upload of other bytes
          object_key: null,
          upload_id: null,
          salt_hex: null,
          key_id: null,
        });
        r = this.row(id)!;
        backup = this.ctx.db.get<BackupRow>('SELECT * FROM data_backup WHERE id = ?', [backupId])!;
        path = archivePath(this.ctx, backup)!;
      }

      // 2. restore verification — nothing unverified leaves the server
      if (r.verify_status !== 'passed') {
        this.update(id, { stage: 'verify' });
        run.progress({ stage: 'verify' });
        const v = await verifyBackup(path, { workDir: this.ctx.config.tmpDir, now: () => this.ctx.clock.now(), acceptMissingFiles: true, bootCheck: this.opts.verifyBoot ?? true });
        const status = v.report.ok ? 'passed' : 'failed';
        this.ctx.db.run('UPDATE data_backup SET verify_status = ?, verify_report_json = ?, verified_at = ? WHERE id = ?', [status, toJson(v.report), this.ctx.clock.now(), backup.id]);
        this.update(id, { verify_status: status });
        if (!v.report.ok) {
          const failed = v.report.checks.filter((c) => !c.ok).map((c) => c.detail_ar).join(' ');
          throw new JobError('OFFSITE_VERIFY_FAILED', `فشلت الاستعادة التجريبية للنسخة على الخادم، فلم تُرفع: ${failed}`.trim(), { retryable: false });
        }
        r = this.row(id)!;
      }

      // 3. encrypt + upload (resumable)
      this.update(id, { stage: 'upload' });
      const keyId = this.cfg.keyId!;
      if (!r.salt_hex || !r.object_key || r.key_id !== keyId) {
        if (r.upload_id && r.object_key) await this.client().abortMultipartUpload(r.object_key, r.upload_id).catch(() => undefined);
        this.update(id, { salt_hex: randomBytes(32).toString('hex'), key_id: keyId, object_key: `${this.cfg.prefix}backups/${backup.file_name}${ENC_SUFFIX}`, upload_id: null });
        r = this.row(id)!;
      }
      const archiveSize = statSync(path).size;
      if (r.archive_size !== null && archiveSize !== r.archive_size) throw new JobError('OFFSITE_ARCHIVE_CHANGED', 'تغيّر حجم النسخة المحلية منذ إنشائها؛ لم تُرفع. سيُنشئ النسخ التالي نسخة جديدة.', { retryable: false });
      const chunkSize = this.opts.encChunkSize ?? ENC_DEFAULT_CHUNK;
      const total = encryptedSize(archiveSize, chunkSize);
      const salt = Buffer.from(r.salt_hex!, 'hex');
      const objectKey = r.object_key!;
      const client = this.client();
      const up = await uploadObject(client, objectKey, () => createReadStream(path).pipe(new EncryptStream(master, { salt, chunkSize })), total, {
        partSize: this.opts.partSizeBytes ?? this.cfg.partSizeBytes,
        contentType: 'application/octet-stream',
        metadata: {
          'medlevo-format': 'medlevo-backup-1+mlvenc01',
          'medlevo-key-id': keyId,
          'medlevo-backup-id': backup.id,
          'medlevo-archive-sha256': backup.sha256 ?? '',
          'medlevo-app-version': this.ctx.config.appVersion,
        },
        resumeUploadId: r.upload_id,
        onUploadId: (uploadId) => this.update(id, { upload_id: uploadId }),
        onProgress: (p) => run.progress({ stage: 'upload', done: p.bytes, total: p.totalBytes, unit: 'bytes' }),
        signal: run.signal,
      });
      const head = await client.headObject(objectKey, { signal: run.signal });
      if (!head || head.size !== total) throw new JobError('OFFSITE_UPLOAD_UNCONFIRMED', 'لم يؤكد R2 حجم النسخة المرفوعة؛ ستُعاد المحاولة.', { retryable: true });
      this.update(id, { size: total, parts: up.parts, parts_resumed: up.partsSkipped, upload_id: null });

      // 4. retention (best effort: the new copy is already safe)
      this.update(id, { stage: 'retention' });
      const retention = await this.applyRetention(objectKey, backup.id, run.signal);
      this.update(id, { status: 'uploaded', stage: 'done', retention_json: toJson(retention), finished_at: this.ctx.clock.now(), error_detail: null });
      this.ctx.audit.record({
        entityType: 'backup_offsite',
        entityId: id,
        action: 'completed',
        summary: `رُفعت نسخة احتياطية مشفّرة إلى R2 (${total} بايت${up.partsSkipped ? `، استُؤنفت بعد ${up.partsSkipped} جزءًا محفوظًا` : ''})`,
        actor: 'job',
        jobId: run.id,
      });
      return { object_key: objectKey, size: total };
    } catch (e) {
      const d = describeOffsiteError(e);
      const final = !d.retryable || run.attempt >= OFFSITE_MAX_ATTEMPTS;
      if (final) {
        await this.closeFailedRun(id, run.signal);
        this.update(id, { status: 'failed', error_detail: d.reasonAr, finished_at: this.ctx.clock.now() });
        this.ctx.audit.record({ entityType: 'backup_offsite', entityId: id, action: 'failed', summary: `فشل النسخ الاحتياطي خارج الخادم: ${d.reasonAr}`, actor: 'job', jobId: run.id });
      } else {
        this.update(id, { error_detail: `المحاولة ${run.attempt} من ${OFFSITE_MAX_ATTEMPTS} فشلت: ${d.reasonAr} ستُعاد تلقائيًا وتُستأنف من حيث توقفت.` });
      }
      throw e instanceof JobError ? e : new JobError(d.code, d.reasonAr, { retryable: d.retryable });
    }
  }

  private client(): S3Client {
    return createOffsiteClient(this.ctx.config, this.opts.client);
  }

  /**
   * (PL-0 review) A run that will never be resumed cleans up after itself, best effort and never masking its error:
   *  * its unfinished multipart upload is aborted (R2 would otherwise keep — and bill — the stored parts until a
   *    lifecycle rule removes them);
   *  * local archives of earlier off-site runs beyond the retention are deleted, keeping this run's archive (a
   *    verified local copy when the upload is what failed) and at least the newest completed one. Without this every
   *    failed run — one a day with a wrong R2 secret — left a full archive on the disk the live database is on.
   */
  private async closeFailedRun(id: string, signal?: AbortSignal): Promise<void> {
    const r = this.row(id);
    if (!r) return;
    if (r.upload_id && r.object_key) {
      try {
        // the job's signal: a server shutting down never waits for R2 here (an aborted signal fails at once)
        await this.client().abortMultipartUpload(r.object_key, r.upload_id, { signal });
        this.update(id, { upload_id: null });
      } catch {
        // unreachable store: R2's own lifecycle rule ends the upload later; nothing else depends on it
      }
    }
    try {
      this.pruneLocal(Math.max(1, this.cfg.keepLocal), r.backup_id);
    } catch {
      // a busy or missing file: the next run tries again
    }
  }

  /**
   * Keep the newest `keepNewest` archives made by off-site runs whose restore verification PASSED (plus `alsoKeep`);
   * delete the others — unverified or failed-verification archives and failed (file-less) backup rows included.
   * Ranking verified archives only means a run whose verification failed never displaces the newest verified local
   * copy (which may not be in R2 when the upload is what failed). Manual and CLI backups are never touched.
   */
  private pruneLocal(keepNewest: number, alsoKeep: string | null): { deleted: number; errors_ar: string[] } {
    const out = { deleted: 0, errors_ar: [] as string[] };
    const local = this.ctx.db.all<{ id: string; status: string; verify_status: string | null }>(
      `SELECT b.id, b.status, b.verify_status FROM data_backup b JOIN data_offsite_backup o ON o.backup_id = b.id
        WHERE b.deleted_at IS NULL AND b.status IN ('completed','completed_with_warnings','failed')
        GROUP BY b.id ORDER BY b.created_at DESC, b.id DESC`,
    );
    const verified = local.filter((x) => x.status !== 'failed' && x.verify_status === 'passed');
    const keepIds = new Set(verified.slice(0, keepNewest).map((x) => x.id));
    if (alsoKeep) keepIds.add(alsoKeep);
    for (const { id } of local) {
      if (keepIds.has(id)) continue;
      try {
        deleteBackup(this.ctx, id);
        out.deleted++;
      } catch {
        out.errors_ar.push('تعذّر حذف نسخة محلية قديمة من قرص الخادم.');
      }
    }
    return out;
  }

  /** Delete what the policy no longer keeps (R2) and local archives of older off-site runs (disk). */
  async applyRetention(newKey: string, currentBackupId: string, signal?: AbortSignal): Promise<OffsiteRetentionResult> {
    const out: OffsiteRetentionResult = { kept: 0, deleted: 0, deleted_local: 0, errors_ar: [] };
    try {
      const client = this.client();
      const objects = await client.listObjects(`${this.cfg.prefix}backups/`, { signal });
      const keys = objects.map((o) => o.key);
      if (!keys.includes(newKey)) {
        out.errors_ar.push('لم تظهر النسخة الجديدة في قائمة R2 بعد؛ لم يُحذف شيء هذه المرة.');
      } else {
        const plan = planRetention(keys, { keepDaily: this.cfg.keepDaily, keepWeekly: this.cfg.keepWeekly, tz: this.ctx.config.timezone, alwaysKeep: [newKey] });
        out.kept = plan.keep.length;
        for (const k of plan.delete) {
          try {
            await client.deleteObject(k, { signal });
            out.deleted++;
          } catch (e) {
            out.errors_ar.push(`تعذّر حذف نسخة قديمة من R2 (${parseObjectName(k)?.fileName ?? k}): ${describeOffsiteError(e).reasonAr}`);
          }
        }
      }
    } catch (e) {
      out.errors_ar.push(`تعذّر تطبيق سياسة الاحتفاظ على R2: ${describeOffsiteError(e).reasonAr}`);
    }
    // local: keep the newest `keepLocal` archives that off-site runs made (manual and CLI backups are never touched)
    const local = this.pruneLocal(this.cfg.keepLocal, this.cfg.keepLocal > 0 ? currentBackupId : null);
    out.deleted_local = local.deleted;
    out.errors_ar.push(...local.errors_ar);
    return out;
  }

  /** What R2 holds (newest first), each with the Shell command that restores it. */
  async listRemote(signal?: AbortSignal): Promise<RemoteBackupView[]> {
    if (!this.cfg.configured) throw new AppError('FEATURE_DISABLED', `النسخ الاحتياطي خارج الخادم غير مُعدّ. ${this.cfg.problems_ar.join(' ')}`.trim(), 409);
    try {
      const objects = await this.client().listObjects(`${this.cfg.prefix}backups/`, { signal });
      return objects
        .map((o) => ({ o, p: parseObjectName(o.key) }))
        .filter((x) => x.p !== null)
        .sort((a, b) => b.p!.createdAt - a.p!.createdAt)
        .map(({ o, p }) => ({ key: o.key, file_name: p!.fileName, size: o.size, created_at: p!.createdAt, last_modified: o.lastModified, restore_command: `medlevo-restore-offsite --key ${p!.fileName}` }));
    } catch (e) {
      const d = describeOffsiteError(e);
      throw new AppError('INTERNAL', d.reasonAr, 502);
    }
  }

  /** One scheduler step: start the run of the latest daily slot when nothing ran since it. */
  tick(): OffsiteRunView | null {
    const cfg = this.cfg;
    if (!cfg.configured || !cfg.schedule) return null;
    this.markInterrupted();
    const now = this.ctx.clock.now();
    const slot = lastSlotAt(now, cfg.schedule, this.ctx.config.timezone);
    if (this.ctx.db.get('SELECT 1 AS x FROM data_offsite_backup WHERE created_at >= ? OR status = ? LIMIT 1', [slot, 'running'])) return null;
    try {
      // nothing to protect before the owner account exists (a fresh deploy)
      if (this.ctx.system.users.countInternal() === 0) return null; // nothing to back up before the first account
    } catch {
      // no owner table in this schema: back up anyway
    }
    return this.start('schedule');
  }

  startScheduler(): void {
    if (this.timer || this.firstTimer) return;
    // P1-T1: timers run in the root context; each tick binds the vault that keeps the platform's backup records (user
    // #1's in R1-b) explicitly, and skips before the first account exists
    const tick = () => {
      try {
        const b = this.ctx.tenancy.platformVaultBinding();
        if (!b) return;
        this.ctx.binding.run(b, () => this.tick());
      } catch (e) {
        this.ctx.log.warn({ err: e }, 'off-site backup scheduler tick failed');
      }
    };
    this.ctx.binding.runRoot(() => this.armScheduler(tick));
  }

  private armScheduler(tick: () => void): void {
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      tick();
      this.timer = setInterval(tick, this.opts.tickMs ?? 60_000);
      this.timer.unref();
    }, this.opts.firstTickMs ?? 120_000);
    this.firstTimer.unref();
  }

  stopScheduler(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = this.timer = null;
  }
}
