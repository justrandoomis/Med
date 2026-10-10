// Generated simulation following the owner's Exam DNA (track F3; §40). Capability `ai.generate_questions`.
//
//   POST /api/exams/simulations/preview   SimulationRequest → SimulationPlanView   (deterministic — works without AI)
//   POST /api/exams/simulations           SimulationRequest → SimulationResponse    (AI-gated; job 'exams.generate_simulation')
//   GET  /api/exams/simulations           recent simulations
//   GET  /api/exams/simulations/:id       one simulation (status polling)
//
// The plan follows the owner's OWN sample only (learning/dna — question sources and previous exams, unique questions,
// explicit denominators): the requested count is split over the sample's lectures by their share of unique questions,
// then inside each lecture over the sample's item types (largest remainder, real counts — never a probability). Every
// cell becomes a regular question_generation_run (origin 'simulation', lecture-only scope) executed INLINE by the
// simulation job through the very same pipeline (evidence pack, independent validator, claim verification, repairs,
// review queue). Only PUBLISHED generated questions are assembled into a normal exam (mode 'simulation',
// is_generated_simulation = 1). Labelled «محاكاة مولدة — ليست نسخة متوقعة من الامتحان القادم» everywhere.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  GENERATED_ITEM_TYPES,
  GENERATION_DIFFICULTIES,
  GENERATION_RUN_STATUS_LABELS_AR,
  SIMULATION_LABEL_AR,
  SIMULATION_NOTICE_AR,
  SIMULATION_STATUS_LABELS_AR,
  newId,
  type ExamDnaDetail,
  type GeneratedItemType,
  type GenerationRunStatus,
  type SimulationBucket,
  type SimulationListResponse,
  type SimulationPlanView,
  type SimulationRequest,
  type SimulationResponse,
  type SimulationRunPart,
  type SimulationRunView,
  type SimulationStatus,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError, isAppError, JobError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery, parseWith, RATE_LIMITS } from '../../lib/http';
import type { JobRun } from '../jobs/queue';
import { resolveConceptId } from '../brain/resolve';
import { examDna } from '../learning/dna';
import { createExam } from './builder';
import { createGenerationRun, executeGenerationRun } from './generation/pipeline';
import { questionsAr } from './store';

export const SIMULATION_JOB = 'exams.generate_simulation';
export const SIMULATION_VERSION = 'simulation-2026.10-1';
/** the generation pipeline accepts at most 5 questions per run */
const RUN_MAX = 5;

const id = z.string().trim().min(1).max(64);
export const simulationRequestSchema = z
  .object({
    count: z.number().int().min(2).max(20),
    difficulty: z.enum(GENERATION_DIFFICULTIES),
    course_node_id: id.nullable().optional(),
    minutes: z.number().int().min(1).max(300).nullable().optional(),
  })
  .strict();

const COUNTING_NOTE_AR =
  'الحصة = عدد الأسئلة الفريدة في عينتك المرتبطة بالمحاضرة ÷ عدد الأسئلة الفريدة في العينة (السؤال المرتبط بمحاضرتين يُعد لكل منهما). يُوزَّع العدد المطلوب بأكبر باقٍ؛ هذا توزيع تقريبي لعينتك، وليس احتمال ظهور.';

/** Item types of the owner's sample that the generator can write (an extracted «clinical feature» question is a diagnosis item). */
const ITEM_TYPE_MAP: Record<string, GeneratedItemType | null> = {
  investigation: 'investigation',
  diagnosis: 'diagnosis',
  management: 'management',
  complications: 'complications',
  mechanism: 'mechanism',
  next_step: 'next_step',
  risk_factors: 'risk_factors',
  recall: 'recall',
  clinical_feature: 'diagnosis',
  vignette: 'vignette',
  interpretation: 'interpretation',
  unclassified: null,
};

// ───────── allocation (pure, exported for unit tests) ─────────
/** Largest-remainder split of `total` over integer weights (ties: input order). Zero weights get nothing. */
export function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) * total) / sum);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    if (weights[o.i]! <= 0) continue;
    out[o.i]!++;
    left--;
  }
  return out;
}

export interface PlanInput {
  count: number;
  lectures: Array<{ id: string; title: string; unique: number; denominator: number; topic: string }>;
  itemTypes: Array<{ item_type: string; count: number }>;
}

/** Buckets (lecture × item type) following the sample's lecture shares, then its item-type shares inside each lecture. */
export function allocateSimulation(input: PlanInput): SimulationBucket[] {
  const lectureCounts = largestRemainder(
    input.count,
    input.lectures.map((l) => l.unique),
  );
  const types = input.itemTypes.filter((t) => t.count > 0 && ITEM_TYPE_MAP[t.item_type] !== undefined && ITEM_TYPE_MAP[t.item_type] !== null);
  const merged = new Map<GeneratedItemType, number>();
  for (const t of types) {
    const g = ITEM_TYPE_MAP[t.item_type]!;
    merged.set(g, (merged.get(g) ?? 0) + t.count);
  }
  const typeList = [...merged.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: SimulationBucket[] = [];
  input.lectures.forEach((l, li) => {
    const n = lectureCounts[li]!;
    if (n <= 0) return;
    const share = { unique: l.unique, denominator: l.denominator };
    if (typeList.length === 0) {
      out.push({ lecture_source_id: l.id, lecture_title: l.title, count: n, share, item_types: [], topic: l.topic, reason_ar: `حصة المحاضرة في عينتك ${l.unique} من ${l.denominator}؛ أنواع الأسئلة غير مصنفة في العينة.` });
      return;
    }
    const perType = largestRemainder(
      n,
      typeList.map(([, c]) => c),
    );
    typeList.forEach(([type, c], ti) => {
      const k = perType[ti]!;
      if (k <= 0) return;
      out.push({
        lecture_source_id: l.id,
        lecture_title: l.title,
        count: k,
        share,
        item_types: [type],
        topic: l.topic,
        reason_ar: `حصة المحاضرة في عينتك ${l.unique} من ${l.denominator} سؤالًا فريدًا؛ والنوع «${type}» ${c} من أسئلة العينة المصنفة.`,
      });
    });
  });
  return out;
}

// ───────── plan from the Exam DNA ─────────
function lectureTopic(ctx: AppContext, lectureId: string, sampleIds: Set<string>, fallback: string): string {
  const freq = new Map<string, number>();
  for (const l of ctx.db.all<{ question_id: string; reason_json: string | null }>(
    `SELECT question_id, reason_json FROM question_lecture_link WHERE lecture_source_id = ? AND status <> 'rejected'`,
    [lectureId],
  )) {
    if (!sampleIds.has(l.question_id)) continue;
    for (const c of fromJson<{ concepts?: string[] }>(l.reason_json, {})?.concepts ?? []) {
      const cid = resolveConceptId(ctx, c);
      freq.set(cid, (freq.get(cid) ?? 0) + 1);
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([c]) => c);
  if (top.length === 0) return fallback.slice(0, 300);
  const names = ctx.db
    .all<{ id: string; name_en: string | null; name_ar: string | null }>(`SELECT id, name_en, name_ar FROM concept WHERE status <> 'rejected' AND id IN (${top.map(() => '?').join(',')})`, top)
    .map((c) => c.name_en || c.name_ar)
    .filter((x): x is string => !!x);
  return (names.length ? names.join('; ') : fallback).slice(0, 300);
}

function sampleQuestionIds(ctx: AppContext, dna: ExamDnaDetail): Set<string> {
  const ids = new Set<string>();
  for (const s of dna.sources) {
    for (const r of ctx.db.all<{ question_id: string }>(
      `SELECT o.question_id FROM question_occurrence o JOIN source s ON s.id = o.source_id
        WHERE o.source_id = ? AND o.status = 'current' AND o.source_version_id = COALESCE(s.frozen_version_id, s.current_version_id)`,
      [s.source_id],
    ))
      ids.add(r.question_id);
  }
  return ids;
}

/** Can the generator run now (capability + both tasks)? */
export function simulationAvailability(ctx: AppContext): { available: boolean; reason_ar: string | null } {
  const gate = ctx.capabilities.get('ai.generate_questions');
  if (gate.state !== 'available') return { available: false, reason_ar: gate.reason_ar ?? 'المحاكاة المولدة تتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.' };
  const status = ctx.ai.status();
  for (const task of ['generate_questions', 'validate_question'] as const) {
    const t = status.tasks[task];
    if (!t.available) return { available: false, reason_ar: t.reason_ar ?? 'المحاكاة المولدة تتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.' };
  }
  return { available: true, reason_ar: null };
}

export function planSimulation(ctx: AppContext, body: unknown): SimulationPlanView {
  const req = parseWith(simulationRequestSchema, body, 'body') as SimulationRequest;
  const dna = examDna(ctx, { courseNodeId: req.course_node_id ?? null });
  const sampleIds = sampleQuestionIds(ctx, dna);
  const excluded: SimulationPlanView['excluded'] = [];
  const lectures: PlanInput['lectures'] = [];
  for (const l of dna.by_lecture) {
    const s = ctx.db.get<{ id: string; title: string; source_type: string; deleted_at: number | null; v: string | null; in_course: number }>(
      `SELECT id, title, source_type, deleted_at, COALESCE(frozen_version_id, current_version_id) AS v,
              CASE WHEN ? IS NULL OR course_node_id = ? OR node_id = ? OR subject_node_id = ? THEN 1 ELSE 0 END AS in_course
         FROM source WHERE id = ?`,
      [req.course_node_id ?? null, req.course_node_id ?? null, req.course_node_id ?? null, req.course_node_id ?? null, l.lecture_source_id],
    );
    if (!s || s.deleted_at !== null) {
      excluded.push({ lecture_source_id: l.lecture_source_id, title: l.title, reason_ar: 'المحاضرة محذوفة أو في سلة المحذوفات.' });
      continue;
    }
    // a sample question can also be linked to a lecture of another course: the simulation of a course uses its own lectures
    if (!s.in_course) {
      excluded.push({ lecture_source_id: s.id, title: s.title, reason_ar: 'المحاضرة خارج الكورس المختار.' });
      continue;
    }
    if (s.source_type === 'question_source' || s.source_type === 'previous_exam') {
      excluded.push({ lecture_source_id: s.id, title: s.title, reason_ar: 'مصدر أسئلة، لا تُولَّد الأسئلة منه.' });
      continue;
    }
    const ready = s.v ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_page WHERE version_id = ? AND processing_status IN ('ready','needs_review')`, [s.v])?.n ?? 0) : 0;
    if (ready === 0) {
      excluded.push({ lecture_source_id: s.id, title: s.title, reason_ar: 'لا توجد صفحات معالجة جاهزة في نسختها الحالية.' });
      continue;
    }
    lectures.push({ id: s.id, title: s.title, unique: l.unique, denominator: l.denominator_unique, topic: lectureTopic(ctx, s.id, sampleIds, s.title) });
  }
  const buckets = allocateSimulation({ count: req.count, lectures, itemTypes: dna.by_item_type });
  const warnings = [...dna.warnings_ar];
  if (dna.unclassified.lecture > 0) {
    warnings.push(`${dna.unclassified.lecture} من ${dna.sample.unique_questions} سؤالًا فريدًا في عينتك غير مرتبط بمحاضرة، فلا يدخل في توزيع المحاضرات.`);
  }
  const zero = lectures.filter((l) => !buckets.some((b) => b.lecture_source_id === l.id));
  if (zero.length > 0) warnings.push(`بهذا العدد لم تحصل ${zero.length === 1 ? 'محاضرة واحدة' : `${zero.length} محاضرات`} ذات حصة صغيرة على أي سؤال: ${zero.map((z) => `«${z.title}»`).join('، ')}.`);
  const availability = simulationAvailability(ctx);
  const can_generate =
    buckets.length === 0
      ? {
          available: false,
          reason_ar:
            dna.sample.unique_questions === 0
              ? 'لا توجد أسئلة في عينتك (مصادر الأسئلة والامتحانات السابقة) ليُتبع توزيعها.'
              : 'لا توجد محاضرة معالجة مرتبطة بأسئلة عينتك يمكن التوليد منها.',
        }
      : availability;
  return {
    request: { count: req.count, difficulty: req.difficulty, course_node_id: req.course_node_id ?? null, minutes: req.minutes ?? null },
    buckets,
    sample: dna.sample,
    item_types: dna.by_item_type,
    warnings_ar: warnings,
    excluded,
    counting_note_ar: COUNTING_NOTE_AR,
    notice_ar: SIMULATION_NOTICE_AR,
    can_generate,
  };
}

// ───────── rows / views ─────────
interface SimulationRow {
  id: string;
  status: SimulationStatus;
  request_json: string;
  plan_json: string;
  parts_json: string;
  exam_id: string | null;
  attempt_id: string | null;
  summary_json: string | null;
  error_json: string | null;
  job_id: string | null;
  created_at: number;
  updated_at: number;
}

interface StoredPart {
  bucket_index: number;
  run_id: string;
}

interface SimulationSummary {
  requested: number;
  published: number;
  parts_abstained: number;
  parts_failed: number;
  notes_ar: string[];
}

function getSimulation(ctx: AppContext, simId: string): SimulationRow {
  const r = ctx.db.get<SimulationRow>('SELECT * FROM simulation_run WHERE id = ?', [simId]);
  if (!r) throw new AppError('NOT_FOUND', 'المحاكاة غير موجودة.', 404);
  return r;
}

function setSimulation(ctx: AppContext, simId: string, patch: { [K in 'status' | 'parts_json' | 'exam_id' | 'attempt_id' | 'summary_json' | 'error_json' | 'job_id']?: string | null }): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (keys.length === 0) return;
  ctx.db.run(`UPDATE simulation_run SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), ctx.clock.now(), simId]);
}

function publishedOf(ctx: AppContext, runId: string): string[] {
  return ctx.db
    .all<{ question_id: string }>(`SELECT question_id FROM generated_question_candidate WHERE run_id = ? AND status = 'published' AND question_id IS NOT NULL ORDER BY ord`, [runId])
    .map((r) => r.question_id);
}

function summaryAr(r: SimulationRow, s: SimulationSummary | null): string {
  if (r.status === 'queued') return 'المحاكاة في الانتظار.';
  if (r.status === 'running') return 'يُولَّد كل جزء من محاضرته ويُتحقق منه مستقلًا؛ لا يدخل المحاكاة إلا ما اجتاز الفحوص.';
  const err = fromJson<{ message_ar?: string } | null>(r.error_json, null);
  if (r.status === 'failed') return `فشل توليد المحاكاة؛ لم يُنشأ اختبار.${err?.message_ar ? ` ${err.message_ar}` : ''}`;
  if (!s) return SIMULATION_STATUS_LABELS_AR[r.status];
  if (r.status === 'abstained') return `لم يجتز أي سؤال مولد الفحوص، فلم يُنشأ اختبار. ${s.notes_ar.join(' ')}`.trim();
  const parts = [`اجتاز ${questionsAr(s.published)} من ${questionsAr(s.requested)} مطلوبة الفحوص ودخلت المحاكاة`];
  if (s.parts_abstained) parts.push(`امتنع ${s.parts_abstained === 1 ? 'جزء واحد' : `${s.parts_abstained} أجزاء`} لقلة الأدلة`);
  if (s.parts_failed) parts.push(`فشل ${s.parts_failed === 1 ? 'جزء واحد' : `${s.parts_failed} أجزاء`}`);
  if (s.published < s.requested) parts.push('لذلك يتبع التوزيع عينتك تقريبيًا فقط');
  return `${parts.join('؛ ')}. ${s.notes_ar.join(' ')}`.trim();
}

export function simulationView(ctx: AppContext, r: SimulationRow): SimulationRunView {
  const plan = fromJson<SimulationPlanView>(r.plan_json)!;
  const stored = fromJson<StoredPart[]>(r.parts_json, []) ?? [];
  const simDone = ['completed', 'partial', 'abstained', 'failed'].includes(r.status);
  const parts: SimulationRunPart[] = plan.buckets.map((b, i) => {
    // a bucket larger than one run (RUN_MAX) is generated in several runs: the part reports ALL of them (F3 review —
    // it reported the first run only, e.g. «طُلب 6، نُشر 5» while all 6 were published)
    const runs = stored
      .filter((x) => x.bucket_index === i)
      .map((p) => ({ id: p.run_id, status: ctx.db.get<{ status: GenerationRunStatus }>('SELECT status FROM question_generation_run WHERE id = ?', [p.run_id])?.status ?? 'queued' }));
    const published = runs.reduce((n, x) => n + publishedOf(ctx, x.id).length, 0);
    const expected = Math.ceil(b.count / RUN_MAX);
    const statuses = runs.map((x) => x.status);
    let status: GenerationRunStatus;
    if (runs.length === 0) status = simDone ? 'failed' : 'queued';
    else if (statuses.some((s) => s === 'queued' || s === 'running') || (runs.length < expected && !simDone)) status = 'running';
    else if (published >= b.count) status = 'completed';
    else if (published > 0) status = 'partial';
    else if (statuses.length === expected && statuses.every((s) => s === statuses[0])) status = statuses[0]!;
    else status = statuses.includes('needs_review') ? 'needs_review' : statuses.includes('abstained') ? 'abstained' : 'failed';
    return {
      bucket_index: i,
      lecture_source_id: b.lecture_source_id,
      lecture_title: b.lecture_title,
      requested: b.count,
      run_id: runs[0]?.id ?? null,
      status,
      status_label_ar: GENERATION_RUN_STATUS_LABELS_AR[status] ?? status,
      published,
    };
  });
  let exam: SimulationRunView['exam'] = null;
  if (r.exam_id && r.attempt_id) {
    const e = ctx.db.get<{ items_json: string }>('SELECT items_json FROM exam WHERE id = ?', [r.exam_id]);
    const items = fromJson<Array<{ origin_type: string }>>(e?.items_json ?? null, []) ?? [];
    exam = { exam_id: r.exam_id, attempt_id: r.attempt_id, items: items.length, generated_items: items.filter((i) => i.origin_type === 'generated').length };
  }
  return {
    id: r.id,
    status: r.status,
    status_label_ar: SIMULATION_STATUS_LABELS_AR[r.status],
    label_ar: SIMULATION_LABEL_AR,
    notice_ar: SIMULATION_NOTICE_AR,
    plan,
    parts,
    exam,
    summary_ar: summaryAr(r, fromJson<SimulationSummary | null>(r.summary_json, null)),
    job: r.job_id ? ctx.jobs.get(r.job_id) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ───────── request ─────────
export function requestSimulation(ctx: AppContext, body: unknown): SimulationRunView {
  const plan = planSimulation(ctx, body);
  if (!plan.can_generate.available) {
    const aiReason = simulationAvailability(ctx);
    if (!aiReason.available) throw new AppError('AI_NOT_CONFIGURED', aiReason.reason_ar ?? 'غير متاح.', 409);
    throw new AppError('CONFLICT', plan.can_generate.reason_ar ?? 'لا يمكن بناء محاكاة من عينتك الآن.', 409, { plan });
  }
  const now = ctx.clock.now();
  const simId = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO simulation_run (id, status, request_json, plan_json, parts_json, exam_id, attempt_id, summary_json, error_json, job_id, created_at, updated_at)
       VALUES (?, 'queued', ?, ?, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [simId, toJson(plan.request), toJson(plan), now, now],
    );
    const job = ctx.jobs.enqueue(SIMULATION_JOB, { simulation_id: simId }, { idempotencyKey: `qsim:${simId}` });
    setSimulation(ctx, simId, { job_id: job.id });
    ctx.audit.record({
      entityType: 'simulation_run',
      entityId: simId,
      action: 'create',
      summary: `${SIMULATION_LABEL_AR}: ${questionsAr(plan.request.count)} موزعة على ${plan.buckets.length} ${plan.buckets.length === 1 ? 'جزء' : 'أجزاء'} حسب عينتك`,
      after: { buckets: plan.buckets.map((b) => ({ lecture: b.lecture_source_id, count: b.count, item_types: b.item_types })) },
      actor: 'owner',
    });
  });
  return simulationView(ctx, getSimulation(ctx, simId));
}

// ───────── job ─────────
/** A child view of the simulation job for one generation run: namespaced checkpoints, prefixed progress. */
function childRun(job: JobRun<{ simulation_id: string }>, runId: string, label: string): JobRun<{ run_id: string }> {
  return {
    id: job.id,
    kind: job.kind,
    input: { run_id: runId },
    attempt: job.attempt,
    signal: job.signal,
    log: job.log,
    checkpoint: (key, fn) => job.checkpoint(`run:${runId}:${key}`, fn),
    progress: (p) => job.progress({ ...p, stage: `${label}: ${p.stage}` }),
    isCancelled: () => job.isCancelled(),
  };
}

const FATAL = new Set(['AI_NOT_CONFIGURED', 'AI_BUDGET_EXCEEDED']);

async function execute(ctx: AppContext, job: JobRun<{ simulation_id: string }>): Promise<{ status: SimulationStatus }> {
  const sim = getSimulation(ctx, job.input.simulation_id);
  if (['completed', 'partial', 'abstained', 'failed'].includes(sim.status)) return { status: sim.status };
  setSimulation(ctx, sim.id, { status: 'running', error_json: null });
  const plan = fromJson<SimulationPlanView>(sim.plan_json)!;
  const req = fromJson<SimulationRequest>(sim.request_json)!;
  const summary: SimulationSummary = { requested: plan.buckets.reduce((a, b) => a + b.count, 0), published: 0, parts_abstained: 0, parts_failed: 0, notes_ar: [] };
  const parts = fromJson<StoredPart[]>(sim.parts_json, []) ?? [];
  const published: string[] = [];
  // a bucket with more than RUN_MAX questions is generated in several runs (same lecture, same type)
  let index = 0;
  for (const [bi, b] of plan.buckets.entries()) {
    let left = b.count;
    while (left > 0) {
      if (job.isCancelled()) break;
      const n = Math.min(RUN_MAX, left);
      left -= n;
      const partIndex = index++;
      const label = `الجزء ${partIndex + 1}: «${b.lecture_title.slice(0, 60)}»`;
      const created = await job.checkpoint(`part:${partIndex}`, () => {
        const runId = createGenerationRun(
          ctx,
          { lecture_source_id: b.lecture_source_id, topic: b.topic, count: n, difficulty: req.difficulty, item_types: b.item_types, language: 'en' },
          { enqueue: false, origin: 'simulation' },
        );
        ctx.db.run('UPDATE question_generation_run SET job_id = ? WHERE id = ?', [job.id, runId]);
        return { run_id: runId };
      });
      if (!parts.some((p) => p.run_id === created.run_id)) {
        parts.push({ bucket_index: bi, run_id: created.run_id });
        setSimulation(ctx, sim.id, { parts_json: toJson(parts) });
      }
      let status: GenerationRunStatus;
      try {
        status = (await executeGenerationRun(ctx, childRun(job, created.run_id, label))).status;
      } catch (e) {
        const code = isAppError(e) ? e.code : 'INTERNAL';
        const messageAr = isAppError(e) ? e.messageAr : 'حدث خطأ غير متوقع أثناء توليد جزء من المحاكاة.';
        // the inline run is closed like the generation job would close it: interrupted candidates are never published
        ctx.db.run(
          `UPDATE generated_question_candidate SET status = 'rejected', updated_at = ?
            WHERE run_id = ? AND status = 'needs_review' AND question_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM review_queue_item r WHERE r.entity_type = 'generated_question_candidate' AND r.entity_id = generated_question_candidate.id)`,
          [ctx.clock.now(), created.run_id],
        );
        ctx.db.run(`UPDATE question_generation_run SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?`, [toJson({ code, message_ar: messageAr }), ctx.clock.now(), created.run_id]);
        if (FATAL.has(code) || (isAppError(e) && (e.details as { retryable?: boolean } | undefined)?.retryable)) throw e;
        status = 'failed';
      }
      if (status === 'abstained') summary.parts_abstained++;
      if (status === 'failed') summary.parts_failed++;
      published.push(...publishedOf(ctx, created.run_id));
    }
  }
  summary.published = published.length;
  if (published.length === 0) {
    summary.notes_ar.push('راجع أسباب امتناع كل جزء في «توليد الأسئلة»؛ الأسئلة التي لم تجتز الفحوص في قائمة المراجعة.');
    setSimulation(ctx, sim.id, { status: 'abstained', summary_json: toJson(summary) });
    return { status: 'abstained' };
  }
  // assemble the simulation exam from the PUBLISHED generated questions only (idempotent across retries)
  const assembled = await job.checkpoint('assemble', () => {
    const attemptId = newId(ctx.clock.now());
    const r = createExam(
      ctx,
      {
        title: `${SIMULATION_LABEL_AR} (${questionsAr(published.length)})`,
        mode: 'simulation',
        count: published.length,
        question_ids: published,
        minutes: req.minutes ?? null,
        attempt_id: attemptId,
        seed: sim.id,
      },
      null,
    );
    return { exam_id: r.examId, attempt_id: r.attemptId };
  });
  // the exam builder may leave out a published question (e.g. a duplicate of another one): say so, never «all entered»
  const items = (fromJson<unknown[]>(ctx.db.get<{ items_json: string }>('SELECT items_json FROM exam WHERE id = ?', [assembled.exam_id])?.items_json ?? null, []) ?? []).length;
  if (items < published.length) {
    summary.notes_ar.push(`دخل الاختبار ${questionsAr(items)} فقط من ${questionsAr(published.length)} اجتازت الفحوص (أُبعد المكرر أو غير الصالح للاختبار).`);
    summary.published = items;
  }
  const status: SimulationStatus = summary.published >= summary.requested ? 'completed' : 'partial';
  setSimulation(ctx, sim.id, { status, exam_id: assembled.exam_id, attempt_id: assembled.attempt_id, summary_json: toJson(summary) });
  return { status };
}

export function registerSimulationJob(ctx: AppContext): void {
  ctx.jobs.register<{ simulation_id: string }, { status: SimulationStatus }>(SIMULATION_JOB, {
    version: SIMULATION_VERSION,
    maxAttempts: 2,
    timeoutMs: 60 * 60 * 1000,
    concurrency: 1,
    inputSchema: z.object({ simulation_id: id }).strict(),
    handler: async (job) => {
      try {
        return await execute(ctx, job);
      } catch (e) {
        const retryable = isAppError(e) && e.code === 'AI_PROVIDER_ERROR' && (e.details as { retryable?: boolean } | undefined)?.retryable === true && job.attempt < 2;
        const code = isAppError(e) ? e.code : 'INTERNAL';
        const messageAr = isAppError(e) ? e.messageAr : 'حدث خطأ غير متوقع أثناء توليد المحاكاة.';
        setSimulation(ctx, job.input.simulation_id, retryable ? { error_json: toJson({ code, message_ar: messageAr }) } : { status: 'failed', error_json: toJson({ code, message_ar: messageAr }) });
        if (e instanceof JobError) throw e;
        throw new JobError(code, messageAr, { retryable });
      }
    },
  });
}

// ───────── routes (mounted under /api/exams) ─────────
export function registerSimulationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ai = { config: { rateLimit: RATE_LIMITS.ai } };
  app.post('/simulations/preview', async (req): Promise<{ plan: SimulationPlanView }> => ({ plan: planSimulation(ctx, parseBody(simulationRequestSchema, req)) }));
  app.post('/simulations', ai, async (req): Promise<SimulationResponse> => ({ simulation: requestSimulation(ctx, parseBody(simulationRequestSchema, req)) }));
  app.get('/simulations', async (req): Promise<SimulationListResponse> => {
    const q = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict(), req);
    const rows = ctx.db.all<SimulationRow>('SELECT * FROM simulation_run ORDER BY created_at DESC, id DESC LIMIT ?', [q.limit]);
    return { simulations: rows.map((r) => simulationView(ctx, r)) };
  });
  app.get('/simulations/:simulationId', async (req): Promise<SimulationResponse> => {
    const { simulationId } = parseParams(z.object({ simulationId: id }), req);
    return { simulation: simulationView(ctx, getSimulation(ctx, simulationId)) };
  });
}

/** Re-exported for tests: the item types the generator can write. */
export const SIMULATION_ITEM_TYPES: readonly GeneratedItemType[] = GENERATED_ITEM_TYPES;
