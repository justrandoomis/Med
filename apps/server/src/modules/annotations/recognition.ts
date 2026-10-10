// Handwriting recognition (§28, §41, §46) — track F4. Owned by the annotations module (table ink_recognition).
//
//  * A recognition is a DERIVED reading of strokes: the owner's ink (annotation rows, or the written-answer pad strokes
//    kept in strokes_json) is never touched, replaced or deleted by anything here.
//  * The web renders the selected strokes to a cropped, normalized black-on-white PNG; the job `ink.recognize` sends
//    that picture (and nothing else from the library) to the vision reader (AI task `ink_recognize`). Without a
//    vision-capable provider the request is refused with the capability's reason and nothing is stored.
//  * The reader returns lines of words with a per-word `uncertain` flag; it may abstain (`unreadable`, with its
//    reason). Output is schema-validated by the orchestrator; empty readings are abstentions, never «recognized».
//  * The owner corrects the reading: `corrected_text` is stored beside the machine text (which stays as returned);
//    search, «اسأل عن المحدد» and the written-answer confirmation use the owner's text when there is one.
//  * Search: owner_content_fts entity 'ink_recognition' with origin 'recognized' (machine) or 'owner' (corrected);
//    only page / note-page readings are indexed (written answers belong to their attempt).
import { z } from 'zod';
import {
  CORRECTED_LABEL_AR,
  RECOGNITION_IMAGE_MAX_BYTES,
  RECOGNITION_IMAGE_MAX_SIDE,
  RECOGNITION_IMAGE_MIN_SIDE,
  RECOGNITION_LANGS,
  RECOGNITION_MAX_TEXT,
  RECOGNITION_PURPOSES,
  RECOGNITION_STATUS_LABELS_AR,
  RECOGNIZED_LABEL_AR,
  annotationTargetKey,
  normalizeForSearch,
  pageDisplayLabel,
  type AnnotationAnchor,
  type AskContextResponse,
  type InkRecognitionView,
  type NormBox,
  type RecognitionLang,
  type RecognitionPurpose,
  type RecognitionStatus,
  type RecognizedLine,
  type ResolvedScope,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError, JobError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import type { JobRun } from '../jobs/queue';

export const INK_RECOGNIZE_JOB = 'ink.recognize';
export const RECOGNIZER_VERSION = 'inkrec-v1';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');
const finite = z.number().refine((n) => Number.isFinite(n), 'قيمة رقمية غير صالحة.');
const coord = finite.refine((n) => n >= -1 && n <= 2, 'إحداثي خارج نطاق الصفحة.');
const boxSchema = z.object({ x: coord, y: coord, w: finite.refine((n) => n >= 0 && n <= 3), h: finite.refine((n) => n >= 0 && n <= 3) });
const pageAnchorSchema = z.object({
  type: z.literal('page'),
  source_id: ID,
  version_id: ID,
  page_id: ID,
  page_index: z.number().int().min(0).max(100_000),
});
const notePageAnchorSchema = z.object({ type: z.literal('note_page'), note_page_id: ID });

/** base64 length of the largest accepted PNG (+ padding) */
const MAX_B64 = Math.ceil((RECOGNITION_IMAGE_MAX_BYTES * 4) / 3) + 8;

export const recognitionCreateSchema = z
  .object({
    id: ID,
    purpose: z.enum(RECOGNITION_PURPOSES),
    lang: z.enum(RECOGNITION_LANGS).default('mixed'),
    annotation_ids: z.array(ID).max(2000).default([]),
    anchor: z.discriminatedUnion('type', [pageAnchorSchema, notePageAnchorSchema]).nullish(),
    bbox: boxSchema.nullish(),
    question_id: ID.nullish(),
    /**
     * pad strokes: [[x, y, t?, p?], …] per stroke (normalized to the pad). Arabic handwriting is many short strokes
     * (dots, hamza, letter groups): a long essay easily passes 500, so the bound is generous (the body limit caps size).
     */
    strokes: z.array(z.array(z.array(finite).min(2).max(4)).min(1).max(5000)).max(4000, 'الإجابة المكتوبة بخط اليد أطول من الحد المسموح؛ قسّمها أو اكتب جزءًا منها بلوحة المفاتيح.').nullish(),
    image_png_base64: z.string().min(16, 'صورة الكتابة مفقودة.').max(MAX_B64, 'صورة الكتابة أكبر من الحد المسموح.'),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.purpose === 'page_ink') {
      if (!v.anchor) c.addIssue({ code: 'custom', path: ['anchor'], message: 'حدّد الصفحة التي كُتب عليها.' });
      if (v.annotation_ids.length === 0) c.addIssue({ code: 'custom', path: ['annotation_ids'], message: 'اختر الكتابة المراد قراءتها بأداة التحديد الحر.' });
    } else {
      if (!v.question_id) c.addIssue({ code: 'custom', path: ['question_id'], message: 'حدّد السؤال الذي تجيب عنه.' });
      if (!v.strokes || v.strokes.length === 0) c.addIssue({ code: 'custom', path: ['strokes'], message: 'اكتب إجابتك بخط يدك أولًا.' });
    }
  });
export type RecognitionCreateInput = z.output<typeof recognitionCreateSchema>;

export const recognitionCorrectSchema = z.object({ corrected_text: z.string().max(RECOGNITION_MAX_TEXT, 'النص أطول من الحد المسموح.').nullable() }).strict();

export const recognitionListQuery = z
  .object({ page_id: ID.optional(), note_page_id: ID.optional(), source_id: ID.optional(), question_id: ID.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) })
  .refine((q) => !!(q.page_id || q.note_page_id || q.source_id || q.question_id), { message: 'حدّد الصفحة أو المصدر أو السؤال.' });

export const askContextSchema = z
  .object({
    anchor: pageAnchorSchema,
    bbox: boxSchema,
    recognition_id: ID.nullish(),
    typed_text: z.string().trim().max(2000).nullish(),
  })
  .strict();

// ───────── model output contract ─────────
const wordSchema = z.object({
  text: z.string().trim().min(1).max(200),
  uncertain: z.boolean(),
  alternatives: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
});
export const recognitionOutputSchema = z.object({
  status: z.enum(['recognized', 'unreadable']),
  language: z.enum(['ar', 'en', 'mixed']).nullable(),
  lines: z.array(z.object({ words: z.array(wordSchema).max(200) })).max(300),
  /** why the reader abstained (unreadable / not handwriting) */
  reason: z.string().max(500).nullable().optional(),
});
type RecognitionOutput = z.infer<typeof recognitionOutputSchema>;

const LANG_INSTRUCTION: Record<RecognitionLang, string> = {
  ar: 'The writing is expected to be in Arabic (Arabic script, right-to-left). Medical terms may still appear in Latin script.',
  en: 'The writing is expected to be in English (Latin script).',
  mixed: 'The writing may mix Arabic (right-to-left) and English medical terms, abbreviations, numbers and units.',
};

export const RECOGNITION_SYSTEM = [
  'You transcribe a picture of a medical student\'s own handwriting (pen strokes drawn black on white). This is transcription only.',
  'Rules:',
  '- Write exactly what is written, word by word, in reading order, one entry per written line. Keep Arabic words in Arabic script and Latin words (drug names, abbreviations, units) in Latin script, as written.',
  '- Never correct, complete, translate, expand abbreviations, or add any word that is not written. Do not explain or add medical content.',
  '- Mark a word "uncertain": true whenever you are not sure of it; give up to 3 alternative readings for it when helpful.',
  '- Drawings, arrows, underlines and circles are not words: ignore them.',
  '- If nothing in the picture can be read as writing, return status "unreadable", empty lines and a short reason in Arabic.',
  'Return ONLY the JSON object required.',
].join('\n');

/** The scope of a recognition call: the picture only — no library source is sent, so no version is in scope. */
export function emptyScope(): ResolvedScope {
  return { mode: 'lecture_only', sourceIds: [], versionIds: [], versionBySource: {}, allowExternal: false, includeMyNotes: false, hash: 'handwriting-only', describeAr: 'صورة الكتابة المحددة فقط (لا مصادر)' };
}

// ───────── rows & views ─────────
export interface RecognitionRow {
  id: string;
  annotation_ids_json: string;
  lang: string | null;
  text: string;
  confidence: number | null;
  engine: string;
  corrected_text: string | null;
  created_at: number;
  updated_at: number;
  purpose: RecognitionPurpose;
  status: RecognitionStatus;
  lang_requested: RecognitionLang;
  lines_json: string | null;
  uncertain_count: number;
  target_key: string | null;
  anchor_json: string | null;
  source_id: string | null;
  version_id: string | null;
  page_id: string | null;
  note_page_id: string | null;
  question_id: string | null;
  bbox_json: string | null;
  strokes_json: string | null;
  image_w: number | null;
  image_h: number | null;
  job_id: string | null;
  error_json: string | null;
  corrected_at: number | null;
  deleted_at: number | null;
}

/** every column except the picture (read only by the job and the image route) */
const COLS = `id, annotation_ids_json, lang, text, confidence, engine, corrected_text, created_at, updated_at, purpose, status, lang_requested,
  lines_json, uncertain_count, target_key, anchor_json, source_id, version_id, page_id, note_page_id, question_id, bbox_json, strokes_json,
  image_w, image_h, job_id, error_json, corrected_at, deleted_at`;

export function getRecognitionRow(ctx: AppContext, id: string, opts: { includeDeleted?: boolean } = {}): RecognitionRow {
  const r = ctx.db.get<RecognitionRow>(`SELECT ${COLS} FROM ink_recognition WHERE id = ?`, [id]);
  if (!r || (r.deleted_at !== null && !opts.includeDeleted)) throw new AppError('NOT_FOUND', 'قراءة الكتابة المطلوبة غير موجودة.', 404);
  return r;
}

export function effectiveText(r: Pick<RecognitionRow, 'text' | 'corrected_text'>): string {
  return r.corrected_text ?? r.text;
}

function isLang(v: string | null): v is RecognitionLang {
  return v === 'ar' || v === 'en' || v === 'mixed';
}

export function recognitionView(ctx: AppContext, r: RecognitionRow): InkRecognitionView {
  const corrected = r.corrected_text !== null;
  const page = r.page_id
    ? ctx.db.get<{ page_index: number; printed_label: string | null; kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment' }>(
        'SELECT page_index, printed_label, kind FROM source_page WHERE id = ?',
        [r.page_id],
      )
    : undefined;
  const hasAnchor = !!(r.page_id || r.note_page_id || r.source_id);
  return {
    id: r.id,
    purpose: r.purpose,
    status: r.status,
    status_label_ar: RECOGNITION_STATUS_LABELS_AR[r.status],
    lang_requested: r.lang_requested,
    lang_detected: isLang(r.lang) ? r.lang : null,
    recognized_text: r.text,
    lines: fromJson<RecognizedLine[]>(r.lines_json, []) ?? [],
    uncertain_count: r.uncertain_count,
    corrected_text: r.corrected_text,
    corrected_at: r.corrected_at,
    effective_text: effectiveText(r),
    origin: corrected ? 'owner_corrected' : 'recognized',
    origin_label_ar: corrected ? CORRECTED_LABEL_AR : RECOGNIZED_LABEL_AR,
    annotation_ids: fromJson<string[]>(r.annotation_ids_json, []) ?? [],
    anchor: hasAnchor
      ? {
          source_id: r.source_id,
          version_id: r.version_id,
          page_id: r.page_id,
          page_index: page?.page_index ?? null,
          page_label_ar: page ? pageDisplayLabel(page) : null,
          note_page_id: r.note_page_id,
        }
      : null,
    bbox: fromJson<NormBox>(r.bbox_json),
    question_id: r.question_id,
    engine: r.engine === 'pending' ? null : r.engine,
    job_id: r.job_id,
    error_ar: fromJson<{ message_ar?: string }>(r.error_json, {})?.message_ar ?? null,
    image_url: `/api/annotations/recognitions/${encodeURIComponent(r.id)}/image`,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ───────── search index ─────────
/** Keep owner_content_fts in step with the displayed text (normalized key only; page / note-page readings only). */
export function indexRecognition(ctx: AppContext, r: RecognitionRow): void {
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'ink_recognition' AND entity_id = ?`, [r.id]);
  if (r.deleted_at !== null || r.purpose !== 'page_ink') return;
  if (r.status !== 'recognized' && r.corrected_text === null) return;
  const key = normalizeForSearch(effectiveText(r));
  if (!key.trim()) return;
  ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('ink_recognition', ?, ?, ?)`, [
    r.id,
    r.corrected_text !== null ? 'owner' : 'recognized',
    key,
  ]);
}

// ───────── PNG validation ─────────
/** Decode + check the picture: real PNG (magic + IHDR), sensible size. Throws a specific Arabic reason. */
export function decodeRecognitionPng(b64: string): { bytes: Buffer; width: number; height: number } {
  const clean = b64.replace(/^data:image\/png;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new AppError('VALIDATION_FAILED', 'صورة الكتابة ليست بصيغة صالحة (base64).', 400);
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length > RECOGNITION_IMAGE_MAX_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 'صورة الكتابة أكبر من الحد المسموح (3 ميغابايت).', 413);
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString('latin1', 12, 16) === 'IHDR';
  if (!png) throw new AppError('UNSUPPORTED_FORMAT', 'صورة الكتابة يجب أن تكون PNG.', 415);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < RECOGNITION_IMAGE_MIN_SIDE || height < RECOGNITION_IMAGE_MIN_SIDE || width > RECOGNITION_IMAGE_MAX_SIDE || height > RECOGNITION_IMAGE_MAX_SIDE) {
    throw new AppError('VALIDATION_FAILED', `أبعاد صورة الكتابة غير مقبولة (بين ${RECOGNITION_IMAGE_MIN_SIDE} و${RECOGNITION_IMAGE_MAX_SIDE} بكسل لكل ضلع).`, 400);
  }
  return { bytes, width, height };
}

// ───────── create ─────────
function assertRecognitionAvailable(ctx: AppContext): void {
  const cap = ctx.capabilities.get('workspace.handwriting_recognition');
  if (cap.state !== 'available') {
    throw new AppError('AI_NOT_CONFIGURED', cap.reason_ar ?? 'قراءة الخط اليدوي غير متاحة الآن.', 409, { feature: 'workspace.handwriting_recognition', state: cap.state });
  }
}

export function createRecognition(ctx: AppContext, body: unknown): { view: InkRecognitionView; created: boolean } {
  const input = parseWith(recognitionCreateSchema, body, 'body');
  // a retried request (lost response) returns what was stored — never a second reading of the same request
  const existing = ctx.db.get<RecognitionRow>(`SELECT ${COLS} FROM ink_recognition WHERE id = ?`, [input.id]);
  if (existing) {
    if (existing.purpose !== input.purpose) throw new AppError('CONFLICT', 'هذا المعرّف مستخدم لقراءة أخرى.', 409);
    return { view: recognitionView(ctx, existing), created: false };
  }
  assertRecognitionAvailable(ctx);
  const png = decodeRecognitionPng(input.image_png_base64);

  let sourceId: string | null = null;
  let versionId: string | null = null;
  let pageId: string | null = null;
  let notePageId: string | null = null;
  let anchor: AnnotationAnchor | null = null;
  if (input.purpose === 'page_ink') {
    const a = input.anchor!;
    if (a.type === 'page') {
      const ok = ctx.db.get<{ source_id: string; deleted_at: number | null }>(
        `SELECT v.source_id, s.deleted_at FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id WHERE p.id = ? AND p.version_id = ?`,
        [a.page_id, a.version_id],
      );
      if (!ok || ok.source_id !== a.source_id) throw new AppError('NOT_FOUND', 'الصفحة التي كُتب عليها غير موجودة في هذه النسخة من المصدر.', 404);
      if (ok.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات.', 409);
      sourceId = a.source_id;
      versionId = a.version_id;
      pageId = a.page_id;
      anchor = { ...a, space: 'page_norm' };
    } else {
      const np = ctx.db.get<{ source_id: string | null; deleted_at: number | null }>('SELECT source_id, deleted_at FROM note_page WHERE id = ?', [a.note_page_id]);
      if (!np) {
        throw new AppError('CONFLICT', 'صفحة الملاحظات هذه لم تصل إلى الخادم بعد. انتظر حتى تتم المزامنة ثم أعد المحاولة؛ كتابتك محفوظة على جهازك.', 409);
      }
      if (np.deleted_at !== null) throw new AppError('CONFLICT', 'صفحة الملاحظات هذه في سلة المحذوفات.', 409);
      notePageId = a.note_page_id;
      sourceId = np.source_id;
      anchor = { ...a, space: 'page_norm' };
    }
  } else {
    const q = ctx.db.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM question WHERE id = ?', [input.question_id!]);
    if (!q || q.deleted_at !== null) throw new AppError('NOT_FOUND', 'السؤال غير موجود.', 404);
  }

  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO ink_recognition (id, annotation_ids_json, lang, text, confidence, engine, corrected_text, created_at, updated_at, purpose, status,
         lang_requested, lines_json, uncertain_count, target_key, anchor_json, source_id, version_id, page_id, note_page_id, question_id, bbox_json,
         strokes_json, image_png, image_w, image_h, job_id, error_json, corrected_at, deleted_at)
       VALUES (?, ?, NULL, '', NULL, 'pending', NULL, ?, ?, ?, 'queued', ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      [
        input.id,
        toJson([...new Set(input.annotation_ids)]),
        now,
        now,
        input.purpose,
        input.lang,
        anchor ? annotationTargetKey(anchor) : null,
        anchor ? toJson(anchor) : null,
        sourceId,
        versionId,
        pageId,
        notePageId,
        input.question_id ?? null,
        input.bbox ? toJson(input.bbox) : null,
        input.strokes ? toJson(input.strokes) : null,
        new Uint8Array(png.bytes),
        png.width,
        png.height,
      ],
    );
    const job = ctx.jobs.enqueue(INK_RECOGNIZE_JOB, { recognition_id: input.id }, { idempotencyKey: `inkrec:${input.id}` });
    ctx.db.run('UPDATE ink_recognition SET job_id = ? WHERE id = ?', [job.id, input.id]);
  });
  return { view: recognitionView(ctx, getRecognitionRow(ctx, input.id)), created: true };
}

// ───────── job ─────────
function setFailed(ctx: AppContext, id: string, code: string, messageAr: string): void {
  ctx.db.run(`UPDATE ink_recognition SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?`, [toJson({ code, message_ar: messageAr }), ctx.clock.now(), id]);
}

/** Words cleaned of blanks; lines without words dropped; text = words joined by spaces, lines by newlines. */
export function normalizeOutput(out: RecognitionOutput): { lines: RecognizedLine[]; text: string; uncertain: number } {
  const lines: RecognizedLine[] = [];
  let uncertain = 0;
  for (const l of out.lines) {
    const words = l.words
      .map((w) => ({ text: w.text.replace(/\s+/g, ' ').trim(), uncertain: w.uncertain, ...(w.alternatives?.length ? { alternatives: w.alternatives.slice(0, 3) } : {}) }))
      .filter((w) => w.text.length > 0);
    if (words.length === 0) continue;
    uncertain += words.filter((w) => w.uncertain).length;
    lines.push({ words });
  }
  const text = lines
    .map((l) => l.words.map((w) => w.text).join(' '))
    .join('\n')
    .slice(0, RECOGNITION_MAX_TEXT);
  return { lines, text, uncertain };
}

async function runRecognition(ctx: AppContext, job: JobRun<{ recognition_id: string }>): Promise<{ status: RecognitionStatus }> {
  const id = job.input.recognition_id;
  const row = ctx.db.get<RecognitionRow & { image_png: Uint8Array | null }>(`SELECT ${COLS}, image_png FROM ink_recognition WHERE id = ?`, [id]);
  if (!row) throw new JobError('NOT_FOUND', 'قراءة الكتابة غير موجودة.', { retryable: false });
  if (row.deleted_at !== null) return { status: row.status };
  if (row.status === 'recognized' || row.status === 'unreadable') return { status: row.status };
  if (!row.image_png || row.image_png.length === 0) {
    setFailed(ctx, id, 'NO_IMAGE', 'لم تُحفظ صورة الكتابة، فلا يمكن قراءتها. أعد التحديد ثم «تحويل إلى نص».');
    return { status: 'failed' };
  }
  ctx.db.run(`UPDATE ink_recognition SET status = 'running', error_json = NULL, updated_at = ? WHERE id = ?`, [ctx.clock.now(), id]);
  job.progress({ stage: 'قراءة الكتابة' });
  const res = await ctx.ai.generateStructured({
    task: 'ink_recognize',
    schema: recognitionOutputSchema,
    system: RECOGNITION_SYSTEM,
    input: [{ label: 'handwriting picture (attached image)', text: 'The attached picture shows the handwriting to transcribe.' }],
    instruction: [LANG_INSTRUCTION[row.lang_requested], 'Transcribe the handwriting in the attached picture.'].join('\n'),
    images: [{ mime: 'image/png', data: row.image_png }],
    scope: emptyScope(),
    sourceVersionIds: [],
    jobId: job.id,
    signal: job.signal,
    maxOutputTokens: 4000,
    rulesVersion: RECOGNIZER_VERSION,
    timeoutMs: 120_000,
  });
  const n = normalizeOutput(res.output);
  const now = ctx.clock.now();
  const recognized = res.output.status === 'recognized' && n.text.trim().length > 0;
  const status: RecognitionStatus = recognized ? 'recognized' : 'unreadable';
  const reason = recognized
    ? null
    : res.output.status === 'recognized'
      ? 'لم يجد القارئ كلمات مقروءة في التحديد.'
      : `تعذّرت قراءة الكتابة${res.output.reason ? `: ${res.output.reason.slice(0, 300)}` : '.'}`;
  ctx.db.tx(() => {
    ctx.db.run(
      `UPDATE ink_recognition SET status = ?, text = ?, lines_json = ?, uncertain_count = ?, lang = ?, engine = ?, error_json = ?, updated_at = ? WHERE id = ?`,
      [status, recognized ? n.text : '', toJson(recognized ? n.lines : []), recognized ? n.uncertain : 0, res.output.language, res.model, reason ? toJson({ code: 'UNREADABLE', message_ar: reason }) : null, now, id],
    );
    indexRecognition(ctx, getRecognitionRow(ctx, id, { includeDeleted: true }));
  });
  return { status };
}

export function registerRecognitionJob(ctx: AppContext): void {
  ctx.jobs.register<{ recognition_id: string }, { status: RecognitionStatus }>(INK_RECOGNIZE_JOB, {
    version: RECOGNIZER_VERSION,
    maxAttempts: 2,
    timeoutMs: 5 * 60 * 1000,
    concurrency: 2,
    inputSchema: z.object({ recognition_id: ID }).strict(),
    handler: async (job) => {
      try {
        return await runRecognition(ctx, job);
      } catch (e) {
        const retryable = isAppError(e) && e.code === 'AI_PROVIDER_ERROR' && (e.details as { retryable?: boolean } | undefined)?.retryable === true && job.attempt < 2;
        const code = isAppError(e) ? e.code : e instanceof JobError ? e.code : 'INTERNAL';
        const messageAr = isAppError(e) ? e.messageAr : e instanceof JobError ? e.messageAr : 'حدث خطأ غير متوقع أثناء قراءة الكتابة.';
        if (!retryable) setFailed(ctx, job.input.recognition_id, code, messageAr);
        if (e instanceof JobError) throw e;
        throw new JobError(code, messageAr, { retryable });
      }
    },
  });
}

// ───────── owner actions ─────────
export function correctRecognition(ctx: AppContext, id: string, body: unknown): InkRecognitionView {
  const input = parseWith(recognitionCorrectSchema, body, 'body');
  const r = getRecognitionRow(ctx, id);
  if (r.status !== 'recognized' && r.status !== 'unreadable') {
    throw new AppError('CONFLICT', 'لا يمكن تصحيح القراءة قبل أن تكتمل.', 409, { status: r.status });
  }
  const text = input.corrected_text === null ? null : input.corrected_text.replace(/\r\n/g, '\n').trim() || null;
  // a «correction» identical to the machine reading is no correction (the origin stays «مقروء آليًا»)
  const corrected = text !== null && text === r.text ? null : text;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE ink_recognition SET corrected_text = ?, corrected_at = ?, updated_at = ? WHERE id = ?', [corrected, corrected === null ? null : now, now, id]);
    indexRecognition(ctx, getRecognitionRow(ctx, id));
    ctx.audit.record({
      entityType: 'ink_recognition',
      entityId: id,
      action: corrected === null ? 'correction_reverted' : 'corrected',
      summary: corrected === null ? 'إرجاع قراءة الخط إلى القراءة الآلية' : 'تصحيح قراءة الخط اليدوي',
      before: { corrected_text: r.corrected_text },
      after: { corrected_text: corrected },
      actor: 'owner',
    });
  });
  return recognitionView(ctx, getRecognitionRow(ctx, id));
}

export function retryRecognition(ctx: AppContext, id: string): InkRecognitionView {
  const r = getRecognitionRow(ctx, id);
  if (r.status !== 'failed' && r.status !== 'unreadable') throw new AppError('CONFLICT', 'تُعاد القراءة بعد فشلها أو تعذّرها فقط.', 409, { status: r.status });
  assertRecognitionAvailable(ctx);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const job = ctx.jobs.enqueue(INK_RECOGNIZE_JOB, { recognition_id: id }, { idempotencyKey: `inkrec:${id}:retry:${now}` });
    ctx.db.run(`UPDATE ink_recognition SET status = 'queued', error_json = NULL, job_id = ?, updated_at = ? WHERE id = ?`, [job.id, now, id]);
  });
  return recognitionView(ctx, getRecognitionRow(ctx, id));
}

/** Removes the DERIVED reading only (soft delete); the strokes stay exactly as written. */
export function deleteRecognition(ctx: AppContext, id: string): void {
  const r = getRecognitionRow(ctx, id);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE ink_recognition SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id]);
    ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'ink_recognition' AND entity_id = ?`, [id]);
    ctx.audit.record({ entityType: 'ink_recognition', entityId: id, action: 'delete', summary: 'حذف قراءة الخط (الكتابة نفسها باقية)', before: { text: effectiveText(r).slice(0, 200) }, actor: 'owner' });
  });
}

export function listRecognitions(ctx: AppContext, q: z.output<typeof recognitionListQuery>): InkRecognitionView[] {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  for (const [col, v] of [
    ['page_id', q.page_id],
    ['note_page_id', q.note_page_id],
    ['source_id', q.source_id],
    ['question_id', q.question_id],
  ] as const) {
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const rows = ctx.db.all<RecognitionRow>(`SELECT ${COLS} FROM ink_recognition WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, q.limit]);
  return rows.map((r) => recognitionView(ctx, r));
}

export function recognitionImage(ctx: AppContext, id: string): Buffer {
  getRecognitionRow(ctx, id);
  const r = ctx.db.get<{ image_png: Uint8Array | null }>('SELECT image_png FROM ink_recognition WHERE id = ?', [id]);
  if (!r?.image_png) throw new AppError('NOT_FOUND', 'صورة الكتابة غير محفوظة.', 404);
  return Buffer.from(r.image_png);
}

/** Written answers: the reading of a pad, checked to belong to the question (used by the exams module). */
export function writtenAnswerRecognition(ctx: AppContext, id: string, questionId: string): RecognitionRow {
  const r = ctx.db.get<RecognitionRow>(`SELECT ${COLS} FROM ink_recognition WHERE id = ?`, [id]);
  if (!r || r.deleted_at !== null || r.purpose !== 'written_answer' || r.question_id !== questionId) {
    throw new AppError('VALIDATION_FAILED', 'قراءة خط اليد المرفقة لا تخص هذا السؤال.', 400);
  }
  if (r.status !== 'recognized' && r.corrected_text === null) throw new AppError('CONFLICT', 'لم تكتمل قراءة خط يدك بعد؛ انتظرها أو اكتب الإجابة بنفسك.', 409);
  return r;
}

// ───────── «اسأل عن المحدد»: the handwriting + the paragraph next to it ─────────
const PARAGRAPH_KINDS = new Set(['paragraph', 'text_block', 'list_item', 'heading', 'caption', 'table_cell', 'question', 'option', 'note']);
/** how far (page heights / widths) a paragraph may be from the writing to count as «next to» it */
const NEAR_V = 0.12;
const NEAR_H = 0.35;

interface RegionCandidate {
  id: string;
  kind: string;
  text: string;
  box: NormBox;
  reading_order: number;
}

/** The paragraph next to a selection box: overlap first, then same band (beside), then the nearest above / below. */
export function paragraphNear(regions: RegionCandidate[], b: NormBox): { region: RegionCandidate; relation: 'overlaps' | 'beside' | 'above' | 'below' } | null {
  let best: { region: RegionCandidate; relation: 'overlaps' | 'beside' | 'above' | 'below'; score: number } | null = null;
  const consider = (region: RegionCandidate, relation: 'overlaps' | 'beside' | 'above' | 'below', score: number) => {
    if (!best || score < best.score) best = { region, relation, score };
  };
  for (const r of regions) {
    const ox = Math.min(b.x + b.w, r.box.x + r.box.w) - Math.max(b.x, r.box.x);
    const oy = Math.min(b.y + b.h, r.box.y + r.box.h) - Math.max(b.y, r.box.y);
    // a heading is a weaker match than a body paragraph at the same distance
    const kindPenalty = r.kind === 'heading' ? 0.05 : 0;
    if (ox > 0 && oy > 0) {
      consider(r, 'overlaps', -(ox * oy) + kindPenalty);
      continue;
    }
    if (oy > 0) {
      const gap = ox <= 0 ? -ox : 0;
      if (gap <= NEAR_H) consider(r, 'beside', 1 + gap + kindPenalty);
      continue;
    }
    const above = r.box.y + r.box.h <= b.y;
    const gap = above ? b.y - (r.box.y + r.box.h) : r.box.y - (b.y + b.h);
    if (gap <= NEAR_V) consider(r, above ? 'above' : 'below', 2 + gap + kindPenalty + (ox > 0 ? 0 : 0.5));
  }
  const found = best as { region: RegionCandidate; relation: 'overlaps' | 'beside' | 'above' | 'below'; score: number } | null;
  return found ? { region: found.region, relation: found.relation } : null;
}

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function askContext(ctx: AppContext, body: unknown): AskContextResponse {
  const input = parseWith(askContextSchema, body, 'body');
  const a = input.anchor;
  const page = ctx.db.get<{ source_id: string; deleted_at: number | null }>(
    `SELECT v.source_id, s.deleted_at FROM source_page p JOIN source_version v ON v.id = p.version_id JOIN source s ON s.id = v.source_id WHERE p.id = ? AND p.version_id = ?`,
    [a.page_id, a.version_id],
  );
  if (!page || page.source_id !== a.source_id) throw new AppError('NOT_FOUND', 'الصفحة غير موجودة في هذه النسخة من المصدر.', 404);
  if (page.deleted_at !== null) throw new AppError('CONFLICT', 'هذا المصدر في سلة المحذوفات.', 409);

  const notes: string[] = [];
  let handwriting: AskContextResponse['handwriting'] = null;
  if (input.recognition_id) {
    const r = getRecognitionRow(ctx, input.recognition_id);
    if (r.purpose !== 'page_ink' || r.page_id !== a.page_id) throw new AppError('VALIDATION_FAILED', 'قراءة الكتابة المرفقة لا تخص هذه الصفحة.', 400);
    const text = effectiveText(r).trim();
    if (text) {
      handwriting = { text, origin: r.corrected_text !== null ? 'owner_corrected' : 'recognized', uncertain_count: r.corrected_text !== null ? 0 : r.uncertain_count };
      if (handwriting.uncertain_count > 0) notes.push(`في القراءة الآلية ${handwriting.uncertain_count === 1 ? 'كلمة غير مؤكدة' : `${handwriting.uncertain_count} كلمات غير مؤكدة`}؛ راجع السؤال قبل إرساله.`);
    }
  }
  if (!handwriting && input.typed_text) handwriting = { text: input.typed_text, origin: 'owner_typed', uncertain_count: 0 };

  const regions = ctx.db
    .all<{ id: string; kind: string; text: string | null; bbox_json: string | null; reading_order: number }>(
      `SELECT id, kind, text, bbox_json, reading_order FROM source_region WHERE page_id = ? AND version_id = ? AND status <> 'rejected' AND text IS NOT NULL AND bbox_json IS NOT NULL`,
      [a.page_id, a.version_id],
    )
    .flatMap((r): RegionCandidate[] => {
      const box = fromJson<NormBox>(r.bbox_json);
      const text = (r.text ?? '').trim();
      if (!box || !text || !PARAGRAPH_KINDS.has(r.kind)) return [];
      return [{ id: r.id, kind: r.kind, text, box, reading_order: r.reading_order }];
    });
  const near = paragraphNear(regions, input.bbox);
  const paragraph = near ? { region_id: near.region.id, text: near.region.text, relation: near.relation } : null;
  if (!paragraph) notes.push('لا توجد فقرة نصية مقروءة قرب الكتابة على هذه الصفحة؛ رُبط السؤال بالصفحة كلها.');

  const hw = handwriting ? `«${shorten(handwriting.text, 400)}»` : '«…»';
  if (!handwriting) notes.push('لم تُقرأ الكتابة آليًا: اكتب ما كتبته بخط يدك مكان النقاط قبل الإرسال.');
  const question_ar = paragraph
    ? `كتبتُ بخط يدي ${hw} بجانب هذه الفقرة:\n«${shorten(paragraph.text, 900)}»\nأجبني عمّا كتبتُه اعتمادًا على هذه الفقرة ومصادر المحاضرة.`
    : `كتبتُ بخط يدي ${hw} على هذه الصفحة. أجبني عمّا كتبتُه اعتمادًا على هذه الصفحة ومصادر المحاضرة.`;
  notes.push('لا يُرسل شيء تلقائيًا: راجع السؤال وعدّله ثم أرسله بنفسك.');
  return {
    handwriting,
    paragraph,
    anchor: {
      source_id: a.source_id,
      version_id: a.version_id,
      page_id: a.page_id,
      region_ids: paragraph ? [paragraph.region_id] : [],
      quote: paragraph ? { exact: paragraph.text.slice(0, 2000) } : null,
    },
    question_ar,
    notes_ar: notes,
  };
}
