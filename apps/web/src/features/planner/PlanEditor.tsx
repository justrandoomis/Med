// /planner/new and /planner/:id/edit — plan inputs (§45): exam date, lectures, available weekdays, daily minutes,
// blocked dates, what the plan includes. «معاينة» shows the server's deterministic plan and its feasibility (what does
// not fit is listed, never squeezed into the last day). Editing builds a NEW plan from the changed inputs and archives
// the old one (its check-offs stay in the archived plan) — said before saving.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, CircleAlert, CircleCheck, Eye, Plus, Save, X } from 'lucide-react';
import type { PlanPreviewResponse, StudyPlanConfig, StudyPlanView } from '@medlevo/shared';
import { Button, Checkbox, ErrorState, IconButton, LoadingState, Switch, TextField, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { useSettings } from '../../lib/settings';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import { learningApi } from '../review/api';
import { planUrl } from '../review/links';
import { WEEKDAYS_AR, dayLabelAr, dayOf, daysCountAr, minutesAr } from '../review/local/time';
import { DayList } from './DayList';
import { configProblems, emptyConfig } from './model';
import '../review/learning.css';
import './planner.css';

const INCLUDE: Array<{ key: keyof StudyPlanConfig['include']; label: string; hint: string }> = [
  { key: 'learn', label: 'تعلّم المحاضرات', hint: 'تقسيم الصفحات على الأيام (4 دقائق للصفحة تقديرًا).' },
  { key: 'review', label: 'مراجعات متباعدة', hint: 'بعد يوم و3 و7 أيام من إنهاء المحاضرة.' },
  { key: 'mcq', label: 'أسئلة', hint: 'للمحاضرات التي لها أسئلة مرتبطة.' },
  { key: 'flashcards', label: 'البطاقات المستحقة', hint: 'وقت يومي للمراجعة المتباعدة.' },
  { key: 'weakness', label: 'نقاط الضعف', hint: 'مراجعة مخصّصة كل ثلاثة أيام.' },
];
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5];

export function PlanEditor() {
  const { id } = useParams();
  usePageTitle(id ? 'تعديل الخطة' : 'خطة جديدة');
  const navigate = useNavigate();
  const caps = useCapabilities();
  const toast = useToast();
  const { settings } = useSettings();
  const today = dayOf(Date.now(), settings.timezone || 'Asia/Baghdad');
  const lib = useLibrary();
  const [cfg, setCfg] = useState<StudyPlanConfig>(() => emptyConfig(today));
  const [old, setOld] = useState<StudyPlanView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState('');
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<PlanPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!id) return;
    void learningApi
      .plan(id)
      .then((p) => {
        setOld(p);
        setCfg({ ...p.config, title: p.config.title });
      })
      .catch((e) => setLoadError(errorMessage(e, 'تعذّر تحميل الخطة.')));
  }, [id]);

  // any change invalidates the preview
  useEffect(() => setPreview(null), [cfg]);

  const sources = useMemo(() => {
    const nodes = new Map((lib.data?.nodes ?? []).map((n) => [n.id, n]));
    const list = (lib.data?.sources ?? []).filter((s) => !s.deleted_at && !s.archived_at && s.source_type !== 'question_source' && s.source_type !== 'previous_exam');
    const groups = new Map<string, { title: string; items: typeof list }>();
    for (const s of list) {
      const key = s.course_node_id ?? s.node_id ?? '';
      const title = nodes.get(key)?.title ?? 'بلا كورس';
      const g = groups.get(key) ?? { title, items: [] };
      g.items.push(s);
      groups.set(key, g);
    }
    return [...groups.values()];
  }, [lib.data]);

  const problems = configProblems(cfg, today);
  const set = <K extends keyof StudyPlanConfig>(k: K, v: StudyPlanConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const toggleSource = (sid: string, on: boolean) => set('source_ids', on ? [...cfg.source_ids, sid] : cfg.source_ids.filter((x) => x !== sid));

  const doPreview = async () => {
    setTried(true);
    if (problems.length) return;
    setBusy('preview');
    setError(null);
    try {
      setPreview(await learningApi.previewPlan(cfg));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بناء المعاينة.'));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setTried(true);
    if (problems.length) return;
    setBusy('save');
    setError(null);
    try {
      const plan = await learningApi.createPlan(cfg);
      let archivedOld = true;
      if (old && old.status === 'active') archivedOld = await learningApi.archivePlan(old.id).then(() => true, () => false);
      if (!old) toast.show({ title: 'أُنشئت الخطة.', tone: 'success' });
      else if (archivedOld) toast.show({ title: 'بُنيت الخطة الجديدة وأُرشفت السابقة بما أنجزته فيها.', tone: 'success' });
      // never claim the old plan was archived when it was not: both stay active until the owner archives it
      else toast.show({ title: 'بُنيت الخطة الجديدة، لكن تعذّرت أرشفة الخطة السابقة فبقيت نشطة؛ أرشفها من صفحتها.', tone: 'warning' });
      navigate(planUrl(plan.id), { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ الخطة.'));
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <div className="ml-page lw-page"><ErrorState message={loadError} /></div>;
  if (id && !old) return <div className="ml-page lw-page"><LoadingState stage="جارٍ تحميل الخطة…" /></div>;
  const needle = filter.trim().toLowerCase();

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">{old ? 'تعديل الخطة' : 'خطة دراسة جديدة'}</h1>
          <p className="ml-page__lede">{old ? 'غيّر المدخلات ثم عاين الخطة الجديدة. عند الحفظ تُبنى خطة جديدة وتُؤرشف الحالية بما أنجزته فيها.' : 'المدخلات أدناه فقط؛ الخطة نفسها تُحسب بقواعد ثابتة وتظهر قبل الحفظ.'}</p>
        </div>
        <Link to={old ? planUrl(old.id) : '/planner'} className={buttonClass({ variant: 'plain' })}>
          <ArrowRight size={16} aria-hidden="true" />
          رجوع
        </Link>
      </header>

      <div className="lw-editor">
        <form
          className="lw-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void doPreview();
          }}
        >
          <section className="lw-sheet" aria-labelledby="pl-basic">
            <h2 id="pl-basic" className="lw-sheet__title">
              الامتحان والوقت
            </h2>
            <TextField label="اسم الخطة" value={cfg.title} maxLength={200} onChange={(e) => set('title', e.target.value)} placeholder="مثل: امتحان الجراحة النهائي" />
            <TextField
              label="تاريخ الامتحان"
              type="date"
              dir="ltr"
              value={cfg.exam_date}
              min={today}
              onChange={(e) => set('exam_date', e.target.value)}
              hint={/^\d{4}-\d{2}-\d{2}$/.test(cfg.exam_date) ? `${dayLabelAr(cfg.exam_date, { year: true })} — بتوقيت ${settings.timezone || 'Asia/Baghdad'}` : undefined}
            />
            <TextField
              label="وقت الدراسة اليومي (دقائق)"
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={15}
              max={960}
              value={String(cfg.daily_minutes)}
              onChange={(e) => set('daily_minutes', Number(e.target.value))}
              hint={cfg.daily_minutes >= 15 ? `لا يتجاوز أي يوم ${minutesAr(cfg.daily_minutes)}.` : undefined}
            />
            <fieldset className="lw-fieldset">
              <legend className="ml-field__label">الأيام المتاحة في الأسبوع</legend>
              <div className="lw-weekdays">
                {WEEK_ORDER.map((w) => (
                  <Checkbox
                    key={w}
                    label={WEEKDAYS_AR[w]}
                    checked={cfg.available_weekdays.includes(w)}
                    onCheckedChange={(v) => set('available_weekdays', v ? [...cfg.available_weekdays, w].sort() : cfg.available_weekdays.filter((x) => x !== w))}
                  />
                ))}
              </div>
            </fieldset>
            <div className="lw-blocked">
              <TextField label="أيام لا تدرس فيها" type="date" dir="ltr" min={today} value={blocked} onChange={(e) => setBlocked(e.target.value)} fieldClassName="lw-blocked__input" />
              <Button
                variant="secondary"
                icon={<Plus size={16} />}
                disabled={!/^\d{4}-\d{2}-\d{2}$/.test(blocked) || cfg.blocked_dates.includes(blocked)}
                onClick={() => {
                  set('blocked_dates', [...cfg.blocked_dates, blocked].sort());
                  setBlocked('');
                }}
              >
                أضف
              </Button>
            </div>
            {cfg.blocked_dates.length > 0 && (
              <ul className="lw-chips" aria-label="الأيام المستثناة">
                {cfg.blocked_dates.map((d) => (
                  <li key={d} className="lw-chip">
                    <span>{dayLabelAr(d)}</span>
                    <IconButton label={`أزل ${dayLabelAr(d)}`} icon={<X size={14} />} onClick={() => set('blocked_dates', cfg.blocked_dates.filter((x) => x !== d))} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lw-sheet" aria-labelledby="pl-src">
            <h2 id="pl-src" className="lw-sheet__title">
              المحاضرات ({cfg.source_ids.length})
            </h2>
            <p className="lw-muted">بالترتيب الذي تختاره تُتعلَّم. حجم كل محاضرة من عدد صفحاتها الفعلي؛ غير المعالجة تُقدَّر.</p>
            <TextField label="ابحث" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {!lib.data && <LoadingState inline stage="جارٍ تحميل المكتبة…" />}
            {sources.map((g) => {
              const items = g.items.filter((s) => !needle || s.title.toLowerCase().includes(needle));
              if (!items.length) return null;
              return (
                <fieldset key={g.title} className="lw-fieldset">
                  <legend className="ml-field__label">
                    <BidiText as="span" text={g.title} />
                  </legend>
                  {items.map((s) => (
                    <Checkbox
                      key={s.id}
                      label={<BidiText as="span" text={s.title} />}
                      description={s.page_count ? `${s.page_count} صفحة` : 'عدد الصفحات غير معروف — يُقدَّر'}
                      checked={cfg.source_ids.includes(s.id)}
                      onCheckedChange={(v) => toggleSource(s.id, v)}
                    />
                  ))}
                </fieldset>
              );
            })}
          </section>

          <section className="lw-sheet" aria-labelledby="pl-inc">
            <h2 id="pl-inc" className="lw-sheet__title">
              ما تتضمنه الخطة
            </h2>
            {INCLUDE.map((i) => (
              <Switch key={i.key} label={i.label} description={i.hint} checked={cfg.include[i.key]} onCheckedChange={(v) => set('include', { ...cfg.include, [i.key]: v })} />
            ))}
          </section>

          {tried && problems.length > 0 && (
            <ul className="lw-warnings" role="alert">
              {problems.map((p) => (
                <li key={p}>
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {error && <ErrorState inline message={error} />}
          <div className="ml-cluster">
            <Button type="submit" variant="secondary" icon={<Eye size={16} />} loading={busy === 'preview'} disabled={!caps.online}>
              عاين الخطة
            </Button>
            <Button variant="primary" icon={<Save size={16} />} loading={busy === 'save'} disabled={!caps.online || !preview} onClick={() => void save()}>
              {old ? 'احفظ كخطة جديدة' : 'احفظ الخطة'}
            </Button>
            {!preview && <span className="lw-muted">عاين الخطة أولًا لترى ما ستكون عليه قبل حفظها.</span>}
            {!caps.online && <span className="lw-muted">بناء الخطة يحتاج اتصالًا.</span>}
          </div>
        </form>

        <aside className="lw-editor__preview lw-plan-preview" aria-label="معاينة الخطة" aria-live="polite">
          <h2 className="lw-sheet__subtitle">المعاينة</h2>
          {!preview ? (
            <p className="lw-muted">تظهر هنا الخطة اليومية وهل تتسع الأيام لها، قبل أن تحفظ.</p>
          ) : (
            <>
              <p className={preview.feasibility.feasible ? 'lw-feasible' : 'lw-feasible lw-feasible--no'}>
                {preview.feasibility.feasible ? <CircleCheck size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
                <span>{preview.feasibility.summary_ar}</span>
              </p>
              <p className="lw-muted">{`المطلوب ${minutesAr(preview.feasibility.required_minutes)} — المتاح ${minutesAr(preview.feasibility.available_minutes)} في ${daysCountAr(preview.feasibility.study_days)} للدراسة.`}</p>
              {preview.feasibility.unfit_ar.length > 0 && (
                <ul className="lw-warnings" aria-label="ما لا يتسع">
                  {preview.feasibility.unfit_ar.map((u) => (
                    <li key={u}>
                      <CircleAlert size={16} aria-hidden="true" />
                      <span>{u}</span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.feasibility.estimates_ar.length > 0 && (
                <ul className="lw-basis" aria-label="أساس التقدير">
                  {preview.feasibility.estimates_ar.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
              <DayList tasks={preview.tasks} today={preview.today} timezone={settings.timezone || 'Asia/Baghdad'} dailyMinutes={cfg.daily_minutes} readOnly limit={7} />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
