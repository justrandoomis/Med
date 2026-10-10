// «مخطط تفاعلي» in the rail's «الشرح والسؤال» section (§31, track F3): a timeline or a flowchart re-organized from the
// current page (or a topic) under the lecture's Source Lock. The server verifies every step and relation against the
// evidence; without an AI provider the panel says why and offers nothing that pretends to work. Earlier diagrams of
// this source stay one click away (served from the server's cache key — never a different scope).
import { useEffect, useState } from 'react';
import { Shapes } from 'lucide-react';
import { STUDY_DIAGRAM_KIND_LABELS_AR, type SourcePageView, type StudyDiagramKind, type StudyDiagramListResponse, type StudyDiagramResponse, type StudyDiagramView } from '@medlevo/shared';
import { Button, ErrorState, SegmentedControl, StatusPill, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import type { SourceDocument } from '../../workspace/data/useSourceDocument';
import { StudyDiagram } from './StudyDiagram';
import './diagrams.css';

export const diagramsApi = {
  create: (body: { kind: StudyDiagramKind; source_id: string; page_ids?: string[]; topic?: string | null; force?: boolean }) =>
    api.post<StudyDiagramResponse>('/studybook/diagrams', body, { timeoutMs: 5 * 60_000 }),
  list: (sourceId: string) => api.get<StudyDiagramListResponse>('/studybook/diagrams', { query: { source_id: sourceId } }),
};

export function DiagramPanel({ doc, page, online }: { doc: SourceDocument; page: SourcePageView | null; online: boolean }) {
  const caps = useCapabilities();
  const gate = caps.feature('ai.summaries');
  const sourceId = doc.detail.id;
  const [kind, setKind] = useState<StudyDiagramKind>('flowchart');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<StudyDiagramView | null>(null);
  const [history, setHistory] = useState<StudyDiagramView[]>([]);
  const reasonId = `dg-why-${sourceId}`;

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    diagramsApi
      .list(sourceId)
      .then((r) => !cancelled && setHistory(r.diagrams.filter((d) => d.status === 'published')))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sourceId, online]);

  const draw = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      const r = await diagramsApi.create({ kind, source_id: sourceId, page_ids: page && !topic.trim() ? [page.id] : undefined, topic: topic.trim() || null, force });
      setCurrent(r.diagram);
      if (r.diagram.status === 'published') setHistory((h) => [r.diagram, ...h.filter((x) => x.id !== r.diagram.id)].slice(0, 8));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر رسم المخطط.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dg-panel" aria-labelledby={`dg-h-${sourceId}`}>
      <h3 id={`dg-h-${sourceId}`} className="dg-panel__title">
        مخطط تفاعلي من المادة
      </h3>
      <p className="dg-muted">خط زمني أو مخطط انسيابي يعيد تنظيم هذه الصفحة (أو موضوعًا تكتبه) من المحاضرة فقط؛ كل خطوة وعلاقة تحمل دليلها.</p>
      <SegmentedControl<StudyDiagramKind>
        label="نوع المخطط"
        options={[
          { value: 'flowchart', label: STUDY_DIAGRAM_KIND_LABELS_AR.flowchart },
          { value: 'timeline', label: STUDY_DIAGRAM_KIND_LABELS_AR.timeline },
        ]}
        value={kind}
        onValueChange={setKind}
        size="sm"
        fullWidth
      />
      <TextField label="موضوع (اختياري — بدونه تُستخدم الصفحة الحالية)" value={topic} maxLength={300} onChange={(e) => setTopic(e.target.value)} />
      {!gate.available && (
        <div className="wk-disabled-card" role="note" id={reasonId}>
          <p className="wk-disabled-card__title">المخططات المولدة غير متاحة الآن</p>
          <p className="wk-muted">{gate.reason ?? 'تتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.'}</p>
        </div>
      )}
      <div className="wk-rail-actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Shapes size={16} />}
          loading={busy}
          disabled={!gate.available || (!page && !topic.trim())}
          aria-describedby={!gate.available ? reasonId : undefined}
          onClick={() => void draw(false)}
        >
          ارسم المخطط
        </Button>
        {current?.cached && (
          <Button variant="plain" size="sm" disabled={!gate.available || busy} onClick={() => void draw(true)}>
            أعد الرسم
          </Button>
        )}
      </div>
      {error && <ErrorState inline message={error} />}
      {current && current.status !== 'published' && (
        <div className="wk-disabled-card" role="status">
          <p className="wk-disabled-card__title">
            <StatusPill tone="warning">{current.status === 'failed' ? 'رُفض المخطط' : 'امتنع عن الرسم'}</StatusPill>
          </p>
          <p className="wk-muted">{current.abstain?.reason_ar}</p>
          {current.abstain?.detail && <p className="wk-muted">{current.abstain.detail}</p>}
        </div>
      )}
      {current && current.status === 'published' && (
        <>
          {current.cached && <p className="dg-muted">مخطط محفوظ لنفس الطلب والنطاق ونسخة المصدر.</p>}
          <StudyDiagram diagram={current} />
        </>
      )}
      {history.length > 0 && (
        <div className="dg-history" aria-label="مخططات سابقة لهذا المصدر">
          {history
            .filter((d) => d.id !== current?.id)
            .slice(0, 5)
            .map((d) => (
              <Button key={d.id} size="sm" variant="plain" onClick={() => setCurrent(d)}>
                {`${d.kind_label_ar}: ${d.title.slice(0, 40)}`}
              </Button>
            ))}
        </div>
      )}
    </section>
  );
}
