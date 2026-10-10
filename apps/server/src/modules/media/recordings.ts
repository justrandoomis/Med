// In-app recordings (§29) — track F4. The web records only on an explicit owner action (MediaRecorder), keeps the
// bytes on the device first (IndexedDB) and uploads them here. A recording becomes a «ملاحظة صوتية» (my_audio_note)
// source through the sources module's own registration (content sniffed — never trusted by name or MIME), linked to
// the lecture that was open (source_link 'audio_for'). audio_recording maps the client's recording id → that source so
// a retried upload is idempotent and pen strokes written during the recording (annotation data.audio_link) can be
// played back at their moment.
import { createWriteStream, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pageDisplayLabel, type RecordingResponse, type RecordingView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { randomToken } from '../../lib/hash';
import { parseWith } from '../../lib/http';
import { SourcesService } from '../sources/service';
import { cleanFileName, sniff, UNSUPPORTED_REASONS_AR } from '../sources/sniff';
import { registerUpload, type IncomingFile } from '../sources/upload';
import { ensureAudioAssets, reportDuration } from './audio';

const ID = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');

const fieldsSchema = z
  .object({
    recording_id: ID,
    title: z.string().trim().max(300).optional(),
    node_id: ID.optional(),
    linked_source_id: ID.optional(),
    started_at: z.coerce.number().int().min(0),
    duration_ms: z.coerce.number().int().min(0).max(24 * 3600 * 1000).optional(),
    device_id: z.string().trim().max(64).optional(),
  })
  .strict();

interface RecordingRow {
  id: string;
  source_id: string;
  version_id: string | null;
  linked_source_id: string | null;
  started_at: number;
  duration_ms: number | null;
  mime: string;
  device_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Default title: «ملاحظة صوتية — 10/10 14:05» in the owner's timezone (never invented content). Built from parts with
 * Western digits and a 24-hour clock and NO bidi control marks: the 'ar' formatter puts an RLM inside «10‏/10», which
 * scrambles the date once the title is shown as an LTR island in Arabic text.
 */
function defaultTitle(ctx: AppContext, startedAt: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.config.timezone ?? 'Asia/Baghdad', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(startedAt);
  const p = (type: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === type)?.value ?? '';
  return `ملاحظة صوتية — ${p('day')}/${p('month')} ${p('hour')}:${p('minute')}`;
}

export function getRecordingRow(ctx: AppContext, id: string): RecordingRow {
  const r = ctx.db.get<RecordingRow>('SELECT * FROM audio_recording WHERE id = ?', [id]);
  const live = r ? ctx.db.get<{ x: number }>('SELECT 1 AS x FROM source WHERE id = ? AND deleted_at IS NULL', [r.source_id]) : null;
  if (!r || !live) throw new AppError('NOT_FOUND', 'التسجيل غير موجود على الخادم (لم يُرفع بعد، أو مصدره في سلة المحذوفات).', 404);
  return r;
}

export function recordingView(ctx: AppContext, r: RecordingRow): RecordingView {
  ensureAudioAssets(ctx);
  const s = ctx.db.get<{ title: string }>('SELECT title FROM source WHERE id = ?', [r.source_id]);
  const audio = r.version_id ? ctx.db.get<{ id: string; duration_ms: number | null }>('SELECT id, duration_ms FROM audio_asset WHERE version_id = ?', [r.version_id]) : undefined;
  const strokes = ctx.db.all<{ id: string; anchor_json: string; data_json: string }>(
    `SELECT id, anchor_json, data_json FROM annotation
      WHERE deleted_at IS NULL AND kind IN ('ink','shape') AND json_extract(data_json, '$.audio_link.recording_id') = ?
      ORDER BY json_extract(data_json, '$.audio_link.offset_ms') LIMIT 2000`,
    [r.id],
  );
  return {
    id: r.id,
    source_id: r.source_id,
    version_id: r.version_id,
    audio_id: audio?.id ?? null,
    title: s?.title ?? '',
    mime: r.mime,
    duration_ms: audio?.duration_ms ?? r.duration_ms,
    started_at: r.started_at,
    linked_source_id: r.linked_source_id,
    stream_url: audio ? `/api/media/audio/${audio.id}/stream` : null,
    linked_strokes: strokes.map((a) => {
      const anchor = fromJson<{ type?: string; source_id?: string; page_id?: string }>(a.anchor_json) ?? {};
      const link = fromJson<{ audio_link?: { offset_ms?: number; origin?: string } }>(a.data_json)?.audio_link ?? {};
      const page = anchor.page_id ? ctx.db.get<{ page_index: number; printed_label: string | null; kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment' }>('SELECT page_index, printed_label, kind FROM source_page WHERE id = ?', [anchor.page_id]) : undefined;
      return {
        annotation_id: a.id,
        source_id: anchor.type === 'page' ? (anchor.source_id ?? null) : null,
        page_id: anchor.type === 'page' ? (anchor.page_id ?? null) : null,
        page_index: page?.page_index ?? null,
        page_label_ar: page ? pageDisplayLabel(page) : null,
        offset_ms: Math.max(0, Math.round(link.offset_ms ?? 0)),
        origin: link.origin === 'manual' ? 'manual' : 'auto',
      };
    }),
    created_at: r.created_at,
  };
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Multipart: fields + exactly one file, streamed to a private temp file (never buffered whole). */
async function readRecordingMultipart(ctx: AppContext, req: FastifyRequest): Promise<{ fields: Record<string, string>; file: IncomingFile | null; cleanup: () => void }> {
  if (!req.isMultipart()) throw new AppError('UNSUPPORTED_FORMAT', 'يجب إرسال التسجيل بصيغة multipart/form-data.', 415);
  const fields: Record<string, string> = {};
  let file: IncomingFile | null = null;
  const tmp: string[] = [];
  const cleanup = () => {
    for (const p of tmp) rmSync(p, { force: true });
  };
  try {
    const parts = req.parts({ throwFileSizeLimit: false } as Parameters<FastifyRequest['parts']>[0]);
    for await (const part of parts) {
      if (part.type === 'file') {
        const tmpPath = join(ctx.config.tmpDir, `recording-${randomToken(12)}`);
        tmp.push(tmpPath);
        const entry: IncomingFile = { tmpPath, fileName: cleanFileName(part.filename), size: 0, truncated: false };
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            entry.size += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(part.file, meter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
        entry.truncated = part.file.truncated === true;
        if (file) throw new AppError('BAD_REQUEST', 'أرسل تسجيلًا واحدًا في كل طلب.', 400);
        file = entry;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { fields, file, cleanup };
}

/**
 * Uploads in flight per recording id (one server process): a second upload of the same recording (two tabs, or a
 * retry while the first request is still storing) waits for the first and then gets its result — never a second
 * my_audio_note source and a 500 on the duplicate key.
 */
const inflight = new WeakMap<AppContext, Map<string, Promise<void>>>();

export async function uploadRecording(ctx: AppContext, req: FastifyRequest): Promise<RecordingResponse> {
  const mp = await readRecordingMultipart(ctx, req);
  let release: (() => void) | null = null;
  const busy = inflight.get(ctx) ?? new Map<string, Promise<void>>();
  inflight.set(ctx, busy);
  let recordingId: string | null = null;
  try {
    const f = parseWith(fieldsSchema, mp.fields, 'body');
    recordingId = f.recording_id;
    for (let prior = busy.get(f.recording_id); prior; prior = busy.get(f.recording_id)) await prior;
    // (no await between this check and claiming the id below: the claim is atomic)
    const existing = ctx.db.get<RecordingRow>('SELECT * FROM audio_recording WHERE id = ?', [f.recording_id]);
    // already stored (also when its source was trashed since): the device can stop retrying
    if (existing) return { recording: recordingView(ctx, existing), created: false };
    busy.set(f.recording_id, new Promise<void>((resolve) => (release = resolve)));
    const file = mp.file;
    if (!file || file.size === 0) throw new AppError('BAD_REQUEST', 'التسجيل فارغ؛ لم يُحفظ شيء.', 400);
    if (file.truncated || file.size > ctx.config.limits.maxUploadBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', 'التسجيل أكبر من حد الرفع على الخادم. يبقى محفوظًا على جهازك؛ ارفع حد الرفع (MEDLEVO_MAX_UPLOAD_MB) ثم أعد المحاولة.', 413);
    }
    // content decides, not the name: only audio is accepted here
    const s = sniff(await readHead(file.tmpPath, 256 * 1024));
    if (s.kind !== 'audio') {
      throw new AppError('UNSUPPORTED_FORMAT', s.kind === 'unsupported' ? `ليس تسجيلًا صوتيًا مدعومًا: ${UNSUPPORTED_REASONS_AR[s.what]}` : 'الملف المرسل ليس تسجيلًا صوتيًا.', 415);
    }
    // The lecture open while recording may have been purged (or trashed) while the recording waited on the device:
    // the recording is still the owner's — it is stored unlinked instead of being refused (a 404 here was retried
    // by the device forever and the recording never arrived).
    let linked: { id: string; node_id: string | null } | null = null;
    if (f.linked_source_id) {
      const l = ctx.db.get<{ id: string; node_id: string | null; deleted_at: number | null }>('SELECT id, node_id, deleted_at FROM source WHERE id = ?', [f.linked_source_id]);
      if (l && l.deleted_at === null) linked = { id: l.id, node_id: l.node_id };
    }
    // the folder: the one sent, else the lecture's (when the sent one no longer exists at all)
    const nodeRow = (id: string | null | undefined) => (id ? ctx.db.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM library_node WHERE id = ?', [id]) : undefined);
    const node = nodeRow(f.node_id) ?? nodeRow(linked?.node_id);
    if (!node) {
      throw new AppError(
        'VALIDATION_FAILED',
        f.node_id || linked
          ? 'المجلد الذي يُحفظ فيه التسجيل لم يعد موجودًا. التسجيل باقٍ على جهازك: نزّل نسخة منه وارفعها من صفحة الرفع.'
          : 'حدّد المجلد الذي يُحفظ فيه التسجيل.',
        400,
      );
    }
    if (node.deleted_at !== null) throw new AppError('CONFLICT', 'المجلد الهدف في سلة المحذوفات؛ التسجيل محفوظ على جهازك.', 409);
    const nodeId = node.id;

    const result = await registerUpload(ctx, { ...file, fileName: file.fileName === 'ملف بلا اسم' ? `recording-${f.recording_id}` : file.fileName }, {
      nodeId,
      sourceType: 'my_audio_note',
      title: f.title || defaultTitle(ctx, f.started_at),
      onDuplicate: 'create',
    });
    if (result.status !== 'accepted' || !result.source_id) throw new AppError('UNSUPPORTED_FORMAT', result.reason_ar ?? 'رفض الخادم التسجيل.', 415);
    const now = ctx.clock.now();
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO audio_recording (id, source_id, version_id, linked_source_id, started_at, duration_ms, mime, device_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [f.recording_id, result.source_id, result.version_id ?? null, linked?.id ?? null, f.started_at, f.duration_ms ?? null, s.mime, f.device_id ?? null, now, now],
      );
    });
    if (linked) {
      try {
        new SourcesService(ctx).addLink(result.source_id, linked.id, 'audio_for');
      } catch (e) {
        ctx.log.warn({ err: e }, 'could not link the recording to its lecture');
      }
    }
    ensureAudioAssets(ctx);
    // the duration measured by the recording device's clock (the server does not decode audio)
    const audio = result.version_id ? ctx.db.get<{ id: string }>('SELECT id FROM audio_asset WHERE version_id = ?', [result.version_id]) : undefined;
    if (audio && f.duration_ms && f.duration_ms > 0) reportDuration(ctx, audio.id, f.duration_ms);
    ctx.audit.record({ entityType: 'audio_recording', entityId: f.recording_id, action: 'create', summary: 'حفظ تسجيل صوتي من داخل التطبيق', after: { source_id: result.source_id, linked_source_id: linked?.id ?? null } });
    return { recording: recordingView(ctx, getRecordingRow(ctx, f.recording_id)), created: true };
  } finally {
    mp.cleanup();
    if (release && recordingId) {
      (release as () => void)();
      busy.delete(recordingId);
    }
  }
}

export function recordingsForSource(ctx: AppContext, sourceId: string): RecordingView[] {
  const rows = ctx.db.all<RecordingRow>(
    `SELECT r.* FROM audio_recording r JOIN source s ON s.id = r.source_id WHERE s.deleted_at IS NULL AND (r.linked_source_id = ? OR r.source_id = ?) ORDER BY r.started_at DESC LIMIT 200`,
    [sourceId, sourceId],
  );
  return rows.map((r) => recordingView(ctx, r));
}
