// Per-page processing (§07, §13, AC-03, AC-04): printed label vs file position, text status, OCR
// confidence, failed pages WITH reasons, and «retry page» (only when processing is really available).
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  pageDisplayLabel,
  type FeatureKey,
  type PageTextStatus,
  type SourceFormat,
  type SourcePagesResponse,
  type SourcePageView,
  type SourceVersionView,
} from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Select, StatusPill, type StatusTone, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { useQuery, invalidate } from '../library/data';
import { countAr, NOUN } from '../library/labels';
import { ProcessingStatusView, useProcessingStatus } from './ProcessingStatus';

const TEXT_STATUS_AR: Record<PageTextStatus, string> = {
  pending: 'لم يُستخرج بعد',
  digital: 'نص رقمي',
  ocr: 'تعرّف ضوئي (OCR)',
  mixed: 'رقمي + OCR',
  no_text_found: 'لا يوجد نص',
  needs_ocr: 'يحتاج OCR',
  failed: 'فشل الاستخراج',
};

const PAGE_STATUS: Record<SourcePageView['processing_status'], { label: string; tone: StatusTone }> = {
  pending: { label: 'في الانتظار', tone: 'neutral' },
  processing: { label: 'قيد المعالجة', tone: 'info' },
  ready: { label: 'جاهزة', tone: 'success' },
  failed: { label: 'تعثّرت', tone: 'danger' },
  needs_review: { label: 'تحتاج مراجعة', tone: 'warning' },
  skipped: { label: 'تُخطّيت', tone: 'neutral' },
};

export function processingFeature(format: SourceFormat): FeatureKey | null {
  switch (format) {
    case 'pdf':
      return 'processing.pdf';
    case 'docx':
      return 'processing.docx';
    case 'pptx':
      return 'processing.pptx';
    case 'image':
    case 'image_set':
      return 'processing.images';
    default:
      return null;
  }
}

/** OCR confidence as stored (0–1 or 0–100) → whole percent of the engine's own score. */
export function confidenceLabel(c: number | null): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return '—';
  const pct = c <= 1 ? c * 100 : c;
  return `${Math.round(pct)}%`;
}

const PAGE_CHUNK = 100;

/** «صفحة واحدة تعثّرت معالجتها» / «صفحتان …» / «3 صفحات …» / «11 صفحة …» (Arabic number agreement). */
export function failedPagesLine(n: number): string {
  return `${countAr(n, NOUN.page)} ${n === 2 ? 'تعثّرت معالجتهما' : 'تعثّرت معالجتها'}`;
}

export function PagesPanel({ sourceId, versions, activeVersionId, readOnly }: { sourceId: string; versions: SourceVersionView[]; activeVersionId: string | null; readOnly: boolean }) {
  const [versionId, setVersionId] = useState<string>(activeVersionId ?? versions[0]?.id ?? '');
  const version = versions.find((v) => v.id === versionId) ?? versions[0];
  const q = useQuery<SourcePagesResponse>(version ? `/sources/${sourceId}/versions/${version.id}/pages` : null);
  // bumped after «إعادة المعالجة» so the status view follows the NEW job (polling had stopped)
  const [procKey, setProcKey] = useState(0);
  const proc = useProcessingStatus(version?.id ?? null, { refreshKey: procKey });
  const caps = useCapabilities();
  const toast = useToast();
  const [shown, setShown] = useState(PAGE_CHUNK);
  const [busy, setBusy] = useState<string | null>(null);
  if (!version) return <p className="ml-trash-note">لا توجد نسخ لهذا المصدر.</p>;
  const featureKey = processingFeature(version.format);
  const gate = featureKey ? caps.feature(featureKey) : { available: false, reason: 'معالجة هذا النوع غير متاحة في هذا الإصدار.' };
  const canRetry = gate.available && !readOnly;

  const reprocess = async (pageIndexes?: number[]) => {
    setBusy(pageIndexes ? `p${pageIndexes[0]}` : 'all');
    try {
      await api.post(`/sources/versions/${version.id}/reprocess`, pageIndexes ? { page_indexes: pageIndexes } : {});
      toast.show({ title: pageIndexes ? 'أُضيفت الصفحة إلى قائمة المعالجة' : 'أُضيفت النسخة إلى قائمة المعالجة', tone: 'success' });
      setProcKey((k) => k + 1);
      invalidate(`/sources/${sourceId}`);
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const pages = q.data?.pages ?? [];
  const failed = pages.filter((p) => p.processing_status === 'failed');
  return (
    <div className="ml-stack">
      {versions.length > 1 && (
        <Select<string>
          label="النسخة"
          options={versions.map((v) => ({ value: v.id, label: `النسخة ${v.version_no}${v.is_frozen ? ' (مثبّتة)' : ''}` }))}
          value={version.id}
          onValueChange={(v) => {
            setVersionId(v);
            setShown(PAGE_CHUNK);
          }}
        />
      )}
      <div className="ml-group">
        <div className="ml-group__row ml-group__row--stack">
          <ProcessingStatusView status={proc.status} format={version.format} error={proc.error} />
          {featureKey && (
            <div className="ml-cluster">
              <Button size="sm" icon={<RotateCcw size={16} />} onClick={() => void reprocess()} disabled={!canRetry} loading={busy === 'all'}>
                إعادة معالجة النسخة كلها
              </Button>
              {!gate.available && gate.reason && <span className="ml-field__hint">{gate.reason}</span>}
            </div>
          )}
        </div>
      </div>

      {version.pagination === 'paragraphs' && (
        <p className="ml-trash-note">مستند Word لا يملك صفحات ثابتة على كل الأجهزة؛ تُحدَّد المواضع فيه بالفقرة والعنوان، ولا تُختلق أرقام صفحات.</p>
      )}
      {version.pagination === 'timestamps' && <p className="ml-trash-note">التسجيل الصوتي يُحدَّد بالتوقيت لا بالصفحات.</p>}

      {q.loading && !q.data && <LoadingState stage="جارٍ تحميل الصفحات…" inline />}
      {q.error && !q.data && <ErrorState inline message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && pages.length === 0 && version.pagination !== 'timestamps' && (
        <p className="ml-trash-note">لم تُنشأ صفحات هذه النسخة بعد؛ تُنشأ أثناء المعالجة.</p>
      )}
      {failed.length > 0 && (
        <p className="ml-proc__warn" role="status">
          {failedPagesLine(failed.length)}؛ بقية الصفحات قابلة للقراءة، ولن يُعرض أي ملخص على أنه كامل قبل معالجتها.
        </p>
      )}
      {pages.length > 0 && (
        <div className="ml-pages">
          <table className="ml-pages__table">
            <caption className="ml-visually-hidden">صفحات النسخة {version.version_no} وحالة معالجتها</caption>
            <thead>
              <tr>
                <th scope="col">الصفحة</th>
                <th scope="col">النص</th>
                <th scope="col">ثقة التعرّف</th>
                <th scope="col">الحالة</th>
                <th scope="col">
                  <span className="ml-visually-hidden">إجراءات</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pages.slice(0, shown).map((p) => {
                const st = PAGE_STATUS[p.processing_status];
                return (
                  <tr key={p.id} data-status={p.processing_status}>
                    <th scope="row" data-label="الصفحة">
                      {pageDisplayLabel(p)}
                      {p.kind === 'image' && p.section_key && (
                        <span className="ml-pages__sub">
                          <bdi dir="ltr">{p.section_key}</bdi>
                        </span>
                      )}
                    </th>
                    <td data-label="النص">{TEXT_STATUS_AR[p.text_status]}</td>
                    <td data-label="ثقة التعرّف">
                      <bdi dir="ltr">{confidenceLabel(p.ocr_confidence)}</bdi>
                    </td>
                    <td data-label="الحالة">
                      <StatusPill tone={st.tone}>{st.label}</StatusPill>
                      {p.error_detail_ar && <span className="ml-pages__reason">{p.error_detail_ar}</span>}
                    </td>
                    <td data-label="">
                      {(p.processing_status === 'failed' || p.processing_status === 'needs_review') && featureKey && (
                        <Button
                          size="sm"
                          variant="plain"
                          icon={<RotateCcw size={16} />}
                          onClick={() => void reprocess([p.page_index])}
                          disabled={!canRetry}
                          loading={busy === `p${p.page_index}`}
                          aria-label={`إعادة المعالجة: ${pageDisplayLabel(p)}`}
                        >
                          إعادة المعالجة
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pages.length > shown && (
            <Button variant="plain" onClick={() => setShown((n) => n + PAGE_CHUNK)}>
              عرض {Math.min(PAGE_CHUNK, pages.length - shown)} صفحة أخرى (من {pages.length})
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
