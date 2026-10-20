// Course page data (§23 «تفاصيل الكورس»): extraction status per lecture, objectives, totals; triggering (re-)extraction.
import { createHash } from 'node:crypto';
import {
  EXTRACT_KNOWLEDGE_JOB_KIND,
  RECOMPUTE_RELATIONS_JOB_KIND,
  type BrainExtractResponse,
  type BrainLectureStatus,
  type CourseBrainResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { versionConcepts } from './coverage';
import { EXTRACTOR_VERSION } from './extract';
import { recomputeInferredRelations, recomputeInferredRelationsAsync, relationsCount, type RecomputeStats } from './relations';
import type { ExtractionSummary } from './run';
import { courseKey, courseSources, locationOfRegion, nodeTitle, PROCESSED, sourcesOfCourseKey, studySource, type StudySource } from './store';

function latestJob(ctx: AppContext, versionId: string): { id: string; status: string } | null {
  return (
    ctx.db.get<{ id: string; status: string }>(
      `SELECT id, status FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [EXTRACT_KNOWLEDGE_JOB_KIND, versionId],
    ) ?? null
  );
}

function lectureStatus(ctx: AppContext, s: StudySource): BrainLectureStatus {
  const processed = !!s.processing_status && PROCESSED.includes(s.processing_status);
  const row = s.version_id
    ? ctx.db.get<{ status: 'completed' | 'nothing_found'; extractor_version: string; summary_json: string; updated_at: number }>(
        'SELECT status, extractor_version, summary_json, updated_at FROM concept_extraction WHERE version_id = ?',
        [s.version_id],
      )
    : undefined;
  const summary = row ? fromJson<ExtractionSummary>(row.summary_json) : null;
  return {
    source_id: s.id,
    title: s.title,
    source_type: s.source_type,
    version_id: s.version_id,
    processing_status: s.processing_status,
    processed,
    extraction:
      row && summary
        ? {
            status: row.status,
            extractor_version: row.extractor_version,
            current: row.extractor_version === EXTRACTOR_VERSION,
            updated_at: row.updated_at,
            counts: summary.counts,
            objectives: summary.objectives.map((o) => ({ text: o.text, region_id: o.region_id, page_label_ar: locationOfRegion(ctx, o.region_id)?.page_label_ar ?? null })),
          }
        : null,
    job: s.version_id ? latestJob(ctx, s.version_id) : null,
  };
}

// Suggested relations follow the course's order, moves, owner merges and extractions. Round 7 H4: they are recomputed by
// a BACKGROUND job (`brain.recompute_relations`), never inside a request; the state each course was last computed for
// is persisted (`brain_relation_state`), so the course page can say whether what it shows is current.
function relationSignature(ctx: AppContext, key: string): string {
  const parts = [
    // the same lectures the recompute reads (every source of the course group, in course order)
    sourcesOfCourseKey(ctx, key).map((s) => [s.id, s.version_id, s.sort_order]),
    ctx.db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM concept_extraction'),
    ctx.db.get(
      `SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE WHEN merged_into_id IS NOT NULL THEN 1 ELSE 0 END) AS m, SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS r FROM concept`,
    ),
    ctx.db.get('SELECT COUNT(*) AS c FROM concept_alias'),
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** An extraction of one of the course's lectures finished: whatever the clock says, the stored state is no longer current. */
export function invalidateRelationState(ctx: AppContext, key: string): void {
  ctx.db.run(`UPDATE brain_relation_state SET signature = 'stale' WHERE course_key = ?`, [key]);
}

interface RelationStateRow {
  course_key: string;
  signature: string;
  stats_json: string | null;
  job_id: string | null;
  computed_at: number;
}

function relationState(ctx: AppContext, key: string): RelationStateRow | null {
  return ctx.db.get<RelationStateRow>('SELECT * FROM brain_relation_state WHERE course_key = ?', [key]) ?? null;
}

function saveRelationState(ctx: AppContext, key: string, signature: string, stats: RecomputeStats | null, jobId: string | null): void {
  ctx.db.run(
    `INSERT INTO brain_relation_state (course_key, signature, stats_json, job_id, computed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(course_key) DO UPDATE SET signature = excluded.signature, stats_json = excluded.stats_json, job_id = excluded.job_id, computed_at = excluded.computed_at`,
    [key, signature, stats ? JSON.stringify(stats) : null, jobId, ctx.clock.now()],
  );
}

/**
 * Enqueue a background recompute of one course group when its state changed since the last one (one job per state:
 * the idempotency key carries the signature, so 30 extraction jobs of one course queue at most one recompute per
 * distinct state, and a recompute that finds the state already computed returns at once). Returns the job id, or
 * null when the relations are already current.
 */
export function enqueueRelationRecompute(ctx: AppContext, key: string): string | null {
  const sig = relationSignature(ctx, key);
  const st = relationState(ctx, key);
  if (st?.signature === sig) return null;
  // a state invalidated by an extraction gets its own job (the signature alone may not move within one clock tick)
  const nonce = st?.signature === 'stale' ? `:${st.computed_at}:${newId(ctx.clock.now())}` : '';
  const job = ctx.jobs.enqueue(RECOMPUTE_RELATIONS_JOB_KIND, { course_key: key }, { idempotencyKey: `${RECOMPUTE_RELATIONS_JOB_KIND}:${key}:${sig}${nonce}` });
  return job.id;
}

/** One recompute at a time per course group in this process (a second one waits, then finds the state current). */
const running = new Map<string, Promise<unknown>>();

/** The job body: recompute (incremental caches, yielding the event loop) unless this state was already computed. */
export async function runRelationRecompute(ctx: AppContext, key: string, job: { id: string | null; signal?: AbortSignal } = { id: null }): Promise<{ skipped: boolean; stats: RecomputeStats | null }> {
  for (let guard = 0; guard < 5 && running.has(key); guard++) await running.get(key)!.catch(() => undefined);
  const work = (async () => {
    const sig = relationSignature(ctx, key);
    if (relationState(ctx, key)?.signature === sig) return { skipped: true, stats: null };
    const stats = await recomputeInferredRelationsAsync(ctx, key, { signal: job.signal });
    // the state the recompute STARTED from: a change that landed meanwhile has another signature → another job
    saveRelationState(ctx, key, sig, stats, job.id);
    return { skipped: false, stats };
  })();
  running.set(key, work);
  try {
    return await work;
  } finally {
    if (running.get(key) === work) running.delete(key);
  }
}

/** Synchronous recompute (no job runner: a module subset, tests of the recompute itself). */
export function recomputeCourseRelations(ctx: AppContext, key: string): RecomputeStats {
  const sig = relationSignature(ctx, key);
  const stats = recomputeInferredRelations(ctx, key);
  saveRelationState(ctx, key, sig, stats, null);
  return stats;
}

/** Course page: relations current, or a background recompute queued (enqueued here when the state changed). */
export function refreshCourseRelations(ctx: AppContext, sources: StudySource[]): NonNullable<CourseBrainResponse['relations_state']> {
  const keys = [...new Set(sources.map(courseKey))];
  let jobId: string | null = null;
  let computedAt: number | null = null;
  for (const key of keys) {
    if (ctx.jobs.isRegistered(RECOMPUTE_RELATIONS_JOB_KIND)) {
      const id = enqueueRelationRecompute(ctx, key);
      if (id) {
        const j = ctx.jobs.get(id);
        if (j && !['completed', 'failed', 'cancelled', 'partial'].includes(j.status)) jobId ??= id;
      }
    } else if (relationState(ctx, key)?.signature !== relationSignature(ctx, key)) recomputeCourseRelations(ctx, key);
    const st = relationState(ctx, key);
    if (st) computedAt = Math.max(computedAt ?? 0, st.computed_at);
  }
  return { status: jobId ? 'refreshing' : 'current', computed_at: computedAt, job_id: jobId };
}

export function courseBrain(ctx: AppContext, nodeId: string): CourseBrainResponse {
  const course = nodeTitle(ctx, nodeId);
  const sources = courseSources(ctx, nodeId);
  const relationsState = refreshCourseRelations(ctx, sources);
  // sources processed before the Course Brain existed (or re-typed into study material) are extracted once
  if (ctx.jobs.isRegistered(EXTRACT_KNOWLEDGE_JOB_KIND)) {
    for (const s of sources) {
      if (!s.version_id || !s.processing_status || !PROCESSED.includes(s.processing_status)) continue;
      if (ctx.db.get('SELECT 1 AS x FROM concept_extraction WHERE version_id = ?', [s.version_id]) || latestJob(ctx, s.version_id)) continue;
      ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: s.version_id }, { idempotencyKey: `${EXTRACT_KNOWLEDGE_JOB_KIND}:${s.version_id}:backfill` });
    }
  }
  const lectures = sources.map((s) => lectureStatus(ctx, s));
  const conceptIds = new Set<string>();
  for (const s of sources) if (s.version_id) for (const c of versionConcepts(ctx, s.version_id)) conceptIds.add(c.id);
  const notes = [
    'هيكل المعرفة يُستخرج آليًا ودون ذكاء اصطناعي من نص المحاضرات بعد معالجتها: العناوين والتعريفات والأقسام (العلامات، الفحوصات، التدبير، المضاعفات، الأدوية، القيم) وأول عمود في الجداول.',
    'كل مفهوم يشير إلى موضعه في المصدر؛ الهيكل وسيط منظم وليس بديلًا عن الملفات الأصلية.',
  ];
  const notProcessed = lectures.filter((l) => !l.processed).length;
  if (notProcessed) notes.push(`${notProcessed} من مصادر الكورس لم تكتمل معالجتها بعد، فلا هيكل لها حتى تكتمل.`);
  const cut = lectures.filter((l) => l.extraction && (l.extraction.counts.mentions_found ?? 0) > l.extraction.counts.mentions);
  if (cut.length) {
    notes.push(
      `استُخرج جزء فقط من هيكل ${cut.map((l) => `«${l.title}» (أول ${l.extraction!.counts.mentions} من ${l.extraction!.counts.mentions_found} ذكرًا)`).join('، ')}: ما بعده من الصفحات بلا مفاهيم مستخرجة.`,
    );
  }
  const stale = lectures.filter((l) => l.extraction && !l.extraction.current).length;
  if (stale) notes.push(`${stale} من المصادر استُخرج هيكلها بإصدار أقدم من المستخرج؛ أعد الاستخراج لتحديثها (قراراتك تبقى).`);
  return {
    course,
    lectures,
    totals: {
      lectures: lectures.length,
      extracted: lectures.filter((l) => l.extraction).length,
      concepts: conceptIds.size,
      relations: relationsCount(ctx, [...conceptIds]),
    },
    notes_ar: notes,
    relations_state: relationsState,
  };
}

export function enqueueExtraction(ctx: AppContext, opts: { sourceId?: string; courseNodeId?: string }): BrainExtractResponse {
  if (!ctx.jobs.isRegistered(EXTRACT_KNOWLEDGE_JOB_KIND)) throw new AppError('FEATURE_DISABLED', 'استخراج هيكل المعرفة غير متاح في هذا الخادم.', 409);
  const sources = opts.sourceId ? [studySource(ctx, opts.sourceId)] : courseSources(ctx, nodeTitle(ctx, opts.courseNodeId!).id);
  const out: BrainExtractResponse = { jobs: [], skipped: [] };
  for (const s of sources) {
    if (!s.version_id) {
      out.skipped.push({ source_id: s.id, reason_ar: 'لا توجد نسخة لهذا المصدر.' });
      continue;
    }
    if (!s.processing_status || !PROCESSED.includes(s.processing_status)) {
      out.skipped.push({ source_id: s.id, reason_ar: 'لم تكتمل معالجة هذا المصدر بعد؛ يُستخرج هيكله تلقائيًا بعد المعالجة.' });
      continue;
    }
    const job = ctx.jobs.enqueue(EXTRACT_KNOWLEDGE_JOB_KIND, { version_id: s.version_id }, { idempotencyKey: `${EXTRACT_KNOWLEDGE_JOB_KIND}:${s.version_id}:manual:${newId(ctx.clock.now())}` });
    out.jobs.push({ source_id: s.id, version_id: s.version_id, job_id: job.id });
  }
  return out;
}
