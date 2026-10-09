// Explain / Simplify / Translate / Explain Image (§15, §19, §20, §30, AC-05…AC-08, AC-29) and Compare Mode (§31).
//
//  * the anchor must lie in the resolved scope (its version = the version the lock uses), anchor regions must
//    belong to that version — otherwise OUT_OF_SCOPE, never a silent widening
//  * real-patient requests → abstention with the educational-use notice, no retrieval, no model call
//  * cache key per ARCHITECTURE §3.7; reuse only on an exact key + valid dependencies (a lecture_only request can
//    never reuse a wider-scope artifact: the scope hash is part of the key)
//  * nothing found in scope → abstention without calling the model, with an optional explicit wider scope
//  * Explain Until Understood: a retry is a NEW version of the same lineage with a different teaching strategy
//  * figures: with vision, the crop is sent and the answer separates caption-stated facts (cited) from the
//    model's visual reading (labels / arrows — not evidence; uncertain unless the label is also OCR-readable);
//    without vision, the figure is explained only from its caption / OCR labels and says so
import {
  REAL_PATIENT_NOTICE_AR,
  type ExplainResponse,
  type SelectionAnchor,
  type StudyArtifactView,
  type StudyBlockMeta,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { ProviderImage, UntrustedBlock } from '../ai/types';
import { cacheKey, resolveScope, VERIFIER_VERSION, type ScopeReport } from '../evidence/services';
import { abstainView, artifactView, findReusable, nextVersionNo, requireArtifact, type ArtifactRow } from './artifacts';
import {
  assertAnchorInScope,
  callModel,
  generateSingleShot,
  publishAbstention,
  publishGenerated,
  requireAi,
  retrieveAndPack,
  keySettings,
  type ArtifactBase,
  type SingleShotInput,
} from './generate';
import type { PreparedBlock, ProcessResult } from './publish';
import { computeBlockKey, regionPages } from './publish';
import { buildExplanationPrompt, GENERATOR_VERSION, resolveRules, type RulesPatch } from './rules';
import { figureOutputSchema, type CompareBody, type ExplainBody, type FigureOutput } from './schema';
import { termsForTexts } from './terms';
import { labelParagraph, paragraphOf, richText, shorten } from './text';
import { normalizeForSearch, pageDisplayLabel } from '@medlevo/shared';

// ───────── real-patient requests (§12) ─────────
const REAL_PATIENT_PATTERNS: RegExp[] = [
  /مريض(?:ي|تي|نا)\s/u,
  /(?:مريض|حالة|مراجع)\s+حقيقي/u,
  /(?:عندي|لدي|أعاني|اعاني|أحس|احس|أشعر|اشعر)\s+(?:من\s+)?(?:ب?ألم|ب?الم|وجع|حمى|حرارة|صداع|نزيف|إسهال|اسهال|تقيؤ|سعال)/u,
  /(?:أمي|امي|أبي|ابي|أبوي|ابوي|ابني|بنتي|ابنتي|زوجتي|زوجي|أخي|اخي|أختي|اختي|طفلي)\s+(?:عنده|عندها|يعاني|تعاني|مريض|مريضة|يشكو|تشكو)/u,
  /(?:شخّ?ص|شخص)\s*(?:حالتي|لي\s+حالتي)/u,
  /(?:شنو|شو|ماذا|ايش|إيش)\s+(?:أعطي|اعطي|أعطيه|اعطيه|أعطيها|اعطيها|آخذ|اخذ|ياخذ|يأخذ|تاخذ|تأخذ)/u,
  /\bmy\s+(?:patient|mother|mom|father|dad|son|daughter|wife|husband|child|baby|brother|sister)\s+(?:has|have|is|was|with|presented|complains)\b/i,
  /\bi\s+(?:have|am having|feel|felt|got)\b[^.?!]{0,40}\b(?:pain|fever|bleeding|headache|rash|vomiting|cough|symptoms?)\b/i,
  /\bshould\s+i\s+(?:take|give|start|stop)\b/i,
  /\b(?:diagnose|treat)\s+me\b/i,
  /\bwhat\s+(?:dose|medication|drug)\s+should\s+(?:i|my|we)\b/i,
];

/** True when the owner's text asks about a real person's diagnosis / treatment (deterministic). */
export function isRealPatientRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.normalize('NFC');
  return REAL_PATIENT_PATTERNS.some((re) => re.test(t));
}

export function realPatientAbstain() {
  return abstainView('real_patient_request', REAL_PATIENT_NOTICE_AR);
}

// ───────── helpers ─────────
interface RegionLite {
  id: string;
  version_id: string;
  page_id: string | null;
  kind: string;
  text: string | null;
  parent_region_id: string | null;
  bbox_json: string | null;
}

/** The anchor's regions; every one must belong to the anchor's version (else OUT_OF_SCOPE, nothing runs). */
export function anchorRegions(ctx: AppContext, anchor: SelectionAnchor): RegionLite[] {
  const ids = [...new Set(anchor.region_ids ?? [])];
  if (ids.length === 0) return [];
  const rows = ctx.db.all<RegionLite>(
    `SELECT id, version_id, page_id, kind, text, parent_region_id, bbox_json FROM source_region WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const foreign = ids.filter((id) => !rows.some((r) => r.id === id && r.version_id === anchor.version_id));
  if (foreign.length) {
    throw new AppError('OUT_OF_SCOPE', 'بعض مناطق التحديد لا تنتمي إلى نسخة المصدر المحددة؛ لم يُنفَّذ الطلب.', 409, { region_ids: foreign });
  }
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

function assertPageInVersion(ctx: AppContext, anchor: SelectionAnchor): void {
  if (!anchor.page_id) return;
  const p = ctx.db.get<{ version_id: string }>('SELECT version_id FROM source_page WHERE id = ?', [anchor.page_id]);
  if (!p || p.version_id !== anchor.version_id) {
    throw new AppError('OUT_OF_SCOPE', 'الصفحة المحددة لا تنتمي إلى نسخة المصدر المحددة.', 409, { page_id: anchor.page_id });
  }
}

/** The selected text: the owner's quote, else the anchor regions' text. Untrusted data. */
function selectionText(anchor: SelectionAnchor, regions: RegionLite[]): string {
  const q = anchor.quote?.exact?.trim();
  if (q) return q.slice(0, 6000);
  return regions
    .map((r) => r.text ?? '')
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

/** «ص 12» for a whole-page request (no selected text). */
function anchorPageLabel(ctx: AppContext, anchor: SelectionAnchor): string | null {
  if (!anchor.page_id) return null;
  const p = ctx.db.get<{ page_index: number; printed_label: string | null; kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment' }>(
    'SELECT page_index, printed_label, kind FROM source_page WHERE id = ?',
    [anchor.page_id],
  );
  return p ? pageDisplayLabel(p) : null;
}

function normalizedAnchor(a: SelectionAnchor): Record<string, unknown> {
  return {
    source_id: a.source_id,
    version_id: a.version_id,
    page_id: a.page_id ?? null,
    region_ids: [...new Set(a.region_ids ?? [])].sort(),
    quote: a.quote?.exact ?? null,
    bbox: a.bbox ? [a.bbox.x, a.bbox.y, a.bbox.w, a.bbox.h].map((n) => Math.round(n * 1000) / 1000) : null,
    block: a.block ?? null,
  };
}

const ACTION_TEXT: Record<ExplainBody['action'], string> = {
  explain: 'Explain the SELECTION (the first untrusted block) for the learner in Arabic, using only the evidence excerpts.',
  simplify: 'Re-explain the SELECTION in the simplest accurate way (short sentences, everyday Arabic, every term defined). Never drop a negation, condition or exception.',
  translate:
    'Translate the SELECTION into natural Arabic sentence by sentence, keeping key English medical terms. Each translated medical sentence is a claim (support_type "directly_stated") citing the excerpt it translates. A translation is never an original quote.',
  explain_image: 'Explain the FIGURE described by the selection, its caption and its labels, using only the evidence excerpts.',
};

const KIND_TITLE: Record<ExplainBody['action'], string> = { explain: 'شرح', simplify: 'تبسيط', translate: 'ترجمة', explain_image: 'شرح الشكل' };

// ───────── explain ─────────
export interface ExplainOptions {
  jobId?: string;
  signal?: AbortSignal;
}

export async function explainSelection(ctx: AppContext, body: ExplainBody, opts: ExplainOptions = {}): Promise<ExplainResponse> {
  const scope = resolveScope(ctx, body.scope);
  const anchor = body.anchor as SelectionAnchor;
  assertAnchorInScope(scope, anchor);
  assertPageInVersion(ctx, anchor);
  const regions = anchorRegions(ctx, anchor);
  const overrides: RulesPatch = { ...(body.rules ?? {}) };
  if (body.level) overrides.level = body.level;
  if (body.action === 'simplify') overrides.level = 'simple';
  const rules = resolveRules(ctx, { sourceId: anchor.source_id, overrides });

  let lineage: ArtifactBase['lineage'] = null;
  let previous: ArtifactRow | null = null;
  if (body.retry_of) {
    previous = requireArtifact(ctx, body.retry_of.artifact_id);
    if (!['explanation', 'figure_explanation', 'chat_answer'].includes(previous.kind)) {
      throw new AppError('BAD_REQUEST', 'يمكن إعادة الشرح بأسلوب آخر لشرح سابق فقط.', 400);
    }
    assertRetryInLineage(previous, anchor, scope);
    lineage = { lineageId: previous.lineage_id, versionNo: nextVersionNo(ctx, previous.lineage_id), parentArtifactId: previous.id };
  }

  const key = cacheKey(ctx, {
    kind: `explanation:${body.action}`,
    scope,
    rulesVersion: rules.rules_version,
    generatorVersion: GENERATOR_VERSION,
    verifierVersion: VERIFIER_VERSION,
    level: rules.level,
    language: 'ar',
    dialect: rules.dialect,
    settings: keySettings(ctx, body.action === 'explain_image' ? 'vision_figure' : 'explain', { style: body.style }),
    params: {
      anchor: normalizedAnchor(anchor),
      instruction: body.instruction?.trim() || null,
      retry_of: body.retry_of?.artifact_id ?? null,
      strategy: body.retry_of?.strategy ?? null,
    },
  });
  const selection = selectionText(anchor, regions);
  const base: ArtifactBase = {
    kind: body.action === 'explain_image' ? 'figure_explanation' : 'explanation',
    title: `${KIND_TITLE[body.action]}: ${shorten(selection || (body.instruction ?? ''), 70) || anchorPageLabel(ctx, anchor) || 'التحديد'}`,
    primarySourceId: anchor.source_id,
    scope,
    rules,
    cacheKey: key,
    params: {
      action: body.action,
      style: body.style,
      level: rules.level,
      dialect: rules.dialect,
      template: rules.template,
      instruction: body.instruction?.trim() || null,
      strategy: body.retry_of?.strategy ?? null,
      language: 'ar',
    },
    anchor,
    lineage,
    jobId: opts.jobId ?? null,
  };

  // §12: a real person's diagnosis / treatment is never answered (no retrieval, no model)
  if (isRealPatientRequest(body.instruction)) return { artifact: publishAbstention(ctx, base, realPatientAbstain()), cached: false };

  requireAi(ctx, 'explain');
  const cached = findReusable(ctx, key, base.kind);
  if (cached) return { artifact: artifactView(ctx, cached), cached: true };

  if (body.action === 'explain_image') return { artifact: await explainFigure(ctx, base, body, anchor, regions, scope, opts), cached: false };

  const leading: UntrustedBlock[] = [];
  if (selection) leading.push({ label: 'SELECTION (text the learner selected in the source)', text: selection });
  if (previous) {
    leading.push({ label: 'PREVIOUS EXPLANATION (generated earlier; NOT evidence; the learner did not understand it)', text: plainOfArtifact(ctx, previous.id).slice(0, 6000) });
  }
  const query = [selection, body.instruction ?? ''].join(' ').slice(0, 2000);
  const input: SingleShotInput = {
    ...base,
    retrieval: {
      query,
      anchor: regions.length ? { region_ids: regions.map((r) => r.id) } : anchor.page_id ? { page_id: anchor.page_id } : null,
      k: 8,
      purpose: 'lecture_explanation',
    },
    call: {
      task: 'explain',
      style: body.style,
      taskText: ACTION_TEXT[body.action],
      ownerInstruction: body.instruction ?? null,
      strategy: body.retry_of?.strategy ?? null,
      leading,
      terms: termsForTexts(ctx, [selection]),
      jobId: opts.jobId,
      signal: opts.signal,
    },
    defaultRegionIds: regions.map((r) => r.id),
  };
  return { artifact: await generateSingleShot(ctx, input), cached: false };
}

/**
 * Explain Until Understood re-teaches THE SAME passage: the explanation being retried must be of the same source
 * and version, and everything it was built from must lie inside the current lock — its text goes to the model as
 * context, so an explanation made under a wider scope never leaks into a narrower request (Source Lock).
 */
function assertRetryInLineage(previous: ArtifactRow, anchor: SelectionAnchor, scope: ScopeReport): void {
  const prevAnchor = fromJson<SelectionAnchor>(previous.anchor_json);
  const prevScope = fromJson<{ version_ids?: string[] }>(previous.scope_json);
  const sameSource = previous.primary_source_id === anchor.source_id && (!prevAnchor || (prevAnchor.source_id === anchor.source_id && prevAnchor.version_id === anchor.version_id));
  if (!sameSource) {
    throw new AppError('BAD_REQUEST', 'يُعاد الشرح بأسلوب آخر لشرح سابق للمصدر ونسخته نفسيهما فقط؛ اطلب شرحًا جديدًا لهذا الموضع.', 400, { retry_of: previous.id });
  }
  const allowed = new Set(scope.versionIds);
  const outside = (prevScope?.version_ids ?? []).filter((v) => !allowed.has(v));
  if (outside.length) {
    throw new AppError('OUT_OF_SCOPE', 'الشرح السابق بُني على مصادر خارج النطاق المقفل الحالي؛ لا يُستخدم سياقًا لطلب أضيق. اطلب شرحًا جديدًا أو استخدم النطاق نفسه.', 409, { retry_of: previous.id });
  }
}

function plainOfArtifact(ctx: AppContext, id: string): string {
  const v = artifactView(ctx, id);
  return v.blocks
    .map((b) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n'))
    .join('\n')
    .trim();
}

// ───────── figures (§15, AC-08) ─────────
interface FigureContext {
  figure: RegionLite | null;
  caption: RegionLite | null;
  labels: RegionLite[];
  imageFileId: string | null;
}

function findFigure(ctx: AppContext, anchor: SelectionAnchor, regions: RegionLite[]): FigureContext {
  let figure = regions.find((r) => r.kind === 'figure') ?? null;
  if (!figure) {
    const diagram = regions.find((r) => r.kind === 'diagram' && r.parent_region_id);
    if (diagram) figure = ctx.db.get<RegionLite>('SELECT id, version_id, page_id, kind, text, parent_region_id, bbox_json FROM source_region WHERE id = ?', [diagram.parent_region_id]) ?? null;
  }
  if (!figure && anchor.page_id) {
    const figures = ctx.db.all<RegionLite>(
      `SELECT id, version_id, page_id, kind, text, parent_region_id, bbox_json FROM source_region WHERE page_id = ? AND version_id = ? AND kind = 'figure' ORDER BY reading_order`,
      [anchor.page_id, anchor.version_id],
    );
    if (anchor.bbox && figures.length > 1) {
      const b = anchor.bbox;
      const overlap = (r: RegionLite) => {
        const f = r.bbox_json ? (JSON.parse(r.bbox_json) as { x: number; y: number; w: number; h: number }) : null;
        if (!f) return 0;
        const w = Math.max(0, Math.min(b.x + b.w, f.x + f.w) - Math.max(b.x, f.x));
        const h = Math.max(0, Math.min(b.y + b.h, f.y + f.h) - Math.max(b.y, f.y));
        return w * h;
      };
      figures.sort((x, y) => overlap(y) - overlap(x));
    }
    figure = figures[0] ?? null;
  }
  if (!figure) return { figure: null, caption: null, labels: [], imageFileId: null };
  const asset = ctx.db.get<{ file_id: string | null; caption_region_id: string | null }>(
    `SELECT file_id, caption_region_id FROM image_asset WHERE region_id = ? AND origin = 'source' ORDER BY created_at LIMIT 1`,
    [figure.id],
  );
  const caption = asset?.caption_region_id
    ? (ctx.db.get<RegionLite>('SELECT id, version_id, page_id, kind, text, parent_region_id, bbox_json FROM source_region WHERE id = ?', [asset.caption_region_id]) ?? null)
    : null;
  const labels = ctx.db.all<RegionLite>(
    `SELECT id, version_id, page_id, kind, text, parent_region_id, bbox_json FROM source_region WHERE parent_region_id = ? AND text IS NOT NULL AND trim(text) <> '' ORDER BY reading_order`,
    [figure.id],
  );
  return { figure, caption, labels, imageFileId: asset?.file_id ?? null };
}

const VISUAL_LABEL_AR = 'قراءة بصرية مولَّدة للشكل — ليست دليلًا من المصدر. العناصر «غير المؤكدة» لا تُعتمد إجابةً امتحانية.';
const VISUAL_KIND_AR: Record<FigureOutput['visual_items'][number]['kind'], string> = { label: 'تسمية', arrow: 'سهم', region: 'منطقة', relation: 'علاقة', other: 'عنصر' };

/** Visual reading → one 'figure' block. A label counts as readable only when the OCR text of the figure has it too. */
export function visualBlock(ctx: AppContext, items: FigureOutput['visual_items'], fc: FigureContext, ord: number, visionUsed: boolean): PreparedBlock | null {
  if (items.length === 0) return null;
  const ocr = ` ${normalizeForSearch([fc.caption?.text ?? '', ...fc.labels.map((l) => l.text ?? '')].join(' ')).replace(/\s+/g, ' ')} `;
  const readable = (s: string | null) => !!s && s.trim().length > 1 && ocr.includes(` ${normalizeForSearch(s).replace(/\s+/g, ' ').trim()} `);
  let uncertain = 0;
  const paras = items.slice(0, 40).map((it) => {
    const confirmedByText = it.kind === 'label' ? readable(it.label_text) : false;
    const isUncertain = !(it.certainty === 'clear' && confirmedByText);
    if (isUncertain) uncertain++;
    const status = isUncertain ? 'غير مؤكد' : 'مقروء نصيًا أيضًا';
    const arrow = it.kind === 'arrow' || it.kind === 'relation' ? (it.from && it.to ? ` (${shorten(it.from, 80)} → ${shorten(it.to, 80)})` : '') : '';
    const label = it.label_text ? ` «${shorten(it.label_text, 120)}»` : '';
    return paragraphOf([{ text: `[${VISUAL_KIND_AR[it.kind]} — ${status}]${label}${arrow}: ${shorten(it.description, 400)}` }], 'li');
  });
  const regionIds = fc.figure ? [fc.figure.id] : [];
  const pages = regionPages(ctx, regionIds);
  const meta: StudyBlockMeta = {
    label_ar: VISUAL_LABEL_AR,
    page_ids: pages.page_ids,
    page_indexes: pages.page_indexes,
    visual: { items: paras.length, uncertain, vision_used: visionUsed },
    not_for_exam_answer: uncertain > 0,
  };
  return {
    id: newId(ctx.clock.now()),
    block_key: computeBlockKey(null, regionIds, 'figure', 0),
    section_key: null,
    ord,
    kind: 'figure',
    content: richText([labelParagraph(VISUAL_LABEL_AR), ...paras]),
    table: null,
    source_region_ids: regionIds,
    status: 'complete',
    // visual reading is never «linked»: it has no evidence; uncertain items need the owner's review
    verification_status: uncertain > 0 ? 'needs_review' : 'not_applicable',
    meta,
    evidence_ids: [],
  };
}

const FIGURE_RULES = [
  'FIGURE TASK: you also receive the figure image (when available). Return JSON {"figure_kind", "content", "visual_items"}.',
  '- "content" follows the evidence contract: every medical fact cites caption / text evidence aliases (E…). The image itself is NOT evidence.',
  '- "visual_items" describe ONLY what is visibly printed or drawn: labels exactly as printed (label_text), arrows with their direction as drawn (from → to), branches, regions. They are not medical claims.',
  '- Mark certainty "uncertain" for anything not clearly legible. Never invent an arrow, a label or a lesion location; do not localize a lesion you cannot clearly see.',
  '- Keep arrow directions and branching exactly as drawn; do not reorder a flowchart.',
];

async function explainFigure(
  ctx: AppContext,
  base: ArtifactBase,
  body: ExplainBody,
  anchor: SelectionAnchor,
  regions: RegionLite[],
  scope: ScopeReport,
  opts: ExplainOptions,
): Promise<StudyArtifactView> {
  const fc = findFigure(ctx, anchor, regions);
  if (!fc.figure) {
    return publishAbstention(ctx, base, abstainView('not_found_in_scope', 'لم يُعثر على شكل (figure) في التحديد أو الصفحة المحددة ضمن النسخة المقفلة.'));
  }
  const textRegions = [fc.caption, ...fc.labels].filter((r): r is RegionLite => !!r);
  const query = [fc.caption?.text ?? '', anchor.quote?.exact ?? '', body.instruction ?? ''].join(' ').slice(0, 1500);
  const retrieval = {
    query,
    anchor: textRegions.length ? { region_ids: textRegions.map((r) => r.id) } : { page_id: fc.figure.page_id },
    k: 6,
    purpose: 'lecture_explanation' as const,
  };
  const r = retrieveAndPack(ctx, scope, retrieval);
  if (r.kind === 'abstain') return publishAbstention(ctx, base, r.abstain);

  let image: ProviderImage | null = null;
  if (fc.imageFileId) {
    const f = ctx.db.get<{ mime: string }>('SELECT mime FROM stored_file WHERE id = ?', [fc.imageFileId]);
    if (f && /^image\/(png|jpeg)$/.test(f.mime)) {
      try {
        image = { mime: f.mime, data: await ctx.files.read(fc.imageFileId) };
      } catch {
        image = null;
      }
    }
  }
  const visionAvailable = !!image && ctx.ai.isAvailable('vision_figure');
  const selection = selectionText(anchor, regions) || fc.caption?.text || '';
  const leading: UntrustedBlock[] = [];
  if (selection) leading.push({ label: 'SELECTION / FIGURE CAPTION (from the source)', text: selection });
  if (fc.labels.length) leading.push({ label: 'FIGURE LABELS READ BY OCR (uncertain)', text: fc.labels.map((l) => l.text).join('\n') });
  const input: SingleShotInput = {
    ...base,
    retrieval,
    call: {
      task: visionAvailable ? 'vision_figure' : 'explain',
      style: body.style,
      taskText: ACTION_TEXT.explain_image,
      ownerInstruction: body.instruction ?? null,
      leading,
      jobId: opts.jobId,
      signal: opts.signal,
      terms: termsForTexts(ctx, [selection]),
    },
    defaultRegionIds: [fc.figure.id, ...textRegions.map((x) => x.id)],
  };
  base.params.vision_used = visionAvailable;

  if (!visionAvailable) {
    // text-only: caption / OCR labels, clearly marked as such
    const why = !image ? 'لا توجد صورة مقتطعة لهذا الشكل' : 'خدمة الرؤية (vision) غير متاحة على الخادم';
    input.appendBlocks = (res: ProcessResult) => [warningBlock(ctx, `شُرح الشكل من تعليقه ونصوصه المقروءة آليًا فقط (${why})؛ لم يُحلَّل بصريًا، فلا تُستنتج منه أسهم أو مواضع.`, res.blocks.length, fc)];
    const { content, model } = await callModel(ctx, scope, base.rules, r.packed, input.call);
    return publishGenerated(ctx, input, r.packed, content, model);
  }

  const prompt = buildExplanationPrompt({ rules: base.rules, style: body.style, task: ACTION_TEXT.explain_image, ownerInstruction: body.instruction ?? null, extra: FIGURE_RULES });
  const res = await ctx.ai.generateStructured({
    task: 'vision_figure',
    schema: figureOutputSchema,
    system: prompt.system,
    input: [...leading, ...r.packed.blocks],
    instruction: prompt.instruction,
    scope,
    sourceVersionIds: [...new Set([...r.packed.versionIds, anchor.version_id])],
    images: [image!],
    maxOutputTokens: 6000,
    rulesVersion: base.rules.rules_version,
    jobId: opts.jobId,
    signal: opts.signal,
    timeoutMs: 240_000,
  });
  base.params.figure_kind = res.output.figure_kind;
  input.appendBlocks = (pr: ProcessResult) => {
    const vb = visualBlock(ctx, res.output.visual_items, fc, pr.blocks.length, true);
    return vb ? [vb] : [];
  };
  return publishGenerated(ctx, input, r.packed, res.output.content, res.model);
}

function warningBlock(ctx: AppContext, text: string, ord: number, fc: FigureContext): PreparedBlock {
  const regionIds = fc.figure ? [fc.figure.id] : [];
  const pages = regionPages(ctx, regionIds);
  return {
    id: newId(ctx.clock.now()),
    block_key: computeBlockKey(null, regionIds, 'warning', 0),
    section_key: null,
    ord,
    kind: 'warning',
    content: richText([paragraphOf([{ text }])]),
    table: null,
    source_region_ids: regionIds,
    status: 'complete',
    verification_status: 'not_applicable',
    meta: { page_ids: pages.page_ids, page_indexes: pages.page_indexes, visual: { items: 0, uncertain: 0, vision_used: false }, not_for_exam_answer: true },
    evidence_ids: [],
  };
}

// ───────── compare (§31) ─────────
export async function compareItems(ctx: AppContext, body: CompareBody, opts: ExplainOptions = {}): Promise<ExplainResponse> {
  const scope = resolveScope(ctx, body.scope);
  const anchor = (body.anchor ?? null) as SelectionAnchor | null;
  if (anchor) assertAnchorInScope(scope, anchor);
  const primarySourceId = anchor?.source_id ?? scope.sourceIds[0] ?? null;
  const rules = resolveRules(ctx, { sourceId: primarySourceId });
  const items = [...new Set(body.items.map((s) => s.trim()))];
  const key = cacheKey(ctx, {
    kind: 'comparison',
    scope,
    rulesVersion: rules.rules_version,
    generatorVersion: GENERATOR_VERSION,
    verifierVersion: VERIFIER_VERSION,
    level: rules.level,
    language: 'ar',
    dialect: rules.dialect,
    settings: keySettings(ctx, 'compare', { style: body.style }),
    params: { items, anchor: anchor ? normalizedAnchor(anchor) : null, instruction: body.instruction?.trim() || null },
  });
  const base: ArtifactBase = {
    kind: 'comparison',
    title: `مقارنة: ${items.map((i) => shorten(i, 40)).join(' × ')}`,
    primarySourceId,
    scope,
    rules,
    cacheKey: key,
    params: { items, style: body.style, level: rules.level, instruction: body.instruction?.trim() || null, language: 'ar' },
    anchor,
  };
  if (isRealPatientRequest(body.instruction) || items.some((i) => isRealPatientRequest(i))) return { artifact: publishAbstention(ctx, base, realPatientAbstain()), cached: false };
  requireAi(ctx, 'compare');
  const cached = findReusable(ctx, key, 'comparison');
  if (cached) return { artifact: artifactView(ctx, cached), cached: true };

  // retrieve per item so each side gets its own evidence (never only the first item's)
  const notFound: string[] = [];
  const packs = items.map((it) => {
    const r = retrieveAndPack(ctx, scope, { query: it, anchor: null, k: 6, purpose: 'lecture_explanation', maxEvidence: 10 });
    if (r.kind === 'abstain') notFound.push(it);
    return r;
  });
  const okPacks = packs.filter((p): p is Extract<typeof p, { kind: 'ok' }> => p.kind === 'ok');
  if (okPacks.length === 0) {
    const first = packs[0] as Extract<(typeof packs)[number], { kind: 'abstain' }>;
    return { artifact: publishAbstention(ctx, base, first.abstain), cached: false };
  }
  // merge into one pack with fresh aliases
  const allViews = new Map<string, (typeof okPacks)[number]['packed']['pack']['views'][number]>();
  for (const p of okPacks) for (const v of p.packed.pack.views) if (!allViews.has(v.id)) allViews.set(v.id, v);
  const views = [...allViews.values()].slice(0, 24);
  const aliasMap: Record<string, string> = {};
  const forModel = views.map((v, i) => {
    aliasMap[`E${i + 1}`] = v.id;
    return { alias: `E${i + 1}`, source_label: `${v.source_title} — ${v.locator_label_ar}`, quote: v.quote.slice(0, 2400) };
  });
  const packed = {
    pack: { aliasMap, regionAliases: {}, views },
    candidates: [],
    blocks: forModel.map((e) => ({ label: `evidence ${e.alias} — ${e.source_label}`, text: `[${e.alias}]\n${e.quote}` })),
    versionIds: [...new Set(views.map((v) => v.version_id))],
  };
  const header = ['الجانب', ...items];
  const input: SingleShotInput = {
    ...base,
    retrieval: { query: items.join(' '), anchor: null, k: 6, purpose: 'lecture_explanation' },
    call: {
      task: 'compare',
      style: body.style,
      taskText: [
        `Compare: ${items.join(' vs ')}.`,
        `Output ONE "comparison_table" block whose header is exactly ${JSON.stringify(header)}; one row per aspect (definition, location, mechanism, presentation, investigations, complications, management — only aspects the evidence covers for at least one item).`,
        'First cell of each row = the aspect name in Arabic (claim null). Other cells = one sentence with a claim citing evidence, or exactly «غير مذكور في المصادر المسموحة» with claim null when the evidence does not cover it for that item.',
        'You may add one short "paragraph" block after the table with the key distinguishing point (with claims).',
      ].join('\n'),
      ownerInstruction: body.instruction ?? null,
      jobId: opts.jobId,
      signal: opts.signal,
      terms: termsForTexts(ctx, items),
    },
    defaultRegionIds: anchor?.region_ids ?? [],
  };
  const { content, model } = await callModel(ctx, scope, rules, packed, input.call);
  const art = await publishGenerated(ctx, input, packed, content, model);
  if (notFound.length && art.abstain === null) {
    ctx.db.run(`UPDATE artifact SET coverage_json = json_set(COALESCE(coverage_json, '{}'), '$.missing_ar', json(?)) WHERE id = ?`, [
      JSON.stringify([...(art.coverage?.missing_ar ?? []), ...notFound.map((n) => `لم أجد «${n}» في النطاق المسموح.`)]),
      art.id,
    ]);
    return { artifact: artifactView(ctx, art.id), cached: false };
  }
  return { artifact: art, cached: false };
}
