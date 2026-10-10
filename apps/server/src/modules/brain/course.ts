// Course page data (§23 «تفاصيل الكورس»): extraction status per lecture, objectives, totals; triggering (re-)extraction.
import { createHash } from 'node:crypto';
import {
  EXTRACT_KNOWLEDGE_JOB_KIND,
  type BrainExtractResponse,
  type BrainLectureStatus,
  type CourseBrainResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { versionConcepts } from './coverage';
import { EXTRACTOR_VERSION } from './extract';
import { recomputeInferredRelations, relationsCount, type RecomputeStats } from './relations';
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

// inferred relations follow the course's order, moves and owner merges: recompute when any of those changed
const relationMemo = new WeakMap<Db, Map<string, string>>();

function relationSignature(ctx: AppContext, key: string): string {
  const parts = [
    // the same lectures the recompute reads (every source of the course group, in course order)
    sourcesOfCourseKey(ctx, key).map((s) => [s.id, s.version_id, s.sort_order]),
    ctx.db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM concept_extraction'),
    ctx.db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE WHEN merged_into_id IS NOT NULL THEN 1 ELSE 0 END) AS m FROM concept'),
    ctx.db.get('SELECT COUNT(*) AS c FROM concept_alias'),
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function refreshCourseRelations(ctx: AppContext, sources: StudySource[]): void {
  let memo = relationMemo.get(ctx.db);
  if (!memo) {
    memo = new Map();
    relationMemo.set(ctx.db, memo);
  }
  for (const key of new Set(sources.map(courseKey))) {
    const sig = relationSignature(ctx, key);
    if (memo.get(key) === sig) continue;
    recomputeInferredRelations(ctx, key);
    memo.set(key, relationSignature(ctx, key));
  }
}

/** Recompute one course group's inferred relations now (extraction job) and remember the state it was computed for,
 * so the next course page does not redo the same work (review F2: large courses). */
export function recomputeCourseRelations(ctx: AppContext, key: string): RecomputeStats {
  const stats = recomputeInferredRelations(ctx, key);
  let memo = relationMemo.get(ctx.db);
  if (!memo) {
    memo = new Map();
    relationMemo.set(ctx.db, memo);
  }
  memo.set(key, relationSignature(ctx, key));
  return stats;
}

export function courseBrain(ctx: AppContext, nodeId: string): CourseBrainResponse {
  const course = nodeTitle(ctx, nodeId);
  const sources = courseSources(ctx, nodeId);
  refreshCourseRelations(ctx, sources);
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
