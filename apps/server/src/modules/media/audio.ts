// Lecture audio layer (§29): audio assets for the audio sources the owner uploaded (lecture_audio / my_audio_note —
// the sources module stores them; this module creates one audio_asset per audio version lazily), authenticated Range
// streaming through the files store, and the duration reported by the owner's player (the server does not decode).
import type { AudioAssetView, AudioListResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';

export interface AudioRow {
  id: string;
  source_id: string;
  file_id: string;
  duration_ms: number | null;
  created_at: number;
  version_id: string | null;
  mime: string | null;
  duration_origin: 'player' | null;
  updated_at: number | null;
}

/** One audio_asset per audio source version (idempotent; trashed sources are skipped). */
export function ensureAudioAssets(ctx: AppContext): void {
  const missing = ctx.db.all<{ version_id: string; source_id: string; file_id: string; mime: string }>(
    `SELECT v.id AS version_id, v.source_id, v.file_id, v.mime FROM source_version v JOIN source s ON s.id = v.source_id
      WHERE v.format = 'audio' AND v.file_id IS NOT NULL AND s.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM audio_asset a WHERE a.version_id = v.id)`,
  );
  if (missing.length === 0) return;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    for (const m of missing) {
      ctx.db.run(
        `INSERT INTO audio_asset (id, source_id, file_id, duration_ms, created_at, version_id, mime, duration_origin, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
        [newId(now), m.source_id, m.file_id, now, m.version_id, m.mime, now],
      );
    }
  });
}

export function getAudioRow(ctx: AppContext, id: string): AudioRow {
  const a = ctx.db.get<AudioRow>('SELECT * FROM audio_asset WHERE id = ?', [id]);
  const live = a ? ctx.db.get<{ x: number }>('SELECT 1 AS x FROM source WHERE id = ? AND deleted_at IS NULL', [a.source_id]) : null;
  if (!a || !live) throw new AppError('NOT_FOUND', 'التسجيل الصوتي غير موجود أو مصدره في سلة المحذوفات.', 404);
  return a;
}

export function audioView(ctx: AppContext, a: AudioRow): AudioAssetView {
  const s = ctx.db.get<{ title: string; source_type: string }>('SELECT title, source_type FROM source WHERE id = ?', [a.source_id]);
  const f = ctx.db.get<{ size: number; mime: string }>('SELECT size, mime FROM stored_file WHERE id = ?', [a.file_id]);
  const counts = ctx.db.get<{ n: number; c: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN corrected_text IS NOT NULL THEN 1 ELSE 0 END), 0) AS c FROM transcript_segment WHERE audio_id = ? AND deleted_at IS NULL`,
    [a.id],
  )!;
  const links =
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM media_region_link l JOIN transcript_segment t ON t.id = l.from_id
        WHERE l.from_type = 'transcript_segment' AND l.deleted_at IS NULL AND t.audio_id = ? AND t.deleted_at IS NULL`,
      [a.id],
    )?.n ?? 0;
  return {
    id: a.id,
    source_id: a.source_id,
    source_title: s?.title ?? '',
    source_type: s?.source_type ?? 'lecture_audio',
    version_id: a.version_id ?? '',
    mime: a.mime ?? f?.mime ?? 'application/octet-stream',
    size: f?.size ?? null,
    duration_ms: a.duration_ms,
    duration_origin: a.duration_origin,
    stream_url: `/api/media/audio/${a.id}/stream`,
    segments: counts.n,
    corrected_segments: counts.c,
    links,
    created_at: a.created_at,
  };
}

export function listAudio(ctx: AppContext): AudioListResponse {
  ensureAudioAssets(ctx);
  const rows = ctx.db.all<AudioRow>(
    `SELECT a.* FROM audio_asset a JOIN source s ON s.id = a.source_id
      WHERE s.deleted_at IS NULL AND (a.version_id IS NULL OR a.version_id = COALESCE(s.frozen_version_id, s.current_version_id))
      ORDER BY s.updated_at DESC, a.created_at DESC`,
  );
  const notes: string[] = [];
  if (rows.length === 0) notes.push('لا توجد تسجيلات بعد. ارفع تسجيل محاضرة أو ملاحظة صوتية من صفحة الرفع (MP3 / M4A / WAV / OGG).');
  notes.push('التفريغ الآلي غير متاح في هذا الإصدار (لا يوجد مزود تفريغ مضبوط). يمكنك كتابة التفريغ بنفسك أو استيراد ملف ترجمة VTT / SRT.');
  return { audio: rows.map((r) => audioView(ctx, r)), notes_ar: notes };
}

export function reportDuration(ctx: AppContext, id: string, durationMs: number): AudioAssetView {
  const a = getAudioRow(ctx, id);
  ctx.db.run(`UPDATE audio_asset SET duration_ms = ?, duration_origin = 'player', updated_at = ? WHERE id = ?`, [Math.round(durationMs), ctx.clock.now(), a.id]);
  return audioView(ctx, getAudioRow(ctx, id));
}
