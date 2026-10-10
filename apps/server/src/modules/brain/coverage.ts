// Question Coverage Map (§36): per lecture, which pages and concepts have SOURCE questions, which only have GENERATED
// questions (kept separate — a generated question never makes a page «covered by the source»), which ones you have
// already attempted, and which have no question at all. Every count comes with its denominator.
import type { ConceptStatus, CoverageConceptRow, CoverageCount, CoverageLecture, CoveragePageRow, CoverageResponse, CoverageStatus } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { lectureQuestions, conceptNamesNorm, type LectureQuestion } from './lecture-questions';
import { resolveConceptId } from './resolve';
import { courseSources, displayName, nodeTitle, pageLabelAr, pagesOf, studySource, type PageRow, type StudySource } from './store';

export interface CoverageConceptInput {
  id: string;
  name: string;
  status: ConceptStatus;
  page_ids: string[];
}

const BASIS_AR: Record<string, string> = { matcher: 'ربط السؤال بالمحاضرة ذكر المفهوم', text: 'اسم المفهوم في نص السؤال', evidence: 'دليل السؤال المولَّد من موضع يذكر المفهوم' };

function statusOf(source: number, generated: number): CoverageStatus {
  return source > 0 ? 'source' : generated > 0 ? 'generated_only' : 'uncovered';
}

function count(rows: Array<{ source_question_ids: string[]; generated_question_ids: string[]; attempted_question_ids: string[]; status: CoverageStatus }>): CoverageCount {
  return {
    total: rows.length,
    with_source_questions: rows.filter((r) => r.source_question_ids.length > 0).length,
    with_generated_questions: rows.filter((r) => r.generated_question_ids.length > 0).length,
    attempted: rows.filter((r) => r.attempted_question_ids.length > 0).length,
    uncovered: rows.filter((r) => r.status === 'uncovered').length,
  };
}

export function addCounts(a: CoverageCount, b: CoverageCount): CoverageCount {
  return {
    total: a.total + b.total,
    with_source_questions: a.with_source_questions + b.with_source_questions,
    with_generated_questions: a.with_generated_questions + b.with_generated_questions,
    attempted: a.attempted + b.attempted,
    uncovered: a.uncovered + b.uncovered,
  };
}

export const ZERO_COUNT: CoverageCount = { total: 0, with_source_questions: 0, with_generated_questions: 0, attempted: 0, uncovered: 0 };

/** Pure coverage math (unit-tested): pages × concepts × questions → rows + totals with denominators. */
export function computeCoverage(
  pages: Array<Pick<PageRow, 'id' | 'page_index' | 'printed_label' | 'kind'>>,
  concepts: CoverageConceptInput[],
  questions: Array<Pick<LectureQuestion, 'id' | 'side' | 'page_ids' | 'concepts' | 'attempts'>>,
): Pick<CoverageLecture, 'pages' | 'concepts' | 'totals'> {
  const pageRows: CoveragePageRow[] = pages.map((p) => {
    const qs = questions.filter((q) => q.page_ids.includes(p.id));
    const src = qs.filter((q) => q.side === 'source').map((q) => q.id);
    const gen = qs.filter((q) => q.side === 'generated').map((q) => q.id);
    return {
      page_id: p.id,
      page_index: p.page_index,
      label_ar: pageLabelAr(p),
      source_question_ids: src,
      generated_question_ids: gen,
      attempted_question_ids: qs.filter((q) => q.attempts > 0).map((q) => q.id),
      status: statusOf(src.length, gen.length),
    };
  });
  const conceptRows: CoverageConceptRow[] = concepts.map((c) => {
    const qs = questions.filter((q) => q.concepts.has(c.id));
    const src = qs.filter((q) => q.side === 'source').map((q) => q.id);
    const gen = qs.filter((q) => q.side === 'generated').map((q) => q.id);
    const bases = [...new Set(qs.map((q) => q.concepts.get(c.id)!))];
    return {
      concept_id: c.id,
      name: c.name,
      status_concept: c.status,
      page_ids: c.page_ids,
      source_question_ids: src,
      generated_question_ids: gen,
      attempted_question_ids: qs.filter((q) => q.attempts > 0).map((q) => q.id),
      status: statusOf(src.length, gen.length),
      basis_ar: qs.length === 0 ? 'لا يوجد سؤال مرتبط بهذا المفهوم في هذه المحاضرة.' : `الأساس: ${bases.map((b) => BASIS_AR[b] ?? b).join('، ')}.`,
    };
  });
  return {
    pages: pageRows,
    concepts: conceptRows,
    totals: {
      pages: count(pageRows),
      concepts: count(conceptRows),
      questions: {
        source: questions.filter((q) => q.side === 'source').length,
        generated: questions.filter((q) => q.side === 'generated').length,
        attempted_source: questions.filter((q) => q.side === 'source' && q.attempts > 0).length,
        attempted_generated: questions.filter((q) => q.side === 'generated' && q.attempts > 0).length,
      },
    },
  };
}

/** Concepts mentioned in a version (stated + candidate mentions), merged ones resolved, rejected ones excluded. */
export function versionConcepts(ctx: AppContext, versionId: string): CoverageConceptInput[] {
  const rows = ctx.db.all<{ concept_id: string; page_id: string | null }>(
    `SELECT m.concept_id, r.page_id FROM concept_mention m LEFT JOIN source_region r ON r.id = m.region_id WHERE m.version_id = ?`,
    [versionId],
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const id = resolveConceptId(ctx, r.concept_id);
    const set = map.get(id) ?? new Set<string>();
    if (r.page_id) set.add(r.page_id);
    map.set(id, set);
  }
  const out: CoverageConceptInput[] = [];
  for (const [id, pages] of map) {
    const c = ctx.db.get<{ id: string; name_en: string | null; name_ar: string | null; status: ConceptStatus }>('SELECT id, name_en, name_ar, status FROM concept WHERE id = ?', [id]);
    if (!c || c.status === 'rejected') continue;
    out.push({ id, name: displayName(c), status: c.status, page_ids: [...pages] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

export function lectureCoverage(ctx: AppContext, s: StudySource): CoverageLecture {
  const pages = s.version_id ? pagesOf(ctx, s.version_id) : [];
  const concepts = s.version_id ? versionConcepts(ctx, s.version_id) : [];
  const questions = lectureQuestions(
    ctx,
    s,
    concepts.map((c) => ({ id: c.id, names: conceptNamesNorm(ctx, c.id), page_ids: c.page_ids })),
  );
  return { source_id: s.id, title: s.title, version_id: s.version_id, ...computeCoverage(pages, concepts, questions) };
}

export function coverage(ctx: AppContext, opts: { courseNodeId?: string | null; sourceId?: string | null }): CoverageResponse {
  let scope: CoverageResponse['scope'];
  let lectures: StudySource[];
  if (opts.sourceId) {
    const s = studySource(ctx, opts.sourceId);
    scope = { kind: 'lecture', id: s.id, title: s.title };
    lectures = [s];
  } else {
    const n = nodeTitle(ctx, opts.courseNodeId!);
    scope = { kind: 'course', id: n.id, title: n.title };
    lectures = courseSources(ctx, n.id);
  }
  const rows = lectures.map((s) => lectureCoverage(ctx, s));
  const totals = rows.reduce((acc, l) => ({ pages: addCounts(acc.pages, l.totals.pages), concepts: addCounts(acc.concepts, l.totals.concepts) }), {
    pages: ZERO_COUNT,
    concepts: ZERO_COUNT,
  });
  return {
    scope,
    lectures: rows,
    totals,
    notes_ar: [
      'تغطية أسئلة المصادر منفصلة عن تغطية الأسئلة المولدة: السؤال المولَّد لا يجعل الصفحة «مغطاة من المصدر».',
      'الأسئلة التي أضفتها بنفسك (لصق أو كتابة) تُحسب مع «أسئلة المصادر» لأنها ليست مولَّدة؛ أصل كل سؤال مكتوب في صفحته.',
      'الصفحة مغطاة بسؤال عندما حدد ربطُ السؤال بالمحاضرة هذه الصفحةَ موضعًا لجوابه (أو كانت من أدلة السؤال المولد).',
      '«اختبرتها» تعني أن لديك محاولة واحدة على الأقل على سؤال من أسئلتها — وليست إتقانًا.',
      'المقام في كل نسبة هو عدد صفحات نسخة الدراسة أو عدد مفاهيم المحاضرة غير المرفوضة.',
    ],
  };
}
