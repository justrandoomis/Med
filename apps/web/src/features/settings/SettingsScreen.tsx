import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouteLoaderData } from 'react-router-dom';
import { BookOpenText, ChevronLeft, Clock, Info, Monitor, Moon, Palette, Shield, SlidersHorizontal, Sun } from 'lucide-react';
import { richTextFromPlain, type OwnerSettings } from '@medlevo/shared';
import {
  Bidi,
  ErrorState,
  ListItem,
  RichTextView,
  SegmentedControl,
  Select,
  StatusPill,
  Switch,
  TextArea,
  type SelectOption,
} from '../../design';
import { useCapabilities } from '../../lib/capabilities';
import { settingsStore, useSettings } from '../../lib/settings';
import { DEFAULT_TIMEZONE, formatDateTime, formatWeekday, isValidTimeZone, listTimeZones } from '../../lib/time';
import { storageEstimate } from '../../lib/localdb';
import { usePageTitle } from '../../lib/usePageTitle';
import type { OwnerGateData } from '../../app/routeTypes';
import { ChangePasswordGroup, LogoutGroup, RecoveryCodesGroup, SessionsGroup } from './SecuritySection';
import './settings.css';

const SECTIONS = [
  { id: 'appearance', label: 'المظهر', icon: Palette },
  { id: 'reading', label: 'القراءة والشرح', icon: BookOpenText },
  { id: 'time', label: 'الوقت', icon: Clock },
  { id: 'security', label: 'الأمان', icon: Shield },
  { id: 'about', label: 'حول التطبيق', icon: Info },
] as const;

const TEXT_SCALES = ['0.9', '1', '1.15', '1.3', '1.5'] as const;

const LEVEL_OPTIONS: SelectOption<OwnerSettings['explanation_level']>[] = [
  { value: 'simple', label: 'مبسّط' },
  { value: 'brief', label: 'موجز' },
  { value: 'medium', label: 'متوسط' },
  { value: 'detailed', label: 'مفصّل' },
  { value: 'expert', label: 'متقدّم' },
  { value: 'exam_focus', label: 'مركّز على الامتحان' },
];
const DIALECT_OPTIONS: SelectOption<OwnerSettings['dialect']>[] = [
  { value: 'fusha_simple', label: 'عربية فصحى مبسّطة' },
  { value: 'iraqi_teaching', label: 'أسلوب تدريس عراقي' },
];
const ANSWER_OPTIONS: SelectOption<OwnerSettings['answer_style']>[] = [
  { value: 'simple', label: 'بسيط' },
  { value: 'short', label: 'قصير' },
  { value: 'detailed', label: 'مفصّل' },
  { value: 'expert', label: 'متقدّم' },
  { value: 'literal', label: 'حرفي من المصدر' },
];

// Formatting sample from spec §21 (typesetting test only — not medical advice).
const BIDI_SAMPLE = richTextFromPlain('مثال للعرض فقط: CT abdomen وpH 7.35 وNa+ 135 mmol/L داخل جملة عربية، والمسار A → B → C.');

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function SaveIndicator() {
  const { save, saveError } = useSettings();
  const content =
    save === 'saving' ? (
      <StatusPill tone="info">جارٍ الحفظ…</StatusPill>
    ) : save === 'saved' ? (
      <StatusPill tone="success">حُفظت التغييرات</StatusPill>
    ) : save === 'pending_offline' ? (
      <StatusPill tone="neutral">محفوظة على هذا الجهاز، وستُرسل عند عودة الاتصال</StatusPill>
    ) : save === 'pending_auth' ? (
      <StatusPill tone="warning">محفوظة على هذا الجهاز، وستُرسل بعد تسجيل الدخول</StatusPill>
    ) : save === 'error' ? (
      <StatusPill tone="danger">{saveError ?? 'تعذّر الحفظ'}</StatusPill>
    ) : (
      <span className="ml-settings__autosave">تُحفظ التغييرات تلقائيًا</span>
    );
  return (
    <div role="status" aria-live="polite" className="ml-settings__save">
      {content}
    </div>
  );
}

export function SettingsScreen() {
  usePageTitle('الإعدادات');
  const { settings, update, loadError, reload } = useSettings();
  const caps = useCapabilities();
  const gate = useRouteLoaderData('owner') as OwnerGateData | undefined;
  const zones = useMemo(() => listTimeZones(), []);
  const [now, setNow] = useState(() => Date.now());
  const [customDraft, setCustomDraft] = useState(settings.custom_instruction);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const aiExplain = caps.feature('ai.explain');
  // The server only checks that timezone is a string; never let an unknown zone crash this screen.
  const tz = isValidTimeZone(settings.timezone) ? settings.timezone : DEFAULT_TIMEZONE;
  const zoneOptions = useMemo(
    () => (zones.includes(tz) ? zones : [tz, ...zones]).map((z) => ({ value: z, label: z === 'Asia/Baghdad' ? 'بغداد (Asia/Baghdad)' : z })),
    [zones, tz],
  );

  // Custom instruction autosaves (the header says «تُحفظ التغييرات تلقائيًا»): shortly after typing
  // stops, and on blur. A value arriving from the server replaces the draft only when the owner has
  // no unsaved typing in it.
  const savedCustom = useRef(settings.custom_instruction);
  useEffect(() => {
    if (customDraft === savedCustom.current) setCustomDraft(settings.custom_instruction);
    savedCustom.current = settings.custom_instruction;
    // (deliberately keyed on the stored value only)
  }, [settings.custom_instruction]);
  useEffect(() => {
    if (customDraft === settings.custom_instruction) return;
    const t = setTimeout(() => {
      // the blur handler may have saved it already
      if (settingsStore.get().settings.custom_instruction !== customDraft) void update({ custom_instruction: customDraft });
    }, 800);
    return () => clearTimeout(t);
    // (deliberately keyed on the draft only)
  }, [customDraft]);
  // leaving the screen inside the debounce window still saves the draft
  const draftRef = useRef(customDraft);
  draftRef.current = customDraft;
  useEffect(
    () => () => {
      if (settingsStore.get().settings.custom_instruction !== draftRef.current) void settingsStore.update({ custom_instruction: draftRef.current });
    },
    [],
  );
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    void storageEstimate().then(setStorage);
    return () => clearInterval(t);
  }, []);

  const scaleValue = TEXT_SCALES.reduce((best, v) => (Math.abs(Number(v) - settings.text_scale) < Math.abs(Number(best) - settings.text_scale) ? v : best), '1' as (typeof TEXT_SCALES)[number]);

  return (
    <div className="ml-page ml-settings">
      <header className="ml-page__header ml-settings__header">
        <h1 className="ml-page__title">الإعدادات</h1>
        <SaveIndicator />
      </header>
      {loadError && <ErrorState inline title="تعذّر تحميل إعداداتك من الخادم" message={`${loadError} تُعرض آخر نسخة محفوظة على هذا الجهاز.`} onRetry={() => void reload()} />}

      {/* (track D2) the Personal Control Center: review queue, processing, AI & estimated cost, storage, conflicts, history */}
      <ul role="list" className="ml-list ml-settings__control">
        <ListItem
          to="/control"
          leading={<SlidersHorizontal size={20} />}
          title="مركز التحكم"
          subtitle="قائمة المراجعة، والمعالجة، والذكاء الاصطناعي وتكلفته التقديرية، والتخزين، وتعارضات المزامنة، والسجل."
          trailing={<ChevronLeft size={18} aria-hidden="true" />}
        />
      </ul>

      <div className="ml-settings__layout">
        <nav aria-label="أقسام الإعدادات" className="ml-settings__nav">
          <ul role="list">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <a href={`#${id}`} className="ml-settings__nav-link">
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-settings__content">
          {/* ───── Appearance ───── */}
          <section id="appearance" aria-labelledby="appearance-h" className="ml-settings__section">
            <h2 id="appearance-h" className="ml-settings__section-title">
              المظهر
            </h2>
            <div className="ml-group">
              <div className="ml-group__row ml-group__row--stack">
                <SegmentedControl
                  label="السمة"
                  showLabel
                  fullWidth
                  value={settings.theme}
                  onValueChange={(v) => void update({ theme: v })}
                  options={[
                    { value: 'system', label: 'حسب الجهاز', icon: <Monitor size={16} /> },
                    { value: 'light', label: 'فاتح', icon: <Sun size={16} /> },
                    { value: 'dark', label: 'داكن', icon: <Moon size={16} /> },
                  ]}
                />
              </div>
              <div className="ml-group__row ml-group__row--stack">
                <SegmentedControl
                  label="حجم النص"
                  showLabel
                  fullWidth
                  value={scaleValue}
                  onValueChange={(v) => void update({ text_scale: Number(v) })}
                  options={TEXT_SCALES.map((v) => ({ value: v, label: `${Math.round(Number(v) * 100)}%` }))}
                />
                <div className="ml-settings__preview ml-paper" aria-label="معاينة النص">
                  <RichTextView value={BIDI_SAMPLE} variant="reading" />
                </div>
              </div>
              <div className="ml-group__row">
                <Switch
                  label="ملمس الورق"
                  description="ملمس خفيف على أسطح الورق. لا يغيّر التباين، ويمكن إيقافه لتخفيف الرسم على الأجهزة الأبطأ."
                  checked={settings.paper_texture}
                  onCheckedChange={(v) => void update({ paper_texture: v })}
                />
              </div>
              <div className="ml-group__row ml-group__row--stack">
                <SegmentedControl
                  label="تقليل الحركة"
                  showLabel
                  fullWidth
                  value={settings.reduce_motion}
                  onValueChange={(v) => void update({ reduce_motion: v })}
                  options={[
                    { value: 'system', label: 'حسب الجهاز' },
                    { value: 'on', label: 'تشغيل' },
                    { value: 'off', label: 'إيقاف' },
                  ]}
                />
                <p className="ml-settings__help">عند التشغيل تُستبدل الحركات بانتقال تلاشٍ قصير، ويُلغى تقليب الصفحات المتحرك.</p>
              </div>
            </div>
          </section>

          {/* ───── Reading & explanation ───── */}
          <section id="reading" aria-labelledby="reading-h" className="ml-settings__section">
            <h2 id="reading-h" className="ml-settings__section-title">
              القراءة والشرح
            </h2>
            {!aiExplain.available && aiExplain.reason && (
              <p className="ml-settings__note">
                <Info size={16} aria-hidden="true" />
                <span>تُحفظ هذه التفضيلات الآن وتُطبَّق على الشروح المولدة عندما تعمل: {aiExplain.reason}</span>
              </p>
            )}
            <div className="ml-group">
              <div className="ml-group__row ml-settings__grid">
                <Select label="مستوى الشرح الافتراضي" options={LEVEL_OPTIONS} value={settings.explanation_level} onValueChange={(v) => void update({ explanation_level: v })} />
                <Select label="أسلوب اللغة" options={DIALECT_OPTIONS} value={settings.dialect} onValueChange={(v) => void update({ dialect: v })} />
                <Select label="أسلوب الإجابة" options={ANSWER_OPTIONS} value={settings.answer_style} onValueChange={(v) => void update({ answer_style: v })} />
              </div>
              <div className="ml-group__row">
                <Switch
                  label="الأسلوب السقراطي افتراضيًا"
                  description="يطرح عليك أسئلة توجيهية قصيرة قبل أن يعطيك الجواب."
                  checked={settings.socratic_default}
                  onCheckedChange={(v) => void update({ socratic_default: v })}
                />
              </div>
              <div className="ml-group__row ml-group__row--stack">
                <SegmentedControl
                  label="كثافة أسئلة التحقق أثناء الشرح"
                  showLabel
                  fullWidth
                  value={settings.check_question_density}
                  onValueChange={(v) => void update({ check_question_density: v })}
                  options={[
                    { value: 'off', label: 'إيقاف' },
                    { value: 'low', label: 'قليلة' },
                    { value: 'medium', label: 'متوسطة' },
                  ]}
                />
              </div>
              <div className="ml-group__row ml-group__row--stack">
                <SegmentedControl
                  label="كثافة الهامش"
                  showLabel
                  fullWidth
                  value={settings.margin_density}
                  onValueChange={(v) => void update({ margin_density: v })}
                  options={[
                    { value: 'minimal', label: 'بسيطة' },
                    { value: 'normal', label: 'عادية' },
                    { value: 'rich', label: 'غنية' },
                  ]}
                />
              </div>
              <div className="ml-group__row ml-group__row--stack">
                <TextArea
                  label="تعليمات خاصة للشرح"
                  hint={`اختياري. مثل: «اذكر المصطلح الإنجليزي بجانب العربي دائمًا». ${customDraft.length} من 1000 حرف.`}
                  maxLength={1000}
                  rows={3}
                  value={customDraft}
                  onChange={(e) => setCustomDraft(e.target.value)}
                  onBlur={() => {
                    if (customDraft !== settings.custom_instruction) void update({ custom_instruction: customDraft });
                  }}
                />
              </div>
            </div>
          </section>

          {/* ───── Time ───── */}
          <section id="time" aria-labelledby="time-h" className="ml-settings__section">
            <h2 id="time-h" className="ml-settings__section-title">
              الوقت
            </h2>
            <div className="ml-group">
              <div className="ml-group__row ml-group__row--stack">
                <Select label="المنطقة الزمنية" options={zoneOptions} value={tz} onValueChange={(v) => void update({ timezone: v })} />
                <p className="ml-settings__help">
                  الوقت الآن في هذه المنطقة: {formatWeekday(now, tz)}، {formatDateTime(now, tz)}
                </p>
              </div>
            </div>
            <p className="ml-group-footer">تُخزَّن الأوقات بتوقيت عالمي ثابت. هذا الإعداد يغيّر طريقة العرض فقط، ولا يحرّك مواعيد المراجعة.</p>
          </section>

          {/* ───── Security ───── */}
          <section id="security" aria-labelledby="security-h" className="ml-settings__section">
            <h2 id="security-h" className="ml-settings__section-title">
              الأمان
            </h2>
            {gate?.mode === 'offline' ? (
              <ErrorState inline title="إعدادات الأمان تحتاج اتصالًا" message="إدارة الجلسات وكلمة المرور ورموز الاسترداد تتم على الخادم. اتصل بالإنترنت ثم أعد فتح هذه الصفحة." />
            ) : (
              <div className="ml-stack">
                <SessionsGroup />
                <ChangePasswordGroup minLength={gate?.passwordMinLength ?? 12} />
                <RecoveryCodesGroup />
                <LogoutGroup />
              </div>
            )}
          </section>

          {/* ───── About ───── */}
          <section id="about" aria-labelledby="about-h" className="ml-settings__section">
            <h2 id="about-h" className="ml-settings__section-title">
              حول التطبيق
            </h2>
            <dl className="ml-group ml-settings__facts">
              <div className="ml-group__row">
                <dt>إصدار الواجهة</dt>
                <dd dir="ltr">{__APP_VERSION__}</dd>
              </div>
              <div className="ml-group__row">
                <dt>إصدار الخادم</dt>
                <dd dir="ltr">{caps.data?.app_version ?? '—'}</dd>
              </div>
              <div className="ml-group__row">
                <dt>مزوّد AI</dt>
                <dd>{caps.data ? (caps.data.ai.configured ? (caps.data.ai.provider ?? 'مهيأ') : 'غير مهيأ على الخادم') : '—'}</dd>
              </div>
              <div className="ml-group__row">
                <dt>المساحة المستخدمة على هذا الجهاز</dt>
                <dd>
                  {storage ? (
                    <>
                      <Bidi dir="ltr">{formatBytes(storage.usage)}</Bidi> من <Bidi dir="ltr">{formatBytes(storage.quota)}</Bidi> متاحة للمتصفح
                    </>
                  ) : (
                    'غير متاح في هذا المتصفح'
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
