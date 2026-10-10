// /review/profile — Learning Profile (§44): what MedLevo uses to personalise explanations and reviews, editable and
// resettable part by part. A reset is a cut-off time: older signals are ignored from now on, the data itself is kept.
// Preferences change how things are explained — never the medical facts or their sources.
import { useEffect, useState } from 'react';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { EXPLANATION_LEVELS, type ExplanationLevel, type LearningProfileView, type ProfileSignalPart } from '@medlevo/shared';
import { EXPLANATION_LEVEL_LABELS_AR } from '@medlevo/shared';
import { Button, ConfirmDialog, ErrorState, LoadingState, Select, Switch, TextField, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { useSettings } from '../../lib/settings';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { learningApi } from './api';
import './learning.css';

const DIALECTS = [
  { value: 'fusha_simple', label: 'فصحى مبسّطة' },
  { value: 'iraqi_teaching', label: 'لهجة عراقية تعليمية' },
] as const;

export function ProfileScreen() {
  usePageTitle('ملف التعلّم');
  const caps = useCapabilities();
  const toast = useToast();
  const settings = useSettings();
  const [p, setP] = useState<LearningProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState('');
  const [subjects, setSubjects] = useState('');
  const [pace, setPace] = useState('');
  const [saving, setSaving] = useState(false);
  const [reset, setReset] = useState<LearningProfileView['signals'][number] | null>(null);
  const [newCards, setNewCards] = useState(String(settings.settings.daily_new_cards));
  useEffect(() => setNewCards(String(settings.settings.daily_new_cards)), [settings.settings.daily_new_cards]);
  const retention = settings.settings.desired_retention.toFixed(2);
  const retentionOptions = [...new Set(['0.80', '0.85', '0.90', '0.95', retention])].sort();

  const apply = (v: LearningProfileView) => {
    setP(v);
    setLevel(v.self_level);
    setSubjects(v.subjects_studied.join('، '));
    setPace(v.pace_minutes_per_day == null ? '' : String(v.pace_minutes_per_day));
  };
  useEffect(() => {
    void learningApi
      .profile()
      .then(apply)
      .catch((e) => setError(errorMessage(e, 'تعذّر تحميل ملف التعلّم.')));
  }, []);

  const patch = async (body: Parameters<typeof learningApi.patchProfile>[0], okText = 'حُفظ.') => {
    setSaving(true);
    try {
      apply(await learningApi.patchProfile(body));
      toast.show({ title: okText, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر الحفظ.'), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="ml-page lw-page"><ErrorState message={error} onRetry={() => window.location.reload()} /></div>;
  if (!p) return <div className="ml-page lw-page"><LoadingState stage="جارٍ تحميل ملف التعلّم…" /></div>;
  const paceNum = pace.trim() === '' ? null : Number(pace);
  const paceInvalid = paceNum !== null && (!Number.isInteger(paceNum) || paceNum < 5 || paceNum > 960);

  return (
    <div className="ml-page ml-page--narrow lw-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">ملف التعلّم</h1>
        <p className="ml-page__lede">ما تستخدمه MedLevo لتخصيص الشرح والمراجعة. صحّح ما لا يناسبك، أو أعد ضبط جزء منه.</p>
      </header>

      <p className="lw-note" role="note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>{p.facts_note_ar}</span>
      </p>

      <section aria-labelledby="lw-prof-me">
        <h2 id="lw-prof-me" className="ml-group-header">
          عنك
        </h2>
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <TextField label="مستواك كما تصفه" hint="مثل: طالب المرحلة الرابعة، أراجع للامتحان النهائي." value={level} maxLength={200} onChange={(e) => setLevel(e.target.value)} />
            <TextField label="المواد التي درستها" hint="افصل بينها بفاصلة." value={subjects} onChange={(e) => setSubjects(e.target.value)} />
            <TextField
              label="وقت الدراسة اليومي الذي تخطط له (دقائق)"
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={5}
              max={960}
              value={pace}
              error={paceInvalid ? 'من 5 إلى 960 دقيقة، أو اتركه فارغًا.' : undefined}
              onChange={(e) => setPace(e.target.value)}
            />
            <Button
              variant="primary"
              loading={saving}
              disabled={!caps.online || paceInvalid}
              onClick={() =>
                void patch(
                  {
                    self_level: level.trim(),
                    subjects_studied: subjects
                      .split(/[،,]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                    pace_minutes_per_day: paceNum,
                  },
                  'حُفظت معلوماتك.',
                )
              }
            >
              احفظ
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="lw-prof-pref">
        <h2 id="lw-prof-pref" className="ml-group-header">
          طريقة الشرح
        </h2>
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <Select<ExplanationLevel>
              label="مستوى الشرح"
              options={EXPLANATION_LEVELS.map((l) => ({ value: l, label: EXPLANATION_LEVEL_LABELS_AR[l] }))}
              value={p.preferences.explanation_level as ExplanationLevel}
              disabled={!caps.online || saving}
              onValueChange={(v) => void patch({ preferences: { explanation_level: v } })}
            />
            <Select
              label="لغة الشرح"
              options={DIALECTS}
              value={p.preferences.dialect}
              disabled={!caps.online || saving}
              onValueChange={(v) => void patch({ preferences: { dialect: v } })}
            />
            <Switch label="الأسئلة الموجِّهة أولًا (Socratic)" description="يسألك قبل أن يشرح." checked={p.preferences.socratic} disabled={!caps.online || saving} onCheckedChange={(v) => void patch({ preferences: { socratic: v } })} />
          </div>
        </div>
      </section>

      <section aria-labelledby="lw-prof-srs">
        <h2 id="lw-prof-srs" className="ml-group-header">
          المراجعة المتباعدة
        </h2>
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <TextField
              label="البطاقات الجديدة في اليوم"
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={0}
              max={500}
              value={newCards}
              hint="حدٌّ أعلى لما يُقدَّم من بطاقات جديدة في يومك (منطقتك الزمنية). يُحفظ تلقائيًا."
              error={newCards !== '' && !(Number.isInteger(Number(newCards)) && Number(newCards) >= 0 && Number(newCards) <= 500) ? 'من 0 إلى 500.' : undefined}
              onChange={(e) => {
                setNewCards(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value !== '' && Number.isInteger(n) && n >= 0 && n <= 500) void settings.update({ daily_new_cards: n });
              }}
            />
            <Select
              label="نسبة التذكّر المستهدفة"
              hint="كلما ارتفعت قصرت الفواصل وكثرت المراجعات. تُعاد جدولة البطاقات من سجلها بالخوارزمية نفسها؛ السجل لا يتغير."
              options={retentionOptions.map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}٪` }))}
              value={retention}
              onValueChange={(v) => void settings.update({ desired_retention: Number(v) })}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="lw-prof-signals">
        <h2 id="lw-prof-signals" className="ml-group-header">
          ما يُستخدم لتخصيص المراجعة الآن
        </h2>
        {p.used_signals_ar.length > 0 && (
          <ul className="lw-basis">
            {p.used_signals_ar.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        <ul className="ml-list">
          {p.signals.map((s) => (
            <li key={s.part} className="ml-list__row lw-signal">
              <div className="lw-signal__text">
                <span className="lw-signal__title">{s.label_ar}</span>
                <span className="lw-muted">{s.used_for_ar}</span>
                <span className="lw-muted">{`عدد السجلات: ${s.count}${s.reset_at ? ` — يُتجاهل ما قبل ${formatDateTime(s.reset_at)}` : ''}`}</span>
              </div>
              <Button size="sm" variant="secondary" icon={<RotateCcw size={16} />} disabled={!caps.online} onClick={() => setReset(s)}>
                أعد الضبط
              </Button>
            </li>
          ))}
        </ul>
        <p className="ml-group-footer">
          {p.measured_pace.sample >= 5
            ? `سرعتك المقيسة (تقدير من ${p.measured_pace.sample} محاولة): ${p.measured_pace.median_seconds_per_question != null ? `${Math.round(p.measured_pace.median_seconds_per_question)} ثانية للسؤال` : '—'}${p.measured_pace.median_seconds_per_card != null ? `، ${Math.round(p.measured_pace.median_seconds_per_card)} ثانية للبطاقة` : ''}.`
            : 'لا توجد بعد محاولات كافية لقياس سرعتك (نحتاج 5 على الأقل).'}
        </p>
      </section>

      <ConfirmDialog
        open={!!reset}
        title={`إعادة ضبط: ${reset?.label_ar ?? ''}`}
        impact={<p>من الآن يتجاهل التخصيص ما سُجّل قبل هذه اللحظة في هذا الجزء. لا تُحذف محاولاتك ولا مراجعاتك، ولا تتغير جدولة البطاقات.</p>}
        confirmLabel="أعد الضبط"
        onCancel={() => setReset(null)}
        onConfirm={async () => {
          if (!reset) return;
          try {
            apply(await learningApi.resetProfilePart(reset.part as ProfileSignalPart));
            toast.show({ title: 'أُعيد الضبط. البيانات نفسها محفوظة.', tone: 'success' });
          } catch (e) {
            toast.show({ title: errorMessage(e, 'تعذّر إعادة الضبط.'), tone: 'danger' });
          }
          setReset(null);
        }}
      />
    </div>
  );
}
