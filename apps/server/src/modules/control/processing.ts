// Processing overview for the owner (§48 Processing, §53, §56, AC-03): background jobs with their real stage and
// counts, what failed and why (in words), what each owner action does, and the source versions whose coverage is
// incomplete — page by page. Retry / cancel go through the jobs API (/api/jobs/:id/retry|cancel); page
// re-processing through the sources API. Nothing here is a raw log.
import {
  PROCESS_JOB_KIND,
  type ControlJobView,
  type JobStatus,
  type JobView,
  type ProcessingOverviewResponse,
  type ProcessingStatus,
  type ProcessingSummary,
  type SourceType,
  type VersionAttentionView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { pageLabelAr } from './corrections';
import { PROCESSING_STATUS_LABELS_AR, jobKindLabel, jobStatusLabel, oneLine, progressLabelAr } from './labels';

const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_for_input'];
const RECENT_MS = 30 * 24 * 3600 * 1000;

function jobSource(ctx: AppContext, input: unknown): ControlJobView['source'] {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const versionId = typeof i.version_id === 'string' ? i.version_id : null;
  if (versionId) {
    const r = ctx.db.get<{ id: string; title: string; version_no: number }>(
      'SELECT s.id, s.title, v.version_no FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
      [versionId],
    );
    if (r) return { id: r.id, title: oneLine(r.title, 200) ?? '', version_id: versionId, version_no: r.version_no };
  }
  const artifactId = typeof i.artifact_id === 'string' ? i.artifact_id : null;
  if (artifactId) {
    const r = ctx.db.get<{ id: string; title: string }>('SELECT s.id, s.title FROM artifact a JOIN source s ON s.id = a.primary_source_id WHERE a.id = ?', [artifactId]);
    if (r) return { id: r.id, title: oneLine(r.title, 200) ?? '', version_id: null, version_no: null };
  }
  const runId = typeof i.run_id === 'string' ? i.run_id : null;
  if (runId) {
    const r = ctx.db.get<{ id: string; title: string }>('SELECT s.id, s.title FROM question_generation_run g JOIN source s ON s.id = g.lecture_source_id WHERE g.id = ?', [runId]);
    if (r) return { id: r.id, title: oneLine(r.title, 200) ?? '', version_id: null, version_no: null };
  }
  return null;
}

function retryEffect(j: JobView): string | null {
  if (!['failed', 'cancelled', 'partial', 'waiting_for_input'].includes(j.status)) return null;
  const base = 'تُعاد المهمة إلى الانتظار وتبدأ من حيث توقفت: الخطوات المكتملة محفوظة ولا تُكرَّر.';
  if (j.kind === PROCESS_JOB_KIND) return `${base} الصفحات التي فشلت تُعالج من جديد، وما صحّحته بنفسك لا يُستبدل.`;
  return base;
}

function cancelEffect(j: JobView): string | null {
  if (!ACTIVE.includes(j.status)) return null;
  return 'تتوقف المهمة. ما اكتمل منها يبقى محفوظًا وقابلًا للاستخدام، ولا يُحذف شيء. يمكنك إعادة المحاولة لاحقًا.';
}

export function toControlJob(ctx: AppContext, j: JobView): ControlJobView {
  const k = jobKindLabel(j.kind);
  const input = j.input ?? ctx.jobs.get(j.id)?.input;
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pages = Array.isArray(i.page_indexes) ? (i.page_indexes as unknown[]).filter((n): n is number => typeof n === 'number') : null;
  const registered = ctx.jobs.isRegistered(j.kind);
  let explanation = k.explain;
  if (j.kind === PROCESS_JOB_KIND && i.reason === 'reprocess') explanation = pages?.length ? `إعادة معالجة ${pages.length === 1 ? 'صفحة واحدة' : `${pages.length} صفحات`} بناءً على طلبك.` : 'إعادة معالجة المصدر بناءً على طلبك.';
  if (j.kind === PROCESS_JOB_KIND && i.reason === 'replacement') explanation = 'معالجة النسخة الجديدة التي رفعتها لهذا المصدر.';
  if (!registered && j.status === 'queued') explanation = `${explanation} لا توجد وحدة على هذا الخادم تنفّذ هذا النوع من المهام، لذلك يبقى في الانتظار.`;
  const progressLabel = progressLabelAr(j.progress);
  return {
    id: j.id,
    kind: j.kind,
    kind_label_ar: k.label,
    explanation_ar: explanation,
    status: j.status,
    status_label_ar: jobStatusLabel(j.status),
    progress: j.progress,
    progress_label_ar: progressLabel,
    attempts: j.attempts,
    max_attempts: j.max_attempts,
    error: j.error,
    source: jobSource(ctx, input),
    page_indexes: pages,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    can_retry: registered && ['failed', 'cancelled', 'partial', 'waiting_for_input'].includes(j.status),
    can_cancel: ACTIVE.includes(j.status),
    retry_effect_ar: registered ? retryEffect(j) : null,
    cancel_effect_ar: cancelEffect(j),
  };
}

interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  processing_status: ProcessingStatus;
  processing_summary_json: string | null;
  title: string;
  source_type: SourceType;
  current_version_id: string | null;
  frozen_version_id: string | null;
}

function coverageNote(status: ProcessingStatus, s: ProcessingSummary | null): string {
  if (status === 'failed') return 'لم تُقرأ أي صفحة من هذه النسخة؛ أدوات الدراسة لا تعتمد عليها حتى تُعالج.';
  if (status === 'partial') {
    const missing = s ? s.pages_failed + Math.max(0, (s.pages_total ?? 0) - s.pages_ready - s.pages_failed - s.pages_needs_review) : null;
    return `الصفحات الأخرى قابلة للقراءة. الشروح والملخصات التي تشمل هذه النسخة تذكر أن التغطية غير كاملة${missing ? ` (${missing} ${missing === 1 ? 'صفحة' : 'صفحات'} ناقصة)` : ''} ولا تُسمّى كاملة.`;
  }
  if (status === 'needs_review') return 'كل الصفحات معالجة، لكن بعضها يحتاج مراجعتك قبل الاعتماد على نصه (راجعه من «قائمة المراجعة»).';
  if (status === 'processing' || status === 'pending') return 'المعالجة لم تنتهِ بعد؛ الصفحات الجاهزة قابلة للقراءة الآن.';
  return 'جاهزة.';
}

function attention(ctx: AppContext): VersionAttentionView[] {
  const rows = ctx.db.all<VersionRow>(
    `SELECT v.id, v.source_id, v.version_no, v.processing_status, v.processing_summary_json, s.title, s.source_type, s.current_version_id, s.frozen_version_id
       FROM source_version v JOIN source s ON s.id = v.source_id
      WHERE s.deleted_at IS NULL AND v.processing_status IN ('partial','failed','needs_review')
      ORDER BY (v.processing_status = 'failed') DESC, (v.processing_status = 'partial') DESC, v.created_at DESC LIMIT 100`,
  );
  return rows.map((v) => {
    const summary = fromJson<ProcessingSummary | null>(v.processing_summary_json, null);
    const pages = ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: 'page' | 'slide' | 'image' | 'docx_section' | 'audio_segment'; processing_status: string; error_code: string | null; error_detail: string | null }>(
      `SELECT id, page_index, printed_label, kind, processing_status, error_code, error_detail FROM source_page
        WHERE version_id = ? AND (processing_status = 'failed' OR (error_code IS NOT NULL AND processing_status <> 'ready'))
        ORDER BY page_index LIMIT 200`,
      [v.id],
    );
    const owned = new Set(
      ctx.db
        .all<{ page_id: string }>(`SELECT DISTINCT page_id FROM source_region WHERE version_id = ? AND (text_origin = 'owner' OR status = 'owner_reviewed') AND page_id IS NOT NULL`, [v.id])
        .map((r) => r.page_id),
    );
    const openItems = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM review_queue_item WHERE status = 'open' AND source_id = ? AND json_valid(details_json) AND (json_extract(details_json, '$.version_id') = ? OR json_extract(details_json, '$.version_id') IS NULL)`,
      [v.source_id, v.id],
    )!.n;
    return {
      source_id: v.source_id,
      source_title: oneLine(v.title, 200) ?? '',
      source_type: v.source_type,
      version_id: v.id,
      version_no: v.version_no,
      is_active: (v.frozen_version_id ?? v.current_version_id) === v.id,
      processing_status: v.processing_status,
      status_label_ar: PROCESSING_STATUS_LABELS_AR[v.processing_status] ?? v.processing_status,
      summary,
      pages: pages.map((p) => ({
        page_id: p.id,
        page_index: p.page_index,
        label_ar: pageLabelAr(p),
        error_code: p.error_code ?? (p.processing_status === 'failed' ? 'PAGE_FAILED' : 'NEEDS_REVIEW'),
        reason_ar: p.error_detail ?? 'تعذرت معالجة هذه الصفحة.',
        owner_corrected: owned.has(p.id),
      })),
      open_review_items: openItems,
      coverage_note_ar: coverageNote(v.processing_status, summary),
    };
  });
}

export function processingOverview(ctx: AppContext): ProcessingOverviewResponse {
  const active = ctx.jobs.list({ status: ACTIVE, limit: 100 }).jobs;
  const since = ctx.clock.now() - RECENT_MS;
  const recent = ctx.jobs.list({ status: ['failed', 'partial', 'cancelled', 'completed'], limit: 60 }).jobs.filter((j) => (j.finished_at ?? j.created_at) >= since).slice(0, 40);
  const counts = { queued: 0, running: 0, waiting_for_input: 0, failed: 0, partial: 0 };
  for (const r of ctx.db.all<{ status: JobStatus; n: number }>(`SELECT status, COUNT(*) AS n FROM processing_job WHERE status IN ('queued','running','waiting_for_input') GROUP BY status`)) {
    if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
  }
  for (const r of ctx.db.all<{ status: JobStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM processing_job WHERE status IN ('failed','partial') AND COALESCE(finished_at, created_at) >= ? GROUP BY status`,
    [since],
  )) {
    if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
  }
  return {
    active: active.map((j) => toControlJob(ctx, j)),
    recent: recent.map((j) => toControlJob(ctx, j)),
    attention: attention(ctx),
    counts,
    notes_ar: [
      'الأعداد حقيقية من سجل المهام؛ لا توجد نسب تقدم تقديرية.',
      'الإلغاء لا يحذف ما اكتمل، وإعادة المحاولة تكمل من آخر خطوة محفوظة.',
      'المهام الفاشلة والجزئية تُعرض لآخر 30 يومًا.',
    ],
  };
}
