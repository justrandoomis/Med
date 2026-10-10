// /api/learning — flashcards & SRS, weakness center, mistake genome, reasoning replay, profile, planner, one-tap
// revision, home, Exam DNA, progress (§40, §43–§45). Owner session + CSRF on every route (global guard); zod on every
// body / query / params.
//
//   GET  /srs-config                         SrsConfigView (algorithm + params + live parity sample)
//   POST /srs/rebuild                        recompute every cached schedule (after a settings change)
//   GET  /cards?source_id=&status=&q=&limit=&cursor=      CardListResponse
//   POST /cards · /cards/from-selection · /cards/from-mistake · /cards/occlusion           CardCreateResponse
//   GET  /cards/duplicates · POST /cards/duplicates/decide                                  suggestions only
//   GET  /cards/:id · PATCH /cards/:id · DELETE /cards/:id · POST /cards/:id/restore
//   POST /cards/:id/suspend · /cards/:id/bury · /cards/:id/unbury · /cards/:id/impact/resolve
//   GET  /cards/:id/review                   CardReviewPayload (occlusion without answer leaks)
//   GET  /review/queue?limit=&source_id=     CardQueueResponse (owner day)
//   POST /reviews                            ReviewSubmitRequest → ReviewSubmitResponse (same as sync 'review_event')
//   GET  /media/:token                       occlusion image (neutral headers, no file name)
//   GET  /export/anki?source_id=&deck=&include_suspended=   Anki text-import TSV (or ZIP with media)
//   GET  /forecast?source_id=&days=          ForgettingForecastView (estimate)
//   GET  /weakness?status= · GET /weakness/:id · PATCH /weakness/:id · POST /weakness/:id/revision
//   GET  /mistakes/genome?source_id=&course_node_id= · PATCH /mistakes/:attemptId
//   GET  /reasoning/:questionId?attempt_id=
//   GET  /profile · PATCH /profile · POST /profile/reset
//   GET  /plans · POST /plans · POST /plans/preview · GET /plans/:id · POST /plans/:id/rebalance
//   PATCH /plans/:id/tasks/:taskId · POST /plans/:id/archive
//   POST /revision · GET /revision/:id
//   GET  /home
//   GET  /exam-dna?course_node_id=&source_ids= · GET /exam-dna/relevance?question_id=|concept_id=
//   GET  /progress?course_node_id= · GET /progress/:sourceId
import {
  CARD_IMPACT_RESOLUTIONS,
  EXPLANATION_LEVELS,
  MISTAKE_TYPES,
  PROFILE_SIGNAL_PARTS,
  toFtsQuery,
  type CardCreateResponse,
  type CardDetailResponse,
  type CardDuplicatesResponse,
  type CardListResponse,
  type CardMutationResponse,
  type CardQueueResponse,
  type CardReviewPayload,
  type ExamDnaDetail,
  type ExamRelevanceView,
  type ForgettingForecastView,
  type HomeDetail,
  type LearningProfileView,
  type MistakeGenomeView,
  type PlanListResponse,
  type PlanPreviewResponse,
  type PlanRebalanceResponse,
  type ReasoningReplayView,
  type ReviewSubmitResponse,
  type RevisionSessionDetail,
  type SourceProgressDetail,
  type SourceProgressListResponse,
  type SrsConfigView,
  type SrsRebuildResponse,
  type StudyPlanConfig,
  type StudyPlanView,
  type WeaknessDetailView,
  type WeaknessListResponse,
} from '@medlevo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { sendStoredFile } from '../files';
import { exportAnki } from './anki';
import {
  bury,
  createCards,
  createFromMistake,
  createFromSelection,
  createOcclusion,
  decideDuplicate,
  deleteCard,
  findDuplicates,
  resolveCardImpact,
  restoreCard,
  setSuspended,
  unbury,
  updateCard,
} from './cards';
import { examDna, examRelevance } from './dna';
import { homeView } from './home';
import { editMistakeType, mistakeGenome, reasoningReplay } from './mistakes';
import { archivePlan, createPlan, listPlans, planConfigSchema, planView, previewPlan, rebalancePlan, setTaskStatus } from './planner';
import { getProfile, patchProfile, resetSignalPart } from './profile';
import { progressList, sourceProgress } from './progress';
import {
  cardMediaFile,
  forgettingForecast,
  insertReviewEvent,
  rebuildAll,
  reviewEventSchema,
  reviewPayload,
  reviewQueue,
  srsConfig,
  verifyCardMediaToken,
} from './review';
import { buildRevision, getRevision, revisionRequestSchema, weaknessRevision } from './revision';
import { cardEvents, eventDTO, findCard, refreshAllImpacts, requireCard, viewOf, viewsFor, type FlashcardRow } from './store';
import { getWeakness, listWeaknesses, patchWeakness } from './weakness';

const id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');
const idParams = z.object({ id });
const richInput = z.union([z.string().max(20_000), z.record(z.string(), z.unknown())]);
const ids = z.array(id).max(50);
const box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) });
const mask = z.object({ id: id.optional(), box, label: z.string().trim().min(1).max(300) });
const boolQuery = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const createBody = z
  .object({
    id: id.optional(),
    kind: z.enum(['basic', 'cloze']),
    front: richInput,
    back: richInput.nullable().optional(),
    concept_id: id.nullable().optional(),
    topic_id: id.nullable().optional(),
    source_id: id.nullable().optional(),
    source_version_id: id.nullable().optional(),
    evidence_ids: ids.optional(),
  })
  .strict();
const selectionBody = z
  .object({
    id: id.optional(),
    source_id: id,
    version_id: id,
    quote: z.string().min(1).max(20_000),
    evidence_ids: ids.optional(),
    region_id: id.nullable().optional(),
    start: z.number().int().min(0).nullable().optional(),
    end: z.number().int().min(0).nullable().optional(),
    kind: z.enum(['basic', 'cloze']).optional(),
    front: richInput,
    back: richInput.nullable().optional(),
    concept_id: id.nullable().optional(),
    topic_id: id.nullable().optional(),
  })
  .strict();
const mistakeBody = z.object({ attempt_id: id, id: id.optional() }).strict();
const occlusionBody = z
  .object({ note_id: id.optional(), image_asset_id: id, masks: z.array(mask).min(1).max(50), prompt: z.string().max(500).nullable().optional(), concept_id: id.nullable().optional(), topic_id: id.nullable().optional() })
  .strict();
const updateBody = z
  .object({ base_rev: z.number().int().min(1), front: richInput.optional(), back: richInput.nullable().optional(), concept_id: id.nullable().optional(), topic_id: id.nullable().optional(), mask: mask.nullable().optional() })
  .strict();
const listQuery = z.object({
  source_id: id.optional(),
  status: z.enum(['active', 'suspended', 'needs_review', 'deleted', 'all']).default('active'),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
});

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── SRS ──
  app.get('/srs-config', async (): Promise<SrsConfigView> => srsConfig(ctx));
  app.post('/srs/rebuild', async (): Promise<SrsRebuildResponse> => rebuildAll(ctx));

  // ── cards ──
  app.get('/cards', async (req): Promise<CardListResponse> => {
    const q = parseQuery(listQuery, req);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.source_id) {
      where.push('source_id = ?');
      params.push(q.source_id);
    }
    if (q.status === 'active') where.push('deleted_at IS NULL AND suspended = 0');
    else if (q.status === 'suspended') where.push('deleted_at IS NULL AND suspended = 1');
    else if (q.status === 'deleted') where.push('deleted_at IS NOT NULL');
    else if (q.status === 'needs_review') where.push(`deleted_at IS NULL AND id IN (SELECT card_id FROM flashcard_impact WHERE active = 1 AND resolved_at IS NULL)`);
    const match = q.q?.trim() ? toFtsQuery(q.q, { prefix: true }) : null;
    if (q.q?.trim() && !match) return { items: [], next_cursor: null, counts: { total: 0, suspended: 0, needs_review: 0, deleted: 0 } };
    if (match) {
      where.push(`id IN (SELECT entity_id FROM owner_content_fts WHERE entity_type = 'flashcard' AND owner_content_fts MATCH ?)`);
      params.push(match);
    }
    if (q.cursor) {
      where.push('id > ?');
      params.push(q.cursor);
    }
    // impacts (AC-26) are brought up to date first (only when a cause changed): the needs_review filter and count depend on them
    refreshAllImpacts(ctx);
    const rows = ctx.db.all<FlashcardRow>(`SELECT * FROM flashcard ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`, [...params, q.limit + 1]);
    const page = rows.slice(0, q.limit);
    const items = viewsFor(ctx, page);
    const c = ctx.db.get<{ total: number; suspended: number; deleted: number }>(
      `SELECT SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS total, SUM(CASE WHEN deleted_at IS NULL AND suspended = 1 THEN 1 ELSE 0 END) AS suspended,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted FROM flashcard`,
    );
    const needs = ctx.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT i.card_id) AS n FROM flashcard_impact i JOIN flashcard f ON f.id = i.card_id WHERE i.active = 1 AND i.resolved_at IS NULL AND f.deleted_at IS NULL`,
    );
    return {
      items: q.status === 'needs_review' ? items.filter((i) => i.needs_review) : items,
      next_cursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      counts: { total: c?.total ?? 0, suspended: c?.suspended ?? 0, needs_review: needs?.n ?? 0, deleted: c?.deleted ?? 0 },
    };
  });
  app.post('/cards', async (req): Promise<CardCreateResponse> => createCards(ctx, parseBody(createBody, req) as never));
  app.post('/cards/from-selection', async (req): Promise<CardCreateResponse> => createFromSelection(ctx, parseBody(selectionBody, req) as never));
  app.post('/cards/from-mistake', async (req): Promise<CardCreateResponse> => createFromMistake(ctx, parseBody(mistakeBody, req)));
  app.post('/cards/occlusion', async (req): Promise<CardCreateResponse> => createOcclusion(ctx, parseBody(occlusionBody, req)));
  app.get('/cards/duplicates', async (): Promise<CardDuplicatesResponse> => ({ items: findDuplicates(ctx) }));
  app.post('/cards/duplicates/decide', async (req) => {
    const body = parseBody(z.object({ card_a_id: id, card_b_id: id, decision: z.enum(['not_duplicate', 'merge']), keep_id: id.nullable().optional() }).strict(), req);
    return decideDuplicate(ctx, body);
  });
  app.get('/cards/:id', async (req): Promise<CardDetailResponse> => {
    const { id: cardId } = parseParams(idParams, req);
    const card = viewOf(ctx, cardId, { refresh: true });
    const siblings = card.note_id
      ? ctx.db.all<Pick<FlashcardRow, 'id' | 'cloze_index' | 'kind' | 'deleted_at'>>('SELECT id, cloze_index, kind, deleted_at FROM flashcard WHERE note_id = ? AND id <> ? ORDER BY cloze_index, created_at', [card.note_id, cardId])
      : [];
    return { card, events: cardEvents(ctx.db, cardId).map(eventDTO), siblings };
  });
  app.patch('/cards/:id', async (req) => {
    const { id: cardId } = parseParams(idParams, req);
    return updateCard(ctx, cardId, parseBody(updateBody, req) as never);
  });
  app.delete('/cards/:id', async (req): Promise<CardMutationResponse> => ({ card: deleteCard(ctx, parseParams(idParams, req).id) }));
  app.post('/cards/:id/restore', async (req): Promise<CardMutationResponse> => ({ card: restoreCard(ctx, parseParams(idParams, req).id) }));
  app.post('/cards/:id/suspend', async (req): Promise<CardMutationResponse> => {
    const { suspended } = parseBody(z.object({ suspended: z.boolean() }).strict(), req);
    return { card: setSuspended(ctx, parseParams(idParams, req).id, suspended) };
  });
  app.post('/cards/:id/bury', async (req): Promise<CardMutationResponse> => {
    const { until } = parseBody(z.object({ until: z.number().int().min(0).nullable().optional() }).strict(), req);
    return { card: bury(ctx, parseParams(idParams, req).id, until) };
  });
  app.post('/cards/:id/unbury', async (req): Promise<CardMutationResponse> => ({ card: unbury(ctx, parseParams(idParams, req).id) }));
  app.post('/cards/:id/impact/resolve', async (req): Promise<CardMutationResponse> => {
    const body = parseBody(z.object({ resolution: z.enum(CARD_IMPACT_RESOLUTIONS.filter((r) => r === 'keep' || r === 'relearn' || r === 'move_to_current_version') as ['keep', 'relearn', 'move_to_current_version']) }).strict(), req);
    return { card: resolveCardImpact(ctx, parseParams(idParams, req).id, body) };
  });
  app.get('/cards/:id/review', async (req): Promise<CardReviewPayload> => reviewPayload(ctx, parseParams(idParams, req).id));

  // ── review ──
  app.get('/review/queue', async (req): Promise<CardQueueResponse> => {
    const q = parseQuery(z.object({ limit: z.coerce.number().int().min(0).max(500).default(50), source_id: id.optional() }), req);
    return reviewQueue(ctx, { limit: q.limit, sourceId: q.source_id ?? null });
  });
  app.post('/reviews', async (req): Promise<ReviewSubmitResponse> => {
    const body = parseBody(reviewEventSchema.extend({ id }).strict(), req);
    const res = ctx.db.tx(() => insertReviewEvent(ctx, body.id, body, { deviceId: null, touch: (t, eid) => void ctx.sync.touch(t, eid) }));
    if (!res.inserted && res.row.card_id !== body.card_id) throw new AppError('CONFLICT', 'يوجد حدث مراجعة بالمعرّف نفسه لبطاقة أخرى.', 409);
    return { result: res.inserted ? 'applied' : 'duplicate', event: eventDTO(res.row), card: viewOf(ctx, res.row.card_id) };
  });
  app.get('/media/:token', async (req, reply) => {
    const { token } = parseParams(z.object({ token: z.string().min(10).max(600) }), req);
    const cardId = verifyCardMediaToken(ctx, token);
    if (!cardId) throw new AppError('FORBIDDEN', 'انتهت صلاحية رابط الصورة؛ افتح البطاقة مجددًا لتحديثه.', 403);
    const fileId = cardMediaFile(ctx, cardId);
    const file = fileId ? ctx.files.stat(fileId) : null;
    if (!file) throw new AppError('NOT_FOUND', 'الصورة غير متاحة.', 404);
    // neutral delivery: never the original file name (it can reveal the hidden answer)
    return sendStoredFile(ctx.files, { ...file, original_name: null }, req, reply);
  });
  app.get('/export/anki', async (req, reply) => {
    const q = parseQuery(z.object({ source_id: id.optional(), deck: z.string().max(100).optional(), include_suspended: boolQuery.optional() }), req);
    const r = await exportAnki(ctx, { sourceId: q.source_id ?? null, deck: q.deck ?? null, includeSuspended: q.include_suspended ?? false });
    ctx.audit.record({ entityType: 'flashcard', entityId: 'export', action: 'export_anki', summary: `صدّرت ${r.report.basic_notes + r.report.cloze_notes} ملاحظة بصيغة استيراد النصوص في Anki${r.report.skipped.length ? ` (لم تُصدَّر ${r.report.skipped.length})` : ''}.` });
    reply.header('content-type', r.mime);
    reply.header('content-disposition', `attachment; filename="${r.filename}"`);
    reply.header('x-medlevo-export-report', encodeURIComponent(JSON.stringify({ basic_notes: r.report.basic_notes, cloze_notes: r.report.cloze_notes, media_files: r.report.media_files, skipped: r.report.skipped.length })));
    return reply.send(r.body);
  });
  app.get('/forecast', async (req): Promise<ForgettingForecastView> => {
    const q = parseQuery(z.object({ source_id: id.optional(), days: z.string().max(40).optional() }), req);
    const horizons = q.days ? q.days.split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x)) : undefined;
    return forgettingForecast(ctx, { sourceId: q.source_id ?? null, ...(horizons ? { horizons } : {}) });
  });

  // ── weakness & mistakes ──
  app.get('/weakness', async (req): Promise<WeaknessListResponse> => {
    const q = parseQuery(z.object({ status: z.enum(['open', 'active', 'improving', 'resolved', 'dismissed', 'all']).default('open') }), req);
    return listWeaknesses(ctx, q.status);
  });
  app.get('/weakness/:id', async (req): Promise<WeaknessDetailView> => getWeakness(ctx, parseParams(idParams, req).id));
  app.patch('/weakness/:id', async (req): Promise<WeaknessDetailView> => {
    const body = parseBody(
      z
        .object({
          label: z.string().max(200).nullable().optional(),
          note: z.string().max(2000).nullable().optional(),
          status: z.enum(['active', 'dismissed', 'resolved']).nullable().optional(),
          excluded_refs: z.array(z.string().max(80)).max(500).optional(),
        })
        .strict(),
      req,
    );
    return patchWeakness(ctx, parseParams(idParams, req).id, body);
  });
  app.post('/weakness/:id/revision', async (req): Promise<RevisionSessionDetail> => {
    const { minutes } = parseBody(z.object({ minutes: z.number().int().min(5).max(240).optional() }).strict(), req);
    return weaknessRevision(ctx, parseParams(idParams, req).id, minutes ?? 20);
  });
  app.get('/mistakes/genome', async (req): Promise<MistakeGenomeView> => {
    const q = parseQuery(z.object({ source_id: id.optional(), course_node_id: id.optional() }), req);
    return mistakeGenome(ctx, { sourceId: q.source_id ?? null, courseNodeId: q.course_node_id ?? null });
  });
  app.patch('/mistakes/:attemptId', async (req) => {
    const { attemptId } = parseParams(z.object({ attemptId: id }), req);
    const { mistake_type } = parseBody(z.object({ mistake_type: z.enum(MISTAKE_TYPES).nullable() }).strict(), req);
    return { attempt: editMistakeType(ctx, attemptId, mistake_type) };
  });
  app.get('/reasoning/:questionId', async (req): Promise<ReasoningReplayView> => {
    const { questionId } = parseParams(z.object({ questionId: id }), req);
    const q = parseQuery(z.object({ attempt_id: id.optional() }), req);
    return reasoningReplay(ctx, questionId, q.attempt_id ?? null);
  });

  // ── profile ──
  app.get('/profile', async (): Promise<LearningProfileView> => getProfile(ctx));
  app.patch('/profile', async (req): Promise<LearningProfileView> => {
    const body = parseBody(
      z
        .object({
          self_level: z.string().max(200).optional(),
          subjects_studied: z.array(z.string().max(200)).max(100).optional(),
          preferences: z
            .object({ explanation_level: z.enum(EXPLANATION_LEVELS).optional(), dialect: z.enum(['fusha_simple', 'iraqi_teaching']).optional(), socratic: z.boolean().optional() })
            .strict()
            .optional(),
          pace_minutes_per_day: z.number().int().min(5).max(960).nullable().optional(),
        })
        .strict(),
      req,
    );
    return patchProfile(ctx, body);
  });
  app.post('/profile/reset', async (req): Promise<LearningProfileView> => {
    const { part } = parseBody(z.object({ part: z.enum(PROFILE_SIGNAL_PARTS) }).strict(), req);
    return resetSignalPart(ctx, part);
  });

  // ── planner ──
  app.get('/plans', async (): Promise<PlanListResponse> => listPlans(ctx));
  app.post('/plans/preview', async (req): Promise<PlanPreviewResponse> => previewPlan(ctx, parseBody(planConfigSchema, req) as StudyPlanConfig));
  app.post('/plans', async (req): Promise<StudyPlanView> => createPlan(ctx, parseBody(planConfigSchema, req) as StudyPlanConfig));
  app.get('/plans/:id', async (req): Promise<StudyPlanView> => planView(ctx, parseParams(idParams, req).id));
  app.post('/plans/:id/rebalance', async (req): Promise<PlanRebalanceResponse> => rebalancePlan(ctx, parseParams(idParams, req).id));
  app.patch('/plans/:id/tasks/:taskId', async (req): Promise<StudyPlanView> => {
    const p = parseParams(z.object({ id, taskId: id }), req);
    const { status } = parseBody(z.object({ status: z.enum(['todo', 'done', 'skipped']) }).strict(), req);
    return setTaskStatus(ctx, p.id, p.taskId, status);
  });
  app.post('/plans/:id/archive', async (req): Promise<StudyPlanView> => archivePlan(ctx, parseParams(idParams, req).id));

  // ── one-tap revision ──
  app.post('/revision', async (req): Promise<RevisionSessionDetail> => buildRevision(ctx, parseBody(revisionRequestSchema.strict(), req)));
  app.get('/revision/:id', async (req): Promise<RevisionSessionDetail> => getRevision(ctx, parseParams(idParams, req).id));

  // ── home, Exam DNA, progress ──
  app.get('/home', async (): Promise<HomeDetail> => homeView(ctx));
  app.get('/exam-dna', async (req): Promise<ExamDnaDetail> => {
    const q = parseQuery(z.object({ course_node_id: id.optional(), source_ids: z.string().max(2000).optional() }), req);
    return examDna(ctx, { courseNodeId: q.course_node_id ?? null, sourceIds: q.source_ids ? q.source_ids.split(',').filter(Boolean).slice(0, 50) : null });
  });
  app.get('/exam-dna/relevance', async (req): Promise<ExamRelevanceView> => {
    const q = parseQuery(z.object({ question_id: id.optional(), concept_id: id.optional() }), req);
    return examRelevance(ctx, { questionId: q.question_id ?? null, conceptId: q.concept_id ?? null });
  });
  app.get('/progress', async (req): Promise<SourceProgressListResponse> => {
    const q = parseQuery(z.object({ course_node_id: id.optional() }), req);
    return progressList(ctx, { courseNodeId: q.course_node_id ?? null });
  });
  app.get('/progress/:id', async (req): Promise<SourceProgressDetail> => sourceProgress(ctx, parseParams(idParams, req).id));
}

export { requireCard, findCard };
