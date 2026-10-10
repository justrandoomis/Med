// Public server API of the questions module for other tracks (exams, generation, learning).
// Import from here: `import { createQuestion, createVersion, listForExam, getQuestion } from '../questions/service';`
// Contract and examples: docs/modules/questions.md («Service for the exams track»).
//
// Rules the service enforces (so callers cannot get them wrong):
//  * generated questions are origin 'generated' with the label «سؤال مولد بواسطة MedLevo من المصادر المحددة» and
//    can never be attributed to a previous exam; AI-derived answers are 'ai_derived', never 'source_key';
//  * versions that were attempted / placed in an exam are immutable — createVersion always appends;
//  * listForExam marks each candidate scorable or not (with the Arabic reason), and gives confirmed duplicates and
//    exact duplicates (one question, several occurrences) the same `duplicate_group` so an exam never shows the
//    same question twice (§36).
import { richTextToPlain, type AnswerStatus, type LectureLinkRelation, type QuestionType, type QuestionVersionView, type QuestionView, type RichText } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { detectNearDuplicates } from './duplicates';
import { refreshQuestion } from './lifecycle';
import {
  currentVersion,
  deriveVersion,
  getQuestionRow,
  insertVersion,
  scorability,
  setCurrentVersion,
  type NewOption,
} from './store';

export { questionView as getQuestion, scorability, isVersionLocked, getVersionRow } from './store';
export { practiceUrl } from '@medlevo/shared';

export interface CreateQuestionInput {
  origin: 'generated' | 'owner';
  qtype: QuestionType;
  stem: string;
  options: Array<{ text: string; label?: string | null; pinned_position?: boolean }>;
  /** indexes into `options` of the correct option(s) */
  correctOptionIndexes?: number[];
  /** generated → 'ai_derived' (or 'unresolved'); owner → 'owner_key' / 'missing_key' */
  answerStatus: Extract<AnswerStatus, 'ai_derived' | 'owner_key' | 'missing_key' | 'unresolved' | 'not_applicable'>;
  courseNodeId?: string | null;
  explanation?: string | RichText | null;
  distractorExplanations?: Record<number, RichText> | null;
  learningObjective?: string | null;
  itemType?: string | null;
  difficultyEst?: string | null;
  model?: string | null;
  jobId?: string | null;
  /** a translation / paraphrase of an existing version (shown as derived, the original stays visible) */
  derivedFromVersionId?: string | null;
  kind?: Extract<QuestionVersionView['kind'], 'generated' | 'translation' | 'paraphrase' | 'structured'>;
  /** lecture the question was generated from (link origin auto, relation given) */
  lecture?: { sourceId: string; relation: LectureLinkRelation; reason: string } | null;
}

/** Create a generated / owner question with its first version (validated, statuses set, indexed). */
export function createQuestion(ctx: AppContext, input: CreateQuestionInput): { questionId: string; versionId: string } {
  if (input.origin === 'generated' && (input.answerStatus as string) === 'source_key') {
    throw new AppError('VALIDATION_FAILED', 'السؤال المولد لا يملك «مفتاح مصدر»؛ استخدم ai_derived.', 400);
  }
  return ctx.db.tx(() => {
    const now = ctx.clock.now();
    const questionId = newId(now);
    ctx.db.run(`INSERT INTO question (id, origin_type, current_version_id, status, course_node_id, created_at, updated_at) VALUES (?, ?, NULL, 'needs_review', ?, ?, ?)`, [
      questionId,
      input.origin,
      input.courseNodeId ?? null,
      now,
      now,
    ]);
    const options: NewOption[] = input.options.map((o, i) => ({ option_key: `o${i + 1}`, source_label: o.label ?? null, text: o.text, raw_text: null, region_id: null, pinned_position: o.pinned_position }));
    const correct = (input.correctOptionIndexes ?? []).map((i) => options[i]?.option_key).filter((k): k is string => !!k);
    const distractors = input.distractorExplanations
      ? Object.fromEntries(Object.entries(input.distractorExplanations).map(([i, rt]) => [options[Number(i)]?.option_key ?? i, rt]))
      : null;
    const v = insertVersion(ctx, {
      questionId,
      kind: input.kind ?? (input.origin === 'generated' ? 'generated' : 'structured'),
      derivedFrom: input.derivedFromVersionId ?? null,
      qtype: input.qtype,
      stemText: input.stem,
      stemRaw: input.origin === 'owner' ? input.stem : null,
      options,
      answerStatus: correct.length ? input.answerStatus : input.answerStatus === 'owner_key' || input.answerStatus === 'ai_derived' ? 'unresolved' : input.answerStatus,
      correctOptionKeys: correct.length ? correct : null,
      keyDetails: null,
      explanation: input.explanation ?? null,
      learningObjective: input.learningObjective ?? null,
      validation: null,
      extractionStatus: 'not_applicable',
      createdBy: input.origin === 'generated' ? 'generation' : 'owner',
      model: input.model ?? null,
      jobId: input.jobId ?? null,
      itemType: input.itemType ?? null,
      distractorExplanations: distractors,
    });
    if (input.difficultyEst) ctx.db.run('UPDATE question_version SET difficulty_est = ? WHERE id = ?', [input.difficultyEst, v.versionId]);
    ctx.db.run('UPDATE question SET current_version_id = ? WHERE id = ?', [v.versionId, questionId]);
    if (input.lecture) {
      ctx.db.run(
        `INSERT INTO question_lecture_link (id, question_id, lecture_source_id, relation, score, reason, reason_json, answerable_from_lecture, origin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
        [newId(now), questionId, input.lecture.sourceId, input.lecture.relation, input.lecture.reason, input.lecture.relation === 'directly_covered' ? 1 : 0, input.origin === 'owner' ? 'owner' : 'auto', input.origin === 'owner' ? 'accepted' : 'suggested', now, now],
      );
    }
    refreshQuestion(ctx, questionId, { jobId: input.jobId ?? null });
    if (input.origin === 'owner') detectNearDuplicates(ctx, questionId);
    ctx.audit.record({
      entityType: 'question',
      entityId: questionId,
      action: 'create',
      summary: input.origin === 'generated' ? 'سؤال مولد بواسطة MedLevo' : 'سؤال أضفته بنفسك',
      after: { version_id: v.versionId, qtype: input.qtype, answer_status: input.answerStatus },
      actor: input.origin === 'generated' ? 'job' : 'owner',
      jobId: input.jobId ?? null,
    });
    return { questionId, versionId: v.versionId };
  });
}

export interface CreateVersionInput {
  kind: QuestionVersionView['kind'];
  createdBy: QuestionVersionView['created_by'];
  stem?: string;
  options?: Array<{ option_key?: string; text: string; label?: string | null }>;
  qtype?: QuestionType;
  answerStatus?: AnswerStatus;
  correctOptionKeys?: string[] | null;
  explanation?: string | RichText | null;
  model?: string | null;
  jobId?: string | null;
  note?: string | null;
}

/** Append a version (the previous one is never modified) and re-validate. Becomes the current version. */
export function createVersion(ctx: AppContext, questionId: string, input: CreateVersionInput): { versionId: string; validation: QuestionVersionView['validation'] } {
  return ctx.db.tx(() => {
    const q = getQuestionRow(ctx, questionId);
    const cur = currentVersion(ctx, q);
    const options = input.options?.map((o, i) => ({
      option_key: o.option_key ?? `o${i + 1}`,
      source_label: o.label ?? null,
      text: o.text,
      raw_text: null,
      region_id: null,
    }));
    const d = deriveVersion(ctx, cur, {
      kind: input.kind,
      createdBy: input.createdBy,
      stemText: input.stem,
      options,
      qtype: input.qtype,
      answerStatus: input.answerStatus,
      correctOptionKeys: input.correctOptionKeys,
      explanation: input.explanation,
      model: input.model ?? null,
      jobId: input.jobId ?? null,
      note: input.note ?? null,
      extractionStatus: cur.extraction_status === 'not_applicable' ? 'not_applicable' : 'extracted',
      ownerReviewedFields: [],
      validation: null,
    });
    setCurrentVersion(ctx, q.id, d.versionId);
    const r = refreshQuestion(ctx, q.id, { jobId: input.jobId ?? null });
    return { versionId: d.versionId, validation: r.validation };
  });
}

export interface ExamCandidateFilter {
  sourceIds?: string[];
  courseNodeIds?: string[];
  questionIds?: string[];
  /** «من محاضرتي فقط» (§35): only questions answerable from this lecture */
  lectureOnlyAnswerable?: string | null;
  /** questions linked to these lectures (accepted or suggested, any relation except rejected) */
  lectureSourceIds?: string[];
  qtypes?: QuestionType[];
  origins?: Array<QuestionView['origin_type']>;
  onlyScorable?: boolean;
  limit?: number;
}

export interface ExamCandidate {
  question_id: string;
  version_id: string;
  origin_type: QuestionView['origin_type'];
  qtype: QuestionType;
  answer_status: AnswerStatus;
  has_negation: boolean;
  scorable: boolean;
  unscorable_reason_ar: string | null;
  /** same value = the same question for the exam (exact duplicates are already one question; confirmed duplicates share it) */
  duplicate_group: string;
  stem_plain: string;
}

/** Candidates for an exam / practice set — never two items of the same duplicate group in one selection. */
export function listForExam(ctx: AppContext, f: ExamCandidateFilter = {}): ExamCandidate[] {
  const where: string[] = [`q.deleted_at IS NULL`, `q.status IN ('ready','needs_review')`];
  const params: unknown[] = [];
  const inList = (xs: string[]) => xs.map(() => '?').join(',');
  if (f.questionIds?.length) {
    where.push(`q.id IN (${inList(f.questionIds)})`);
    params.push(...f.questionIds);
  }
  if (f.sourceIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id AND o.source_id IN (${inList(f.sourceIds)}))`);
    params.push(...f.sourceIds);
  }
  if (f.courseNodeIds?.length) {
    where.push(
      `(q.course_node_id IN (${inList(f.courseNodeIds)}) OR EXISTS (SELECT 1 FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = q.id AND s.course_node_id IN (${inList(f.courseNodeIds)})))`,
    );
    params.push(...f.courseNodeIds, ...f.courseNodeIds);
  }
  if (f.lectureOnlyAnswerable) {
    where.push(`EXISTS (SELECT 1 FROM question_lecture_link l WHERE l.question_id = q.id AND l.lecture_source_id = ? AND l.answerable_from_lecture = 1 AND l.status <> 'rejected')`);
    params.push(f.lectureOnlyAnswerable);
  }
  if (f.lectureSourceIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM question_lecture_link l WHERE l.question_id = q.id AND l.lecture_source_id IN (${inList(f.lectureSourceIds)}) AND l.status <> 'rejected')`);
    params.push(...f.lectureSourceIds);
  }
  if (f.qtypes?.length) {
    where.push(`v.qtype IN (${inList(f.qtypes)})`);
    params.push(...f.qtypes);
  }
  if (f.origins?.length) {
    where.push(`q.origin_type IN (${inList(f.origins)})`);
    params.push(...f.origins);
  }
  const rows = ctx.db.all<{ id: string; origin_type: QuestionView['origin_type']; v_id: string; qtype: QuestionType; answer_status: AnswerStatus; has_negation: number; validation_json: string | null; correct_option_ids_json: string | null; stem_json: string }>(
    `SELECT q.id, q.origin_type, v.id AS v_id, v.qtype, v.answer_status, v.has_negation, v.validation_json, v.correct_option_ids_json, v.stem_json
       FROM question q JOIN question_version v ON v.id = q.current_version_id
      WHERE ${where.join(' AND ')} ORDER BY q.id LIMIT ?`,
    [...params, Math.min(Math.max(f.limit ?? 500, 1), 5000)],
  );
  // confirmed duplicates → one group (union-find over confirmed pairs)
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const d of ctx.db.all<{ a: string; b: string }>(`SELECT question_a_id AS a, question_b_id AS b FROM question_duplicate WHERE status = 'confirmed'`)) {
    const ra = find(d.a);
    const rb = find(d.b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const out: ExamCandidate[] = [];
  for (const r of rows) {
    const s = scorability({ answer_status: r.answer_status, validation_json: r.validation_json, correct_option_ids_json: r.correct_option_ids_json });
    if (f.onlyScorable && !s.scorable) continue;
    out.push({
      question_id: r.id,
      version_id: r.v_id,
      origin_type: r.origin_type,
      qtype: r.qtype,
      answer_status: r.answer_status,
      has_negation: r.has_negation === 1,
      scorable: s.scorable,
      unscorable_reason_ar: s.reason_ar,
      duplicate_group: find(r.id),
      stem_plain: richTextToPlain(fromJson<RichText | null>(r.stem_json, null)),
    });
  }
  return out;
}

/** Pick at most one candidate per duplicate group (keeps the first in the given order). */
export function dedupeCandidates<T extends { duplicate_group: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.duplicate_group) ? false : (seen.add(x.duplicate_group), true)));
}
