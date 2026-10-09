// /api/exams — practice & exams (§37–§39, §41, §44 signals). Owner session + CSRF on every route (global guard).
//
//   POST /preview                                   ExamCreateRequest → ExamPreviewResponse (what would be selected and why)
//   POST /                                          ExamCreateRequest → ExamCreateResponse (exam + first attempt; idempotent by attempt_id)
//   GET  /attempts?limit=&cursor=                   attempt history
//   GET  /attempts/:attemptId                       ExamSessionView (delivery payload: no keys / explanations / sources, AC-19)
//   POST /attempts/:attemptId/items/:index/hint     progressive hint (practice, policy 'progressive')
//   POST /attempts/:attemptId/items/:index/answer   practice: record the answer (idempotent by client id) → feedback
//   POST /attempts/:attemptId/items/:index/solution practice: view the solution (recorded; refused in Anti-shortcut mode)
//   GET  /attempts/:attemptId/items/:index/feedback feedback after answering (practice) / after finishing (exam)
//   GET  /attempts/:attemptId/result                ExamResultDetail (after finishing in assessed modes)
//   PATCH /question-attempts/:id/mistake            owner edit of the mistake type (origin 'owner')
//   GET  /media/:token                              exam media through a short-lived token, neutral headers (no file name)
//   POST /generate · GET /generate · GET /generate/:runId      generated hard MCQs (AI)
//   GET  /written/:questionId · POST /written/attempts · POST /written/attempts/:id/grade   written answers (AI grading)
// Exam attempts' answers / timer / pause state and question attempts travel through /api/sync (entity handlers).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EXAM_MODES,
  MISTAKE_TYPES,
  QUESTION_TYPES,
  CONFIDENCE_LEVELS,
  type AttemptFeedbackView,
  type ExamAttemptListResponse,
  type ExamCreateRequest,
  type ExamCreateResponse,
  type ExamPreviewResponse,
  type ExamResultDetail,
  type ExamSessionView,
  type GenerateQuestionsResponse,
  type GenerationRunListResponse,
  type HintResponse,
  type MistakeUpdateResponse,
  type WrittenAttemptResponse,
  type WrittenQuestionView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery, RATE_LIMITS } from '../../lib/http';
import { insertQuestionAttempt, setMistakeType } from './attempts';
import { buildExam, createExam } from './builder';
import { deliverItems, unscoredReasons, verifyMediaToken, questionMediaFiles } from './delivery';
import { buildFeedback, viewSolution } from './feedback';
import { listRuns, requestGeneration, runView } from './generation/pipeline';
import { serveHint } from './hints';
import { computeResult, listAttempts } from './results';
import { attemptDTO, attemptWithExam, examItems, examPolicy, examSummary, questionAttemptDTO } from './store';
import { getWrittenQuestion, gradeWrittenAttempt, saveWrittenAttempt } from './written';
import { isAssessedMode } from '@medlevo/shared';
import { sendStoredFile } from '../files';

const id = z.string().trim().min(1).max(64);

export const createSchema = z
  .object({
    title: z.string().trim().max(200).default(''),
    mode: z.enum(EXAM_MODES as unknown as [string, ...string[]]),
    source_ids: z.array(id).max(200).optional(),
    course_node_ids: z.array(id).max(50).optional(),
    question_ids: z.array(id).max(500).optional(),
    count: z.number().int().min(1).max(200),
    minutes: z.number().min(1).max(600).nullable().optional(),
    per_question_seconds: z.number().int().min(10).max(1800).nullable().optional(),
    qtypes: z.array(z.enum(QUESTION_TYPES)).max(QUESTION_TYPES.length).optional(),
    origin_mix: z.object({ source: z.number().min(0).max(100), generated: z.number().min(0).max(100) }).strict().optional(),
    include_my_mistakes: z.boolean().optional(),
    lecture_only_answerable: z.boolean().optional(),
    difficulty: z.enum(['any', 'easy', 'medium', 'hard']).optional(),
    attempt_id: id.optional(),
    policy: z
      .object({ pause_allowed: z.boolean(), hints: z.enum(['off', 'progressive']), shuffle_options: z.boolean(), anti_shortcut: z.boolean() })
      .partial()
      .strict()
      .optional(),
    start_question_id: id.nullable().optional(),
    seed: z.string().trim().max(64).nullable().optional(),
  })
  .strict();

const attemptParams = z.object({ attemptId: id });
const itemParams = z.object({ attemptId: id, index: z.coerce.number().int().min(0).max(10_000) });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(20).optional() });
const hintBody = z.object({ level: z.union([z.literal(1), z.literal(2)]) }).strict();
const answerBody = z
  .object({
    id,
    selected_option_ids: z.array(id).min(1).max(12),
    confidence: z.enum(CONFIDENCE_LEVELS).nullable().optional(),
    hints_used: z.number().int().min(0).max(20).optional(),
    solution_viewed_before_answer: z.boolean().optional(),
    time_ms: z.number().int().min(0).max(24 * 3600 * 1000).nullable().optional(),
    flagged: z.boolean().optional(),
    answered_at: z.number().int().min(0),
  })
  .strict();
const mistakeBody = z.object({ mistake_type: z.enum(MISTAKE_TYPES).nullable() }).strict();
const runsQuery = z.object({ lecture_source_id: id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

export function sessionView(ctx: AppContext, attemptId: string): ExamSessionView {
  const { attempt, exam } = attemptWithExam(ctx, attemptId);
  const { items, mediaExpiresAt } = deliverItems(ctx, exam, attempt.id);
  return {
    exam: examSummary(exam),
    attempt: attemptDTO(attempt),
    items,
    media_expires_at: mediaExpiresAt,
    unscored_reasons: unscoredReasons(ctx, examItems(exam)),
  };
}

function practiceAnswer(ctx: AppContext, attemptId: string, index: number, body: z.infer<typeof answerBody>): AttemptFeedbackView {
  const { attempt, exam } = attemptWithExam(ctx, attemptId);
  const policy = examPolicy(exam);
  if (isAssessedMode(exam.mode) || policy.show_solution !== 'after_each') {
    throw new AppError('CONFLICT', 'في هذا الاختبار تُحفظ الإجابات في المحاولة وتظهر الحلول بعد إنهائه، لا بعد كل سؤال.', 409);
  }
  if (attempt.status === 'completed' || attempt.status === 'abandoned') throw new AppError('CONFLICT', 'انتهت هذه المحاولة؛ إجاباتها ثابتة.', 409);
  const item = examItems(exam)[index];
  if (!item) throw new AppError('NOT_FOUND', 'السؤال غير موجود في هذه المحاولة.', 404);
  ctx.db.tx(() =>
    insertQuestionAttempt(
      ctx.db,
      {
        id: body.id,
        question_id: item.question_id,
        question_version_id: item.question_version_id,
        exam_attempt_id: attempt.id,
        exam_item_index: index,
        selected_option_ids: body.selected_option_ids,
        confidence: body.confidence ?? null,
        hints_used: body.hints_used,
        solution_viewed_before_answer: body.solution_viewed_before_answer,
        time_ms: body.time_ms ?? null,
        flagged: body.flagged,
        answered_at: body.answered_at,
      },
      { now: ctx.clock.now(), deviceId: null, touch: (t, i) => void ctx.sync.touch(t, i) },
    ),
  );
  // the FIRST answer of an item stays (a different later answer is not recorded); feedback is about it
  return buildFeedback(ctx, exam, attemptWithExam(ctx, attemptId).attempt, index);
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ai = { config: { rateLimit: RATE_LIMITS.ai } };

  app.post('/preview', async (req): Promise<ExamPreviewResponse> => {
    const body = parseBody(createSchema, req) as ExamCreateRequest;
    return { report: buildExam(ctx, body).report };
  });

  app.post('/', async (req): Promise<ExamCreateResponse> => {
    const body = parseBody(createSchema, req) as ExamCreateRequest;
    const r = createExam(ctx, body, null);
    return { session: sessionView(ctx, r.attemptId), created: r.created };
  });

  app.get('/attempts', async (req): Promise<ExamAttemptListResponse> => {
    const q = parseQuery(listQuery, req);
    return listAttempts(ctx, q.limit, q.cursor ?? null);
  });

  app.get('/attempts/:attemptId', async (req): Promise<ExamSessionView> => {
    const { attemptId } = parseParams(attemptParams, req);
    return sessionView(ctx, attemptId);
  });

  app.post('/attempts/:attemptId/items/:index/hint', async (req): Promise<HintResponse> => {
    const p = parseParams(itemParams, req);
    const { level } = parseBody(hintBody, req);
    const { attempt, exam } = attemptWithExam(ctx, p.attemptId);
    return { hint: serveHint(ctx, exam, attempt, p.index, level) };
  });

  app.post('/attempts/:attemptId/items/:index/answer', async (req): Promise<AttemptFeedbackView> => {
    const p = parseParams(itemParams, req);
    return practiceAnswer(ctx, p.attemptId, p.index, parseBody(answerBody, req));
  });

  app.post('/attempts/:attemptId/items/:index/solution', async (req): Promise<AttemptFeedbackView> => {
    const p = parseParams(itemParams, req);
    const { attempt, exam } = attemptWithExam(ctx, p.attemptId);
    return viewSolution(ctx, exam, attempt, p.index);
  });

  app.get('/attempts/:attemptId/items/:index/feedback', async (req): Promise<AttemptFeedbackView> => {
    const p = parseParams(itemParams, req);
    const { attempt, exam } = attemptWithExam(ctx, p.attemptId);
    return buildFeedback(ctx, exam, attempt, p.index);
  });

  app.get('/attempts/:attemptId/result', async (req): Promise<ExamResultDetail> => {
    const { attemptId } = parseParams(attemptParams, req);
    const { attempt, exam } = attemptWithExam(ctx, attemptId);
    return computeResult(ctx, exam, attempt);
  });

  app.patch('/question-attempts/:id/mistake', async (req): Promise<MistakeUpdateResponse> => {
    const { id: attemptId } = parseParams(z.object({ id }), req);
    const { mistake_type } = parseBody(mistakeBody, req);
    const row = ctx.db.tx(() => {
      const r = setMistakeType(ctx.db, attemptId, mistake_type, ctx.clock.now(), (t, i) => void ctx.sync.touch(t, i));
      ctx.audit.record({ entityType: 'question_attempt', entityId: attemptId, action: 'update', summary: 'تعديل تصنيف الخطأ', after: { mistake_type }, actor: 'owner' });
      return r;
    });
    return { attempt: questionAttemptDTO(row) };
  });

  app.get('/media/:token', async (req, reply) => {
    const { token } = parseParams(z.object({ token: z.string().min(10).max(600) }), req);
    const v = verifyMediaToken(ctx, token);
    if (!v) throw new AppError('FORBIDDEN', 'انتهت صلاحية رابط الصورة؛ أعد فتح الاختبار لتحديثه.', 403);
    const { exam } = attemptWithExam(ctx, v.attemptId);
    const allowed = examItems(exam).some((i) => questionMediaFiles(ctx, i.question_id).fileIds.includes(v.fileId));
    const file = allowed ? ctx.files.stat(v.fileId) : null;
    if (!file) throw new AppError('NOT_FOUND', 'الصورة غير متاحة.', 404);
    // neutral delivery: never the original file name (it can reveal the answer, AC-19)
    return sendStoredFile(ctx.files, { ...file, original_name: null }, req, reply);
  });

  // ── generated hard MCQs (§37–§38) ──
  app.post('/generate', ai, async (req): Promise<GenerateQuestionsResponse> => ({ run: requestGeneration(ctx, req.body ?? {}) }));

  app.get('/generate', async (req): Promise<GenerationRunListResponse> => {
    const q = parseQuery(runsQuery, req);
    return { runs: listRuns(ctx, q.lecture_source_id ?? null, q.limit) };
  });

  app.get('/generate/:runId', async (req): Promise<GenerateQuestionsResponse> => {
    const { runId } = parseParams(z.object({ runId: id }), req);
    return { run: runView(ctx, runId) };
  });

  // ── written answers (§41) ──
  app.get('/written/:questionId', async (req): Promise<WrittenQuestionView> => {
    const { questionId } = parseParams(z.object({ questionId: id }), req);
    return getWrittenQuestion(ctx, questionId);
  });

  app.post('/written/attempts', async (req): Promise<WrittenAttemptResponse> => ({ attempt: saveWrittenAttempt(ctx, req.body ?? {}) }));

  app.post('/written/attempts/:id/grade', ai, async (req): Promise<WrittenAttemptResponse> => {
    const { id: attemptId } = parseParams(z.object({ id }), req);
    return { attempt: await gradeWrittenAttempt(ctx, attemptId, req.body ?? {}) };
  });
}
