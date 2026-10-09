// Live processing status of one version: stage name + REAL page counts from the server's
// ProcessingSummary and job state (§13: never a fake percentage). Polls while work is pending.
import { useEffect, useRef, useState } from 'react';
import { JOB_STATUS_LABELS_AR, type ProcessingStatusResponse, type SourceFormat } from '@medlevo/shared';
import { ProgressBar, Spinner } from '../../design';
import { api, isApiError } from '../../lib/api';
import { countAr, NOUN } from '../library/labels';
import './sources.css';

const ACTIVE_JOB = new Set(['queued', 'running']);

export function isProcessingActive(s: ProcessingStatusResponse | null): boolean {
  if (!s) return true;
  if (s.job) return ACTIVE_JOB.has(s.job.status);
  return false;
}

/**
 * Poll GET /sources/versions/:id/processing while the job is queued/running. Change `refreshKey`
 * (e.g. after «إعادة المعالجة») to look again: polling stops once a job has finished.
 */
export function useProcessingStatus(versionId: string | null, opts: { intervalMs?: number; refreshKey?: number } = {}) {
  const [state, setState] = useState<ProcessingStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = opts.intervalMs ?? 2500;
  useEffect(() => {
    if (!versionId) return;
    let stopped = false;
    let delay = interval;
    const tick = async () => {
      try {
        const s = await api.get<ProcessingStatusResponse>(`/sources/versions/${versionId}/processing`);
        if (stopped) return;
        setState(s);
        setError(null);
        delay = interval;
        if (!isProcessingActive(s)) return;
      } catch (e) {
        if (stopped) return;
        setError(isApiError(e) ? e.message : 'تعذّر تحديث حالة المعالجة.');
        delay = Math.min(delay * 2, 30_000);
      }
      timer.current = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [versionId, interval, opts.refreshKey]);
  return { status: state, error };
}

function unitNoun(format: SourceFormat | null | undefined) {
  return format === 'pptx' ? NOUN.slide : format === 'image' || format === 'image_set' ? NOUN.image : NOUN.page;
}

/** Stage + counts. `compact` for upload rows. */
export function ProcessingStatusView({ status, format, error }: { status: ProcessingStatusResponse | null; format?: SourceFormat | null; error?: string | null }) {
  if (!status) return error ? <p className="ml-proc__error">{error}</p> : <p className="ml-proc__line">جارٍ التحقق من حالة المعالجة…</p>;
  const s = status.summary;
  const job = status.job;
  const active = isProcessingActive(status);
  const unit = unitNoun(format);
  const total = s?.pages_total ?? job?.progress?.total ?? null;
  const ready = s?.pages_ready ?? 0;
  const counts: string[] = [];
  if (s) {
    if (total !== null && total > 0) counts.push(`جاهز ${ready} من ${countAr(total, unit)}`);
    else if (ready > 0) counts.push(`جاهز ${countAr(ready, unit)}`);
    if (s.pages_failed > 0) counts.push(`تعثّر ${s.pages_failed}`);
    if (s.pages_needs_review > 0) counts.push(`يحتاج مراجعة ${s.pages_needs_review}`);
    if (s.pages_ocr > 0) counts.push(`قُرئ بالتعرف الضوئي (OCR) ${s.pages_ocr}`);
  }
  // the server's Arabic stage label (ProcessingSummary) is authoritative; job state is the fallback
  const stage = s?.stage_label_ar ?? (job ? JOB_STATUS_LABELS_AR[job.status] : 'لا توجد معلومات معالجة بعد.');
  return (
    <div className="ml-proc" aria-live="polite">
      <p className="ml-proc__line">
        {active && <Spinner size={14} />}
        <span>{stage}</span>
        {job && !active && job.status !== 'completed' && <span className="ml-proc__job">({JOB_STATUS_LABELS_AR[job.status]})</span>}
      </p>
      {counts.length > 0 && <p className="ml-proc__counts">{counts.join('، ')}</p>}
      {total !== null && total > 0 && active && <ProgressBar label="الصفحات الجاهزة" value={ready} max={total} valueText={`${ready} من ${total}`} />}
      {s && s.stage === 'done' && !s.coverage_complete && s.pages_total !== null && (
        <p className="ml-proc__warn">التغطية غير مكتملة: بعض الأجزاء لم تُعالج بنجاح، ولن يُعرض أي ملخص على أنه كامل.</p>
      )}
      {job?.error && <p className="ml-proc__error">{job.error.message}</p>}
      {error && <p className="ml-proc__error">{error}</p>}
    </div>
  );
}
