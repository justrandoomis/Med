// Generated hard MCQs (§37–§38, AC-18; capability ai.generate_questions). The owner picks a lecture and pages or a
// topic, the count, difficulty and item types; the server generates from evidence inside the Source Lock, validates
// every item deterministically, by an independent validator and claim by claim, repairs at most twice, and sends
// failing items to the review queue — never to the vault. Abstentions say why and what to change.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, CircleCheck, CircleX, Sparkles, WifiOff } from 'lucide-react';
import {
  GENERATED_ITEM_TYPES,
  GENERATED_ITEM_TYPE_LABELS_AR,
  GENERATION_DIFFICULTIES,
  GENERATION_DIFFICULTY_LABELS_AR,
  type GeneratedItemType,
  type GenerationDifficulty,
  type GenerationRunView,
  type SourcePageView,
} from '@medlevo/shared';
import { Button, Checkbox, Select, StatusPill, Switch, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { useLibrary } from '../library/useLibrary';
import { examsApi } from './api';
import { MixedLine } from './MixedLine';
import './exams.css';

const QUESTION_SOURCE_TYPES = new Set(['question_source', 'previous_exam']);
const TERMINAL = new Set(['completed', 'partial', 'needs_review', 'abstained', 'failed']);

function pageLabel(p: SourcePageView): string {
  const file = p.page_index + 1;
  return p.printed_label && p.printed_label !== String(file) ? `ص ${p.printed_label} (الصفحة ${file} في الملف)` : `ص ${file}`;
}

export function GenerateScreen() {
  usePageTitle('توليد أسئلة صعبة');
  const caps = useCapabilities();
  const gate = caps.feature('ai.generate_questions');
  const online = useOnline();
  const lib = useLibrary();
  const lectures = useMemo(() => [...(lib.index?.sources.values() ?? [])].filter((s) => !s.deleted_at && !QUESTION_SOURCE_TYPES.has(s.source_type) && s.active_version_id), [lib.index]);
  const [lectureId, setLectureId] = useState('');
  const [pages, setPages] = useState<SourcePageView[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState('3');
  const [difficulty, setDifficulty] = useState<GenerationDifficulty>('hard');
  const [types, setTypes] = useState<GeneratedItemType[]>([]);
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [withRefs, setWithRefs] = useState(false);
  const [run, setRun] = useState<GenerationRunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [recent, setRecent] = useState<GenerationRunView[]>([]);

  const lecture = lectures.find((l) => l.id === lectureId) ?? null;

  useEffect(() => {
    setPages([]);
    setPageIds([]);
    if (!lecture?.active_version_id) return;
    let cancel = false;
    examsApi
      .pages(lecture.id, lecture.active_version_id)
      .then((r) => !cancel && setPages(r.pages))
      .catch(() => !cancel && setPages([]));
    examsApi
      .runs(lecture.id)
      .then((r) => !cancel && setRecent(r.runs))
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [lecture?.id, lecture?.active_version_id]);

  // poll a running request (real job state, no fake progress)
  useEffect(() => {
    if (!run || TERMINAL.has(run.status)) return;
    const t = setTimeout(async () => {
      try {
        setRun((await examsApi.run(run.id)).run);
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [run]);

  const submit = useCallback(async () => {
    if (!lecture) return;
    setSending(true);
    setError(null);
    try {
      const r = await examsApi.generate({
        lecture_source_id: lecture.id,
        scope: withRefs ? { mode: 'lecture_plus_references', lecture_source_id: lecture.id, reference_source_ids: [], version_pins: {}, include_my_notes: false } : null,
        topic: topic.trim() || null,
        page_ids: pageIds,
        count: Math.max(1, Math.min(5, Number.parseInt(count, 10) || 1)),
        difficulty,
        item_types: types,
        language,
      });
      setRun(r.run);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بدء التوليد.'));
    } finally {
      setSending(false);
    }
  }, [lecture, withRefs, topic, pageIds, count, difficulty, types, language]);

  const toggle = <T,>(l: T[], v: T) => (l.includes(v) ? l.filter((x) => x !== v) : [...l, v]);
  const blocked = !gate.available || !online;

  return (
    <div className="ml-page ex-page">
      <header className="ml-page__header ex-head">
        <div>
          <h1 className="ml-page__title">توليد أسئلة صعبة من محاضرتك</h1>
          <p className="ml-page__lede">
            أسئلة <bdi dir="ltr">USMLE-style</bdi> من الأدلة داخل نطاق المصادر المحدد فقط — ليست رسمية ولا مكافئة لامتحان. كل سؤال يمر بتحقق مستقل قبل نشره في خزنتك موسومًا «سؤال مولد».
          </p>
        </div>
        <Link to="/exams" className={buttonClass({ variant: 'secondary' })}>
          السجل
        </Link>
      </header>

      {!gate.available && (
        <p className="ex-note ex-note--warn" role="status">
          <CircleAlert size={16} aria-hidden="true" /> {gate.reason}
        </p>
      )}
      {gate.available && !online && (
        <p className="ex-note ex-note--warn" role="status">
          <WifiOff size={16} aria-hidden="true" /> توليد الأسئلة يحتاج اتصالًا بالخادم.
        </p>
      )}

      <form
        className="ex-builder"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="ex-fieldset" disabled={blocked}>
          <legend>المصدر</legend>
          <Select<string>
            label="المحاضرة"
            options={[{ value: '', label: lectures.length ? 'اختر محاضرة' : 'لا توجد محاضرات معالجة' }, ...lectures.map((l) => ({ value: l.id, label: l.title }))]}
            value={lectureId}
            onValueChange={setLectureId}
          />
          {pages.length > 0 && (
            <div className="ex-checks ex-checks--pages" role="group" aria-label="صفحات المحاضرة">
              <p className="ex-group-label">الصفحات (اختر صفحة أو أكثر، أو اكتب موضوعًا)</p>
              {pages.slice(0, 80).map((p) => (
                <Checkbox key={p.id} label={pageLabel(p)} checked={pageIds.includes(p.id)} onCheckedChange={() => setPageIds((l) => (l.length >= 10 && !l.includes(p.id) ? l : toggle(l, p.id)))} />
              ))}
            </div>
          )}
          <TextField label="الموضوع (اختياري)" hint="مثل: التشخيص التفريقي لألم الحفرة الحرقفية اليمنى" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} />
          <Switch label="المحاضرة + مراجعها" description="الافتراضي: المحاضرة فقط. التوسيع اختيار صريح منك، ويظهر في نطاق كل سؤال." checked={withRefs} onCheckedChange={setWithRefs} />
        </fieldset>
        <fieldset className="ex-fieldset" disabled={blocked}>
          <legend>الأسئلة</legend>
          <div className="ex-grid">
            <TextField label="العدد (1–5)" type="number" min={1} max={5} value={count} onChange={(e) => setCount(e.target.value)} />
            <Select<GenerationDifficulty> label="الصعوبة المطلوبة" hint="تقديرية؛ إن لم تكفِ الأدلة يمتنع التوليد ويقترح البديل." options={GENERATION_DIFFICULTIES.map((d) => ({ value: d, label: GENERATION_DIFFICULTY_LABELS_AR[d] }))} value={difficulty} onValueChange={setDifficulty} />
            <Select<'en' | 'ar'>
              label="لغة السؤال"
              options={[
                { value: 'en', label: 'الإنجليزية' },
                { value: 'ar', label: 'العربية (المصطلحات بالإنجليزية)' },
              ]}
              value={language}
              onValueChange={setLanguage}
            />
          </div>
          <div className="ex-checks" role="group" aria-label="أنواع الأسئلة">
            <p className="ex-group-label">الأنواع (اختياري)</p>
            {GENERATED_ITEM_TYPES.map((t) => (
              <Checkbox key={t} label={GENERATED_ITEM_TYPE_LABELS_AR[t]} checked={types.includes(t)} onCheckedChange={() => setTypes((l) => toggle(l, t))} />
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="ex-note ex-note--warn" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" icon={<Sparkles size={16} />} loading={sending} disabled={blocked || !lecture || (!topic.trim() && pageIds.length === 0)}>
          ولّد وتحقق
        </Button>
        {lecture && !topic.trim() && pageIds.length === 0 && <p className="ex-muted">اختر صفحات أو اكتب موضوعًا؛ لا يُولَّد سؤال من «المحاضرة كلها» دون تحديد.</p>}
      </form>

      {run && <RunView run={run} />}
      {recent.length > 0 && (
        <section aria-labelledby="ex-recent-h">
          <h2 id="ex-recent-h" className="ex-subhead">
            طلبات سابقة لهذه المحاضرة
          </h2>
          <ul className="ex-list">
            {recent.slice(0, 10).map((r) => (
              <li key={r.id}>
                <Button size="sm" variant="plain" onClick={() => setRun(r)}>
                  {r.status_label_ar}
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

export function RunView({ run }: { run: GenerationRunView }) {
  const running = !TERMINAL.has(run.status);
  const published = run.candidates.filter((c) => c.status === 'published' && c.question_id);
  return (
    <section className="ex-run" aria-labelledby="ex-run-h" aria-live="polite">
      <h2 id="ex-run-h" className="ex-subhead">
        {run.status_label_ar}
      </h2>
      <p className="ex-muted">
        النطاق: <MixedLine text={run.scope_describe_ar} />
      </p>
      {running && run.job?.progress && (
        <p className="ex-muted">
          {run.job.progress.stage}
          {run.job.progress.total ? ` — ${run.job.progress.done ?? 0} من ${run.job.progress.total}` : ''}
        </p>
      )}
      <p>{run.summary_ar}</p>
      {run.abstain && (
        <div className="ex-note ex-note--warn" role="note">
          <p>
            <strong>{run.abstain.reason_ar}</strong>
          </p>
          <p>
            <MixedLine text={run.abstain.detail} />
          </p>
          <p>{run.abstain.suggestion_ar}</p>
        </div>
      )}
      {run.candidates.length > 0 && (
        <ol className="ex-items">
          {run.candidates.map((c) => (
            <li key={c.id} className="ex-item">
              <div className="ml-cluster">
                {c.status === 'published' ? (
                  <StatusPill tone="success" icon={<CircleCheck size={14} />}>
                    نُشر بعد التحقق
                  </StatusPill>
                ) : c.status === 'needs_review' ? (
                  <StatusPill tone="warning" icon={<CircleAlert size={14} />}>
                    في قائمة المراجعة — لم يُنشر
                  </StatusPill>
                ) : (
                  <StatusPill tone="danger" icon={<CircleX size={14} />}>
                    مرفوض
                  </StatusPill>
                )}
                <span className="ex-muted">جولات التوليد والإصلاح: {c.rounds}</span>
                {c.difficulty_est && <span className="ex-muted">الصعوبة (تقدير): {GENERATION_DIFFICULTY_LABELS_AR[c.difficulty_est as GenerationDifficulty] ?? c.difficulty_est}</span>}
              </div>
              <p>
                <MixedLine text={c.stem_preview} />
              </p>
              {c.issues.length > 0 && (
                <ul className="ex-list">
                  {c.issues.map((i, k) => (
                    <li key={k}>
                      <MixedLine text={i.reason_ar} />
                    </li>
                  ))}
                </ul>
              )}
              {c.question_id && (
                <div className="ml-cluster">
                  <Link className="ex-link" to={`/questions/${encodeURIComponent(c.question_id)}`}>
                    افتح في الخزنة
                  </Link>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {published.length > 0 && (
        <Link className={buttonClass({ variant: 'primary' })} to={`/practice?question_id=${encodeURIComponent(published[0]!.question_id!)}`}>
          تدرّب على السؤال الأول
        </Link>
      )}
    </section>
  );
}
