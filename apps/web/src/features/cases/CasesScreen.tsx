// /cases — clinical cases, OSCE stations and viva (§42). The owner writes cases by hand (no AI needed) or — when a
// provider is configured — asks for one generated from chosen lecture pages / a topic (evidence-checked). Voice mode
// is not available and says why. A plain list, no counters.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mic, Plus, Sparkles, Stethoscope } from 'lucide-react';
import {
  CASE_KIND_LABELS_AR,
  OSCE_STATION_TYPE_LABELS_AR,
  OSCE_STATION_TYPES,
  type CaseKind,
  type CaseListResponse,
  type OsceStationType,
} from '@medlevo/shared';
import { Button, EmptyState, ErrorState, ListItem, LoadingState, Select, StatusPill, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import { casesApi } from './api';
import './cases.css';

const STATUS_TONE = { ready: 'success', needs_review: 'warning', draft: 'neutral' } as const;
const LECTURE_TYPES = new Set(['lecture', 'course_reference', 'textbook', 'guideline', 'practical_manual', 'my_notes']);

function GeneratePanel({ reason, onCreated }: { reason: string | null; onCreated: (id: string) => void }) {
  const lib = useLibrary();
  const sources = useMemo(() => (lib.data?.sources ?? []).filter((s) => LECTURE_TYPES.has(s.source_type) && !s.deleted_at), [lib.data]);
  const [lecture, setLecture] = useState('');
  const [kind, setKind] = useState<CaseKind>('case');
  const [station, setStation] = useState<OsceStationType>('history_taking');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (reason) {
    return (
      <section className="cs-section" aria-labelledby="cs-gen-h">
        <h2 id="cs-gen-h" className="cs-section__title">
          <Sparkles size={18} aria-hidden="true" /> توليد حالة من محاضرة
        </h2>
        <p className="cs-muted">{reason}</p>
        <p className="cs-muted">يمكنك كتابة الحالة بنفسك؛ التشغيل والتقييم لا يحتاجان الذكاء الاصطناعي.</p>
      </section>
    );
  }
  return (
    <section className="cs-section" aria-labelledby="cs-gen-h">
      <h2 id="cs-gen-h" className="cs-section__title">
        <Sparkles size={18} aria-hidden="true" /> توليد حالة من محاضرة
      </h2>
      <p className="cs-muted">تُبنى الحالة من مقتطفات المحاضرة فقط؛ كل جملة طبية تُتحقق من دليلها وتُحذف غير المدعومة، وتفاصيل المريض تُوسم «بيانات تعليمية مؤلفة».</p>
      <div className="cs-form-row">
        <Select label="المحاضرة" value={lecture} onValueChange={setLecture} options={[{ value: '', label: lib.loading && !lib.data ? 'جارٍ التحميل…' : 'اختر محاضرة' }, ...sources.map((s) => ({ value: s.id, label: s.title }))]} />
        <Select label="النوع" value={kind} onValueChange={(v) => setKind(v as CaseKind)} options={(['case', 'osce', 'viva'] as const).map((k) => ({ value: k, label: CASE_KIND_LABELS_AR[k] }))} />
        {kind === 'osce' && <Select label="نوع المحطة" value={station} onValueChange={(v) => setStation(v as OsceStationType)} options={OSCE_STATION_TYPES.map((s) => ({ value: s, label: OSCE_STATION_TYPE_LABELS_AR[s] }))} />}
      </div>
      <TextField label="الموضوع" hint="مثل: ألم الحفرة الحرقفية اليمنى عند امرأة في سن الإنجاب" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} />
      {error && <ErrorState inline message={error} />}
      <Button
        variant="secondary"
        icon={<Sparkles size={16} />}
        loading={busy}
        disabled={!lecture || !topic.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await casesApi.generate({ lecture_source_id: lecture, kind, station_type: kind === 'osce' ? station : null, topic: topic.trim() });
            onCreated(r.case.id);
          } catch (e) {
            setError(errorMessage(e, 'تعذّر طلب التوليد.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        ولّد الحالة
      </Button>
    </section>
  );
}

export function CasesScreen() {
  usePageTitle('الحالات وOSCE');
  const navigate = useNavigate();
  const [data, setData] = useState<CaseListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await casesApi.list());
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الحالات.'));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ml-page cs-page">
      <header className="ml-page__header cs-head">
        <div>
          <h1 className="ml-page__title">الحالات السريرية وOSCE والامتحان الشفهي</h1>
          <p className="ml-page__lede">حالة تتقدم بقراراتك، أو محطة OSCE نصية، أو أسئلة شفهية بمتابعة — كل حكم مع سببه ومصدره.</p>
        </div>
        <div className="ml-cluster">
          {(['case', 'osce', 'viva'] as const).map((k, i) => (
            <Link key={k} to={`/cases/new?kind=${k}`} className={buttonClass({ variant: i === 0 ? 'primary' : 'secondary' })}>
              <Plus size={16} aria-hidden="true" />
              {k === 'case' ? 'حالة جديدة' : k === 'osce' ? 'محطة OSCE' : 'امتحان شفهي'}
            </Link>
          ))}
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!data && !error && <LoadingState stage="جارٍ تحميل الحالات…" />}
      {data && (
        <>
          {data.cases.length === 0 ? (
            <EmptyState
              icon={<Stethoscope size={28} />}
              title="لا توجد حالات بعد"
              description="اكتب حالة من محاضرة تدرسها: معلومات المريض الثابتة، المراحل والقرارات، وقائمة التقييم. يمكنك إرفاق دليل من مصادرك لكل شرح."
              actions={
                <Link to="/cases/new?kind=case" className={buttonClass({ variant: 'primary' })}>
                  اكتب حالة
                </Link>
              }
            />
          ) : (
            <ul className="ml-list cs-cases" aria-label="الحالات">
              {data.cases.map((c) => (
                <ListItem
                  key={c.id}
                  to={`/cases/${encodeURIComponent(c.id)}`}
                  leading={<Stethoscope size={20} />}
                  title={<BidiText as="span" text={c.title} />}
                  subtitle={
                    <>
                      {c.kind_label_ar}
                      {c.station_type ? ` (${OSCE_STATION_TYPE_LABELS_AR[c.station_type]})` : ''} — {c.origin_label_ar} — {c.attempts ? `${c.attempts} محاولة` : 'لم تُجرَّب'}
                      {c.last_attempt ? `، آخرها ${formatDateTime(c.last_attempt.started_at)}` : ''}
                    </>
                  }
                  trailing={
                    <StatusPill tone={c.generation && ['queued', 'running'].includes(c.generation.status) ? 'info' : STATUS_TONE[c.status]} icon={false}>
                      {c.generation && ['queued', 'running', 'abstained', 'failed'].includes(c.generation.status) ? c.generation.status_label_ar : c.status_label_ar}
                    </StatusPill>
                  }
                />
              ))}
            </ul>
          )}
          <GeneratePanel reason={data.capabilities.generation.available ? null : data.capabilities.generation.reason_ar} onCreated={(id) => navigate(`/cases/${encodeURIComponent(id)}`)} />
          <p className="cs-muted cs-voice">
            <Mic size={14} aria-hidden="true" /> {data.capabilities.voice.reason_ar}
          </p>
        </>
      )}
    </div>
  );
}
