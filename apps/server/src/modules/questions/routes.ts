// /api/questions — Question Vault HTTP API (owner session + CSRF enforced globally).
//   GET    /                               list with filters (QuestionListResponse)
//   GET    /review-queue                   question review items (ReviewQueueResponse)
//   POST   /review-queue/:itemId/resolve   accept / correct / reject / dismiss one item
//   GET    /for-lecture/:sourceId?page_id= questions linked to a lecture, this page first (LectureQuestionsResponse)
//   GET    /extractions/:versionId         extraction summary of a source version
//   GET    /concepts?source_id=            concept candidates of a lecture (§16)
//   PATCH  /concepts/:id                   accept / reject a concept candidate
//   POST   /extract {version_id}           (re)run extraction → job
//   POST   /match {version_id|source_id}   (re)run lecture ↔ question matching → job
//   POST   /quick-add                      JSON {text,…} or multipart {node_id, title?, file}
//   POST   /links/:linkId/decision         owner accepts / rejects a suggested lecture link
//   POST   /duplicates/:dupId/decision     owner confirms / rejects a duplicate suggestion
//   GET    /:id                            QuestionDetailResponse
//   GET    /:id/original?occurrence_id=    original page(s) + regions for side-by-side review
//   PATCH  /:id                            owner correction → new version
//   POST   /:id/key                        owner key → new version + impact + content alert
//   POST   /:id/review                     accept (owner_reviewed) / reject (retired)
//   POST   /:id/links                      owner-made lecture link
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ANSWER_STATUSES,
  EXTRACT_QUESTIONS_JOB_KIND,
  LECTURE_LINK_RELATIONS,
  MATCH_QUESTIONS_JOB_KIND,
  QUESTION_TYPES,
  SCORABLE_ANSWER_STATUSES,
  normalizeForSearch,
  pageDisplayLabel,
  richTextToPlain,
  stemPreview,
  toFtsQuery,
  type ConceptListResponse,
  type DuplicateDetail,
  type ExtractionSummaryView,
  type JobStartedResponse,
  type JobView,
  type KeyEntryDetail,
  type LectureQuestionItem,
  type LectureQuestionsResponse,
  type NormBox,
  type QuestionDetailResponse,
  type QuestionListItem,
  type QuestionListResponse,
  type QuestionMutationResponse,
  type QuestionOriginalView,
  type QuickAddResponse,
  type ReviewQueueResponse,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery, RATE_LIMITS } from '../../lib/http';
import { conceptViews, decideConcept } from './concepts';
import { correctKey, correctQuestion, decideLink, ownerLink, reviewQuestion } from './corrections';
import { decideDuplicate } from './duplicates';
import { extractionSummary } from './extract';
import { courseHasQuestionSources } from './match';
import { quickAddImage, quickAddText } from './quickadd';
import { QUESTION_REVIEW_KINDS, reviewItemsForQuestion, reviewItemView, type ReviewItemRow } from './review';
import {
  attemptsByVersion,
  getQuestionRow,
  linkView,
  occurrenceView,
  optionRows,
  originLabel,
  pageLabel,
  questionView,
  scorability,
  type OccurrenceBox,
  type OccurrenceRow,
  type QuestionRow,
  type VersionRow,
  versionView,
} from './store';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });
const optReason = z.string().trim().max(1000).optional();

const listQuery = z.object({
  course_id: id.optional(),
  source_id: id.optional(),
  lecture_id: id.optional(),
  relation: z.enum(LECTURE_LINK_RELATIONS).optional(),
  answer_status: z.enum(ANSWER_STATUSES).optional(),
  extraction_status: z.enum(['not_applicable', 'extracted', 'checks_passed', 'needs_review', 'owner_reviewed']).optional(),
  status: z.enum(['draft', 'needs_review', 'ready', 'retired']).optional(),
  origin: z.enum(['source', 'generated', 'owner']).optional(),
  review: z.enum(['open', 'none']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().max(16).optional(),
});
const correctionBody = z
  .object({
    stem: z.string().max(20_000).optional(),
    options: z
      .array(
        z
          .object({
            option_key: z.string().regex(/^o\d{1,3}$/).optional(),
            source_label: z.string().trim().max(8).nullable().optional(),
            text: z.string().trim().min(1, 'نص الخيار مطلوب.').max(4000),
            pinned_position: z.boolean().optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    qtype: z.enum(QUESTION_TYPES).optional(),
    explanation: z.string().max(20_000).nullable().optional(),
    learning_objective: z.string().max(1000).nullable().optional(),
    reviewed_fields: z.array(z.enum(['stem', 'options', 'key', 'images', 'qtype', 'explanation', 'all'])).max(10).optional(),
    note: z.string().trim().max(1000).optional(),
    acknowledge_blockers: z.boolean().optional(),
  })
  .strict();
const keyBody = z.object({ option_keys: z.array(z.string().regex(/^o\d{1,3}$/)).max(12).nullable(), reason: optReason }).strict();
const reviewBody = z
  .object({
    decision: z.enum(['accept', 'reject']),
    reviewed_fields: z.array(z.enum(['stem', 'options', 'key', 'images', 'qtype', 'explanation', 'all'])).max(10).optional(),
    reason: optReason,
    acknowledge_blockers: z.boolean().optional(),
  })
  .strict();
const decisionBody = z.object({ status: z.enum(['accepted', 'rejected']), reason: optReason }).strict();
const dupDecisionBody = z.object({ status: z.enum(['confirmed', 'rejected']), reason: optReason }).strict();
const ownerLinkBody = z.object({ lecture_source_id: id, relation: z.enum(LECTURE_LINK_RELATIONS), reason: optReason }).strict();
const extractBody = z.object({ version_id: id }).strict();
const matchBody = z
  .object({ version_id: id.optional(), source_id: id.optional() })
  .strict()
  .refine((b) => !!b.version_id || !!b.source_id, 'حدد version_id أو source_id.');
const quickAddBody = z
  .object({
    text: z.string().max(20_000),
    course_node_id: id.nullable().optional(),
    lecture_source_id: id.nullable().optional(),
    key_label: z.string().trim().max(4).nullable().optional(),
  })
  .strict();
const reviewQueueQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  kind: z.enum(QUESTION_REVIEW_KINDS as [string, ...string[]]).optional(),
  source_id: id.optional(),
  question_id: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const resolveBody = z.object({ action: z.enum(['accepted', 'corrected', 'rejected', 'dismissed']), note: optReason }).strict();
const forLectureQuery = z.object({ page_id: id.optional() });
const conceptsQuery = z.object({ source_id: id });
const conceptBody = z.object({ status: z.enum(['accepted', 'rejected']) }).strict();
const originalQuery = z.object({ occurrence_id: id.optional() });

// ───────── helpers ─────────
function listItem(ctx: AppContext, q: QuestionRow, v: VersionRow): QuestionListItem {
  const occRows = ctx.db.all<OccurrenceRow & { source_title: string; source_type: string }>(
    `SELECT o.*, s.title AS source_title, s.source_type FROM question_occurrence o JOIN source s ON s.id = o.source_id
      WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.created_at, o.ord`,
    [q.id],
  );
  const first = occRows[0] ? occurrenceView(ctx, occRows[0]) : null;
  const open = ctx.db.all<{ id: string; kind: QuestionListItem['open_review'][number]['kind']; reason: string }>(
    `SELECT id, kind, reason FROM review_queue_item WHERE status = 'open' AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions'
       AND (json_extract(details_json, '$.question_id') = ? OR (entity_type = 'question' AND entity_id = ?)) ORDER BY created_at`,
    [q.id, q.id],
  );
  const links = ctx.db.all<{ lecture_source_id: string; lecture_title: string; relation: QuestionListItem['lecture_links'][number]['relation']; status: QuestionListItem['lecture_links'][number]['status'] }>(
    `SELECT l.lecture_source_id, s.title AS lecture_title, l.relation, l.status FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND l.status <> 'rejected' AND s.deleted_at IS NULL
      ORDER BY CASE l.relation WHEN 'directly_covered' THEN 0 WHEN 'strongly_related' THEN 1 WHEN 'partially_covered' THEN 2 ELSE 3 END`,
    [q.id],
  );
  const s = scorability(v);
  return {
    id: q.id,
    origin_type: q.origin_type,
    origin_label_ar: originLabel(ctx, q, first ? [first] : []),
    status: q.status,
    version_id: v.id,
    version_no: v.version_no,
    qtype: v.qtype,
    stem_preview: stemPreview(fromJson<RichText | null>(v.stem_json, null)),
    has_negation: v.has_negation === 1,
    negation_terms: fromJson<string[]>(v.negation_terms_json, []) ?? [],
    answer_status: v.answer_status,
    extraction_status: v.extraction_status,
    options_count: optionRows(ctx, v.id).length,
    occurrences_count: occRows.length,
    primary_occurrence: first
      ? { source_id: first.source_id, source_title: first.source_title, section_key: first.section_key, section_title: first.section_title, printed_number: first.printed_number, pages: first.pages }
      : null,
    open_review: open,
    lecture_links: links,
    scorable: s.scorable,
    unscorable_reason_ar: s.reason_ar,
    updated_at: q.updated_at,
  };
}

function enqueueJob(ctx: AppContext, kind: string, input: unknown, key: string): JobView | null {
  if (!ctx.jobs.isRegistered(kind)) return null;
  return ctx.jobs.enqueue(kind, input, { idempotencyKey: key });
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ───────── list ─────────
  app.get('/', async (req): Promise<QuestionListResponse> => {
    const f = parseQuery(listQuery, req);
    const where: string[] = ['q.deleted_at IS NULL', 'q.current_version_id IS NOT NULL'];
    const params: unknown[] = [];
    if (f.status) {
      where.push('q.status = ?');
      params.push(f.status);
    } else where.push(`q.status <> 'retired'`);
    if (f.origin) {
      where.push('q.origin_type = ?');
      params.push(f.origin);
    }
    if (f.answer_status) {
      where.push('v.answer_status = ?');
      params.push(f.answer_status);
    }
    if (f.extraction_status) {
      where.push('v.extraction_status = ?');
      params.push(f.extraction_status);
    }
    if (f.course_id) {
      where.push(`(q.course_node_id = ? OR EXISTS (SELECT 1 FROM question_occurrence o JOIN source s ON s.id = o.source_id WHERE o.question_id = q.id AND s.course_node_id = ?))`);
      params.push(f.course_id, f.course_id);
    }
    if (f.source_id) {
      where.push('EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = q.id AND o.source_id = ?)');
      params.push(f.source_id);
    }
    if (f.lecture_id || f.relation) {
      const conds = [`l.question_id = q.id`, `l.status <> 'rejected'`];
      if (f.lecture_id) {
        conds.push('l.lecture_source_id = ?');
        params.push(f.lecture_id);
      }
      if (f.relation) {
        conds.push('l.relation = ?');
        params.push(f.relation);
      }
      where.push(`EXISTS (SELECT 1 FROM question_lecture_link l WHERE ${conds.join(' AND ')})`);
    }
    if (f.review) {
      const sub = `EXISTS (SELECT 1 FROM review_queue_item r WHERE r.status = 'open' AND json_valid(r.details_json) AND json_extract(r.details_json, '$.origin') = 'questions'
        AND (json_extract(r.details_json, '$.question_id') = q.id OR (r.entity_type = 'question' AND r.entity_id = q.id)))`;
      where.push(f.review === 'open' ? sub : `NOT ${sub}`);
    }
    if (f.q) {
      const match = toFtsQuery(f.q, { prefix: true });
      if (!match) return { items: [], next_cursor: null, total: 0 };
      where.push('q.id IN (SELECT question_id FROM question_fts WHERE question_fts MATCH ?)');
      params.push(match);
    }
    const base = `FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE ${where.join(' AND ')}`;
    const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params)!.n;
    // source order: when the question entered the vault, then its place in the file (ids created in the same
    // millisecond are not ordered); the cursor is an offset into this stable order
    const offset = f.cursor && /^\d{1,7}$/.test(f.cursor) ? Number(f.cursor) : 0;
    const rows = ctx.db.all<QuestionRow & { v_id: string }>(
      `SELECT q.*, v.id AS v_id ${base}
        ORDER BY q.created_at,
                 (SELECT o.ord FROM question_occurrence o WHERE o.question_id = q.id ORDER BY o.created_at, o.ord LIMIT 1),
                 q.id
        LIMIT ? OFFSET ?`,
      [...params, f.limit + 1, offset],
    );
    const page = rows.slice(0, f.limit);
    const items = page.map((r) => listItem(ctx, r, ctx.db.get<VersionRow>('SELECT * FROM question_version WHERE id = ?', [r.v_id])!));
    return { items, next_cursor: rows.length > f.limit ? String(offset + f.limit) : null, total };
  });

  // ───────── review queue ─────────
  app.get('/review-queue', async (req): Promise<ReviewQueueResponse> => {
    const f = parseQuery(reviewQueueQuery, req);
    const where = [`json_valid(details_json)`, `json_extract(details_json, '$.origin') = 'questions'`];
    const params: unknown[] = [];
    if (f.status === 'open') where.push(`status = 'open'`);
    else if (f.status === 'resolved') where.push(`status <> 'open'`);
    if (f.kind) {
      where.push('kind = ?');
      params.push(f.kind);
    }
    if (f.source_id) {
      where.push('source_id = ?');
      params.push(f.source_id);
    }
    if (f.question_id) {
      where.push(`(json_extract(details_json, '$.question_id') = ? OR (entity_type = 'question' AND entity_id = ?))`);
      params.push(f.question_id, f.question_id);
    }
    const rows = ctx.db.all<ReviewItemRow>(`SELECT * FROM review_queue_item WHERE ${where.join(' AND ')} ORDER BY status = 'open' DESC, created_at LIMIT ?`, [...params, f.limit]);
    const totalOpen = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions'`,
    )!.n;
    const items = rows.map((r) => {
      const v = reviewItemView(r);
      let preview: string | null = null;
      let origin: string | null = null;
      if (v.question_id) {
        const q = ctx.db.get<QuestionRow>('SELECT * FROM question WHERE id = ? AND deleted_at IS NULL', [v.question_id]);
        if (q?.current_version_id) {
          const cv = ctx.db.get<{ stem_json: string }>('SELECT stem_json FROM question_version WHERE id = ?', [q.current_version_id]);
          preview = stemPreview(fromJson<RichText | null>(cv?.stem_json ?? null, null), 140);
          origin = originLabel(ctx, q);
        }
      }
      return { ...v, question_stem_preview: preview, origin_label_ar: origin };
    });
    return { items, total_open: totalOpen };
  });

  app.post('/review-queue/:itemId/resolve', async (req) => {
    const { itemId } = parseParams(z.object({ itemId: id }), req);
    const b = parseBody(resolveBody, req);
    const row = ctx.db.get<ReviewItemRow>(
      `SELECT * FROM review_queue_item WHERE id = ? AND json_valid(details_json) AND json_extract(details_json, '$.origin') = 'questions'`,
      [itemId],
    );
    if (!row) throw new AppError('NOT_FOUND', 'عنصر المراجعة غير موجود.', 404);
    if (row.status !== 'open') throw new AppError('CONFLICT', 'عولج هذا العنصر من قبل.', 409);
    const now = ctx.clock.now();
    ctx.db.run('UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ? WHERE id = ?', [b.action, now, toJson({ by: 'owner', note: b.note ?? null }), itemId]);
    ctx.audit.record({ entityType: 'review_queue_item', entityId: itemId, action: `review_${b.action}`, summary: row.reason, after: { note: b.note ?? null } });
    return { ok: true, item: reviewItemView({ ...row, status: b.action, resolved_at: now }) };
  });

  // ───────── lecture side ─────────
  app.get('/for-lecture/:sourceId', async (req): Promise<LectureQuestionsResponse> => {
    const { sourceId } = parseParams(z.object({ sourceId: id }), req);
    const { page_id } = parseQuery(forLectureQuery, req);
    const src = ctx.db.get<{ id: string; title: string; current_version_id: string | null; frozen_version_id: string | null; deleted_at: number | null; source_type: string }>(
      'SELECT id, title, current_version_id, frozen_version_id, deleted_at, source_type FROM source WHERE id = ?',
      [sourceId],
    );
    if (!src || src.deleted_at !== null) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
    const versionId = src.frozen_version_id ?? src.current_version_id;
    const rows = ctx.db.all<Parameters<typeof linkView>[1] & { reason_json: string | null }>(
      `SELECT l.*, s.title AS lecture_title FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
         JOIN question q ON q.id = l.question_id
        WHERE l.lecture_source_id = ? AND l.status <> 'rejected' AND q.deleted_at IS NULL AND q.status <> 'retired'`,
      [sourceId],
    );
    const strength: Record<string, number> = { directly_covered: 0, strongly_related: 1, partially_covered: 2, course_related_only: 3 };
    const items: LectureQuestionItem[] = rows.map((r) => {
      const link = linkView(ctx, r);
      const q = getQuestionRow(ctx, r.question_id);
      const v = ctx.db.get<VersionRow>('SELECT * FROM question_version WHERE id = ?', [q.current_version_id])!;
      const occRow = ctx.db.get<OccurrenceRow & { source_title: string; source_type: string }>(
        `SELECT o.*, s.title AS source_title, s.source_type FROM question_occurrence o JOIN source s ON s.id = o.source_id
          WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.status = 'current' DESC, o.created_at LIMIT 1`,
        [q.id],
      );
      const occ = occRow ? occurrenceView(ctx, occRow) : null;
      const box = occRow ? (fromJson<OccurrenceBox[]>(occRow.boxes_json, []) ?? [])[0] : undefined;
      return {
        link,
        question_id: q.id,
        origin_label_ar: originLabel(ctx, q, occ ? [occ] : []),
        stem_preview: stemPreview(fromJson<RichText | null>(v.stem_json, null), 200),
        qtype: v.qtype,
        has_negation: v.has_negation === 1,
        answer_status: v.answer_status,
        status: q.status,
        scorable: scorability(v).scorable,
        on_this_page: !!page_id && link.lecture_pages.some((p) => p.page_id === page_id),
        occurrence: occ,
        original: occRow
          ? {
              source_id: occRow.source_id,
              version_id: occRow.source_version_id,
              page_id: box?.page_id ?? occ?.pages[0]?.page_id ?? null,
              page_index: box?.page_index ?? occ?.pages[0]?.page_index ?? null,
              bbox: (box?.bbox as NormBox | null) ?? null,
              region_id: box?.region_id ?? null,
            }
          : null,
      };
    });
    items.sort(
      (a, b) =>
        Number(b.on_this_page) - Number(a.on_this_page) ||
        Number(b.link.status === 'accepted') - Number(a.link.status === 'accepted') ||
        strength[a.link.relation]! - strength[b.link.relation]! ||
        (a.occurrence?.origin_label_ar ?? '').localeCompare(b.occurrence?.origin_label_ar ?? '', 'ar', { numeric: true }),
    );
    let matching: LectureQuestionsResponse['matching'];
    const v = versionId ? ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source_version WHERE id = ?', [versionId]) : undefined;
    const pendingJob = versionId
      ? ctx.db.get<{ id: string }>(
          `SELECT id FROM processing_job WHERE kind IN (?, ?) AND status IN ('queued','running') AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC LIMIT 1`,
          [MATCH_QUESTIONS_JOB_KIND, 'process_source_version', versionId],
        )
      : undefined;
    if (!v || !['ready', 'partial', 'needs_review'].includes(v.processing_status)) {
      matching = { state: 'not_processed', message_ar: 'لم تنتهِ معالجة هذه المحاضرة بعد؛ تُربط الأسئلة بها تلقائيًا عند انتهائها.', job: pendingJob ? ctx.jobs.get(pendingJob.id) : null };
    } else if (pendingJob) {
      matching = { state: 'pending', message_ar: 'جارٍ ربط أسئلة الكورس بهذه المحاضرة…', job: ctx.jobs.get(pendingJob.id) };
    } else if (items.length === 0 && !courseHasQuestionSources(ctx, sourceId)) {
      matching = {
        state: 'no_question_sources',
        message_ar: 'لا توجد مصادر أسئلة أو امتحانات سابقة في كورس هذه المحاضرة بعد. عند رفعها تُربط أسئلتها هنا تلقائيًا مع سبب الربط وصفحاته.',
        job: null,
      };
    } else {
      matching = {
        state: 'done',
        message_ar: items.length === 0 ? 'لم يُعثر على أسئلة من مصادر الكورس تغطيها هذه المحاضرة.' : null,
        job: null,
      };
    }
    return { lecture: { source_id: src.id, title: src.title, version_id: versionId }, items, matching };
  });

  // ───────── extraction / matching triggers ─────────
  app.get('/extractions/:versionId', async (req): Promise<{ summary: ExtractionSummaryView | null; job: JobView | null }> => {
    const { versionId } = parseParams(z.object({ versionId: id }), req);
    const job = ctx.db.get<{ id: string }>(
      `SELECT id FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC LIMIT 1`,
      [EXTRACT_QUESTIONS_JOB_KIND, versionId],
    );
    return { summary: extractionSummary(ctx, versionId), job: job ? ctx.jobs.get(job.id) : null };
  });

  app.post('/extract', async (req): Promise<JobStartedResponse> => {
    const { version_id } = parseBody(extractBody, req);
    const v = ctx.db.get<{ processing_status: string; deleted_at: number | null }>(
      'SELECT v.processing_status, s.deleted_at FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
      [version_id],
    );
    if (!v || v.deleted_at !== null) throw new AppError('NOT_FOUND', 'نسخة المصدر غير موجودة.', 404);
    if (!['ready', 'partial', 'needs_review'].includes(v.processing_status)) {
      throw new AppError('CONFLICT', 'لم تنتهِ معالجة هذا المصدر بعد؛ تُستخرج الأسئلة تلقائيًا عند انتهائها.', 409);
    }
    const job = enqueueJob(ctx, EXTRACT_QUESTIONS_JOB_KIND, { version_id }, `${EXTRACT_QUESTIONS_JOB_KIND}:${version_id}:manual:${ctx.clock.now()}`);
    return { job, message_ar: 'بدأ استخراج الأسئلة. ما سبق أن صححته أو راجعته لن يُستبدل، ولن تتكرر الأسئلة.' };
  });

  app.post('/match', async (req): Promise<JobStartedResponse> => {
    const b = parseBody(matchBody, req);
    let versionId = b.version_id ?? null;
    if (!versionId && b.source_id) {
      const s = ctx.db.get<{ current_version_id: string | null; frozen_version_id: string | null }>('SELECT current_version_id, frozen_version_id FROM source WHERE id = ? AND deleted_at IS NULL', [b.source_id]);
      versionId = s ? (s.frozen_version_id ?? s.current_version_id) : null;
    }
    if (!versionId || !ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [versionId])) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
    const job = enqueueJob(ctx, MATCH_QUESTIONS_JOB_KIND, { version_id: versionId }, `${MATCH_QUESTIONS_JOB_KIND}:${versionId}:manual:${ctx.clock.now()}`);
    return { job, message_ar: 'بدأ ربط الأسئلة بالمحاضرات. الروابط التي قبلتها أو رفضتها لن تتغير.' };
  });

  // ───────── quick add ─────────
  app.post('/quick-add', { config: { rateLimit: RATE_LIMITS.upload } }, async (req): Promise<QuickAddResponse> => {
    if (req.isMultipart()) return quickAddImage(ctx, req);
    return quickAddText(ctx, parseBody(quickAddBody, req));
  });

  // ───────── concepts ─────────
  app.get('/concepts', async (req): Promise<ConceptListResponse> => {
    const { source_id } = parseQuery(conceptsQuery, req);
    const s = ctx.db.get<{ current_version_id: string | null; frozen_version_id: string | null }>('SELECT current_version_id, frozen_version_id FROM source WHERE id = ? AND deleted_at IS NULL', [source_id]);
    if (!s) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
    const vid = s.frozen_version_id ?? s.current_version_id;
    return { items: vid ? conceptViews(ctx, [vid]) : [] };
  });
  app.patch('/concepts/:id', async (req) => {
    const p = parseParams(idParams, req);
    const b = parseBody(conceptBody, req);
    decideConcept(ctx, p.id, b.status);
    return { ok: true };
  });

  // ───────── links & duplicates ─────────
  app.post('/links/:linkId/decision', async (req) => {
    const { linkId } = parseParams(z.object({ linkId: id }), req);
    const b = parseBody(decisionBody, req);
    decideLink(ctx, linkId, b.status, b.reason ?? null);
    const l = ctx.db.get<{ question_id: string }>('SELECT question_id FROM question_lecture_link WHERE id = ?', [linkId])!;
    return { question: questionView(ctx, l.question_id) };
  });
  app.post('/duplicates/:dupId/decision', async (req) => {
    const { dupId } = parseParams(z.object({ dupId: id }), req);
    const b = parseBody(dupDecisionBody, req);
    decideDuplicate(ctx, dupId, b.status, b.reason ?? null);
    return { ok: true };
  });

  // ───────── one question ─────────
  app.get('/:id', async (req): Promise<QuestionDetailResponse> => {
    const p = parseParams(idParams, req);
    const view = questionView(ctx, p.id);
    const versions = ctx.db.all<VersionRow>('SELECT * FROM question_version WHERE question_id = ? ORDER BY version_no DESC', [p.id]);
    const attempts = attemptsByVersion(ctx, p.id);
    const occIds = view.occurrences.map((o) => o.id);
    const keyRows = occIds.length
      ? ctx.db.all<{
          id: string;
          section_key: string;
          printed_number: string;
          key_label: string;
          mark_kind: KeyEntryDetail['mark_kind'];
          origin_known: number;
          page_id: string | null;
          region_id: string | null;
          key_block: number;
          binding: KeyEntryDetail['binding'];
          section_title: string | null;
          raw_text: string | null;
          source_id: string;
          source_title: string;
          option_labels_json: string | null;
          page_index: number | null;
          printed_label: string | null;
          page_kind: string | null;
        }>(
          `SELECT e.*, o.source_id, s.title AS source_title, o.option_labels_json, p.page_index, p.printed_label, p.kind AS page_kind
             FROM answer_key_entry e JOIN question_occurrence o ON o.id = e.matched_occurrence_id JOIN source s ON s.id = o.source_id
             LEFT JOIN source_page p ON p.id = e.page_id
            WHERE e.matched_occurrence_id IN (${occIds.map(() => '?').join(',')}) ORDER BY e.created_at, e.key_block`,
          occIds,
        )
      : [];
    const key_entries: KeyEntryDetail[] = keyRows.map((k) => {
      const labels = fromJson<Record<string, string>>(k.option_labels_json, {}) ?? {};
      const optionKey = Object.entries(labels).find(([, l]) => l === k.key_label)?.[0] ?? null;
      return {
        id: k.id,
        section_key: k.section_key,
        printed_number: k.printed_number,
        key_label: k.key_label,
        mark_kind: k.mark_kind,
        origin_known: k.origin_known === 1,
        page_id: k.page_id,
        region_id: k.region_id,
        key_block: k.key_block,
        binding: k.binding,
        section_title: k.section_title,
        raw_text: k.raw_text,
        source_id: k.source_id,
        source_title: k.source_title,
        page_label_ar: k.page_index !== null ? pageLabel({ id: k.page_id ?? '', page_index: k.page_index, printed_label: k.printed_label, kind: k.page_kind ?? 'page' }) : null,
        option_key: optionKey,
      };
    });
    const cur = versions.find((x) => x.id === view.current.id)!;
    const s = scorability(cur);
    const occurrence_boxes: QuestionDetailResponse['occurrence_boxes'] = {};
    for (const o of ctx.db.all<{ id: string; boxes_json: string | null }>('SELECT id, boxes_json FROM question_occurrence WHERE question_id = ?', [p.id])) {
      occurrence_boxes[o.id] = (fromJson<OccurrenceBox[]>(o.boxes_json, []) ?? []).map((b) => ({ page_id: b.page_id, page_index: b.page_index, region_id: b.region_id, bbox: (b.bbox as NormBox | null) ?? null }));
    }
    return {
      question: view,
      versions: versions.map((v) => ({ ...versionView(ctx, v), attempts: attempts[v.id] ?? 0, note: v.note })),
      key_entries,
      review_items: reviewItemsForQuestion(ctx, p.id),
      attempts_by_version: attempts,
      occurrence_boxes,
      scorable: s.scorable,
      unscorable_reason_ar: s.reason_ar,
    };
  });

  app.get('/:id/duplicates', async (req): Promise<{ items: DuplicateDetail[] }> => {
    const p = parseParams(idParams, req);
    const view = questionView(ctx, p.id);
    const items = view.duplicates.map((d) => {
      const other = ctx.db.get<QuestionRow>('SELECT * FROM question WHERE id = ?', [d.other_question_id])!;
      const ov = ctx.db.get<{ stem_json: string }>('SELECT stem_json FROM question_version WHERE id = ?', [other.current_version_id]);
      const dr = ctx.db.get<{ decision_reason: string | null }>('SELECT decision_reason FROM question_duplicate WHERE id = ?', [d.id]);
      return { ...d, other_stem_preview: stemPreview(fromJson<RichText | null>(ov?.stem_json ?? null, null), 200), other_origin_label_ar: originLabel(ctx, other), decision_reason: dr?.decision_reason ?? null };
    });
    return { items };
  });

  app.get('/:id/original', async (req): Promise<QuestionOriginalView> => {
    const p = parseParams(idParams, req);
    const { occurrence_id } = parseQuery(originalQuery, req);
    getQuestionRow(ctx, p.id);
    const occ = ctx.db.get<OccurrenceRow & { source_title: string; source_type: string }>(
      `SELECT o.*, s.title AS source_title, s.source_type FROM question_occurrence o JOIN source s ON s.id = o.source_id
        WHERE o.question_id = ? ${occurrence_id ? 'AND o.id = ?' : ''} AND s.deleted_at IS NULL ORDER BY o.status = 'current' DESC, o.created_at LIMIT 1`,
      occurrence_id ? [p.id, occurrence_id] : [p.id],
    );
    if (!occ) throw new AppError('NOT_FOUND', 'لا يوجد موضع أصلي لهذا السؤال (أضفته بنفسك أو حُذف مصدره).', 404);
    const ver = ctx.db.get<{ id: string; format: string; display_file_id: string | null; file_id: string | null }>(
      'SELECT id, format, display_file_id, file_id FROM source_version WHERE id = ?',
      [occ.source_version_id],
    )!;
    const boxes = fromJson<OccurrenceBox[]>(occ.boxes_json, []) ?? [];
    const pageIds = fromJson<string[]>(occ.page_ids_json, []) ?? [];
    const pages = pageIds
      .map((pid) =>
        ctx.db.get<{ id: string; page_index: number; printed_label: string | null; kind: string; width: number | null; height: number | null; render_file_id: string | null }>(
          'SELECT id, page_index, printed_label, kind, width, height, render_file_id FROM source_page WHERE id = ?',
          [pid],
        ),
      )
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((pg) => ({
        page_id: pg.id,
        page_index: pg.page_index,
        label_ar: pageDisplayLabel({ page_index: pg.page_index, printed_label: pg.printed_label, kind: pg.kind as never }),
        width: pg.width,
        height: pg.height,
        kind: pg.kind,
        render_file_id: pg.render_file_id,
        boxes: boxes.filter((b) => b.page_id === pg.id && b.bbox).map((b) => ({ region_id: b.region_id, bbox: b.bbox as NormBox })),
      }));
    return { occurrence: occurrenceView(ctx, occ), version: ver, pages, raw_text: occ.raw_text };
  });

  app.patch('/:id', async (req): Promise<QuestionMutationResponse> => {
    const p = parseParams(idParams, req);
    return correctQuestion(ctx, p.id, parseBody(correctionBody, req));
  });

  app.post('/:id/key', async (req): Promise<QuestionMutationResponse> => {
    const p = parseParams(idParams, req);
    return correctKey(ctx, p.id, parseBody(keyBody, req));
  });

  app.post('/:id/review', async (req): Promise<QuestionMutationResponse> => {
    const p = parseParams(idParams, req);
    return reviewQuestion(ctx, p.id, parseBody(reviewBody, req));
  });

  app.post('/:id/links', async (req) => {
    const p = parseParams(idParams, req);
    const b = parseBody(ownerLinkBody, req);
    const linkId = ownerLink(ctx, p.id, b.lecture_source_id, b.relation, b.reason ?? null);
    return { link_id: linkId, question: questionView(ctx, p.id) };
  });
}

export { SCORABLE_ANSWER_STATUSES, normalizeForSearch, richTextToPlain };
