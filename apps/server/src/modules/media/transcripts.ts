// Transcript segments (§29): manual entry, corrections with history, subtitle import, search indexing.
//
//  * `text` is the ORIGINAL (typed / imported / recognized) and is never overwritten; a correction goes to
//    corrected_text; every change appends a transcript_revision (create, correct, clear_correction, retime, delete,
//    restore, replaced_by_import). Deletion is a tombstone. Edits carry base_rev (a concurrent edit is refused).
//  * Search: owner_content_fts row (entity 'transcript_segment') holding the NORMALIZED search key of the displayed
//    text (corrected ?? original) — the contract the universal search reads; removed when the segment is deleted.
//  * Import never discards the owner's work: replacing a previous import tombstones only its UNCORRECTED segments
//    (corrected and manual segments are kept and counted).
import {
  TRANSCRIPT_ORIGIN_LABELS_AR,
  normalizeForSearch,
  segmentCreateSchema,
  segmentPatchSchema,
  transcriptImportSchema,
  type SegmentRevisionView,
  type TranscriptImportResponse,
  type TranscriptOrigin,
  type TranscriptResponse,
  type TranscriptSegmentView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { audioView, getAudioRow } from './audio';
import { linksFrom } from './links';
import { parseSubtitles, SubtitleError } from './subtitles';

export interface SegmentRow {
  id: string;
  audio_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  corrected_text: string | null;
  confidence: number | null;
  engine: string | null;
  created_at: number;
  origin: TranscriptOrigin;
  speaker: string | null;
  rev: number;
  updated_at: number | null;
  deleted_at: number | null;
  import_id: string | null;
}

const ACTION_AR: Record<SegmentRevisionView['action'], string> = {
  create: 'إنشاء',
  correct: 'تصحيح النص',
  clear_correction: 'إلغاء التصحيح (العودة إلى النص الأصلي)',
  retime: 'تعديل التوقيت',
  delete: 'حذف',
  restore: 'استعادة',
  replaced_by_import: 'استُبدل باستيراد أحدث (لم يكن مصحَّحًا)',
};

const FTS_ORIGIN: Record<TranscriptOrigin, string> = { manual: 'owner', imported_vtt: 'imported', imported_srt: 'imported', transcription: 'recognized' };

export function getSegmentRow(ctx: AppContext, id: string): SegmentRow {
  const s = ctx.db.get<SegmentRow>('SELECT * FROM transcript_segment WHERE id = ?', [id]);
  if (!s) throw new AppError('NOT_FOUND', 'مقطع التفريغ غير موجود.', 404);
  getAudioRow(ctx, s.audio_id); // the recording must still be available
  return s;
}

function displayText(s: Pick<SegmentRow, 'text' | 'corrected_text'>): string {
  return s.corrected_text ?? s.text;
}

/** Keep the search index in step with the displayed text (normalized key only). */
export function indexSegment(ctx: AppContext, s: SegmentRow): void {
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'transcript_segment' AND entity_id = ?`, [s.id]);
  if (s.deleted_at !== null) return;
  const key = normalizeForSearch(displayText(s));
  if (!key.trim()) return;
  ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('transcript_segment', ?, ?, ?)`, [s.id, FTS_ORIGIN[s.origin], key]);
}

function revision(ctx: AppContext, s: SegmentRow, action: SegmentRevisionView['action'], now: number): void {
  ctx.db.run(
    `INSERT INTO transcript_revision (id, segment_id, rev, action, text, corrected_text, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(now), s.id, s.rev, action, s.text, s.corrected_text, s.start_ms, s.end_ms, now],
  );
}

export function segmentView(ctx: AppContext, s: SegmentRow): TranscriptSegmentView {
  const revisions = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_revision WHERE segment_id = ?', [s.id])?.n ?? 0;
  return {
    id: s.id,
    audio_id: s.audio_id,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    text: s.text,
    corrected_text: s.corrected_text,
    display_text: displayText(s),
    origin: s.origin,
    origin_label_ar: TRANSCRIPT_ORIGIN_LABELS_AR[s.origin],
    speaker: s.speaker,
    confidence: s.confidence,
    rev: s.rev,
    revisions,
    links: linksFrom(ctx, 'transcript_segment', s.id),
    deleted: s.deleted_at !== null,
    created_at: s.created_at,
    updated_at: s.updated_at ?? s.created_at,
  };
}

export function transcript(ctx: AppContext, audioId: string, opts: { includeDeleted?: boolean } = {}): TranscriptResponse {
  const a = getAudioRow(ctx, audioId);
  const rows = ctx.db.all<SegmentRow>(
    `SELECT * FROM transcript_segment WHERE audio_id = ? ${opts.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY start_ms, created_at, id`,
    [a.id],
  );
  const imports = ctx.db
    .all<{ id: string; format: 'vtt' | 'srt'; file_name: string | null; created_count: number; skipped_json: string; created_at: number }>(
      'SELECT id, format, file_name, created_count, skipped_json, created_at FROM transcript_import WHERE audio_id = ? ORDER BY created_at DESC',
      [a.id],
    )
    .map((i) => ({ id: i.id, format: i.format, file_name: i.file_name, created: i.created_count, skipped: (fromJson<unknown[]>(i.skipped_json, []) ?? []).length, created_at: i.created_at }));
  const notes: string[] = ['التفريغ الآلي غير متاح (لا يوجد مزود تفريغ مضبوط)؛ النص هنا كتبته أنت أو استوردته من ملف ترجمة.'];
  if (rows.some((r) => r.origin !== 'manual')) notes.push('النص المستورد يبقى كما ورد في الملف؛ تصحيحاتك تُحفظ بجانبه مع سجلها، ولا يُخمَّن المتحدث أو كلمة غير مسموعة.');
  return { audio: audioView(ctx, a), segments: rows.map((r) => segmentView(ctx, r)), imports, notes_ar: notes };
}

function checkBounds(ctx: AppContext, audioId: string, start: number, end: number): void {
  if (end <= start) throw new AppError('VALIDATION_FAILED', 'نهاية المقطع يجب أن تكون بعد بدايته.', 400, { where: 'body', issues: [{ path: 'end_ms', code: 'custom', message: 'نهاية المقطع يجب أن تكون بعد بدايته.' }] });
  const a = getAudioRow(ctx, audioId);
  if (a.duration_ms !== null && start >= a.duration_ms + 1000) {
    throw new AppError('VALIDATION_FAILED', 'بداية المقطع بعد نهاية التسجيل.', 400, { where: 'body', issues: [{ path: 'start_ms', code: 'custom', message: 'بداية المقطع بعد نهاية التسجيل.' }] });
  }
}

export function createSegment(ctx: AppContext, audioId: string, body: unknown): TranscriptSegmentView {
  const req = parseWith(segmentCreateSchema, body, 'body');
  const a = getAudioRow(ctx, audioId);
  checkBounds(ctx, a.id, req.start_ms, req.end_ms);
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO transcript_segment (id, audio_id, start_ms, end_ms, text, corrected_text, confidence, engine, created_at, origin, speaker, rev, updated_at, deleted_at, import_id)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'manual', NULL, 1, ?, NULL, NULL)`,
      [id, a.id, req.start_ms, req.end_ms, req.text, now, now],
    );
    const s = getSegmentRow(ctx, id);
    revision(ctx, s, 'create', now);
    indexSegment(ctx, s);
  });
  return segmentView(ctx, getSegmentRow(ctx, id));
}

function staleEdit(current: number): never {
  throw new AppError('CONFLICT', 'عُدّل هذا المقطع في مكان آخر؛ حدّث الصفحة ثم أعد التعديل. لم يُحفظ شيء.', 409, { current_rev: current });
}

export function patchSegment(ctx: AppContext, id: string, body: unknown): TranscriptSegmentView {
  const req = parseWith(segmentPatchSchema, body, 'body');
  const s = getSegmentRow(ctx, id);
  if (s.deleted_at !== null) throw new AppError('CONFLICT', 'المقطع محذوف؛ استعده أولًا.', 409);
  if (req.base_rev !== s.rev) staleEdit(s.rev);
  const start = req.start_ms ?? s.start_ms;
  const end = req.end_ms ?? s.end_ms;
  const retimed = start !== s.start_ms || end !== s.end_ms;
  if (retimed) checkBounds(ctx, s.audio_id, start, end);
  const corrected = req.corrected_text === undefined ? s.corrected_text : req.corrected_text;
  // a «correction» identical to the original text is not a correction
  const nextCorrected = corrected !== null && corrected.trim() === s.text.trim() ? null : corrected;
  const textChanged = nextCorrected !== s.corrected_text;
  if (!retimed && !textChanged) return segmentView(ctx, s);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const cur = getSegmentRow(ctx, id);
    if (cur.rev !== req.base_rev) staleEdit(cur.rev);
    ctx.db.run('UPDATE transcript_segment SET start_ms = ?, end_ms = ?, corrected_text = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [start, end, nextCorrected, now, id]);
    const next = getSegmentRow(ctx, id);
    if (textChanged) revision(ctx, next, nextCorrected === null ? 'clear_correction' : 'correct', now);
    if (retimed) revision(ctx, next, 'retime', now);
    indexSegment(ctx, next);
  });
  return segmentView(ctx, getSegmentRow(ctx, id));
}

export function deleteSegment(ctx: AppContext, id: string, baseRev: number | null): TranscriptSegmentView {
  const s = getSegmentRow(ctx, id);
  if (s.deleted_at !== null) return segmentView(ctx, s);
  if (baseRev !== null && baseRev !== s.rev) staleEdit(s.rev);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE transcript_segment SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, id]);
    const next = getSegmentRow(ctx, id);
    revision(ctx, next, 'delete', now);
    indexSegment(ctx, next);
  });
  return segmentView(ctx, getSegmentRow(ctx, id));
}

export function restoreSegment(ctx: AppContext, id: string): TranscriptSegmentView {
  const s = getSegmentRow(ctx, id);
  if (s.deleted_at === null) return segmentView(ctx, s);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE transcript_segment SET deleted_at = NULL, rev = rev + 1, updated_at = ? WHERE id = ?', [now, id]);
    const next = getSegmentRow(ctx, id);
    revision(ctx, next, 'restore', now);
    indexSegment(ctx, next);
  });
  return segmentView(ctx, getSegmentRow(ctx, id));
}

export function segmentRevisions(ctx: AppContext, id: string): SegmentRevisionView[] {
  getSegmentRow(ctx, id);
  return ctx.db
    .all<{ rev: number; action: SegmentRevisionView['action']; text: string; corrected_text: string | null; start_ms: number; end_ms: number; created_at: number }>(
      'SELECT rev, action, text, corrected_text, start_ms, end_ms, created_at FROM transcript_revision WHERE segment_id = ? ORDER BY created_at, rev',
      [id],
    )
    .map((r) => ({ rev: r.rev, action: r.action, action_label_ar: ACTION_AR[r.action], text: r.text, corrected_text: r.corrected_text, start_ms: r.start_ms, end_ms: r.end_ms, at: r.created_at }));
}

export function importSubtitles(ctx: AppContext, audioId: string, body: unknown): TranscriptImportResponse {
  const req = parseWith(transcriptImportSchema, body, 'body');
  const a = getAudioRow(ctx, audioId);
  let parsed;
  try {
    parsed = parseSubtitles(req.text, req.format);
  } catch (e) {
    if (e instanceof SubtitleError) throw new AppError('UNSUPPORTED_FORMAT', e.message_ar, 415);
    throw e;
  }
  if (parsed.cues.length === 0) {
    throw new AppError('VALIDATION_FAILED', `لم يُعثر في الملف على أي مقطع صالح (${parsed.skipped.length} مقطعًا غير صالح).`, 400, { skipped: parsed.skipped.slice(0, 50) });
  }
  const origin: TranscriptOrigin = parsed.format === 'vtt' ? 'imported_vtt' : 'imported_srt';
  const now = ctx.clock.now();
  const importId = newId(now);
  let replaced = 0;
  let keptCorrected = 0;
  ctx.db.tx(() => {
    if (req.replace_previous_import) {
      const previous = ctx.db.all<SegmentRow>(`SELECT * FROM transcript_segment WHERE audio_id = ? AND origin IN ('imported_vtt','imported_srt') AND deleted_at IS NULL`, [a.id]);
      for (const p of previous) {
        if (p.corrected_text !== null || linksFrom(ctx, 'transcript_segment', p.id).length > 0) {
          keptCorrected++;
          continue;
        }
        ctx.db.run('UPDATE transcript_segment SET deleted_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [now, now, p.id]);
        const next = getSegmentRow(ctx, p.id);
        revision(ctx, next, 'replaced_by_import', now);
        indexSegment(ctx, next);
        replaced++;
      }
    }
    ctx.db.run(
      `INSERT INTO transcript_import (id, audio_id, format, file_name, created_count, skipped_json, replaced_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [importId, a.id, parsed.format, req.file_name ?? null, parsed.cues.length, toJson(parsed.skipped.slice(0, 500)), replaced, now],
    );
    for (const c of parsed.cues) {
      const id = newId(now);
      ctx.db.run(
        `INSERT INTO transcript_segment (id, audio_id, start_ms, end_ms, text, corrected_text, confidence, engine, created_at, origin, speaker, rev, updated_at, deleted_at, import_id)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1, ?, NULL, ?)`,
        [id, a.id, c.start_ms, c.end_ms, c.text, parsed.format, now, origin, c.speaker, now, importId],
      );
      const s = getSegmentRow(ctx, id);
      revision(ctx, s, 'create', now);
      indexSegment(ctx, s);
    }
    ctx.audit.record({
      entityType: 'audio_asset',
      entityId: a.id,
      action: 'import',
      summary: `استيراد ${parsed.cues.length} مقطعًا من ملف ${parsed.format.toUpperCase()}${req.file_name ? ` «${req.file_name}»` : ''}`,
      after: { created: parsed.cues.length, skipped: parsed.skipped.length, replaced, kept_corrected: keptCorrected },
      actor: 'owner',
    });
  });
  return { import_id: importId, format: parsed.format, created: parsed.cues.length, skipped: parsed.skipped, replaced, kept_corrected: keptCorrected, transcript: transcript(ctx, a.id) };
}
