// Generated content → validated, published content blocks (§10, §12, §19, §24, ARCHITECTURE §3.6).
//
//  1. rules post-filter: block kinds the owner disabled are dropped; LITERAL style keeps verbatim quotes only
//  2. every block's sentences (and comparison-table cells) go through validateClaims (evidence module):
//     unknown aliases / out-of-scope evidence / critical-token mismatches / unsupported → removed (reported in
//     `removed`, never softened); kept claims carry their claim id on every RichText run
//  3. template post-check: a heading left without content is dropped (a template never justifies invented
//     fields) and reported as «not covered»
//  4. generated examples / memory hooks / self-check questions get a visible server label
//  5. block_key = hash(section, explained region ids, kind, ordinal) — stable across regenerations of the same
//     source version, so semantic anchors (notes) keep resolving (AC-22)
import {
  GENERATED_EXAMPLE_LABEL_AR,
  MEMORY_HOOK_LABEL_AR,
  MINI_QUESTION_LABEL_AR,
  normalizeForSearch,
  richTextToPlain,
  type AnswerStyle,
  type ContentBlockView,
  type EvidenceView,
  type ExplanationRules,
  type GeneratedSentence,
  type Paragraph,
  type ResolvedScope,
  type RichText,
  type StudyBlockMeta,
  type VerificationStatus,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { sha256 } from '../../lib/hash';
import { newId } from '../../lib/ids';
import { recordDependencies, validateClaims, type AliasMap, type SentenceResult } from '../evidence/services';
import type { GeneratedBlockOut, GeneratedContentOut } from './schema';
import { labelParagraph, paragraphOf, richText, type SentencePiece } from './text';

export interface PackContext {
  aliasMap: AliasMap;
  /** R1… → region id (regions the request asked to explain) */
  regionAliases: Record<string, string>;
  views: EvidenceView[];
}

export interface PreparedBlock {
  id: string;
  block_key: string;
  section_key: string | null;
  ord: number;
  kind: ContentBlockView['kind'];
  content: RichText;
  table: { header: RichText[]; rows: RichText[][] } | null;
  source_region_ids: string[];
  status: 'complete' | 'incomplete';
  verification_status: ContentBlockView['verification_status'];
  meta: StudyBlockMeta | null;
  /** evidence ids of kept claims (dependencies) */
  evidence_ids: string[];
}

export interface ProcessOptions {
  sectionKey: string | null;
  sectionTitle?: string | null;
  scope: ResolvedScope;
  rules: ExplanationRules;
  style: AnswerStyle;
  pack: PackContext;
  /** regions a block explains when the model did not say (anchor / section regions) */
  defaultRegionIds: string[];
  ordBase?: number;
  jobId?: string;
  signal?: AbortSignal;
}

export interface ProcessResult {
  blocks: PreparedBlock[];
  removed: Array<{ text: string; reason_ar: string }>;
  counts: Record<VerificationStatus | 'not_applicable', number>;
  /** template headings dropped because nothing under them survived (reported as not covered) */
  droppedHeadings: string[];
  citedEvidenceIds: string[];
  entailment: { used: boolean; model: string | null; reason_ar: string | null };
  /** medical sentences that survived verification */
  keptMedical: number;
}

const LITERAL_REASON = 'النمط الحرفي يعرض اقتباسات حرفية من المصدر فقط؛ حُذفت هذه الصياغة.';
const CELL_REMOVED = 'غير مثبت في المصادر المسموحة';
const UNCITED_REASON =
  'جملة بلا دليل مرفق داخل محتوى طبي؛ حُذفت لأنها قد تحمل معلومة غير مستندة. تُنشر دون دليل جمل الربط القصيرة والأسئلة الموجّهة للمتعلم فقط.';

/**
 * Block kinds whose claim-less sentences are not medical statements by nature: section headings, a self-check
 * question, a mnemonic (labelled as such by the server; the facts it helps remember carry their own claims), and
 * a coverage note (what the sources do NOT cover).
 */
const CLAIMLESS_KINDS = new Set<GeneratedBlockOut['kind']>(['heading', 'mini_question', 'memory_hook', 'coverage_note']);

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Words a pure transition / lead-in is made of (normalized with normalizeForSearch: no harakat, ا/ي/ه unified).
 * Deliberately small: it holds discourse words, pronouns / prepositions and the names of template sections — no
 * medical noun, verb or adjective and no negation — so a phrase made ONLY of these words cannot state a fact.
 */
const CONNECTIVE_WORDS = new Set(
  [
    // Arabic (MSA + the Iraqi teaching tone the rules allow)
    'لنر', 'لنري', 'نري', 'سنري', 'دعنا', 'دعونا', 'خلي', 'خلينا', 'نشوف', 'شوف', 'ليش', 'لماذا', 'ليه', 'اذن', 'الان', 'هسه', 'هسا', 'الحين',
    'بعباره', 'اخري', 'ابسط', 'بمعني', 'يعني', 'باختصار', 'ببساطه', 'اولا', 'ثانيا', 'ثالثا', 'رابعا', 'اخيرا', 'مثلا', 'لاحظ', 'لاحظي',
    'تذكر', 'تذكري', 'انتبه', 'انتبهي', 'ركز', 'ركزي', 'هنا', 'هيا', 'حسنا', 'طيب', 'تمام', 'خلاصه', 'الخلاصه', 'النقطه', 'الفكره', 'التاليه',
    'التالي', 'كالتالي', 'كما', 'يلي', 'فيما', 'نبدا', 'لنبدا', 'سنبدا', 'نشرح', 'لنشرح', 'سنشرح', 'بالتفصيل', 'خطوه', 'بخطوه', 'معا', 'سويه',
    'ننتقل', 'لننتقل', 'ننظر', 'لننظر', 'نتعرف', 'لنتعرف', 'نفهم', 'لنفهم', 'نراجع', 'لنراجع', 'نتذكر', 'لنتذكر', 'هذا', 'هذه', 'ذلك', 'تلك',
    'هو', 'هي', 'الي', 'علي', 'في', 'من', 'عن', 'مع', 'ثم', 'او', 'لكن', 'بل', 'اي', 'كيف', 'السبب', 'السوال', 'الجواب', 'الاجابه', 'الشرح',
    'المثال', 'الموضوع', 'القسم', 'الجزء', 'الفقره', 'الاسباب', 'الاعراض', 'العلامات', 'التشخيص', 'العلاج', 'الفحوصات', 'المضاعفات', 'التعريف',
    'الاليه', 'الاهم', 'المهم', 'مهم', 'جدا',
    // English lead-ins
    "let's", 'lets', 'let', 'us', 'see', 'why', 'now', 'so', 'in', 'other', 'words', 'first', 'second', 'next', 'then', 'finally', 'for',
    'example', 'note', 'remember', 'here', 'the', 'idea', 'step', 'by', 'okay', 'ok', 'summary', 'recap', 'to', 'sum', 'up', 'we', 'will',
    'look', 'at', 'this', 'that', 'how', 'what', 'and', 'a',
  ].map((w) => normalizeForSearch(w)),
);

/** Placeholders the comparison prompt prescribes for a cell the sources do not cover (and the server's own). */
const NOT_COVERED_PHRASES = new Set(['غير مذكور في المصادر المسموحة', CELL_REMOVED].map((p) => normalizeForSearch(p)));

function connectiveWord(w: string): boolean {
  if (CONNECTIVE_WORDS.has(w)) return true;
  // a conjunction / preposition glued to the word: و ف ب ل ك, optionally followed by «ال»
  const m = /^[وفبلك](.+)$/u.exec(w);
  return !!m && (CONNECTIVE_WORDS.has(m[1]!) || CONNECTIVE_WORDS.has(`ال${m[1]!}`));
}

/**
 * Review hardening (§0.1, AC-29): the evidence module keeps a claim-less sentence as «connective text» unless it
 * carries a value / threshold — it cannot decide «medical» reliably. A generator (or an instruction injected into
 * an uploaded document) could therefore publish a medical statement simply by omitting its claim — and a short
 * Arabic statement («الزائدة الملتهبة لا تحتاج جراحة.») has no digit or Latin letter to catch. Inside medical
 * content blocks this module only lets through what is recognisably NOT a statement of fact: a question to the
 * learner, the prescribed «not covered» placeholder, or a short phrase (≤ 6 words) made only of connective words
 * (CONNECTIVE_WORDS). Everything else is removed and reported, like any other unsupported sentence.
 */
export function isConnectiveText(text: string): boolean {
  const t = text.trim().replace(/[\s.»"'”)\]:،,؛;!…-]+$/u, '');
  if (!t) return true;
  if (/[?؟]$/u.test(t)) return true;
  const norm = normalizeForSearch(t).replace(/\s+/g, ' ').trim();
  if (NOT_COVERED_PHRASES.has(norm)) return true;
  if (/[0-9]/.test(norm)) return false;
  const words = norm.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (words.length === 0) return true;
  return words.length <= 6 && words.every(connectiveWord);
}

/** A comparison table's first column names the aspect (e.g. «Mechanism», «الجرعة») — a label, not a claim. */
function isAspectLabel(text: string): boolean {
  return wordCount(text) <= 6 && !/[0-9٠-٩۰-۹]/.test(text);
}

const LABELS: Partial<Record<ContentBlockView['kind'], string>> = {
  example: `${GENERATED_EXAMPLE_LABEL_AR} — مؤلَّف للتعليم، ليس من المصدر ولا لمريض حقيقي`,
  memory_hook: MEMORY_HOOK_LABEL_AR,
  mini_question: MINI_QUESTION_LABEL_AR,
};

function disabledByRules(kind: GeneratedBlockOut['kind'], rules: ExplanationRules): boolean {
  const i = rules.include;
  return (
    (kind === 'memory_hook' && !i.memory_hooks) ||
    (kind === 'clinical_note' && !i.clinical_notes) ||
    (kind === 'exam_pearl' && !i.exam_pearls) ||
    (kind === 'mini_question' && !i.mini_questions) ||
    (kind === 'example' && !i.examples)
  );
}

export function computeBlockKey(sectionKey: string | null, regionIds: string[], kind: string, ordinal: number): string {
  return `b${sha256(`${sectionKey ?? 'main'}|${[...regionIds].sort().join(',')}|${kind}|${ordinal}`).slice(0, 20)}`;
}

/** Pages of the original that regions sit on (Lecture Twin). */
export function regionPages(ctx: AppContext, regionIds: string[]): { page_ids: string[]; page_indexes: number[] } {
  if (regionIds.length === 0) return { page_ids: [], page_indexes: [] };
  const rows = ctx.db.all<{ page_id: string; page_index: number }>(
    `SELECT DISTINCT p.id AS page_id, p.page_index FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.id IN (${regionIds.map(() => '?').join(',')}) ORDER BY p.page_index`,
    regionIds,
  );
  return { page_ids: rows.map((r) => r.page_id), page_indexes: rows.map((r) => r.page_index) };
}

function aggregateStatus(results: SentenceResult[]): ContentBlockView['verification_status'] {
  const st = results.filter((r) => r.keep && r.status !== 'not_applicable').map((r) => r.status);
  if (st.length === 0) return 'not_applicable';
  if (st.includes('conflict')) return 'conflict';
  if (st.includes('needs_review')) return 'needs_review';
  if (st.includes('pending')) return 'pending';
  if (st.every((s) => s === 'linked' || s === 'owner_reviewed')) return 'linked';
  return 'needs_review';
}

function piece(r: SentenceResult, s: GeneratedSentence): SentencePiece {
  const claimId = r.keep && r.claim_id && r.status !== 'rejected' ? r.claim_id : null;
  return { text: s.text, claimId, originalQuote: !!s.original_quote && !!claimId, evidenceIds: claimId ? r.evidence_ids : [] };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Validate and shape generated blocks. Nothing is written except claims/verification rows (evidence module). */
export async function processGenerated(ctx: AppContext, content: GeneratedContentOut, o: ProcessOptions): Promise<ProcessResult> {
  const removed: ProcessResult['removed'] = [];
  const counts: ProcessResult['counts'] = { pending: 0, linked: 0, needs_review: 0, conflict: 0, rejected: 0, owner_reviewed: 0, not_applicable: 0 };
  const evidenceRegion = new Map(o.pack.views.map((v) => [v.id, v.region_id]));
  let entailment: ProcessResult['entailment'] = { used: false, model: null, reason_ar: null };

  // 1) rules post-filter
  const input = content.blocks
    .filter((b) => !disabledByRules(b.kind, o.rules))
    .map((b) => {
      if (o.style !== 'literal') return b;
      const keep = b.sentences.filter((s) => s.original_quote && s.claim);
      for (const s of b.sentences) if (!(s.original_quote && s.claim)) removed.push({ text: s.text, reason_ar: LITERAL_REASON });
      return { ...b, kind: 'original_quote' as const, sentences: keep, table: null };
    })
    // claim-less sentences inside medical content: only questions / short connective phrases (see isConnectiveText);
    // «original quotes» without a claim are left to validateClaims, which rejects them with its own reason
    .map((b) => {
      if (CLAIMLESS_KINDS.has(b.kind)) return b;
      const sentences = b.sentences.filter((s) => {
        if (s.claim || s.original_quote || isConnectiveText(s.text)) return true;
        removed.push({ text: s.text, reason_ar: UNCITED_REASON });
        return false;
      });
      const table = b.table
        ? {
            ...b.table,
            rows: b.table.rows.map((row) =>
              row.map((cell, c) => {
                if (cell.claim || cell.original_quote || (c === 0 ? isAspectLabel(cell.text) : isConnectiveText(cell.text))) return cell;
                removed.push({ text: cell.text, reason_ar: UNCITED_REASON });
                return { text: CELL_REMOVED, claim: null };
              }),
            ),
          }
        : b.table;
      return { ...b, sentences, table };
    })
    .filter((b) => b.sentences.length > 0 || (b.table?.rows.length ?? 0) > 0);

  // 2) validation per block (claims owned by the content block), bounded concurrency
  const validated = await mapLimit(input, 3, async (b) => {
    const id = newId(ctx.clock.now());
    const flat: GeneratedSentence[] = [...b.sentences];
    const cellIndex: Array<[number, number]> = [];
    for (const [r, row] of (b.table?.rows ?? []).entries()) {
      for (const [c, cell] of row.entries()) {
        flat.push(cell);
        cellIndex.push([r, c]);
      }
    }
    if (flat.length === 0) return { id, b, results: [] as SentenceResult[], cellIndex };
    const v = await validateClaims(ctx, { ownerType: 'content_block', ownerId: id, sentences: flat, aliasMap: o.pack.aliasMap, scope: o.scope, jobId: o.jobId, signal: o.signal });
    if (v.entailment.used || !entailment.used) entailment = v.entailment;
    return { id, b, results: v.sentences, cellIndex };
  });

  // 3) shape blocks
  type Draft = Omit<PreparedBlock, 'block_key' | 'ord' | 'section_key'> & { headingText: string | null };
  const drafts: Draft[] = [];
  const cited = new Set<string>();
  let keptMedical = 0;
  for (const { id, b, results, cellIndex } of validated) {
    const nSentences = b.sentences.length;
    const sentRes = results.slice(0, nSentences);
    const cellRes = results.slice(nSentences);
    for (const r of results) {
      counts[r.status]++;
      if (!r.keep) removed.push({ text: r.text, reason_ar: r.reason_ar ?? 'لم تجتز الجملة التحقق من الأدلة.' });
      else if (r.medical) {
        keptMedical++;
        for (const e of r.evidence_ids) cited.add(e);
      }
    }
    const kept = sentRes.map((r, i) => ({ r, s: b.sentences[i]! })).filter((x) => x.r.keep);
    const pieces = kept.map((x) => piece(x.r, x.s));
    const paragraphs: Array<Paragraph | null> = [];
    const label = LABELS[b.kind];
    let kind: ContentBlockView['kind'] = b.kind;
    if (b.kind === 'heading') paragraphs.push(paragraphOf(pieces, 'h', 2));
    else if (b.kind === 'list' || b.kind === 'flowchart') for (const p of pieces) paragraphs.push(paragraphOf([p], 'li'));
    else if (b.kind === 'original_quote') paragraphs.push(paragraphOf(pieces.map((p) => ({ ...p, originalQuote: !!p.claimId })), 'quote'));
    else paragraphs.push(paragraphOf(pieces));
    const hasBody = paragraphs.some((p) => p !== null);

    let table: PreparedBlock['table'] = null;
    if (b.kind === 'comparison_table' && b.table) {
      const header = b.table.header.map((h) => richText([paragraphOf([{ text: h }])]));
      const rows: RichText[][] = b.table.rows.map((row) => row.map(() => richText([])));
      cellIndex.forEach(([r, c], k) => {
        const res = cellRes[k]!;
        const cell = b.table!.rows[r]![c]!;
        rows[r]![c] = res.keep ? richText([paragraphOf([piece(res, cell)])]) : richText([paragraphOf([{ text: CELL_REMOVED }])]);
      });
      const anyKeptCell = cellRes.some((r) => r.keep && r.medical);
      if (anyKeptCell) table = { header, rows };
      kind = 'comparison_table';
    }
    if (!hasBody && !table) continue; // nothing survived → block not published (its sentences are in `removed`)
    if (label) paragraphs.unshift(labelParagraph(label));

    // regions the block explains: model-declared R-aliases → cited evidence regions → request default
    let regionIds = (b.explains_regions ?? []).map((a) => (Object.prototype.hasOwnProperty.call(o.pack.regionAliases, a) ? o.pack.regionAliases[a]! : null)).filter((x): x is string => !!x);
    if (regionIds.length === 0) {
      const fromEvidence = results.filter((r) => r.keep).flatMap((r) => r.evidence_ids.map((e) => evidenceRegion.get(e) ?? null)).filter((x): x is string => !!x);
      const allowed = new Set(o.defaultRegionIds);
      regionIds = o.defaultRegionIds.length ? fromEvidence.filter((x) => allowed.has(x)) : fromEvidence;
    }
    if (regionIds.length === 0) regionIds = [...o.defaultRegionIds];
    regionIds = [...new Set(regionIds)];

    drafts.push({
      id,
      kind,
      content: richText(paragraphs),
      table,
      source_region_ids: regionIds,
      status: 'complete',
      verification_status: aggregateStatus(results),
      meta: label ? { label_ar: label } : null,
      evidence_ids: [...new Set(results.filter((r) => r.keep).flatMap((r) => r.evidence_ids))],
      headingText: b.kind === 'heading' ? kept.map((x) => x.s.text).join(' ').trim() : null,
    });
  }

  // 4) template post-check: headings with nothing under them are dropped and reported as not covered
  const droppedHeadings: string[] = [];
  const finalDrafts: Draft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i]!;
    if (d.kind === 'heading') {
      const next = drafts[i + 1];
      if (!next || next.kind === 'heading') {
        if (d.headingText) droppedHeadings.push(d.headingText);
        continue;
      }
    }
    finalDrafts.push(d);
  }

  // 5) keys, order, section titles, pages
  const ordBase = o.ordBase ?? 0;
  const ordinals = new Map<string, number>();
  let currentHeading: string | null = o.sectionTitle ?? null;
  const blocks: PreparedBlock[] = finalDrafts.map((d, i) => {
    if (d.kind === 'heading' && d.headingText) currentHeading = d.headingText;
    const sig = `${[...d.source_region_ids].sort().join(',')}|${d.kind}`;
    const n = ordinals.get(sig) ?? 0;
    ordinals.set(sig, n + 1);
    const pages = regionPages(ctx, d.source_region_ids);
    const meta: StudyBlockMeta = { ...(d.meta ?? {}), section_title: currentHeading, page_ids: pages.page_ids, page_indexes: pages.page_indexes };
    const { headingText: _h, ...rest } = d;
    return { ...rest, section_key: o.sectionKey, ord: ordBase + i, block_key: computeBlockKey(o.sectionKey, d.source_region_ids, d.kind, n), meta };
  });

  return { blocks, removed, counts, droppedHeadings, citedEvidenceIds: [...cited], entailment, keptMedical };
}

/** Write a section's blocks (replacing any earlier blocks of the same section) — call inside a transaction. */
export function writeBlocks(ctx: AppContext, artifactId: string, sectionKey: string | null, blocks: PreparedBlock[]): void {
  const now = ctx.clock.now();
  if (sectionKey === null) ctx.db.run('DELETE FROM content_block WHERE artifact_id = ? AND section_key IS NULL', [artifactId]);
  else ctx.db.run('DELETE FROM content_block WHERE artifact_id = ? AND section_key = ?', [artifactId, sectionKey]);
  for (const b of blocks) {
    ctx.db.run(
      `INSERT INTO content_block (id, artifact_id, block_key, section_key, ord, kind, content_json, source_region_ids_json, status, verification_status, created_at, table_json, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.id, artifactId, b.block_key, b.section_key, b.ord, b.kind, toJson(b.content), toJson(b.source_region_ids), b.status, b.verification_status, now, b.table ? toJson(b.table) : null, b.meta ? toJson(b.meta) : null],
    );
  }
}

/** Dependencies of blocks + artifact: the versions/regions of cited evidence and the explained regions (§18). */
export function recordBlockDependencies(ctx: AppContext, artifactId: string, blocks: PreparedBlock[], baseVersionIds: string[]): void {
  const evIds = [...new Set(blocks.flatMap((b) => b.evidence_ids))];
  const evRows = evIds.length
    ? ctx.db.all<{ id: string; version_id: string; region_id: string | null }>(`SELECT id, version_id, region_id FROM evidence WHERE id IN (${evIds.map(() => '?').join(',')})`, evIds)
    : [];
  const byId = new Map(evRows.map((e) => [e.id, e]));
  const allVersions = new Set(baseVersionIds);
  const allRegions = new Set<string>();
  for (const b of blocks) {
    const versions = new Set<string>();
    const regions = new Set<string>(b.source_region_ids);
    for (const e of b.evidence_ids) {
      const row = byId.get(e);
      if (!row) continue;
      versions.add(row.version_id);
      if (row.region_id) regions.add(row.region_id);
    }
    for (const v of versions) allVersions.add(v);
    for (const r of regions) allRegions.add(r);
    recordDependencies(ctx, 'content_block', b.id, [...versions, ...baseVersionIds], [...regions]);
  }
  recordDependencies(ctx, 'artifact', artifactId, [...allVersions], [...allRegions]);
}

/** Universal search: the artifact's text as a normalized key, origin 'generated' (never evidence). */
export function indexArtifact(ctx: AppContext, artifactId: string): void {
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'artifact' AND entity_id = ?`, [artifactId]);
  const a = ctx.db.get<{ title: string | null }>('SELECT title FROM artifact WHERE id = ?', [artifactId]);
  if (!a) return;
  const rows = ctx.db.all<{ content_json: string; table_json: string | null }>('SELECT content_json, table_json FROM content_block WHERE artifact_id = ? ORDER BY ord', [artifactId]);
  const parts = [a.title ?? ''];
  for (const r of rows) {
    parts.push(richTextToPlain(JSON.parse(r.content_json) as RichText));
    if (r.table_json) {
      const t = JSON.parse(r.table_json) as { header: RichText[]; rows: RichText[][] };
      parts.push([...t.header, ...t.rows.flat()].map((x) => richTextToPlain(x)).join(' '));
    }
  }
  const text = normalizeForSearch(parts.filter(Boolean).join('\n'));
  if (!text.trim()) return;
  ctx.db.run(`INSERT INTO owner_content_fts (entity_type, entity_id, origin, text) VALUES ('artifact', ?, 'generated', ?)`, [artifactId, text]);
}

export function unindexArtifact(ctx: AppContext, artifactId: string): void {
  ctx.db.run(`DELETE FROM owner_content_fts WHERE entity_type = 'artifact' AND entity_id = ?`, [artifactId]);
}
