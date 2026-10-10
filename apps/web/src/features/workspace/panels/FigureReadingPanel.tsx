// «قراءة بنية الشكل» (§13 vision step, AC-08, track F3) — under a figure / diagram region in «المصادر».
// The owner asks for an on-demand vision reading of the figure; the result is a DERIVED structure (boxes, arrows,
// direction, each with its certainty) stored beside the region — the region, its OCR text and the page are never
// changed. Everything stays «غير مؤكدة» and can never back a fixed exam answer until the owner reviews it: they may
// correct a label, keep or drop each relation (uncertain relations start unchecked), then confirm — or reject it.
// Without a vision provider the button is disabled with the server's reason; nothing pretends to read the image.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, ScanSearch } from 'lucide-react';
import {
  FIGURE_READING_LABEL_AR,
  type DiagramStructure,
  type FigureReadingResponse,
  type FigureReadingReviewRequest,
  type FigureReadingView,
  type FigureReadingsResponse,
} from '@medlevo/shared';
import { Button, Checkbox, ErrorState, Skeleton, StatusPill, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';

const enc = encodeURIComponent;
export const visionApi = {
  readings: (regionId: string) => api.get<FigureReadingsResponse>(`/processing/figures/${enc(regionId)}/readings`),
  analyze: (regionId: string) => api.post<FigureReadingResponse>(`/processing/figures/${enc(regionId)}/analyze`, {}, { timeoutMs: 30_000 }),
  review: (readingId: string, body: FigureReadingReviewRequest) => api.post<FigureReadingResponse>(`/processing/figure-readings/${enc(readingId)}/review`, body),
};

const PENDING = new Set(['queued', 'running']);
const certaintyAr = (c: 'read' | 'uncertain') => (c === 'read' ? 'مقروء' : 'غير مؤكد');

function tone(s: FigureReadingView['status']): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  return s === 'owner_reviewed' ? 'success' : s === 'uncertain' ? 'warning' : s === 'failed' ? 'danger' : s === 'rejected' ? 'neutral' : 'info';
}

export function FigureReadingPanel({ regionId, online }: { regionId: string; online: boolean }) {
  const [data, setData] = useState<FigureReadingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await visionApi.readings(regionId);
      setData(r);
      setError(null);
      window.clearTimeout(timer.current);
      if (r.readings.some((x) => PENDING.has(x.status))) timer.current = window.setTimeout(() => void load(), 2000);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل قراءات الشكل.'));
    }
  }, [regionId]);

  useEffect(() => {
    if (!online) return;
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load, online]);

  const analyze = async () => {
    setBusy(true);
    try {
      await visionApi.analyze(regionId);
      await load();
    } catch (e) {
      setError(errorMessage(e, 'تعذّر طلب قراءة الشكل.'));
    } finally {
      setBusy(false);
    }
  };

  const can = data?.can_analyze ?? { available: false, reason_ar: null };
  const latest = data?.readings[0] ?? null;
  const reasonId = `fr-why-${regionId}`;
  const pending = latest ? PENDING.has(latest.status) : false;
  return (
    <div className="wk-figread" role="group" aria-label="قراءة بنية الشكل">
      <p className="wk-figread__label" role="note">
        {FIGURE_READING_LABEL_AR}
      </p>
      {!online && <p className="wk-muted">قراءة الشكل تحتاج اتصالًا بالخادم.</p>}
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      {online && !data && !error && <Skeleton lines={2} />}
      {data && (
        <div className="wk-rail-actions">
          <Button size="sm" variant="secondary" icon={<ScanSearch size={16} />} loading={busy} disabled={!can.available || busy || pending} aria-describedby={!can.available ? reasonId : undefined} onClick={() => void analyze()}>
            {latest ? 'اقرأ الشكل من جديد' : 'اقرأ بنية الشكل'}
          </Button>
        </div>
      )}
      {data && !can.available && (
        <p id={reasonId} className="wk-muted" role="note">
          {can.reason_ar}
        </p>
      )}
      {data && data.readings.length === 0 && <p className="wk-muted">لم يُقرأ هذا الشكل بعد. تسميات الرسم الحالية من OCR فقط ولا تُستنتج منها الأسهم.</p>}
      {latest && <ReadingView key={latest.id} reading={latest} onChanged={(r) => setData((d) => (d ? { ...d, readings: [r, ...d.readings.filter((x) => x.id !== r.id)] } : d))} />}
    </div>
  );
}

export function ReadingView({ reading, onChanged }: { reading: FigureReadingView; onChanged: (r: FigureReadingView) => void }) {
  const [reviewing, setReviewing] = useState(false);
  const shown: DiagramStructure | null = reading.reviewed_structure ?? reading.structure;
  const label = (id: string) => shown?.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="wk-figread__reading">
      <div className="ml-cluster">
        <StatusPill tone={tone(reading.status)}>{reading.status_label_ar}</StatusPill>
        {reading.status !== 'failed' && reading.status !== 'queued' && reading.status !== 'running' && <span className="wk-muted">{`الاتجاه: ${reading.direction_label_ar}`}</span>}
      </div>
      <p className="wk-muted">
        {reading.usable_as_fixed_answer ? 'أكدتَ هذه القراءة؛ يمكن الاعتماد عليها كما راجعتها (الصورة الأصلية لم تتغير).' : 'لا تُعتمد إجابةً امتحانية ولا دليلًا ثابتًا حتى تراجعها وتؤكدها.'}
      </p>
      {reading.error_ar && <p className="wk-muted">{reading.error_ar}</p>}
      {shown && !reviewing && (
        <>
          <p className="wk-muted">{`${reading.counts.nodes} عناصر، ${reading.counts.edges} علاقات، غير المؤكد منها ${reading.counts.uncertain}.`}</p>
          <ul className="wk-figread__list" aria-label="عناصر الشكل">
            {shown.nodes.map((n) => (
              <li key={n.id}>
                <bdi>{n.label}</bdi> <span className="wk-muted">{`(${certaintyAr(n.certainty)})`}</span>
              </li>
            ))}
          </ul>
          {shown.edges.length > 0 ? (
            <ul className="wk-figread__list" aria-label="علاقات الشكل">
              {shown.edges.map((e, i) => (
                <li key={i} data-certainty={e.certainty}>
                  {`من «${label(e.from)}» إلى «${label(e.to)}»${e.label ? ` — ${e.label}` : ''}`} <span className="wk-muted">{`(${certaintyAr(e.certainty)})`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wk-muted">لم تُقرأ علاقات مؤكدة بين العناصر.</p>
          )}
          {reading.notes_ar.length > 0 && (
            <ul className="wk-muted">
              {reading.notes_ar.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {reading.status === 'uncertain' && reading.structure && !reviewing && (
        <Button size="sm" variant="secondary" icon={<Eye size={16} />} onClick={() => setReviewing(true)}>
          راجع القراءة
        </Button>
      )}
      {reviewing && reading.structure && <ReviewForm reading={reading} structure={reading.structure} onDone={(r) => (setReviewing(false), onChanged(r))} onCancel={() => setReviewing(false)} />}
    </div>
  );
}

function ReviewForm({ reading, structure, onDone, onCancel }: { reading: FigureReadingView; structure: DiagramStructure; onDone: (r: FigureReadingView) => void; onCancel: () => void }) {
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries(structure.nodes.map((n) => [n.id, n.label])));
  // an uncertain relation is NOT kept unless the owner ticks it
  const [keep, setKeep] = useState<boolean[]>(() => structure.edges.map((e) => e.certainty === 'read'));
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => labels[id] || id;

  const send = async (decision: 'confirm' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      const body: FigureReadingReviewRequest =
        decision === 'reject'
          ? { decision }
          : {
              decision,
              nodes: structure.nodes.map((n) => ({ id: n.id, label: (labels[n.id] ?? n.label).trim() || n.label })),
              edges: structure.edges.filter((_, i) => keep[i]).map((e) => ({ from: e.from, to: e.to, label: e.label ?? null })),
            };
      onDone((await visionApi.review(reading.id, body)).reading);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ المراجعة.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="wk-figread__review"
      onSubmit={(e) => {
        e.preventDefault();
        void send('confirm');
      }}
    >
      <fieldset className="wk-figread__fieldset">
        <legend>العناصر (صحّح ما قُرئ خطأ)</legend>
        {structure.nodes.map((n) => (
          <TextField key={n.id} label={`${n.id} — ${certaintyAr(n.certainty)}`} value={labels[n.id] ?? ''} maxLength={300} onChange={(e) => setLabels((l) => ({ ...l, [n.id]: e.target.value }))} />
        ))}
      </fieldset>
      {structure.edges.length > 0 && (
        <fieldset className="wk-figread__fieldset">
          <legend>العلاقات (أبقِ ما تراه في الصورة فقط)</legend>
          {structure.edges.map((e, i) => (
            <Checkbox
              key={i}
              label={`من «${name(e.from)}» إلى «${name(e.to)}»${e.label ? ` — ${e.label}` : ''} (${certaintyAr(e.certainty)})`}
              checked={keep[i] ?? false}
              onCheckedChange={(v) => setKeep((k) => k.map((x, j) => (j === i ? v : x)))}
            />
          ))}
        </fieldset>
      )}
      {error && <ErrorState inline message={error} />}
      <div className="wk-rail-actions">
        <Button type="submit" size="sm" variant="primary" loading={busy === 'confirm'} disabled={!!busy}>
          أكّد القراءة كما راجعتها
        </Button>
        <Button size="sm" variant="secondary" loading={busy === 'reject'} disabled={!!busy} onClick={() => void send('reject')}>
          ارفض القراءة
        </Button>
        <Button size="sm" variant="plain" disabled={!!busy} onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}
