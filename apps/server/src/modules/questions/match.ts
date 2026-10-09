// Lecture ↔ question matching (§35, AC-16). Deterministic and incremental: a new lecture is matched against the
// questions of its course; a new question source against the lectures of its course. Signals:
//   * normalized FTS over the LECTURE VERSION's chunks only (version filter in the same SQL as MATCH — scope
//     before ranking), with the stem's specific terms + the correct option's terms;
//   * concept candidates of the lecture (headings, table first column, captions, capitalized terms) found in the
//     question;
//   * where the answer is located: the correct option (or, for NOT/EXCEPT questions, the other options) in the
//     same passage as the question's topic → «directly covered / answerable from the lecture».
// Relations: directly_covered / strongly_related / partially_covered / course_related_only, with an Arabic reason
// naming the matched terms and the lecture pages. The owner's accept/reject decisions are never overridden.
import { normalizeForSearch, type LectureLinkRelation } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import { extractConceptCandidates, lectureConcepts, type LectureConcept } from './concepts';
import { syncReviewItems } from './review';
import { correctOptionKeys, currentVersion, optionRows, pageLabel, stemText, type QuestionRow } from './store';
import { contentTokens, normPhrase, type Token } from './text';
import { richTextToPlain, type RichText } from '@medlevo/shared';

export const MATCHER_VERSION = 'qmatch-v1';
const LECTURE_TYPES = ['lecture'];
const PROCESSED = ['ready', 'partial', 'needs_review'];

interface Chunk {
  id: string;
  text: string;
  norm: string;
  /** heading path + text (matching) */
  stems: Set<string>;
  /** text only (page attribution: every chunk carries the lecture title in its heading path) */
  bodyStems: Set<string>;
  pageIds: string[];
  rank: number;
}

interface PageLite {
  id: string;
  page_index: number;
  printed_label: string | null;
  kind: string;
}

export interface LectureTarget {
  sourceId: string;
  title: string;
  versionId: string;
  concepts: LectureConcept[];
  pages: Map<string, PageLite>;
}

export interface MatchResult {
  relation: LectureLinkRelation;
  score: number;
  answerable: boolean;
  reason: string;
  matchedTerms: string[];
  lecturePageIds: string[];
  conceptIds: string[];
}

function stemSet(text: string): Set<string> {
  return new Set(contentTokens(text).map((t) => t.stem));
}

function chunksFor(ctx: AppContext, versionId: string, terms: Token[]): Chunk[] {
  const parts = [...new Set(terms.map((t) => t.norm.replace(/"/g, '""')))]
    .filter((t) => t.length >= 2)
    .slice(0, 40)
    .map((t) => (t.length >= 5 ? `"${t.slice(0, Math.max(4, t.length - 2))}"*` : `"${t}"`));
  if (parts.length === 0) return [];
  // scope (this lecture version) is in the same statement as MATCH: nothing outside it is ranked
  const rows = ctx.db.all<{ id: string; text: string; heading_path: string | null; page_ids_json: string; rank: number }>(
    `SELECT c.id, c.text, c.heading_path, c.page_ids_json, bm25(chunk_fts) AS rank
       FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid
      WHERE chunk_fts MATCH ? AND c.version_id = ?
      ORDER BY rank LIMIT 16`,
    [parts.join(' OR '), versionId],
  );
  return rows.map((r) => {
    const text = `${r.heading_path ?? ''}\n${r.text}`;
    return {
      id: r.id,
      text,
      norm: normPhrase(text),
      stems: stemSet(text),
      bodyStems: stemSet(r.text),
      pageIds: fromJson<string[]>(r.page_ids_json, []) ?? [],
      rank: r.rank,
    };
  });
}

/** Where an option's text is found: phrase containment, or ≥ 60 % of its content words (one of them specific). */
function locate(optionText: string, chunks: Chunk[]): Chunk | null {
  const phrase = normPhrase(optionText);
  const toks = contentTokens(optionText);
  for (const c of chunks) {
    if (phrase.length >= 3 && c.norm.includes(phrase)) return c;
  }
  if (toks.length === 0) return null;
  let best: { c: Chunk; cov: number } | null = null;
  for (const c of chunks) {
    const found = toks.filter((t) => c.stems.has(t.stem));
    const cov = found.length / toks.length;
    if (cov >= 0.6 && found.some((t) => !t.generic) && (!best || cov > best.cov)) best = { c, cov };
  }
  return best?.c ?? null;
}

function conceptInText(concept: LectureConcept, tokens: Set<string>): boolean {
  const parts = concept.key.split(' ').filter(Boolean);
  return parts.length > 0 && parts.every((p) => tokens.has(p));
}

const list = (xs: string[]) => [...new Set(xs)].slice(0, 6).join('، ');

export function matchOne(ctx: AppContext, lecture: LectureTarget, q: QuestionRow): MatchResult | null {
  const v = currentVersion(ctx, q);
  const stem = stemText(v);
  const options = optionRows(ctx, v.id).map((o) => ({ key: o.option_key, label: o.source_label, text: richTextToPlain(fromJson<RichText | null>(o.text_json, null)) }));
  const keyKnown = ['source_key', 'owner_key', 'ai_derived'].includes(v.answer_status);
  const correct = keyKnown ? (correctOptionKeys(ctx, v) ?? []) : [];
  const negation = v.has_negation === 1;
  const answerOpts = options.filter((o) => correct.includes(o.key));
  const otherOpts = options.filter((o) => !correct.includes(o.key));

  const stemToks = contentTokens(stem);
  const specific = stemToks.filter((t) => !t.generic);
  const generic = stemToks.filter((t) => t.generic);
  const evidenceOpts = keyKnown ? (negation ? otherOpts : answerOpts) : [];
  const evidenceToks = evidenceOpts.flatMap((o) => contentTokens(o.text));
  const questionStems = new Set([...stemToks, ...evidenceToks].map((t) => t.stem));

  const conceptHits = lecture.concepts.filter((c) => conceptInText(c, questionStems));
  const ftsTerms = [...specific, ...evidenceToks, ...conceptHits.flatMap((c) => contentTokens(c.name)), ...(keyKnown ? [] : options.flatMap((o) => contentTokens(o.text)))];
  const chunks = chunksFor(ctx, lecture.versionId, ftsTerms.length ? ftsTerms : generic);
  if (chunks.length === 0) return null;

  const inLecture = (t: Token) => chunks.some((c) => c.stems.has(t.stem));
  const specificHits = specific.filter(inLecture);
  const genericHits = generic.filter(inLecture);
  const topicalIn = (c: Chunk) =>
    specific.some((t) => c.stems.has(t.stem)) || conceptHits.some((k) => k.key.split(' ').every((p) => c.stems.has(p)));

  // where is the answer?
  let answerChunk: Chunk | null = null;
  let located: string[] = [];
  if (keyKnown && answerOpts.length > 0) {
    if (negation) {
      // NOT / EXCEPT: the lecture lists the items that ARE true; the answer is the one it does not list
      const byChunk = new Map<string, { c: Chunk; opts: string[] }>();
      for (const o of otherOpts) {
        const c = locate(o.text, chunks);
        if (!c) continue;
        const e = byChunk.get(c.id) ?? { c, opts: [] };
        e.opts.push(o.text);
        byChunk.set(c.id, e);
      }
      const best = [...byChunk.values()].sort((a, b) => b.opts.length - a.opts.length)[0];
      const needed = Math.min(2, otherOpts.length);
      if (best && best.opts.length >= needed && !answerOpts.some((o) => best.c.norm.includes(normPhrase(o.text)))) {
        answerChunk = best.c;
        located = best.opts;
      }
    } else {
      for (const o of answerOpts) {
        const c = locate(o.text, chunks);
        if (c) {
          answerChunk = c;
          located.push(o.text);
        }
      }
    }
  }
  const optionsFound = keyKnown ? [] : options.filter((o) => locate(o.text, chunks)).map((o) => o.text);
  const coLocated = answerChunk !== null && topicalIn(answerChunk);
  const topical = specificHits.length + conceptHits.length;

  let relation: LectureLinkRelation | null = null;
  if (answerChunk && coLocated && topical >= 1) relation = 'directly_covered';
  else if (topical >= 2) relation = 'strongly_related';
  else if (topical >= 1) relation = 'partially_covered';
  else if (genericHits.length > 0 || optionsFound.length > 0 || located.length > 0) relation = 'course_related_only';
  if (!relation) return null;

  // pages: the answer passage first, then the passages whose TEXT carries most of the question's topic
  const bodyHits = (c: Chunk) =>
    specific.filter((t) => c.bodyStems.has(t.stem)).length + conceptHits.filter((k) => k.key.split(' ').every((p) => c.bodyStems.has(p))).length;
  const pageIds: string[] = [];
  const addPages = (c: Chunk) => c.pageIds.forEach((p) => !pageIds.includes(p) && pageIds.push(p));
  if (answerChunk) addPages(answerChunk);
  const extra = chunks
    .filter((c) => c !== answerChunk && bodyHits(c) > 0)
    .sort((a, b) => bodyHits(b) - bodyHits(a) || a.rank - b.rank);
  for (const c of extra) {
    if (pageIds.length >= (answerChunk ? 3 : 2)) break;
    addPages(c);
  }
  if (pageIds.length === 0) for (const c of chunks.slice(0, 1)) addPages(c);
  const lecturePageIds = pageIds.slice(0, 3);
  const pagesAr = lecturePageIds
    .map((id) => lecture.pages.get(id))
    .filter((p): p is PageLite => !!p)
    .map((p) => pageLabel(p))
    .join('، ');

  // a word already named by a matched concept is not listed again («Alvarado score», not «… ، Alvarado»)
  const conceptStems = new Set(conceptHits.flatMap((c) => c.key.split(' ')));
  const shownSpecific = specificHits.filter((t) => !conceptStems.has(t.stem));
  const termsAr = list([...conceptHits.map((c) => c.name), ...shownSpecific.map((t) => t.surface)]);
  const missingTopic = list(specific.filter((t) => !inLecture(t)).map((t) => t.surface));
  let reason: string;
  if (relation === 'directly_covered') {
    reason = negation
      ? `سؤال بصيغة نفي (${(fromJson<string[]>(v.negation_terms_json, []) ?? []).join('، ')}): الخيارات الأخرى (${list(located)}) مذكورة في المحاضرة مع ${termsAr} (${pagesAr})، والإجابة هي ما لا تذكره المحاضرة.`
      : `الإجابة («${list(located)}») مذكورة في المحاضرة (${pagesAr}) مع مصطلحات السؤال: ${termsAr}.`;
  } else if (relation === 'strongly_related') {
    reason = `مصطلحات السؤال مذكورة في المحاضرة: ${termsAr} (${pagesAr})، ${
      !keyKnown ? 'لكن لا يوجد مفتاح لتأكيد أن الإجابة نفسها في المحاضرة.' : answerChunk ? 'لكن الإجابة مذكورة في موضع آخر غير موضع السؤال.' : 'لكن الإجابة نفسها لم تُوجد في المحاضرة.'
    }`;
  } else if (relation === 'partially_covered') {
    reason = `يشترك مع المحاضرة في ${termsAr} (${pagesAr}) فقط${missingTopic ? `؛ غير مذكور فيها: ${missingTopic}` : ''}.`;
  } else {
    const shared = list([...genericHits.map((t) => t.surface), ...optionsFound, ...located]);
    reason = `من مصادر الكورس نفسه، لكن موضوع السؤال${missingTopic ? ` (${missingTopic})` : ''} غير مذكور في المحاضرة؛ المشترك عام فقط: ${shared}.`;
  }
  const raw = specificHits.length + 1.5 * conceptHits.length + (answerChunk ? 3 : 0) + 0.3 * genericHits.length;
  return {
    relation,
    score: Math.round(Math.min(1, raw / 8) * 1000) / 1000,
    answerable: relation === 'directly_covered',
    reason,
    matchedTerms: [...new Set([...conceptHits.map((c) => c.name), ...shownSpecific.map((t) => t.surface), ...located, ...optionsFound])],
    lecturePageIds,
    conceptIds: conceptHits.map((c) => c.id),
  };
}

function lectureTarget(ctx: AppContext, sourceId: string): LectureTarget | null {
  const s = ctx.db.get<{ id: string; title: string; current_version_id: string | null; frozen_version_id: string | null; deleted_at: number | null; source_type: string }>(
    'SELECT id, title, current_version_id, frozen_version_id, deleted_at, source_type FROM source WHERE id = ?',
    [sourceId],
  );
  if (!s || s.deleted_at !== null || !LECTURE_TYPES.includes(s.source_type)) return null;
  const versionId = s.frozen_version_id ?? s.current_version_id;
  if (!versionId) return null;
  const v = ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [versionId]);
  if (!v || !PROCESSED.includes(v.processing_status)) return null;
  if (!ctx.db.get(`SELECT 1 AS x FROM concept_mention WHERE version_id = ? AND role LIKE 'candidate%' LIMIT 1`, [versionId])) extractConceptCandidates(ctx, versionId);
  const pages = new Map(
    ctx.db.all<PageLite>('SELECT id, page_index, printed_label, kind FROM source_page WHERE version_id = ?', [versionId]).map((p) => [p.id, p]),
  );
  return { sourceId: s.id, title: s.title, versionId, concepts: lectureConcepts(ctx, versionId), pages };
}

/** Store (or refresh) one auto link. Owner decisions (accepted/rejected/owner-made) are never touched. */
function upsertLink(ctx: AppContext, lecture: LectureTarget, q: QuestionRow, m: MatchResult | null): 'created' | 'updated' | 'kept_owner' | 'removed' | 'none' {
  const now = ctx.clock.now();
  const prior = ctx.db.get<{ id: string; origin: string; status: string }>('SELECT id, origin, status FROM question_lecture_link WHERE question_id = ? AND lecture_source_id = ?', [
    q.id,
    lecture.sourceId,
  ]);
  if (prior && (prior.origin === 'owner' || prior.status !== 'suggested')) return 'kept_owner';
  const questionPages = ctx.db.all<{ page_ids_json: string }>(`SELECT page_ids_json FROM question_occurrence WHERE question_id = ? AND status = 'current'`, [q.id]).flatMap((o) => fromJson<string[]>(o.page_ids_json, []) ?? []);
  if (!m) {
    if (prior) {
      ctx.db.run(`DELETE FROM review_queue_item WHERE entity_type = 'question_lecture_link' AND entity_id = ? AND status = 'open'`, [prior.id]);
      ctx.db.run('DELETE FROM question_lecture_link WHERE id = ?', [prior.id]);
      return 'removed';
    }
    return 'none';
  }
  const reasonJson = toJson({ concepts: m.conceptIds, matched_terms: m.matchedTerms, lecture_page_ids: m.lecturePageIds, question_page_ids: questionPages, lecture_version_id: lecture.versionId });
  let id: string;
  let outcome: 'created' | 'updated';
  if (prior) {
    id = prior.id;
    ctx.db.run(
      `UPDATE question_lecture_link SET relation = ?, score = ?, reason = ?, reason_json = ?, answerable_from_lecture = ?, lecture_version_id = ?, matcher_version = ?, updated_at = ?
        WHERE id = ?`,
      [m.relation, m.score, m.reason, reasonJson, m.answerable ? 1 : 0, lecture.versionId, MATCHER_VERSION, now, id],
    );
    outcome = 'updated';
  } else {
    id = newId(now);
    ctx.db.run(
      `INSERT INTO question_lecture_link (id, question_id, lecture_source_id, relation, score, reason, reason_json, answerable_from_lecture, origin, status,
         decision_reason, created_at, updated_at, lecture_version_id, matcher_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'suggested', NULL, ?, ?, ?, ?)`,
      [id, q.id, lecture.sourceId, m.relation, m.score, m.reason, reasonJson, m.answerable ? 1 : 0, now, now, lecture.versionId, MATCHER_VERSION],
    );
    outcome = 'created';
  }
  const uncertain = m.relation === 'strongly_related' || m.relation === 'partially_covered';
  syncReviewItems(
    ctx,
    'question_lecture_link',
    id,
    'link',
    uncertain
      ? [
          {
            kind: 'uncertain_lecture_link',
            code: 'uncertain_link',
            reason: `ربط غير مؤكد بمحاضرة «${lecture.title}»: ${m.reason}`,
            details: { lecture_source_id: lecture.sourceId, relation: m.relation },
          },
        ]
      : [],
    lecture.sourceId,
    q.id,
  );
  return outcome;
}

// ───────── candidate pairs (same course; explicit «question source for» links) ─────────
interface SrcLite {
  id: string;
  source_type: string;
  node_id: string | null;
  subject_node_id: string | null;
  course_node_id: string | null;
}

function groupKey(s: Pick<SrcLite, 'node_id' | 'subject_node_id' | 'course_node_id'>): string {
  return s.course_node_id ?? s.subject_node_id ?? s.node_id ?? '__unfiled__';
}

function liveSources(ctx: AppContext): SrcLite[] {
  return ctx.db.all<SrcLite>('SELECT id, source_type, node_id, subject_node_id, course_node_id FROM source WHERE deleted_at IS NULL');
}

function linkedPairs(ctx: AppContext): Array<{ from: string; to: string }> {
  return ctx.db.all<{ from: string; to: string }>(`SELECT from_source_id AS "from", to_source_id AS "to" FROM source_link WHERE relation = 'question_source_for'`);
}

export interface MatchStats {
  lectures: number;
  questions: number;
  created: number;
  updated: number;
  removed: number;
  kept_owner: number;
}

function liveQuestion(ctx: AppContext, id: string): QuestionRow | null {
  return ctx.db.get<QuestionRow>(`SELECT * FROM question WHERE id = ? AND deleted_at IS NULL AND status <> 'retired' AND current_version_id IS NOT NULL`, [id]) ?? null;
}

function run(ctx: AppContext, pairs: Map<string, Set<string>>): MatchStats {
  const stats: MatchStats = { lectures: 0, questions: 0, created: 0, updated: 0, removed: 0, kept_owner: 0 };
  const seenQ = new Set<string>();
  for (const [lectureId, qids] of pairs) {
    const lecture = lectureTarget(ctx, lectureId);
    if (!lecture) continue;
    stats.lectures++;
    ctx.db.tx(() => {
      for (const qid of qids) {
        const q = liveQuestion(ctx, qid);
        if (!q) continue;
        seenQ.add(qid);
        const outcome = upsertLink(ctx, lecture, q, matchOne(ctx, lecture, q));
        if (outcome === 'created') stats.created++;
        else if (outcome === 'updated') stats.updated++;
        else if (outcome === 'removed') stats.removed++;
        else if (outcome === 'kept_owner') stats.kept_owner++;
      }
    });
  }
  stats.questions = seenQ.size;
  return stats;
}

function questionsOfSources(ctx: AppContext, sourceIds: string[]): string[] {
  if (sourceIds.length === 0) return [];
  return ctx.db
    .all<{ id: string }>(
      `SELECT DISTINCT o.question_id AS id FROM question_occurrence o JOIN question q ON q.id = o.question_id
        WHERE o.source_id IN (${sourceIds.map(() => '?').join(',')}) AND o.status = 'current' AND q.deleted_at IS NULL AND q.status <> 'retired'`,
      sourceIds,
    )
    .map((r) => r.id);
}

/** A (new / re-processed) lecture: match every question of its course. */
export function matchLecture(ctx: AppContext, lectureSourceId: string): MatchStats {
  const all = liveSources(ctx);
  const lec = all.find((s) => s.id === lectureSourceId);
  if (!lec) return { lectures: 0, questions: 0, created: 0, updated: 0, removed: 0, kept_owner: 0 };
  const g = groupKey(lec);
  const qSources = all.filter((s) => s.id !== lec.id && !LECTURE_TYPES.includes(s.source_type) && groupKey(s) === g).map((s) => s.id);
  for (const l of linkedPairs(ctx)) if (l.to === lec.id && !qSources.includes(l.from)) qSources.push(l.from);
  const qids = new Set(questionsOfSources(ctx, qSources));
  if (lec.course_node_id) {
    for (const r of ctx.db.all<{ id: string }>(`SELECT id FROM question WHERE origin_type = 'owner' AND course_node_id = ? AND deleted_at IS NULL`, [lec.course_node_id])) qids.add(r.id);
  }
  return run(ctx, new Map([[lec.id, qids]]));
}

/** Questions (of a new question source, or quick-added) against the lectures of their course. */
export function matchQuestions(ctx: AppContext, questionIds: string[]): MatchStats {
  const all = liveSources(ctx);
  const byId = new Map(all.map((s) => [s.id, s]));
  const lectures = all.filter((s) => LECTURE_TYPES.includes(s.source_type));
  const links = linkedPairs(ctx);
  const pairs = new Map<string, Set<string>>();
  const add = (lectureId: string, qid: string) => {
    const set = pairs.get(lectureId) ?? new Set<string>();
    set.add(qid);
    pairs.set(lectureId, set);
  };
  for (const qid of questionIds) {
    const q = liveQuestion(ctx, qid);
    if (!q) continue;
    const srcIds = ctx.db.all<{ source_id: string }>(`SELECT DISTINCT source_id FROM question_occurrence WHERE question_id = ? AND status = 'current'`, [qid]).map((r) => r.source_id);
    const groups = new Set(srcIds.map((id) => byId.get(id)).filter((s): s is SrcLite => !!s).map(groupKey));
    if (q.origin_type === 'owner' && q.course_node_id) groups.add(q.course_node_id);
    for (const l of lectures) if (groups.has(groupKey(l))) add(l.id, qid);
    for (const l of links) if (srcIds.includes(l.from) && byId.get(l.to) && LECTURE_TYPES.includes(byId.get(l.to)!.source_type)) add(l.to, qid);
  }
  return run(ctx, pairs);
}

export function matchSourceVersion(ctx: AppContext, versionId: string): MatchStats & { kind: 'lecture' | 'questions' | 'none' } {
  const v = ctx.db.get<{ source_id: string; source_type: string }>(
    'SELECT v.source_id, s.source_type FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
    [versionId],
  );
  if (!v) return { lectures: 0, questions: 0, created: 0, updated: 0, removed: 0, kept_owner: 0, kind: 'none' };
  if (LECTURE_TYPES.includes(v.source_type)) {
    extractConceptCandidates(ctx, versionId);
    return { ...matchLecture(ctx, v.source_id), kind: 'lecture' };
  }
  return { ...matchQuestions(ctx, questionsOfSources(ctx, [v.source_id])), kind: 'questions' };
}

/** Whether any question source shares the lecture's course (for the honest empty state). */
export function courseHasQuestionSources(ctx: AppContext, lectureSourceId: string): boolean {
  const all = liveSources(ctx);
  const lec = all.find((s) => s.id === lectureSourceId);
  if (!lec) return false;
  const g = groupKey(lec);
  return all.some((s) => s.id !== lec.id && ['question_source', 'previous_exam'].includes(s.source_type) && groupKey(s) === g) || linkedPairs(ctx).some((l) => l.to === lec.id);
}

export { normalizeForSearch };
