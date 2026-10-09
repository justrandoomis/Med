// Summaries (§31): the type, the pages and the Source Lock are shown BEFORE generation (with what will not be
// covered: unreadable / unprocessed pages, selections such as last-minute) and AFTER it (coverage of the result).
// A summary is never called complete when pages are missing; generated text keeps its chips and labels.
import { useEffect, useState } from 'react';
import {
  SUMMARY_TYPES,
  SUMMARY_TYPE_LABELS_AR,
  type StudyBookView,
  type SummaryPreviewResponse,
  type SummaryRequest,
  type SummaryType,
} from '@medlevo/shared';
import { Button, ErrorState, LoadingState, SegmentedControl, Select, StatusPill, TextArea } from '../../../design';
import { errorMessage } from '../../../lib/api';
import type { FeatureGateState } from '../../../lib/capabilities';
import { ArtifactContent } from '../../evidence';
import { studybookApi, type ArtifactListItem } from '../../studybook/api';
import { coverageSummary, defaultScopeFor, pagesAr } from '../../studybook/model';
import type { SourceDocument } from '../data/useSourceDocument';
import { fullPageLabel } from '../model/pages';

type PagesChoice = 'all' | 'current';

export function SummaryPanel({ doc, pageIndex, online, gate }: { doc: SourceDocument; pageIndex: number; online: boolean; gate: FeatureGateState }) {
  const [type, setType] = useState<SummaryType>('quick');
  const [pages, setPages] = useState<PagesChoice>('all');
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<SummaryPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StudyBookView | null>(null);
  const [history, setHistory] = useState<ArtifactListItem[]>([]);
  const page = doc.pages[pageIndex];

  const request = (): SummaryRequest => ({
    type,
    source_id: doc.detail.id,
    version_id: doc.version.id,
    page_indexes: pages === 'current' && page ? [page.page_index] : undefined,
    scope: { ...defaultScopeFor(doc.detail, 'lecture_only'), version_pins: { [doc.detail.id]: doc.version.id } },
    instruction: type === 'custom' && instruction.trim() ? instruction.trim() : undefined,
  });

  useEffect(() => {
    setPreview(null);
  }, [type, pages, pageIndex]);

  useEffect(() => {
    if (!online) return;
    void studybookApi
      .artifacts(doc.detail.id, 'summary', 10)
      .then((r) => setHistory(r.artifacts))
      .catch(() => undefined);
  }, [doc.detail.id, online, result?.artifact.id]);

  // poll a running summary
  useEffect(() => {
    if (!result || result.artifact.status !== 'generating') return;
    const t = setTimeout(() => {
      void studybookApi.summary(result.artifact.id).then(setResult).catch(() => undefined);
    }, 2500);
    return () => clearTimeout(t);
  }, [result]);

  const doPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      setPreview(await studybookApi.summaryPreview(request()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      const r = await studybookApi.createSummary(request());
      setResult(r.book);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const typeOptions = SUMMARY_TYPES.map((t) => ({ value: t, label: SUMMARY_TYPE_LABELS_AR[t] }));
  const cov = result ? coverageSummary(result.artifact.coverage) : null;

  return (
    <div className="sb-summary">
      <p className="sb-muted">يُعرض نطاق الملخص وما لن يغطيه قبل التوليد، ثم تغطيته الفعلية بعده. لا يُسمّى الملخص كاملًا إن بقيت صفحات غير معالجة أو مستثناة.</p>
      <div className="sb-summary__form">
        <Select label="نوع الملخص" options={typeOptions} value={type} onValueChange={setType} />
        <SegmentedControl
          label="الصفحات"
          showLabel
          options={[
            { value: 'all', label: 'المحاضرة كلها' },
            { value: 'current', label: page ? `الصفحة الحالية (${fullPageLabel(page)})` : 'الصفحة الحالية' },
          ]}
          value={pages}
          onValueChange={setPages}
          size="sm"
        />
        {type === 'custom' && <TextArea label="تعليماتك للملخص" hint="تفضيل للصياغة والبنية فقط؛ لا يضيف معلومات من خارج المصادر." value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} />}
        <div className="sb-row">
          <Button variant="secondary" onClick={() => void doPreview()} loading={busy === 'preview'} disabled={!online}>
            اعرض النطاق والتغطية قبل التوليد
          </Button>
        </div>
      </div>

      {preview && (
        <section className="sb-preview" aria-label="معاينة نطاق الملخص">
          <p className="sb-label">قبل التوليد</p>
          <p className="sb-muted">{preview.scope_describe_ar}</p>
          <p>
            {`${preview.type_label_ar}: ${pagesAr(preview.pages_ready)} جاهزة من ${preview.pages_selected}.`}{' '}
            <StatusPill tone={preview.will_be_complete ? 'success' : 'warning'}>{preview.will_be_complete ? 'سيغطي كل الصفحات المحددة' : 'لن يكون ملخصًا كاملًا'}</StatusPill>
          </p>
          {preview.notes_ar.length > 0 && (
            <ul className="sb-notes" role="list">
              {preview.notes_ar.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <Button variant="primary" onClick={() => void create()} loading={busy === 'create'} loadingLabel="جارٍ البدء…" disabled={!gate.available || preview.pages_ready === 0} aria-describedby={!gate.available ? 'sb-summary-gate' : undefined}>
            أنشئ الملخص
          </Button>
          {!gate.available && (
            <p id="sb-summary-gate" className="sb-reason" role="note">
              {gate.reason}
            </p>
          )}
        </section>
      )}
      {error && <ErrorState inline message={error} />}

      {result && (
        <section className="sb-result" aria-label="الملخص">
          {result.artifact.status === 'generating' ? (
            <LoadingState inline stage="يُولَّد الملخص على دفعات من الصفحات، ويُتحقق من كل جملة قبل عرضها." done={result.progress.sections_complete + result.progress.sections_abstained} total={result.progress.sections_total} unit="دفعات" />
          ) : (
            <>
              <p className="sb-label">بعد التوليد</p>
              {cov?.text && (
                <p>
                  {cov.text} <StatusPill tone={cov.complete ? 'success' : 'warning'}>{cov.complete ? 'غطّى كل الصفحات المحددة' : 'تغطية جزئية'}</StatusPill>
                </p>
              )}
              <ArtifactContent artifact={result.artifact} />
            </>
          )}
        </section>
      )}

      {history.length > 0 && (
        <details className="sb-history">
          <summary>{`ملخصات سابقة (${history.length})`}</summary>
          <ul role="list">
            {history.map((h) => (
              <li key={h.id}>
                <Button size="sm" variant="plain" onClick={() => void studybookApi.summary(h.id).then(setResult).catch((e: unknown) => setError(errorMessage(e)))}>
                  {h.title ?? 'ملخص'}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
