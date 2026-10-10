// /exams/simulate — «محاكاة مولدة» (§37, §40, track F3). The plan follows the owner's OWN Exam DNA (their uploaded
// question sources only, with denominators): lecture shares and item-type shares decide how many generated questions
// come from which lecture. The plan is computed WITHOUT AI and always shown; generation needs the AI capability and
// runs the full generation pipeline (Source Lock, independent validator, claim checks, review queue) for every part.
// The result is labelled «محاكاة مولدة — ليست نسخة متوقعة من الامتحان القادم» everywhere and is never presented as the
// expected exam.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleAlert, Info, Sparkles, WifiOff } from 'lucide-react';
import {
  GENERATED_ITEM_TYPE_LABELS_AR,
  GENERATION_DIFFICULTIES,
  GENERATION_DIFFICULTY_LABELS_AR,
  SIMULATION_LABEL_AR,
  SIMULATION_NOTICE_AR,
  type GenerationDifficulty,
  type SimulationListResponse,
  type SimulationPlanView,
  type SimulationRequest,
  type SimulationResponse,
  type SimulationRunView,
} from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Select, StatusPill, TextField, buttonClass } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import './exams.css';

const enc = encodeURIComponent;
export const simulationApi = {
  preview: (body: SimulationRequest) => api.post<{ plan: SimulationPlanView }>('/exams/simulations/preview', body, { timeoutMs: 30_000 }),
  create: (body: SimulationRequest) => api.post<SimulationResponse>('/exams/simulations', body, { timeoutMs: 30_000 }),
  get: (id: string) => api.get<SimulationResponse>(`/exams/simulations/${enc(id)}`),
  list: () => api.get<SimulationListResponse>('/exams/simulations'),
};

const TERMINAL = new Set(['completed', 'partial', 'abstained', 'failed']);
const EXTRA_ITEM_TYPES_AR: Record<string, string> = { clinical_feature: 'العلامات والأعراض', investigation: 'الفحوصات', recall: 'استرجاع معلومة' };
export const itemTypeLabelAr = (t: string) => EXTRA_ITEM_TYPES_AR[t] ?? (GENERATED_ITEM_TYPE_LABELS_AR as Record<string, string>)[t] ?? t;

/** Arabic number agreement: «سؤال واحد» / «سؤالان» / «5 أسئلة» / «12 سؤالًا». */
export const questionsAr = (n: number) => (n === 1 ? 'سؤال واحد' : n === 2 ? 'سؤالان' : n >= 3 && n <= 10 ? `${n} أسئلة` : `${n} سؤالًا`);

function tone(s: SimulationRunView['status']): 'success' | 'warning' | 'danger' | 'info' {
  return s === 'completed' ? 'success' : s === 'partial' || s === 'abstained' ? 'warning' : s === 'failed' ? 'danger' : 'info';
}

export function SimulationScreen() {
  usePageTitle(SIMULATION_LABEL_AR);
  const online = useOnline();
  const lib = useLibrary();
  const courses = useMemo(() => (lib.data?.nodes ?? []).filter((n) => n.kind === 'course' && !n.deleted_at), [lib.data]);
  const [params] = useSearchParams();
  const [course, setCourse] = useState(() => params.get('course_node_id') ?? '');
  const [count, setCount] = useState('6');
  const [minutes, setMinutes] = useState('');
  const [difficulty, setDifficulty] = useState<GenerationDifficulty>('hard');
  const [plan, setPlan] = useState<SimulationPlanView | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulationRunView | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<SimulationRunView[]>([]);

  const request = useMemo<SimulationRequest>(() => {
    const n = Math.max(2, Math.min(20, Number.parseInt(count, 10) || 2));
    const m = Number.parseInt(minutes, 10);
    return { count: n, difficulty, course_node_id: course || null, minutes: Number.isFinite(m) && m > 0 ? Math.min(300, m) : null };
  }, [count, difficulty, course, minutes]);

  // the plan is computed by the server WITHOUT AI — always available while online
  useEffect(() => {
    if (!online) return;
    let cancel = false;
    const t = setTimeout(() => {
      simulationApi
        .preview(request)
        .then((r) => {
          if (cancel) return;
          if (!r?.plan || !Array.isArray(r.plan.buckets)) throw new Error('bad response');
          setPlan(r.plan);
          setPlanError(null);
        })
        .catch((e) => !cancel && setPlanError(errorMessage(e, 'تعذّر حساب خطة المحاكاة.')));
    }, 250);
    return () => {
      cancel = true;
      clearTimeout(t);
    };
  }, [request, online]);

  useEffect(() => {
    if (!online) return;
    simulationApi
      .list()
      .then((r) => setRecent(r.simulations))
      .catch(() => undefined);
  }, [online]);

  // poll a running simulation (real job state, no fake progress)
  useEffect(() => {
    if (!sim || TERMINAL.has(sim.status)) return;
    const t = setTimeout(async () => {
      try {
        const r = await simulationApi.get(sim.id);
        setSim(r.simulation);
        if (TERMINAL.has(r.simulation.status)) setRecent((l) => [r.simulation, ...l.filter((x) => x.id !== r.simulation.id)]);
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [sim]);

  const submit = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const r = await simulationApi.create(request);
      setSim(r.simulation);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بدء المحاكاة.'));
    } finally {
      setSending(false);
    }
  }, [request]);

  const can = plan?.can_generate ?? { available: false, reason_ar: null };
  const reasonId = 'ex-sim-why';
  return (
    <div className="ml-page ex-page">
      <header className="ml-page__header ex-head">
        <div>
          <h1 className="ml-page__title">{SIMULATION_LABEL_AR}</h1>
          <p className="ml-page__lede">أسئلة مولدة من محاضراتك بتوزيع يتبع بصمة امتحاناتك (العينة التي رفعتها فقط).</p>
        </div>
        <div className="ml-cluster">
          <Link to="/review/dna" className={buttonClass({ variant: 'secondary' })}>
            بصمة امتحاناتك
          </Link>
          <Link to="/exams" className={buttonClass({ variant: 'plain' })}>
            السجل
          </Link>
        </div>
      </header>

      <p className="ex-note" role="note">
        <Info size={16} aria-hidden="true" /> {SIMULATION_NOTICE_AR}
      </p>
      {!online && (
        <p className="ex-note ex-note--warn" role="status">
          <WifiOff size={16} aria-hidden="true" /> حساب الخطة والتوليد يحتاجان اتصالًا بالخادم.
        </p>
      )}

      <form
        className="ex-builder"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="ex-fieldset" disabled={!online}>
          <legend>الطلب</legend>
          <div className="ex-grid">
            {courses.length > 0 && (
              <Select<string> label="الكورس" options={[{ value: '', label: 'كل مصادر الأسئلة' }, ...courses.map((c) => ({ value: c.id, label: c.title }))]} value={course} onValueChange={setCourse} />
            )}
            <TextField label="عدد الأسئلة (2–20)" type="number" min={2} max={20} value={count} onChange={(e) => setCount(e.target.value)} />
            <Select<GenerationDifficulty> label="الصعوبة المطلوبة" options={GENERATION_DIFFICULTIES.map((d) => ({ value: d, label: GENERATION_DIFFICULTY_LABELS_AR[d] }))} value={difficulty} onValueChange={setDifficulty} />
            <TextField label="الوقت بالدقائق (اختياري)" type="number" min={1} max={300} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </div>
        </fieldset>

        {planError && <ErrorState inline message={planError} />}
        {!plan && !planError && online && <LoadingState stage="جارٍ حساب التوزيع من عينتك…" />}
        {plan && <PlanView plan={plan} />}

        {plan && !can.available && (
          <p id={reasonId} className="ex-note ex-note--warn" role="note">
            <CircleAlert size={16} aria-hidden="true" /> {can.reason_ar}
          </p>
        )}
        {error && (
          <p className="ex-note ex-note--warn" role="alert">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          icon={<Sparkles size={16} />}
          loading={sending}
          disabled={!online || !plan || !can.available || (!!sim && !TERMINAL.has(sim.status))}
          aria-describedby={plan && !can.available ? reasonId : undefined}
        >
          ولّد المحاكاة وتحقق منها
        </Button>
      </form>

      {sim && <SimulationRun sim={sim} />}
      {recent.filter((r) => r.id !== sim?.id).length > 0 && (
        <section aria-labelledby="ex-sim-recent-h">
          <h2 id="ex-sim-recent-h" className="ex-subhead">
            محاكاة سابقة
          </h2>
          <ul className="ex-list">
            {recent
              .filter((r) => r.id !== sim?.id)
              .slice(0, 8)
              .map((r) => (
                <li key={r.id}>
                  <Button size="sm" variant="plain" onClick={() => setSim(r)}>
                    {`${r.label_ar} — ${r.status_label_ar}`}
                  </Button>{' '}
                  <span className="ex-muted">{r.summary_ar}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One row per lecture: the server splits a lecture's questions into parts by item type (same share). */
export function lectureRows(plan: SimulationPlanView) {
  const rows = new Map<string, { id: string; title: string; share: { unique: number; denominator: number }; count: number; types: string[] }>();
  for (const b of plan.buckets) {
    const r = rows.get(b.lecture_source_id) ?? { id: b.lecture_source_id, title: b.lecture_title, share: b.share, count: 0, types: [] };
    r.count += b.count;
    for (const t of b.item_types) if (!r.types.includes(t)) r.types.push(t);
    rows.set(b.lecture_source_id, r);
  }
  return [...rows.values()];
}

export function PlanView({ plan }: { plan: SimulationPlanView }) {
  const s = plan.sample;
  const rows = lectureRows(plan);
  return (
    <section className="ex-run" aria-labelledby="ex-sim-plan-h">
      <h2 id="ex-sim-plan-h" className="ex-subhead">
        خطة التوزيع
      </h2>
      <p className="ex-muted">
        {s.files === 0
          ? 'لا توجد مصادر أسئلة في العينة.'
          : `العينة: ${s.files === 1 ? 'ملف واحد' : `${s.files} ملفات`}، ${questionsAr(s.unique_questions)} دون تكرار، ${s.occurrences} ظهورًا مع التكرار.${s.date_range ? ` الفترة المعلومة: ${s.date_range}.` : ''}`}
      </p>
      <p className="ex-muted">{plan.counting_note_ar}</p>
      {plan.warnings_ar.length > 0 && (
        <ul className="ex-list" aria-label="حدود العينة">
          {plan.warnings_ar.map((w) => (
            <li key={w}>
              <CircleAlert size={14} aria-hidden="true" /> {w}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 ? (
        <div className="ex-table-wrap">
          <table className="ex-table">
            <caption className="ex-muted">كل صف جزء يُولَّد من محاضرته فقط؛ الحصة = أسئلة العينة المرتبطة بالمحاضرة من مقام الأسئلة الفريدة.</caption>
            <thead>
              <tr>
                <th scope="col">المحاضرة</th>
                <th scope="col">حصتها في العينة</th>
                <th scope="col">أسئلة مولدة</th>
                <th scope="col">الأنواع</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <BidiText as="span" text={r.title} />
                  </th>
                  <td>{`${r.share.unique} من ${r.share.denominator}`}</td>
                  <td>{r.count}</td>
                  <td>{r.types.length ? r.types.map(itemTypeLabelAr).join('، ') : 'دون تحديد'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ex-muted">لا يوجد توزيع صالح بعد: اربط أسئلة مصادرك بمحاضرات معالجة أولًا.</p>
      )}
      {plan.item_types.length > 0 && (
        <p className="ex-muted">{`أنواع العينة: ${plan.item_types.map((t) => `${itemTypeLabelAr(t.item_type)} ${t.count} من ${t.denominator}`).join('، ')}`}</p>
      )}
      {plan.excluded.length > 0 && (
        <details className="ex-details">
          <summary>{`محاضرات من العينة لم تدخل الخطة (${plan.excluded.length})`}</summary>
          <ul className="ex-list">
            {plan.excluded.map((x) => (
              <li key={x.lecture_source_id}>
                <BidiText as="span" text={x.title} /> — {x.reason_ar}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function SimulationRun({ sim }: { sim: SimulationRunView }) {
  const running = !TERMINAL.has(sim.status);
  return (
    <section className="ex-run" aria-labelledby="ex-sim-run-h" aria-live="polite">
      <h2 id="ex-sim-run-h" className="ex-subhead">
        {sim.label_ar}
      </h2>
      <div className="ml-cluster">
        <StatusPill tone={tone(sim.status)}>{sim.status_label_ar}</StatusPill>
      </div>
      <p className="ex-muted" role="note">
        {sim.notice_ar}
      </p>
      {running && sim.job?.progress && (
        <p className="ex-muted">
          {sim.job.progress.stage}
          {sim.job.progress.total ? ` — ${sim.job.progress.done ?? 0} من ${sim.job.progress.total}` : ''}
        </p>
      )}
      <p>{sim.summary_ar}</p>
      {sim.parts.length > 0 && (
        <ol className="ex-items">
          {sim.parts.map((p) => (
            <li key={`${p.bucket_index}-${p.run_id ?? 'x'}`} className="ex-item">
              <div className="ml-cluster">
                <strong>
                  <BidiText as="span" text={p.lecture_title} />
                </strong>
                <span className="ex-muted">{p.status_label_ar}</span>
              </div>
              <p className="ex-muted">{`طُلب ${p.requested}، نُشر بعد التحقق ${p.published}.`}</p>
            </li>
          ))}
        </ol>
      )}
      {sim.exam && (
        <div className="ml-cluster">
          <Link className={buttonClass({ variant: 'primary' })} to={`/exams/${enc(sim.exam.attempt_id)}`}>
            ابدأ المحاكاة
          </Link>
          <span className="ex-muted">{`${questionsAr(sim.exam.items)}، المولد منها ${sim.exam.generated_items} — كلها مولدة ومتحقق منها.`}</span>
        </div>
      )}
    </section>
  );
}
