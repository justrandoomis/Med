// Exam Builder (§39): scope (courses, lectures, question sources), count, time, estimated difficulty, question
// types, original vs generated mix, «أخطائي», «من محاضرتي فقط». A live server preview shows how many items match,
// how many are scorable and WHY items are left out (unresolved keys, duplicates, written types, …) — real counts.
// The policy (pause, hints, shuffling, Anti-shortcut) is chosen here and is fixed for the whole attempt.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ClipboardCheck, Sparkles, WifiOff } from 'lucide-react';
import {
  EXAM_MODES,
  EXAM_MODE_LABELS_AR,
  MCQ_QUESTION_TYPES,
  isAssessedMode,
  newId,
  type ExamBuildReport,
  type ExamCreateRequest,
  type ExamMode,
  type QuestionType,
  type SourceSummary,
} from '@medlevo/shared';
import { Button, Checkbox, ErrorState, Select, StatusPill, Switch, TextField, buttonClass, type SelectOption } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { useLibrary } from '../library/useLibrary';
import { examsApi } from './api';
import { MixedLine } from './MixedLine';
import { questionsAr } from './model';
import './exams.css';

const MODE_HELP_AR: Record<ExamMode, string> = {
  practice: 'سؤال بسؤال مع تلميحات متدرجة وتصحيح فوري بعد كل إجابة. الأسئلة غير المحسومة تظهر مع سبب عدم احتسابها.',
  exam: 'لا تلميحات ولا حلول قبل الإنهاء، وأسئلة محسوبة فقط.',
  time_pressure: 'زمن لكل سؤال، يقارن أداءك بالوقت المتاح دون أن يجزم بسبب التأخر. لا إيقاف مؤقت.',
  simulation: 'محاكاة امتحان محسوبة بمؤقت كلي. إن تضمنت أسئلة مولدة تُوسم محاكاةً مولدة، لا نسخة متوقعة من الامتحان.',
  revision: 'مراجعة هادئة مع تصحيح بعد كل سؤال.',
};

const QTYPE_LABELS_AR: Partial<Record<QuestionType, string>> = { sba: 'إجابة واحدة أفضل (SBA)', multi_select: 'اختيار متعدد', true_false: 'صح / خطأ' };

type MixKey = 'all' | 'source' | 'generated' | 'half' | 'mostly_source';
const MIX: Record<MixKey, { label: string; value?: { source: number; generated: number } }> = {
  all: { label: 'كل الأسئلة المتاحة' },
  source: { label: 'أصلية فقط (من مصادرك)', value: { source: 1, generated: 0 } },
  generated: { label: 'مولدة فقط', value: { source: 0, generated: 1 } },
  half: { label: 'نصف أصلية ونصف مولدة', value: { source: 1, generated: 1 } },
  mostly_source: { label: 'غالبًا أصلية (3 : 1)', value: { source: 3, generated: 1 } },
};

const QUESTION_SOURCE_TYPES = new Set(['question_source', 'previous_exam']);

export function BuilderScreen() {
  usePageTitle('اختبار جديد');
  const navigate = useNavigate();
  const online = useOnline();
  const caps = useCapabilities();
  const lib = useLibrary();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<ExamMode>('practice');
  const [courses, setCourses] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [count, setCount] = useState('10');
  const [minutes, setMinutes] = useState('');
  const [perQ, setPerQ] = useState('60');
  const [difficulty, setDifficulty] = useState<'any' | 'easy' | 'medium' | 'hard'>('any');
  const [qtypes, setQtypes] = useState<QuestionType[]>(['sba', 'multi_select', 'true_false']);
  const [mix, setMix] = useState<MixKey>('all');
  const [mistakes, setMistakes] = useState(false);
  const [lectureOnly, setLectureOnly] = useState(false);
  const [pauseAllowed, setPauseAllowed] = useState<boolean | null>(null);
  const [hints, setHints] = useState(true);
  const [shuffle, setShuffle] = useState<boolean | null>(null);
  const [anti, setAnti] = useState(false);
  const [report, setReport] = useState<ExamBuildReport | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const attemptId = useRef(newId());

  const assessed = isAssessedMode(mode);
  const index = lib.index;
  const courseNodes = useMemo(() => [...(index?.nodes.values() ?? [])].filter((n) => n.kind === 'course' && !n.deleted_at && !n.archived_at), [index]);
  const allSources = useMemo(() => [...(index?.sources.values() ?? [])].filter((s) => !s.deleted_at), [index]);
  const visibleSources = useMemo(() => (courses.length ? allSources.filter((s) => s.course_node_id && courses.includes(s.course_node_id)) : allSources), [allSources, courses]);
  const lectures = visibleSources.filter((s) => !QUESTION_SOURCE_TYPES.has(s.source_type));
  const questionSources = visibleSources.filter((s) => QUESTION_SOURCE_TYPES.has(s.source_type));
  const lectureChosen = sources.some((id) => lectures.some((l) => l.id === id));

  const request = useMemo<ExamCreateRequest>(() => {
    const n = Math.max(1, Math.min(200, Number.parseInt(count, 10) || 10));
    const req: ExamCreateRequest = {
      title: title.trim(),
      mode,
      count: n,
      qtypes,
      difficulty,
      include_my_mistakes: mistakes,
      lecture_only_answerable: lectureOnly && lectureChosen,
      policy: {
        ...(pauseAllowed !== null && mode !== 'time_pressure' ? { pause_allowed: pauseAllowed } : {}),
        ...(shuffle !== null ? { shuffle_options: shuffle } : {}),
        ...(!assessed ? { hints: hints ? 'progressive' : 'off', anti_shortcut: anti } : {}),
      },
    };
    if (courses.length) req.course_node_ids = courses;
    if (sources.length) req.source_ids = sources;
    if (minutes.trim()) req.minutes = Math.max(1, Number(minutes));
    if (mode === 'time_pressure') req.per_question_seconds = Math.max(10, Number.parseInt(perQ, 10) || 60);
    if (MIX[mix].value) req.origin_mix = MIX[mix].value;
    return req;
  }, [title, mode, count, qtypes, difficulty, mistakes, lectureOnly, lectureChosen, pauseAllowed, shuffle, assessed, hints, anti, courses, sources, minutes, perQ, mix]);

  // live preview (debounced) — what would be selected and why the rest is left out
  useEffect(() => {
    if (!online) return;
    const t = setTimeout(async () => {
      try {
        setPreviewError(null);
        setReport((await examsApi.preview(request)).report);
      } catch (e) {
        setPreviewError(errorMessage(e, 'تعذّرت المعاينة.'));
      }
    }, 350);
    return () => clearTimeout(t);
  }, [request, online]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const r = await examsApi.create({ ...request, attempt_id: attemptId.current });
      navigate(`/exams/${encodeURIComponent(r.session.attempt.id)}`);
    } catch (e) {
      if (isApiError(e) && e.status === 409 && (e.details as { report?: ExamBuildReport } | undefined)?.report) setReport((e.details as { report: ExamBuildReport }).report);
      setCreateError(errorMessage(e, 'تعذّر إنشاء الاختبار.'));
      attemptId.current = newId();
    } finally {
      setCreating(false);
    }
  };

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const gen = caps.feature('ai.generate_questions');
  const modeOptions: SelectOption<ExamMode>[] = EXAM_MODES.map((m) => ({ value: m, label: EXAM_MODE_LABELS_AR[m] }));

  return (
    <div className="ml-page ex-page">
      <header className="ml-page__header ex-head">
        <div>
          <h1 className="ml-page__title">اختبار جديد</h1>
          <p className="ml-page__lede">اختر النطاق والأسئلة وطريقة الاختبار. سياسة الاختبار تُثبَّت عند إنشائه ولا تتغير أثناء المحاولة.</p>
        </div>
        <div className="ml-cluster">
          <Link to="/exams" className={buttonClass({ variant: 'secondary' })}>
            سجل الاختبارات
          </Link>
          {gen.available ? (
            <Link to="/exams/generate" className={buttonClass({ variant: 'secondary' })}>
              <Sparkles size={16} aria-hidden="true" />
              توليد أسئلة صعبة
            </Link>
          ) : (
            <span className="ex-gated">
              <Button variant="secondary" icon={<Sparkles size={16} />} disabled aria-describedby="ex-gen-why">
                توليد أسئلة صعبة
              </Button>
              <span id="ex-gen-why" className="ex-muted">
                {gen.reason}
              </span>
            </span>
          )}
        </div>
      </header>

      {!online && (
        <p className="ex-note ex-note--warn" role="status">
          <WifiOff size={16} aria-hidden="true" /> إنشاء اختبار جديد يحتاج اتصالًا بالخادم. الاختبارات التي فتحتها سابقًا تعمل دون اتصال من «سجل الاختبارات».
        </p>
      )}

      <form
        className="ex-builder"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <fieldset className="ex-fieldset">
          <legend>الطريقة</legend>
          <TextField label="العنوان (اختياري)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={EXAM_MODE_LABELS_AR[mode]} maxLength={200} />
          <Select<ExamMode> label="الوضع" hint={MODE_HELP_AR[mode]} options={modeOptions} value={mode} onValueChange={setMode} />
          <div className="ex-grid">
            <TextField label="عدد الأسئلة" type="number" inputMode="numeric" min={1} max={200} value={count} onChange={(e) => setCount(e.target.value)} />
            <TextField label="الوقت الكلي بالدقائق (اختياري)" type="number" inputMode="numeric" min={1} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            {mode === 'time_pressure' && (
              <TextField label="ثوانٍ لكل سؤال" type="number" inputMode="numeric" min={10} max={1800} value={perQ} onChange={(e) => setPerQ(e.target.value)} />
            )}
          </div>
        </fieldset>

        <fieldset className="ex-fieldset">
          <legend>النطاق</legend>
          {lib.error && !lib.data && <ErrorState inline message="تعذّر تحميل المكتبة." onRetry={() => void lib.refresh()} />}
          {courseNodes.length > 0 && (
            <div className="ex-checks" role="group" aria-label="الكورسات">
              <p className="ex-group-label">الكورسات</p>
              {courseNodes.map((c) => (
                <Checkbox key={c.id} label={c.title} checked={courses.includes(c.id)} onCheckedChange={() => setCourses((l) => toggle(l, c.id))} />
              ))}
            </div>
          )}
          <SourceChecks title="المحاضرات والمراجع" items={lectures} selected={sources} onToggle={(id) => setSources((l) => toggle(l, id))} />
          <SourceChecks title="مصادر الأسئلة والامتحانات السابقة" items={questionSources} selected={sources} onToggle={(id) => setSources((l) => toggle(l, id))} />
          <Switch
            label="من محاضرتي فقط"
            description={lectureChosen ? 'الأسئلة التي يمكن حلها من المحاضرات المختارة فقط (حسب ربطها بها).' : 'اختر محاضرة أولًا لتفعيل هذا الخيار.'}
            checked={lectureOnly && lectureChosen}
            disabled={!lectureChosen}
            onCheckedChange={setLectureOnly}
          />
          <Switch label="أضف أخطائي" description="الأسئلة التي كانت آخر إجابة محسوبة لك عليها خاطئة تأتي أولًا." checked={mistakes} onCheckedChange={setMistakes} />
        </fieldset>

        <fieldset className="ex-fieldset">
          <legend>الأسئلة</legend>
          <div className="ex-checks" role="group" aria-label="أنواع الأسئلة">
            <p className="ex-group-label">الأنواع</p>
            {MCQ_QUESTION_TYPES.map((q) => (
              <Checkbox key={q} label={QTYPE_LABELS_AR[q] ?? q} checked={qtypes.includes(q)} onCheckedChange={() => setQtypes((l) => (l.includes(q) && l.length === 1 ? l : toggle(l, q)))} />
            ))}
            <p className="ex-muted">الأسئلة المقالية والقصيرة تُحل في صفحة الإجابة المكتوبة.</p>
          </div>
          <div className="ex-grid">
            <Select<'any' | 'easy' | 'medium' | 'hard'>
              label="الصعوبة"
              hint="تقديرية: من تقدير السؤال المولد أو من أدائك السابق، لا معيارًا رسميًا."
              options={[
                { value: 'any', label: 'أي صعوبة' },
                { value: 'easy', label: 'سهلة' },
                { value: 'medium', label: 'متوسطة' },
                { value: 'hard', label: 'صعبة' },
              ]}
              value={difficulty}
              onValueChange={setDifficulty}
            />
            <Select<MixKey> label="الأسئلة الأصلية والمولدة" options={(Object.keys(MIX) as MixKey[]).map((k) => ({ value: k, label: MIX[k].label }))} value={mix} onValueChange={setMix} />
          </div>
        </fieldset>

        <fieldset className="ex-fieldset">
          <legend>سياسة الاختبار (ثابتة بعد الإنشاء)</legend>
          {mode !== 'time_pressure' && (
            <Switch
              label="السماح بالإيقاف المؤقت"
              description={assessed ? 'غير مسموح افتراضيًا في الاختبار المحسوب.' : 'مسموح افتراضيًا في التدريب.'}
              checked={pauseAllowed ?? !assessed}
              onCheckedChange={setPauseAllowed}
            />
          )}
          <Switch label="خلط ترتيب الخيارات" description="الأسئلة التي تعتمد على الترتيب («جميع ما سبق») لا تُخلط أبدًا." checked={shuffle ?? assessed} onCheckedChange={setShuffle} />
          {!assessed && (
            <>
              <Switch label="تلميحات متدرجة" description="تلميح يشير إلى موضع الفكرة، ثم تلميح أعمق للكلمات المفتاحية، ثم الحل." checked={hints} onCheckedChange={setHints} />
              <Switch label="وضع منع الاختصار" description="لا يظهر زر الحل حتى تختار إجابة." checked={anti} onCheckedChange={setAnti} />
            </>
          )}
          {assessed && <p className="ex-muted">في الوضع المحسوب: لا تلميحات، والحلول والأدلة بعد الإنهاء فقط.</p>}
        </fieldset>

        <section className="ex-preview" aria-labelledby="ex-preview-h" aria-live="polite">
          <h2 id="ex-preview-h" className="ex-subhead">
            <ClipboardCheck size={18} aria-hidden="true" /> ما سيدخل الاختبار
          </h2>
          {previewError && <p className="ex-note ex-note--warn">{previewError}</p>}
          {report ? <ReportView report={report} assessed={assessed} /> : <p className="ex-muted">{online ? 'جارٍ حساب المعاينة…' : 'المعاينة تحتاج اتصالًا.'}</p>}
        </section>

        {createError && (
          <p className="ex-note ex-note--warn" role="alert">
            {createError}
          </p>
        )}
        <div className="ml-cluster">
          <Button type="submit" variant="primary" loading={creating} loadingLabel="جارٍ إنشاء الاختبار…" disabled={!online || (report !== null && report.selected === 0)}>
            ابدأ {EXAM_MODE_LABELS_AR[mode]}
          </Button>
        </div>
      </form>
    </div>
  );
}

function SourceChecks({ title, items, selected, onToggle }: { title: string; items: SourceSummary[]; selected: string[]; onToggle: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ex-checks" role="group" aria-label={title}>
      <p className="ex-group-label">{title}</p>
      {items.map((s) => (
        <Checkbox key={s.id} label={<MixedLine text={s.title} />} checked={selected.includes(s.id)} onCheckedChange={() => onToggle(s.id)} />
      ))}
    </div>
  );
}

export function ReportView({ report: r, assessed }: { report: ExamBuildReport; assessed: boolean }) {
  return (
    <div className="ex-report">
      <p>
        <strong>{questionsAr(r.selected)}</strong> من {r.requested} مطلوبة — {r.selected_scored} محسوبة
        {r.selected_unscored > 0 && `، ${r.selected_unscored} للتدريب غير المحسوب`}.
      </p>
      <ul className="ex-list">
        <li>مطابقة للنطاق: {r.matched} (بعد دمج المواضع المتكررة للسؤال نفسه)</li>
        <li>
          قابلة للاحتساب: {r.scorable}، غير قابلة: {r.unscorable}
          {assessed && r.unscorable > 0 && ' — لا تدخل الاختبار المحسوب'}
        </li>
        <li>
          حسب الأصل: أصلية {r.by_origin.source}، مولدة {r.by_origin.generated}، أضفتها بنفسك {r.by_origin.owner}
        </li>
        {r.my_mistakes > 0 && <li>من أخطائي في النطاق: {r.my_mistakes}</li>}
      </ul>
      {r.exclusions.length > 0 && (
        <>
          <p className="ex-group-label">ما استُبعد ولماذا</p>
          <ul className="ex-list">
            {r.exclusions.map((x) => (
              <li key={x.code}>
                <StatusPill tone={x.code === 'unscorable' ? 'warning' : 'neutral'} icon={false}>
                  {x.count}
                </StatusPill>{' '}
                {x.reason_ar}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.notes_ar.map((n, i) => (
        <p key={i} className="ex-muted">
          {n}
        </p>
      ))}
    </div>
  );
}
