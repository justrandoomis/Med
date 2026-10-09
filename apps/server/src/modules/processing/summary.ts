// ProcessingSummary from REAL page rows (§13: no fake percentages) and the version/source status rule:
//   ready        every page ready
//   needs_review every page processed, some need the owner's review
//   partial      some pages failed or were never processed (coverage is not complete)
//   failed       nothing readable
import type { FailedPageInfo, ProcessingStatus, ProcessingSummary } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';

export type SummaryStage = ProcessingSummary['stage'];

export const STAGE_LABELS_AR: Record<SummaryStage, string> = {
  queued: 'في انتظار المعالجة',
  inspect: 'فحص الملف وعدّ الصفحات',
  extract: 'استخراج النص وتحليل تخطيط الصفحات',
  ocr: 'التعرف الضوئي على النص (OCR)',
  layout: 'ربط الأشكال بتعليقاتها',
  structure: 'تحليل بنية المحاضرة',
  index: 'بناء فهرس البحث',
  validate: 'التحقق من اكتمال المعالجة',
  done: 'اكتملت المعالجة',
};

interface PageRow {
  page_index: number;
  printed_label: string | null;
  processing_status: string;
  text_status: string;
  error_code: string | null;
  error_detail: string | null;
}

export function computeSummary(ctx: AppContext, versionId: string, stage: SummaryStage, jobId: string | null): { summary: ProcessingSummary; status: ProcessingStatus } {
  const pages = ctx.db.all<PageRow>(
    'SELECT page_index, printed_label, processing_status, text_status, error_code, error_detail FROM source_page WHERE version_id = ? ORDER BY page_index',
    [versionId],
  );
  const total = pages.length;
  const ready = pages.filter((p) => p.processing_status === 'ready').length;
  const failed = pages.filter((p) => p.processing_status === 'failed').length;
  const needsReview = pages.filter((p) => p.processing_status === 'needs_review').length;
  const ocr = pages.filter((p) => p.text_status === 'ocr' || p.text_status === 'mixed').length;
  const unprocessed = total - ready - failed - needsReview;
  // pages whose text could not be read at all (no OCR available, OCR found nothing) are not "almost ready"
  const unreadable = pages.filter((p) => p.processing_status === 'needs_review' && (p.text_status === 'needs_ocr' || p.text_status === 'no_text_found')).length;
  const failedPages: FailedPageInfo[] = pages
    .filter((p) => p.processing_status === 'failed' || (p.error_code && p.processing_status !== 'ready'))
    .map((p) => ({
      page_index: p.page_index,
      printed_label: p.printed_label,
      error_code: p.error_code ?? (p.processing_status === 'failed' ? 'PAGE_FAILED' : 'NEEDS_REVIEW'),
      reason_ar: p.error_detail ?? 'تعذرت معالجة هذه الصفحة.',
    }));

  let status: ProcessingStatus;
  if (total === 0 || failed === total) status = 'failed';
  else if (failed > 0 || unprocessed > 0) status = 'partial';
  else if (needsReview > 0) status = 'needs_review';
  else status = 'ready';

  let label = STAGE_LABELS_AR[stage];
  if (stage === 'done') {
    if (status === 'ready') label = `اكتملت المعالجة: ${total} من ${total} ${total === 1 ? 'صفحة' : 'صفحات'} جاهزة.`;
    else if (status === 'needs_review')
      label = `اكتملت المعالجة: ${ready} جاهزة و${needsReview} تحتاج مراجعتك قبل الاعتماد عليها${unreadable ? ` (منها ${unreadable} لم يُقرأ نصها)` : ''}.`;
    else if (status === 'partial')
      label = `اكتملت المعالجة جزئيًا: ${ready + needsReview} من ${total} قابلة للقراءة، ${failed} متعثرة${unprocessed ? ` و${unprocessed} لم تُعالج بعد` : ''}. التغطية غير كاملة.`;
    else label = 'تعذرت معالجة الملف: لم تُقرأ أي صفحة.';
  }
  return {
    status,
    summary: {
      stage,
      stage_label_ar: label,
      pages_total: total,
      pages_ready: ready,
      pages_failed: failed,
      pages_needs_review: needsReview,
      pages_ocr: ocr,
      failed_pages: failedPages,
      coverage_complete: total > 0 && ready === total,
      job_id: jobId,
      updated_at: ctx.clock.now(),
    },
  };
}

/** Write the summary; `final` also sets version (and active-version source) processing_status. */
export function writeSummary(
  ctx: AppContext,
  versionId: string,
  stage: SummaryStage,
  jobId: string | null,
  opts: { final?: boolean; overrideStatus?: ProcessingStatus; overrideLabelAr?: string } = {},
): { summary: ProcessingSummary; status: ProcessingStatus } {
  const res = computeSummary(ctx, versionId, stage, jobId);
  if (opts.overrideStatus) res.status = opts.overrideStatus;
  if (opts.overrideLabelAr) res.summary.stage_label_ar = opts.overrideLabelAr;
  const now = ctx.clock.now();
  const versionStatus: ProcessingStatus = opts.final ? res.status : 'processing';
  ctx.db.tx(() => {
    ctx.db.run('UPDATE source_version SET processing_status = ?, processing_summary_json = ? WHERE id = ?', [versionStatus, toJson(res.summary), versionId]);
    // the source mirrors the version the owner studies (frozen ?? current)
    ctx.db.run(
      `UPDATE source SET processing_status = ?, updated_at = ?
        WHERE id = (SELECT source_id FROM source_version WHERE id = ?) AND COALESCE(frozen_version_id, current_version_id) = ?`,
      [versionStatus, now, versionId, versionId],
    );
  });
  return res;
}
