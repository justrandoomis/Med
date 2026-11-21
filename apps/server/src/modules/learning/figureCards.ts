// Image flashcards from described lecture figures (figure descriptions, modules/processing/figures.ts).
//
//   POST /api/learning/cards/from-figure    {description_id, hide_labels?}  one card, enters spaced repetition
//   POST /api/learning/cards/from-figures   {version_id, hide_labels?}      a DRAFT per described picture (suspended
//                                                                           until the owner accepts it)
//   GET  /api/learning/cards/figure-drafts?version_id=                      the drafts of a lecture version
//   POST /api/learning/cards/:id/draft      {decision: accept | discard}
//
// The card is an image card (kind 'image_occlusion', reused): its front is the ORIGINAL picture — optionally with the
// labels / arrows processing found inside it covered (non-destructive masks; the picture itself never changes) — and
// its back is the caption / findings / diagnosis of the description, saying «وصف آلي — راجعه» until the owner
// confirmed the description. A rejected description makes no card. FSRS state is untouched: a draft is an ordinary
// card kept suspended (no review events, its schedule cache is the usual new-card state), accepted = unsuspended.
import {
  FIGURE_DESCRIPTION_LABEL_AR,
  FIGURE_DIAGNOSIS_BASIS_LABELS_AR,
  FIGURE_IMAGE_TYPE_LABELS_AR,
  richTextFromPlain,
  type CardCreateResponse,
  type FigureDescriptionContent,
  type FlashcardView,
  type OcclusionMask,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { getDescription, imageKindOf, isOwnerReviewed, shownContent, type DescriptionRow } from '../processing/figures';
import { cardsAr, cleanRefs, deleteCard, insertCard, touchFn } from './cards';
import { findCard, indexCard, liveCard, viewOf, viewsFor, type FlashcardRow } from './store';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Label / arrow regions processing found INSIDE the figure, as masks on the figure's own picture (normalized). */
export function labelMasks(ctx: AppContext, figureRegionId: string | null, now: number): OcclusionMask[] {
  if (!figureRegionId) return [];
  const fig = fromJson<Box>(ctx.db.get<{ bbox_json: string | null }>('SELECT bbox_json FROM source_region WHERE id = ?', [figureRegionId])?.bbox_json ?? null);
  if (!fig || fig.w <= 0 || fig.h <= 0) return [];
  const kids = ctx.db.all<{ bbox_json: string | null; text: string | null }>(
    `SELECT bbox_json, text FROM source_region WHERE parent_region_id = ? AND text IS NOT NULL AND trim(text) <> '' ORDER BY reading_order LIMIT 50`,
    [figureRegionId],
  );
  const out: OcclusionMask[] = [];
  for (const k of kids) {
    const b = fromJson<Box>(k.bbox_json);
    if (!b) continue;
    const x = Math.max(0, (b.x - fig.x) / fig.w);
    const y = Math.max(0, (b.y - fig.y) / fig.h);
    const w = Math.min(1 - x, b.w / fig.w);
    const h = Math.min(1 - y, b.h / fig.h);
    if (w < 0.005 || h < 0.005) continue;
    out.push({ id: newId(now), box: { x, y, w, h }, label: k.text!.trim().slice(0, 300) });
  }
  return out;
}

/** The image_asset the card shows: the figure's own asset, else (image-only page, re-processed page) a registered one. */
function assetFor(ctx: AppContext, d: DescriptionRow, c: FigureDescriptionContent): string {
  if (d.image_asset_id && ctx.db.get('SELECT 1 AS x FROM image_asset WHERE id = ? AND file_id = ?', [d.image_asset_id, d.file_id])) return d.image_asset_id;
  const ex = ctx.db.get<{ id: string }>(`SELECT id FROM image_asset WHERE version_id = ? AND file_id = ? AND origin = 'source' ORDER BY created_at LIMIT 1`, [d.version_id, d.file_id]);
  if (ex) return ex.id;
  const now = ctx.clock.now();
  const id = newId(now);
  // the ORIGINAL picture registered once (origin 'source', no region: it survives re-processing of the page)
  ctx.db.run(
    `INSERT INTO image_asset (id, file_id, source_id, version_id, page_id, region_id, caption_region_id, origin, image_kind, caption, match_status, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 'source', ?, NULL, 'unverified', ?)`,
    [id, d.file_id, d.source_id, d.version_id, d.page_id, imageKindOf(c.image_type), now],
  );
  return id;
}

export function frontText(c: FigureDescriptionContent, masked: boolean): string {
  if (masked) return 'سمِّ الأجزاء المخفية في الصورة، ثم اذكر ما تُظهره.';
  if (c.image_type === 'graph') return 'ماذا يُظهر هذا الرسم البياني؟ (المحوران والاتجاه)';
  if (c.image_type === 'diagram') return 'اشرح ما يُظهره هذا المخطط.';
  return 'ما التشخيص الأرجح لهذه الصورة، وما الموجودات الأساسية فيها؟';
}

export function backText(c: FigureDescriptionContent, reviewed: boolean, masks: OcclusionMask[]): string {
  const lines: string[] = [];
  if (!reviewed) lines.push(`(${FIGURE_DESCRIPTION_LABEL_AR})`);
  if (c.caption_ar) lines.push(c.caption_ar);
  if (c.caption_en) lines.push(c.caption_en);
  lines.push(`النوع: ${FIGURE_IMAGE_TYPE_LABELS_AR[c.image_type]}${c.stain ? ` — ${c.stain}` : ''}${c.magnification ? ` — ${c.magnification}` : ''}`);
  if (c.diagnosis) lines.push(`التشخيص / الموضوع: ${c.diagnosis.text} (${FIGURE_DIAGNOSIS_BASIS_LABELS_AR[c.diagnosis.basis]})`);
  for (const f of c.findings.slice(0, 8)) lines.push(`• ${f}`);
  if (c.graph) lines.push(`المحور الأفقي: ${c.graph.x_axis ?? '—'} · المحور العمودي: ${c.graph.y_axis ?? '—'} · الاتجاه: ${c.graph.trend ?? '—'}`);
  if (masks.length) lines.push(`الأجزاء المخفية: ${masks.map((m) => m.label).join('، ')}`);
  else for (const l of c.labels.slice(0, 10)) lines.push(`↳ ${l.text}${l.points_to ? `: ${l.points_to}` : ''}`);
  return lines.join('\n');
}

function figureCardRow(ctx: AppContext, d: DescriptionRow, opts: { hideLabels: boolean; draft: boolean; now: number }): { row: FlashcardRow; notes: string[] } {
  const c = shownContent(d);
  if (!c) throw new AppError('CONFLICT', d.owner_status === 'rejected' ? 'رفضتَ وصف هذه الصورة؛ لا تُصنع منه بطاقة. صحّحه أولًا.' : 'لم تُوصف هذه الصورة بعد؛ صِفها أولًا ثم اصنع البطاقة.', 409);
  const reviewed = isOwnerReviewed(d);
  const notes: string[] = [];
  const masks = opts.hideLabels ? labelMasks(ctx, d.region_id, opts.now) : [];
  if (opts.hideLabels && masks.length === 0) notes.push('لم تُعثر على تسميات مقروءة داخل الصورة لإخفائها؛ صُنعت البطاقة بالصورة كاملة.');
  const refs = cleanRefs(ctx, { source_id: d.source_id, source_version_id: d.version_id });
  if (d.region_id) refs.region_ids.push(d.region_id);
  const assetId = assetFor(ctx, d, c);
  const row = insertCard(
    ctx,
    {
      id: newId(opts.now),
      kind: 'image_occlusion',
      front: richTextFromPlain(frontText(c, masks.length > 0)),
      back: richTextFromPlain(backText(c, reviewed, masks)),
      refs,
      // AI-derived text the owner has not reviewed is «generated»; an owner-confirmed description is the owner's
      origin: reviewed ? 'owner' : 'generated',
      origin_ref: { figure_description_id: d.id, image_asset_id: assetId, draft: opts.draft },
      note_id: null,
      cloze_index: null,
      // no active mask: every mask is covered on the front and revealed on the back (OcclusionView)
      image: { image_asset_id: assetId, masks },
      suspended: opts.draft,
      device_id: null,
      created_at: opts.now,
    },
    touchFn(ctx),
  );
  return { row, notes: [...refs.notes_ar, ...notes] };
}

export function createCardFromFigure(ctx: AppContext, req: { description_id: string; hide_labels?: boolean }): CardCreateResponse {
  const d = getDescription(ctx, req.description_id);
  const now = ctx.clock.now();
  const out = ctx.db.tx(() => figureCardRow(ctx, d, { hideLabels: req.hide_labels === true, draft: false, now }));
  ctx.audit.record({ entityType: 'flashcard', entityId: out.row.id, action: 'create_from_figure', summary: 'أنشأت بطاقة من صورة في المحاضرة (الصورة الأصلية لم تتغير).' });
  return { cards: viewsFor(ctx, [out.row]), created: true, duplicates: [], notes_ar: out.notes };
}

/** One DRAFT card per described picture of a version that has no card yet (rejected / undescribed ones are skipped). */
export function createCardsFromFigures(ctx: AppContext, req: { version_id: string; hide_labels?: boolean }): CardCreateResponse {
  if (!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [req.version_id])) throw new AppError('NOT_FOUND', 'نسخة المحاضرة غير موجودة.', 404);
  const rows = ctx.db.all<DescriptionRow>('SELECT * FROM figure_description WHERE version_id = ? ORDER BY ord, created_at, id', [req.version_id]);
  const now = ctx.clock.now();
  const made: FlashcardRow[] = [];
  let already = 0;
  let notReady = 0;
  ctx.db.tx(() => {
    for (const d of rows) {
      if (!shownContent(d)) {
        notReady++;
        continue;
      }
      const has = ctx.db.get('SELECT 1 AS x FROM flashcard WHERE deleted_at IS NULL AND json_extract(origin_ref_json, ?) = ?', ['$.figure_description_id', d.id]);
      if (has) {
        already++;
        continue;
      }
      made.push(figureCardRow(ctx, d, { hideLabels: req.hide_labels === true, draft: true, now }).row);
    }
  });
  const notes: string[] = [];
  if (made.length) notes.push(`أُنشئت ${cardsAr(made.length)} كمسودات موقوفة؛ راجعها واقبل ما تريده لتدخل المراجعة المتباعدة.`);
  if (already) notes.push(`${already === 1 ? 'صورة واحدة لها' : `${already} صور لها`} بطاقة من قبل؛ لم تُكرَّر.`);
  if (notReady) notes.push(`${notReady === 1 ? 'صورة واحدة لم تُوصف' : `${notReady} صور لم تُوصف`} (أو رُفض وصفها)؛ لم تُصنع منها بطاقات.`);
  if (made.length) ctx.audit.record({ entityType: 'flashcard', entityId: made[0]!.id, action: 'create_from_figures', summary: `أنشأت ${cardsAr(made.length)} مسودة من صور المحاضرة.` });
  return { cards: viewsFor(ctx, made), created: made.length > 0, duplicates: [], notes_ar: notes };
}

export function figureDrafts(ctx: AppContext, versionId: string): FlashcardView[] {
  const rows = ctx.db.all<FlashcardRow>(
    `SELECT f.* FROM flashcard f JOIN figure_description d ON d.id = json_extract(f.origin_ref_json, '$.figure_description_id')
      WHERE d.version_id = ? AND f.deleted_at IS NULL AND json_extract(f.origin_ref_json, '$.draft') = 1 ORDER BY d.ord, f.created_at`,
    [versionId],
  );
  return viewsFor(ctx, rows);
}

/** Accept a draft (it enters spaced repetition: unsuspended, no review history touched) or discard it (tombstone). */
export function decideDraft(ctx: AppContext, id: string, decision: 'accept' | 'discard'): FlashcardView {
  const r = liveCard(ctx.db, id);
  const ref = fromJson<Record<string, unknown>>(r.origin_ref_json, {}) ?? {};
  if (ref.draft !== true) throw new AppError('CONFLICT', 'هذه البطاقة ليست مسودة من صورة.', 409);
  if (decision === 'discard') {
    deleteCard(ctx, id);
    return viewOf(ctx, id);
  }
  ctx.db.tx(() => {
    ctx.db.run('UPDATE flashcard SET suspended = 0, origin_ref_json = ?, rev = rev + 1, updated_at = ? WHERE id = ?', [toJson({ ...ref, draft: false }), ctx.clock.now(), id]);
    indexCard(ctx.db, findCard(ctx.db, id)!);
    ctx.sync.touch('flashcard', id);
    ctx.audit.record({ entityType: 'flashcard', entityId: id, action: 'accept_draft', summary: 'قبلت مسودة بطاقة من صورة؛ دخلت المراجعة المتباعدة.' });
  });
  return viewOf(ctx, id);
}
