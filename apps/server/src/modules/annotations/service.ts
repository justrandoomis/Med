// Read paths of the annotations module: annotations by target / by source, notes, needs-reanchor,
// study sessions (latest, Continue Studying) and reading progress (§25, §45, §46, §47).
import type {
  AnnotationDTO,
  ContinueStudyingItem,
  NeedsReanchorItem,
  NoteDTO,
  ReadingProgressView,
  SourceAnnotationsResponse,
  SourceType,
  StudySessionDTO,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import {
  describeAnchorAr,
  pageLabelAr,
  splitTargetKey,
  toAnnotationDTO,
  toNoteDTO,
  toNotePageDTO,
  toSessionDTO,
  type AnnotationRow,
  type NotePageRow,
  type NoteRow,
  type PageInfoRow,
  type StudySessionRow,
} from './repo';

export const MAX_TARGET_KEYS = 200;

function inList(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export class AnnotationsService {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.db;
  }

  // ───────── annotations ─────────
  byTargets(keys: string[], includeDeleted = false): AnnotationDTO[] {
    const parsed = keys.map((k) => ({ key: k, t: splitTargetKey(k) }));
    const bad = parsed.filter((p) => !p.t).map((p) => p.key);
    if (bad.length) throw new AppError('VALIDATION_FAILED', 'مفاتيح الصفحات غير صالحة. الصيغة: source_page:<id> أو note_page:<id>.', 400, { invalid: bad.slice(0, 10) });
    if (parsed.length === 0) return [];
    const out: AnnotationDTO[] = [];
    // group by target type (small IN lists; at most MAX_TARGET_KEYS keys)
    const byType = new Map<string, string[]>();
    for (const p of parsed) {
      const list = byType.get(p.t!.target_type) ?? [];
      list.push(p.t!.target_id);
      byType.set(p.t!.target_type, list);
    }
    for (const [type, ids] of byType) {
      const rows = this.db.all<AnnotationRow>(
        `SELECT a.* FROM annotation_target t JOIN annotation a ON a.id = t.annotation_id
         WHERE t.target_type = ? AND t.target_id IN (${inList(ids.length)}) ${includeDeleted ? '' : 'AND a.deleted_at IS NULL'}
         ORDER BY a.z, a.created_at, a.id`,
        [type, ...ids],
      );
      out.push(...rows.map(toAnnotationDTO));
    }
    return out;
  }

  private versionsOf(sourceId: string, versionId?: string): string[] {
    const src = this.db.get<{ id: string }>('SELECT id FROM source WHERE id = ?', [sourceId]);
    if (!src) throw Errors.notFound('المصدر');
    if (versionId) {
      const v = this.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [versionId]);
      if (!v || v.source_id !== sourceId) throw Errors.notFound('إصدار المصدر');
      return [versionId];
    }
    return this.db.all<{ id: string }>('SELECT id FROM source_version WHERE source_id = ? ORDER BY version_no', [sourceId]).map((r) => r.id);
  }

  forSource(sourceId: string, versionId?: string): SourceAnnotationsResponse {
    const versionIds = this.versionsOf(sourceId, versionId);
    const annotations: AnnotationDTO[] = [];
    if (versionIds.length) {
      const rows = this.db.all<AnnotationRow>(
        `SELECT a.* FROM source_page p
           JOIN annotation_target t ON t.target_type = 'source_page' AND t.target_id = p.id
           JOIN annotation a ON a.id = t.annotation_id
         WHERE p.version_id IN (${inList(versionIds.length)}) AND a.deleted_at IS NULL
         ORDER BY p.page_index, a.z, a.created_at, a.id`,
        versionIds,
      );
      annotations.push(...rows.map(toAnnotationDTO));
    }
    const notePages = this.db.all<NotePageRow>('SELECT * FROM note_page WHERE source_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at', [sourceId]);
    if (notePages.length) {
      const rows = this.db.all<AnnotationRow>(
        `SELECT a.* FROM annotation_target t JOIN annotation a ON a.id = t.annotation_id
         WHERE t.target_type = 'note_page' AND t.target_id IN (${inList(notePages.length)}) AND a.deleted_at IS NULL
         ORDER BY a.z, a.created_at, a.id`,
        notePages.map((n) => n.id),
      );
      annotations.push(...rows.map(toAnnotationDTO));
    }
    const notes = this.db.all<NoteRow>('SELECT * FROM note WHERE source_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [sourceId]).map(toNoteDTO);
    return { source_id: sourceId, version_ids: versionIds, annotations, notes, note_pages: notePages.map(toNotePageDTO) };
  }

  // ───────── notes ─────────
  notes(q: { source_id?: string; node_id?: string; page_id?: string; include_conflicts?: boolean; limit: number }): NoteDTO[] {
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (q.source_id) {
      where.push('source_id = ?');
      params.push(q.source_id);
    }
    if (q.node_id) {
      where.push('node_id = ?');
      params.push(q.node_id);
    }
    if (q.page_id) {
      where.push('anchor_target_key = ?');
      params.push(`source_page:${q.page_id}`);
    }
    if (params.length === 0) throw new AppError('VALIDATION_FAILED', 'حدّد المصدر أو المجلد أو الصفحة لعرض الملاحظات.', 400);
    params.push(q.limit);
    return this.db.all<NoteRow>(`SELECT * FROM note WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id LIMIT ?`, params).map(toNoteDTO);
  }

  // ───────── needs re-anchor ─────────
  needsReanchor(sourceId?: string, limit = 200): NeedsReanchorItem[] {
    const rows = this.db.all<AnnotationRow>(
      `SELECT * FROM annotation WHERE anchor_status = 'needs_reanchor' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      [sourceId ? 5000 : limit],
    );
    const items: NeedsReanchorItem[] = [];
    for (const r of rows) {
      const dto = toAnnotationDTO(r);
      const where = describeAnchorAr(this.db, dto.previous_anchor ?? dto.anchor);
      const srcId = where.sourceId ?? (dto.anchor.type === 'page' ? dto.anchor.source_id : null);
      if (sourceId && srcId !== sourceId) continue;
      items.push({ annotation: dto, source_id: srcId, source_title: where.sourceTitle, previous_location_ar: where.text });
      if (items.length >= limit) break;
    }
    return items;
  }

  // ───────── sessions ─────────
  latestSession(sourceId: string): StudySessionDTO | null {
    const r = this.db.get<StudySessionRow>('SELECT * FROM study_session WHERE source_id = ? ORDER BY updated_at DESC, rev DESC LIMIT 1', [sourceId]);
    return r ? toSessionDTO(r) : null;
  }

  recentSessions(limit: number): ContinueStudyingItem[] {
    // latest session per source; trashed / missing sources are not offered
    const rows = this.db.all<StudySessionRow & { s_title: string; s_type: SourceType; s_archived: number | null; s_active: string | null }>(
      `SELECT ss.*, s.title AS s_title, s.source_type AS s_type, s.archived_at AS s_archived,
              COALESCE(s.frozen_version_id, s.current_version_id) AS s_active
         FROM study_session ss
         JOIN source s ON s.id = ss.source_id
        WHERE s.deleted_at IS NULL
          AND ss.id = (SELECT x.id FROM study_session x WHERE x.source_id = ss.source_id ORDER BY x.updated_at DESC, x.rev DESC LIMIT 1)
        ORDER BY ss.updated_at DESC
        LIMIT ?`,
      [limit],
    );
    return rows.map((r) => {
      const session = toSessionDTO(r);
      const version = r.version_id ? this.db.get<{ id: string; version_no: number }>('SELECT id, version_no FROM source_version WHERE id = ?', [r.version_id]) : undefined;
      let page: PageInfoRow | undefined;
      if (r.version_id) {
        const loc = session.location;
        if (loc.page_id) page = this.db.get<PageInfoRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE id = ? AND version_id = ?', [loc.page_id, r.version_id]);
        if (!page && typeof loc.page_index === 'number') {
          page = this.db.get<PageInfoRow>('SELECT id, version_id, page_index, printed_label, kind FROM source_page WHERE version_id = ? AND page_index = ?', [r.version_id, loc.page_index]);
        }
      }
      return {
        session,
        source: { id: r.source_id!, title: r.s_title, source_type: r.s_type, archived: r.s_archived !== null },
        version: version ? { id: version.id, version_no: version.version_no, is_active: version.id === r.s_active } : null,
        page: page ? { id: page.id, page_index: page.page_index, printed_label: page.printed_label, kind: page.kind, label_ar: pageLabelAr(page) } : null,
        reading: this.progress(r.source_id!),
      };
    });
  }

  // ───────── reading progress (Reading Progress ONLY — never mastery, §45) ─────────
  private pagesTotal(versionId: string): number | null {
    const v = this.db.get<{ page_count: number | null }>('SELECT page_count FROM source_version WHERE id = ?', [versionId]);
    if (v?.page_count) return v.page_count;
    const c = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [versionId]);
    return c && c.n > 0 ? c.n : null;
  }

  progress(sourceId: string): ReadingProgressView {
    const row = this.db.get<{ pages_viewed_json: string; reading_progress: number; updated_at: number; progress_version_id: string | null }>(
      'SELECT pages_viewed_json, reading_progress, updated_at, progress_version_id FROM source_progress WHERE source_id = ?',
      [sourceId],
    );
    if (!row) return { source_id: sourceId, version_id: null, pages_viewed: [], pages_total: null, reading_progress: 0, updated_at: null };
    let viewed: number[] = [];
    try {
      const parsed: unknown = JSON.parse(row.pages_viewed_json);
      if (Array.isArray(parsed)) viewed = parsed.filter((n): n is number => Number.isInteger(n) && n >= 0);
    } catch {
      viewed = [];
    }
    const total = row.progress_version_id ? this.pagesTotal(row.progress_version_id) : null;
    return {
      source_id: sourceId,
      version_id: row.progress_version_id,
      pages_viewed: viewed,
      pages_total: total,
      reading_progress: total ? Math.min(1, viewed.length / total) : 0,
      updated_at: row.updated_at,
    };
  }

  recordViewed(sourceId: string, versionId: string, pageIndexes: number[]): ReadingProgressView {
    const v = this.db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [versionId]);
    if (!this.db.get('SELECT 1 AS x FROM source WHERE id = ?', [sourceId])) throw Errors.notFound('المصدر');
    if (!v || v.source_id !== sourceId) throw Errors.notFound('إصدار المصدر');
    const total = this.pagesTotal(versionId);
    if (total !== null) {
      const outside = pageIndexes.filter((i) => i >= total);
      if (outside.length) throw new AppError('VALIDATION_FAILED', `رقم الصفحة خارج عدد صفحات هذا الإصدار (${total}).`, 400, { pages_total: total });
    }
    const now = this.ctx.clock.now();
    this.db.tx(() => {
      const row = this.db.get<{ pages_viewed_json: string; progress_version_id: string | null }>(
        'SELECT pages_viewed_json, progress_version_id FROM source_progress WHERE source_id = ?',
        [sourceId],
      );
      // One version's pages are kept per source. Glancing at an older (non-active) version — e.g. a citation
      // made against it — must not wipe the reading progress of the version the owner studies.
      const active = this.db.get<{ v: string | null }>('SELECT COALESCE(frozen_version_id, current_version_id) AS v FROM source WHERE id = ?', [sourceId])?.v ?? null;
      if (row && row.progress_version_id && row.progress_version_id !== versionId && row.progress_version_id === active) return;
      let viewed = new Set<number>();
      if (row && row.progress_version_id === versionId) {
        try {
          const parsed: unknown = JSON.parse(row.pages_viewed_json);
          if (Array.isArray(parsed)) for (const n of parsed) if (Number.isInteger(n) && n >= 0) viewed.add(n);
        } catch {
          viewed = new Set();
        }
      }
      for (const i of pageIndexes) viewed.add(i);
      const list = [...viewed].sort((a, b) => a - b);
      const ratio = total ? Math.min(1, list.length / total) : 0;
      this.db.run(
        `INSERT INTO source_progress (source_id, pages_viewed_json, reading_progress, updated_at, progress_version_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET pages_viewed_json = excluded.pages_viewed_json, reading_progress = excluded.reading_progress,
           updated_at = excluded.updated_at, progress_version_id = excluded.progress_version_id`,
        [sourceId, JSON.stringify(list), ratio, now, versionId],
      );
    });
    return this.progress(sourceId);
  }
}
