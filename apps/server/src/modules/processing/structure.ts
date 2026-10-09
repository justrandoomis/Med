// Version-level structure passes (run after all pages, idempotent):
//  * figure ↔ caption links across adjacent pages, and paragraphs that reference "Figure N"
//  * lecture kind suggestion (theoretical / practical / clinical / mixed) with reasons — only while the
//    owner has not chosen one (origin 'owner' is never overridden)
import type { FigureStructure, LectureKind } from '@medlevo/shared';
import { normalizeForSearch } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import { captionInfo, figureReferences } from './layout/page';
import { imageKindFromCaption } from './persist';

interface RegionLite {
  id: string;
  page_index: number;
  kind: string;
  reading_order: number;
  text: string | null;
  bbox_json: string | null;
  structure_json: string | null;
}

/** Link figures to captions on adjacent pages and record which paragraphs reference each figure. */
export function linkFiguresAcrossPages(ctx: AppContext, versionId: string): { captionsLinked: number; references: number } {
  const rows = ctx.db.all<RegionLite>(
    `SELECT r.id, p.page_index, r.kind, r.reading_order, r.text, r.bbox_json, r.structure_json
       FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.kind IN ('figure','caption','paragraph','list_item','text_block','table')
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const figures = rows.filter((r) => r.kind === 'figure');
  // a caption link to a region that no longer exists (its page was re-processed) is dropped and re-linked
  const captionIds = new Set(rows.filter((r) => r.kind === 'caption').map((r) => r.id));
  const usedCaptions = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'figure' && r.kind !== 'table') continue;
    const s = fromJson<{ caption_region_id?: string | null }>(r.structure_json);
    if (s?.caption_region_id && captionIds.has(s.caption_region_id)) usedCaptions.add(s.caption_region_id);
  }
  const freeFigureCaptions = rows.filter((r) => r.kind === 'caption' && !usedCaptions.has(r.id) && captionInfo(r.text ?? '')?.for === 'figure');
  const bboxTop = (r: RegionLite) => fromJson<{ y: number; h: number }>(r.bbox_json)?.y ?? 0.5;
  const bboxBottom = (r: RegionLite) => {
    const b = fromJson<{ y: number; h: number }>(r.bbox_json);
    return b ? b.y + b.h : 0.5;
  };
  let captionsLinked = 0;
  const updates = new Map<string, FigureStructure>();
  for (const f of figures) {
    const s: FigureStructure = { type: 'figure', referenced_by_region_ids: [], ...(fromJson<FigureStructure>(f.structure_json) ?? {}) };
    if (s.caption_region_id && !captionIds.has(s.caption_region_id)) s.caption_region_id = null;
    if (!s.caption_region_id) {
      // caption at the top of the next page (figure at the bottom of its page), or at the bottom of the previous page
      const next = freeFigureCaptions.find((c) => c.page_index === f.page_index + 1 && bboxTop(c) <= 0.3 && !usedCaptions.has(c.id));
      const prev = freeFigureCaptions.find((c) => c.page_index === f.page_index - 1 && bboxBottom(c) >= 0.7 && !usedCaptions.has(c.id));
      const pick = bboxBottom(f) >= 0.6 ? (next ?? prev) : (prev ?? next);
      if (pick) {
        s.caption_region_id = pick.id;
        usedCaptions.add(pick.id);
        captionsLinked++;
        ctx.db.run('UPDATE image_asset SET caption_region_id = ?, caption = ?, image_kind = CASE WHEN image_kind = \'unknown\' THEN ? ELSE image_kind END WHERE region_id = ?', [
          pick.id,
          pick.text,
          imageKindFromCaption(pick.text),
          f.id,
        ]);
      }
    }
    s.referenced_by_region_ids = [];
    updates.set(f.id, s);
  }
  // "as shown in Figure 2" → the figure whose caption carries number 2 (same version)
  const figureByNumber = new Map<string, string>();
  const captionText = new Map(rows.filter((r) => r.kind === 'caption').map((r) => [r.id, r.text ?? '']));
  for (const [figId, s] of updates) {
    const num = s.caption_region_id ? captionInfo(captionText.get(s.caption_region_id) ?? '')?.number : undefined;
    if (num && !figureByNumber.has(num)) figureByNumber.set(num, figId);
  }
  let references = 0;
  for (const r of rows) {
    if (r.kind === 'figure' || r.kind === 'caption' || r.kind === 'table' || !r.text) continue;
    for (const n of figureReferences(r.text)) {
      const figId = figureByNumber.get(n);
      if (!figId) continue;
      const s = updates.get(figId)!;
      if (!s.referenced_by_region_ids!.includes(r.id)) {
        s.referenced_by_region_ids!.push(r.id);
        references++;
      }
    }
  }
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    for (const [id, s] of updates) ctx.db.run('UPDATE source_region SET structure_json = ?, updated_at = ? WHERE id = ?', [toJson(s), now, id]);
  });
  return { captionsLinked, references };
}

// ───────── lecture kind ─────────
const KIND_TERMS: Record<'theoretical' | 'practical' | 'clinical', string[]> = {
  clinical: [
    'patient', 'patients', 'case', 'presentation', 'presents', 'history', 'examination', 'diagnosis', 'differential', 'management',
    'treatment', 'investigation', 'investigations', 'clinical', 'signs', 'symptoms', 'prognosis', 'complications',
    'مريض', 'المريض', 'حاله', 'تشخيص', 'التشخيص', 'علاج', 'العلاج', 'سريري', 'السريري', 'الاعراض', 'الفحوصات',
  ],
  practical: [
    'practical', 'lab', 'laboratory', 'procedure', 'procedures', 'technique', 'steps', 'station', 'osce', 'specimen', 'specimens',
    'slide', 'slides', 'microscope', 'stain', 'staining', 'dissection', 'skills', 'equipment',
    'عملي', 'العملي', 'مختبر', 'المختبر', 'اجراء', 'خطوات', 'عينه', 'شريحه', 'مجهر', 'المجهر', 'صبغه',
  ],
  theoretical: [
    'definition', 'defined', 'mechanism', 'mechanisms', 'pathophysiology', 'physiology', 'pathogenesis', 'classification', 'classified',
    'etiology', 'aetiology', 'structure', 'function', 'theory', 'concept', 'concepts', 'objectives',
    'تعريف', 'اليه', 'فسيولوجيا', 'تصنيف', 'التصنيف', 'اسباب', 'نظريه', 'مفهوم',
  ],
};
const KIND_LABEL_AR: Record<LectureKind, string> = { theoretical: 'نظرية', practical: 'عملية', clinical: 'سريرية', mixed: 'مختلطة' };
const FAMILY_AR: Record<'theoretical' | 'practical' | 'clinical', string> = { theoretical: 'نظرية', practical: 'عملية', clinical: 'سريرية' };

export interface LectureKindSuggestion {
  kind: LectureKind | null;
  scores: Record<'theoretical' | 'practical' | 'clinical', number>;
  reasons_ar: string[];
}

export function suggestLectureKind(text: string): LectureKindSuggestion {
  const tokens = normalizeForSearch(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const scores = { theoretical: 0, practical: 0, clinical: 0 };
  const hits: Record<keyof typeof scores, Array<[string, number]>> = { theoretical: [], practical: [], clinical: [] };
  for (const fam of Object.keys(KIND_TERMS) as Array<keyof typeof scores>) {
    for (const term of KIND_TERMS[fam]) {
      const n = counts.get(normalizeForSearch(term)) ?? 0;
      if (n > 0) {
        scores[fam] += n;
        hits[fam].push([term, n]);
      }
    }
  }
  const ranked = (Object.keys(scores) as Array<keyof typeof scores>).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  const second = ranked[1]!;
  const reasons_ar = ranked
    .filter((f) => scores[f] > 0)
    .map(
      (f) =>
        `مصطلحات ${FAMILY_AR[f]}: ${hits[f]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t, n]) => `${t} (${n})`)
          .join('، ')}`,
    );
  const total = scores.theoretical + scores.practical + scores.clinical;
  if (total < 3 || scores[top] < 2) {
    return { kind: null, scores, reasons_ar: ['الإشارات في النص غير كافية لاقتراح نوع المحاضرة.', ...reasons_ar] };
  }
  const kind: LectureKind = scores[second] >= 3 && scores[second] >= 0.6 * scores[top] ? 'mixed' : top;
  return { kind, scores, reasons_ar: [`النوع المقترح: ${KIND_LABEL_AR[kind]} (اقتراح تلقائي قابل للتصحيح).`, ...reasons_ar] };
}

/** Apply the suggestion to the source when allowed; returns what was decided. */
export function applyLectureKind(ctx: AppContext, sourceId: string, versionId: string, jobId: string): LectureKindSuggestion | null {
  const src = ctx.db.get<{ source_type: string; lecture_kind: string | null; lecture_kind_origin: string | null; current_version_id: string | null; frozen_version_id: string | null }>(
    'SELECT source_type, lecture_kind, lecture_kind_origin, current_version_id, frozen_version_id FROM source WHERE id = ?',
    [sourceId],
  );
  if (!src || src.source_type !== 'lecture') return null;
  if (src.lecture_kind_origin === 'owner') return null; // never override the owner's choice
  if ((src.frozen_version_id ?? src.current_version_id) !== versionId) return null; // only the version the owner studies
  const texts = ctx.db.all<{ text: string }>(
    `SELECT text FROM source_region WHERE version_id = ? AND text IS NOT NULL AND kind NOT IN ('header','footer','table_cell')`,
    [versionId],
  );
  const suggestion = suggestLectureKind(texts.map((t) => t.text).join('\n'));
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run(
      `DELETE FROM review_queue_item WHERE status = 'open' AND kind = 'classification_suggestion' AND entity_type = 'source' AND entity_id = ?
         AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'processing'`,
      [sourceId],
    );
    if (!suggestion.kind) return;
    if (src.lecture_kind !== suggestion.kind || src.lecture_kind_origin !== 'auto') {
      ctx.db.run(`UPDATE source SET lecture_kind = ?, lecture_kind_origin = 'auto', updated_at = ? WHERE id = ?`, [suggestion.kind, now, sourceId]);
      ctx.audit.record({
        entityType: 'source',
        entityId: sourceId,
        action: 'classify',
        summary: `اقتراح تلقائي لنوع المحاضرة: ${KIND_LABEL_AR[suggestion.kind]}`,
        before: { lecture_kind: src.lecture_kind, lecture_kind_origin: src.lecture_kind_origin },
        after: { lecture_kind: suggestion.kind, lecture_kind_origin: 'auto' },
        actor: 'job',
        jobId,
      });
    }
    ctx.db.run(
      `INSERT INTO review_queue_item (id, kind, entity_type, entity_id, source_id, reason, details_json, status, created_at)
       VALUES (?, 'classification_suggestion', 'source', ?, ?, ?, ?, 'open', ?)`,
      [
        newId(now),
        sourceId,
        sourceId,
        `صُنّفت المحاضرة تلقائيًا كـ«${KIND_LABEL_AR[suggestion.kind]}». راجع التصنيف وصحّحه إن لزم.`,
        toJson({ origin: 'processing', version_id: versionId, suggested: suggestion.kind, scores: suggestion.scores, reasons_ar: suggestion.reasons_ar }),
        now,
      ],
    );
  });
  return suggestion;
}
