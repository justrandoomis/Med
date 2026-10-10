// The questions of one lecture, with the pages and concepts they bear on — the shared input of the Question Coverage
// Map, the knowledge map and the Student Knowledge Map. Read-only over the questions / exams tables.
//  * source questions = question_lecture_link (not rejected, not «course_related_only»), origin source or owner;
//    pages = the lecture pages the matcher located (reason_json.lecture_page_ids) — only pages of the study version;
//  * generated questions = published candidates of a generation run on this lecture (pages from their evidence),
//    plus generated questions the matcher linked;
//  * a question bears on a concept when the matcher listed it for the link, or when the concept's name (or alias) is
//    in the question's own text, or (generated) when its evidence regions mention the concept — the basis is kept.
import { stemPreview, type RichText } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { nameNorm, resolveConceptId } from './resolve';
import { inList, type StudySource } from './store';

export type QuestionSide = 'source' | 'generated';
export type ConceptBasis = 'matcher' | 'text' | 'evidence';

export interface LectureQuestion {
  id: string;
  side: QuestionSide;
  origin_type: string;
  stem: string;
  page_ids: string[];
  concepts: Map<string, ConceptBasis>;
  attempts: number;
  relation: string | null;
}

export interface LectureConceptRef {
  id: string;
  names: string[];
  page_ids: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function conceptNamesNorm(ctx: AppContext, conceptId: string): string[] {
  const c = ctx.db.get<{ name_en: string | null; name_ar: string | null }>('SELECT name_en, name_ar FROM concept WHERE id = ?', [conceptId]);
  const aliases = ctx.db.all<{ alias: string }>('SELECT alias FROM concept_alias WHERE concept_id = ?', [conceptId]).map((a) => a.alias);
  return [...new Set([c?.name_en, c?.name_ar, ...aliases].filter((n): n is string => !!n).map(nameNorm).filter((n) => n.length >= 3))];
}

function questionText(ctx: AppContext, questionId: string): { stem: string; norm: string } {
  const q = ctx.db.get<{ stem_raw: string | null; stem_json: string; vid: string }>(
    'SELECT v.stem_raw, v.stem_json, v.id AS vid FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?',
    [questionId],
  );
  if (!q) return { stem: '', norm: '' };
  const stem = stemPreview(fromJson<RichText>(q.stem_json), 4000);
  const options = ctx.db.all<{ raw_text: string | null; text_json: string }>('SELECT raw_text, text_json FROM question_option WHERE question_version_id = ?', [q.vid]);
  const all = [q.stem_raw ?? stem, ...options.map((o) => o.raw_text ?? stemPreview(fromJson<RichText>(o.text_json), 400))].join(' \n ');
  return { stem: stemPreview(fromJson<RichText>(q.stem_json), 160), norm: nameNorm(all) };
}

export function lectureQuestions(ctx: AppContext, lecture: StudySource, concepts: LectureConceptRef[]): LectureQuestion[] {
  if (!lecture.version_id) return [];
  const pageIds = new Set(ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ?', [lecture.version_id]).map((p) => p.id));
  const out = new Map<string, LectureQuestion>();
  const attemptsOf = (qid: string) =>
    (ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_attempt WHERE question_id = ?', [qid])?.n ?? 0) +
    (ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM written_attempt WHERE question_id = ?', [qid])?.n ?? 0);

  // 1) matcher / owner links
  const links = ctx.db.all<{ question_id: string; relation: string; reason_json: string | null; origin_type: string }>(
    `SELECT l.question_id, l.relation, l.reason_json, q.origin_type FROM question_lecture_link l JOIN question q ON q.id = l.question_id
      WHERE l.lecture_source_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only' AND q.deleted_at IS NULL AND q.status <> 'retired'`,
    [lecture.id],
  );
  for (const l of links) {
    const rj = fromJson<{ concepts?: string[]; lecture_page_ids?: string[] }>(l.reason_json, {}) ?? {};
    const q: LectureQuestion = {
      id: l.question_id,
      side: l.origin_type === 'generated' ? 'generated' : 'source',
      origin_type: l.origin_type,
      stem: '',
      page_ids: (rj.lecture_page_ids ?? []).filter((p) => pageIds.has(p)),
      concepts: new Map(),
      attempts: attemptsOf(l.question_id),
      relation: l.relation,
    };
    for (const c of rj.concepts ?? []) q.concepts.set(resolveConceptId(ctx, c), 'matcher');
    out.set(q.id, q);
  }

  // 2) generated questions published from this lecture
  const gens = ctx.db.all<{ question_id: string; evidence_json: string }>(
    `SELECT gc.question_id, gc.evidence_json FROM generated_question_candidate gc JOIN question_generation_run run ON run.id = gc.run_id
       JOIN question q ON q.id = gc.question_id
      WHERE run.lecture_source_id = ? AND gc.status = 'published' AND q.deleted_at IS NULL AND q.status <> 'retired'`,
    [lecture.id],
  );
  for (const g of gens) {
    const ev = fromJson<{ lecture_page_ids?: string[]; region_ids?: string[] }>(g.evidence_json, {}) ?? {};
    const regionPages = ev.region_ids?.length
      ? ctx.db.all<{ page_id: string | null }>(`SELECT page_id FROM source_region WHERE id IN (${inList(ev.region_ids.length)})`, ev.region_ids).map((r) => r.page_id)
      : [];
    const pages = [...new Set([...(ev.lecture_page_ids ?? []), ...regionPages].filter((p): p is string => !!p && pageIds.has(p)))];
    const prev = out.get(g.question_id);
    const q: LectureQuestion = prev ?? { id: g.question_id, side: 'generated', origin_type: 'generated', stem: '', page_ids: [], concepts: new Map(), attempts: attemptsOf(g.question_id), relation: null };
    q.side = 'generated';
    q.page_ids = [...new Set([...q.page_ids, ...pages])];
    if (ev.region_ids?.length) {
      for (const m of ctx.db.all<{ concept_id: string }>(`SELECT DISTINCT concept_id FROM concept_mention WHERE region_id IN (${inList(ev.region_ids.length)})`, ev.region_ids)) {
        const cid = resolveConceptId(ctx, m.concept_id);
        if (!q.concepts.has(cid)) q.concepts.set(cid, 'evidence');
      }
    }
    out.set(q.id, q);
  }

  // 3) concept names in the question's own text
  const matchers = concepts
    .filter((c) => c.names.length)
    .map((c) => ({ id: c.id, re: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${c.names.map(escapeRe).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'u') }));
  for (const q of out.values()) {
    const t = questionText(ctx, q.id);
    q.stem = t.stem;
    for (const m of matchers) if (!q.concepts.has(m.id) && m.re.test(t.norm)) q.concepts.set(m.id, 'text');
  }
  // only concepts of this lecture count here
  const inLecture = new Set(concepts.map((c) => c.id));
  for (const q of out.values()) for (const cid of [...q.concepts.keys()]) if (!inLecture.has(cid)) q.concepts.delete(cid);
  return [...out.values()];
}
