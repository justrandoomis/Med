// «إعدادات الكتابة» (parity N1): the owner's writing settings, synced with the other settings (they follow the owner to
// every device and work offline), except the pen-feel profile and the palm test, which belong to this device.
//  * الألوان ومعانيها (G03): up to 12 colour slots per tool — reorder, remove, add, reset — each with an optional meaning;
//  * الإيماءات (G14): scribble to erase, circle + hold to select, two- / three-finger double tap; each can be turned off;
//  * راحة اليد (G02): sensitivity and writing hand, the values in force, and a test pad that counts stray marks;
//  * إحساس القلم (G01): the profile of this notebook and the «مخصّص» values per nib;
//  * شريط الأدوات (G66): order, hidden tools, dock side, the previous-tool slot, insert tools back to the lasso, per-mode
//    profiles.
import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { INK_MAX_SLOTS, INK_SLOT_MEANING_MAX, INK_SLOT_TOOLS, STUDY_MODES, STUDY_MODE_LABELS_AR, stripBidiControls, type InkNibFeel, type InkSettings, type InkSlot, type InkSlotTool, type StudyMode } from '@medlevo/shared';
import { Button, Dialog, IconButton, SegmentedControl, Select, Switch, Tab, TabList, TabPanel, Tabs } from '../../../design';
import { FEEL_PROFILES, feelProfile as profileOf, type FeelProfileId } from './feel';
import { useInkInternal } from './InkProvider';
import { defaultSlots, setSlots, slotsFor, updateInkSettings } from './inkSettings';
import { classifyPointerDown, palmPolicy } from './input';
import { colorLabel, HIGHLIGHTER_COLORS, isHexColor, PEN_COLORS, resolveInkColor } from './palette';
import { localGet, localSet } from './prefs';
import { currentPaperTone } from './render';
import { MODE_SUGGESTIONS, suggestedHidden } from './toolbarLayout';
import { entryInfo } from './InkToolbar';

type Section = 'colors' | 'gestures' | 'palm' | 'feel' | 'toolbar' | 'aids';

const SLOT_TOOL_LABELS: Record<InkSlotTool, string> = { pen: 'القلم', fountain: 'قلم الحبر', ball: 'القلم الجاف', highlighter: 'قلم التظليل', shape: 'الأشكال', text: 'مربعات النص', pencil: 'قلم الرصاص' };

export function InkSettingsDialog({ open, onClose, available }: { open: boolean; onClose: () => void; available: readonly string[] }) {
  const [section, setSection] = useState<Section>('colors');
  return (
    <Dialog open={open} onClose={onClose} title="إعدادات الكتابة" size="lg" description="تُحفظ مع إعداداتك وتتبعك إلى أجهزتك، وتعمل دون اتصال (تُرسل عند عودته). إحساس القلم في هذا الدفتر واختبار راحة اليد لهذا الجهاز فقط.">
      {open && (
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
          <TabList label="أقسام إعدادات الكتابة" className="ml-ink-settings__tabs">
            <Tab value="colors">الألوان ومعانيها</Tab>
            <Tab value="gestures">الإيماءات</Tab>
            <Tab value="palm">راحة اليد</Tab>
            <Tab value="feel">إحساس القلم</Tab>
            <Tab value="toolbar">شريط الأدوات</Tab>
            <Tab value="aids">المحاذاة والتكبير</Tab>
          </TabList>
          <TabPanel value="colors">
            <ColorsSection />
          </TabPanel>
          <TabPanel value="gestures">
            <GesturesSection />
          </TabPanel>
          <TabPanel value="palm">
            <PalmSection />
          </TabPanel>
          <TabPanel value="feel">
            <FeelSection />
          </TabPanel>
          <TabPanel value="toolbar">
            <ToolbarSection available={available} />
          </TabPanel>
          <TabPanel value="aids">
            <AidsSection />
          </TabPanel>
        </Tabs>
      )}
    </Dialog>
  );
}

// ─── colours and meanings (G03) ────────────────────────────────────────────────────────────────────
/** A meaning as it may be stored: one line, trimmed, no bidi control characters, at most 60 characters. */
export function cleanMeaning(v: string): string | undefined {
  const s = stripBidiControls(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, INK_SLOT_MEANING_MAX).trim();
  return s ? s : undefined;
}

function ColorsSection() {
  const { inkSettings, announce } = useInkInternal();
  const [tool, setTool] = useState<InkSlotTool>('pen');
  const slots = slotsFor(inkSettings, tool);
  const own = !!inkSettings.palettes[tool];
  const tokens = tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const unused = tokens.filter((t) => !slots.some((s) => s.color === t.token));
  const [add, setAdd] = useState<string>('');
  const [hex, setHex] = useState('#2346c8');
  const save = (next: InkSlot[]) => void setSlots(tool, next);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= slots.length) return;
    const next = slots.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
    announce(`نُقل ${colorLabel(slots[i]!.color)} إلى الموضع ${j + 1}.`);
  };
  const addColor = (color: string) => {
    if (slots.length >= INK_MAX_SLOTS) return;
    save([...slots, { color }]);
    announce(`أُضيف ${colorLabel(color)}.`);
  };
  const pick = add || unused[0]?.token || '';
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-colors-h" dir="rtl">
      <h3 id="ink-colors-h" className="ml-ink-settings__h">الألوان ومعانيها</h3>
      <p className="ml-ink-options__note">سمِّ ما يعنيه كل لون (مثل: أحمر = موانع استعمال، أزرق = آلية). يُحفظ المعنى مع كل خط تكتبه به، ويُقرأ مع اللون لقارئ الشاشة، ويمكنك أن تعرض معنى واحدًا فقط من «دليل الألوان».</p>
      <Select label="الأداة" value={tool} options={INK_SLOT_TOOLS.map((t) => ({ value: t, label: SLOT_TOOL_LABELS[t] }))} onValueChange={(v) => setTool(v as InkSlotTool)} />
      <ol className="ml-ink-slots" aria-label={`ألوان ${SLOT_TOOL_LABELS[tool]}`}>
        {slots.map((s, i) => (
          <SlotRow
            key={`${tool}:${i}:${s.color}`}
            slot={s}
            index={i}
            count={slots.length}
            onMove={(d) => move(i, d)}
            onRemove={() => {
              save(slots.filter((_, k) => k !== i));
              announce(`حُذف ${colorLabel(s.color)} من الألوان.`);
            }}
            onMeaning={(m) => {
              const next = slots.slice();
              next[i] = { color: s.color, ...(m ? { meaning: m } : {}), ...(s.dash ? { dash: s.dash } : {}) };
              save(next);
            }}
            onDash={(d) => {
              const next = slots.slice();
              next[i] = { color: s.color, ...(s.meaning ? { meaning: s.meaning } : {}), ...(d ? { dash: d } : {}) };
              save(next);
              announce(`${colorLabel(s.color)}: خط ${d === 'dash' ? 'متقطع' : d === 'dot' ? 'منقّط' : 'متصل'}.`);
            }}
          />
        ))}
      </ol>
      <div className="ml-ink-slots__add">
        {unused.length > 0 && (
          <>
            <Select label="لون من اللوحة" value={pick} options={unused.map((t) => ({ value: t.token, label: t.label_ar }))} onValueChange={setAdd} />
            <Button size="sm" icon={<Plus size={16} />} disabled={slots.length >= INK_MAX_SLOTS || !pick} onClick={() => addColor(pick)}>
              أضف هذا اللون
            </Button>
          </>
        )}
        <label className="ml-ink-slots__hex">
          <span>لون مخصّص</span>
          <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} aria-label="اختر لونًا مخصّصًا" />
        </label>
        <Button size="sm" icon={<Plus size={16} />} disabled={slots.length >= INK_MAX_SLOTS || !isHexColor(hex)} onClick={() => addColor(hex.toLowerCase())}>
          أضف اللون المخصّص
        </Button>
        {slots.length >= INK_MAX_SLOTS && <p className="ml-ink-options__note">{`${INK_MAX_SLOTS} لونًا على الأكثر لكل أداة.`}</p>}
      </div>
      <Button
        size="sm"
        variant="plain"
        icon={<RotateCcw size={16} />}
        disabled={!own}
        onClick={() => {
          void setSlots(tool, null);
          announce(`أُعيدت ألوان ${SLOT_TOOL_LABELS[tool]} الافتراضية (${defaultSlots(tool).length}).`);
        }}
      >
        أعد الألوان الافتراضية
      </Button>
    </section>
  );
}

function SlotRow({ slot, index, count, onMove, onRemove, onMeaning, onDash }: { slot: InkSlot; index: number; count: number; onMove: (d: -1 | 1) => void; onRemove: () => void; onMeaning: (m: string | undefined) => void; onDash: (d: 'dash' | 'dot' | undefined) => void }) {
  const [draft, setDraft] = useState(slot.meaning ?? '');
  const id = useId();
  const name = colorLabel(slot.color);
  const commit = () => {
    const m = cleanMeaning(draft);
    if (m !== slot.meaning) onMeaning(m);
    setDraft(m ?? '');
  };
  return (
    <li className="ml-ink-slot">
      <span className="ml-ink-swatch" style={{ background: resolveInkColor(slot.color, currentPaperTone(), null) }} aria-hidden="true" />
      <label className="ml-ink-slot__label" htmlFor={id}>
        {`معنى ${name}`}
      </label>
      <input
        id={id}
        className="ml-ink-slot__meaning ml-input"
        dir="auto"
        maxLength={INK_SLOT_MEANING_MAX}
        placeholder="بلا معنى"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {/* (N1 wave 2, G04) the slot's line pattern (dashed = to verify, dotted = deep structures …) */}
      <select className="ml-ink-slot__dash ml-input" aria-label={`نمط خط ${name}`} value={slot.dash ?? 'solid'} onChange={(e) => onDash(e.target.value === 'solid' ? undefined : (e.target.value as 'dash' | 'dot'))}>
        <option value="solid">متصل</option>
        <option value="dash">متقطع</option>
        <option value="dot">منقّط</option>
      </select>
      <span className="ml-ink-slot__actions">
        <IconButton size="sm" label={`انقل ${name} للأعلى`} icon={<ArrowUp size={16} />} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton size="sm" label={`انقل ${name} للأسفل`} icon={<ArrowDown size={16} />} disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton size="sm" label={`احذف ${name}`} icon={<Trash2 size={16} />} disabled={count <= 1} onClick={onRemove} />
      </span>
    </li>
  );
}

// ─── gestures (G14) ────────────────────────────────────────────────────────────────────────────────
function GesturesSection() {
  const { inkSettings } = useInkInternal();
  const g = inkSettings.gestures;
  const set = (patch: Partial<InkSettings['gestures']>) => void updateInkSettings((s) => ({ ...s, gestures: { ...s.gestures, ...patch } }));
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-gestures-h" dir="rtl">
      <h3 id="ink-gestures-h" className="ml-ink-settings__h">الإيماءات</h3>
      <p className="ml-ink-options__note">تُتعرّف الإيماءات بعد أن يُحفظ الخط، ولكل منها زر أو اختصار يؤدي العمل نفسه.</p>
      <Switch
        checked={g.scribble_erase}
        onCheckedChange={(v) => set({ scribble_erase: v })}
        label="الخربشة فوق الكتابة تمسحها"
        description="خربشة متعرّجة كثيفة فوق خطّين أو أكثر (أو فوق 60٪ من خط واحد) تمسحها بخطوة تراجع واحدة. الكتابة العادية ورسم تخطيط القلب لا تُعدّ خربشة. البديل: الممحاة (E)."
      />
      <Switch
        checked={g.circle_lasso}
        onCheckedChange={(v) => set({ circle_lasso: v })}
        label="دائرة ثم توقّف = تحديد"
        description="ارسم دائرة مغلقة حول كتابة وأبقِ القلم ثابتًا: يُحدَّد ما بداخلها بالتحديد الحر (والدائرة لا تُحفظ). دائرة حول فراغ تبقى شكلًا. البديل: التحديد الحر (L)."
      />
      <Switch
        checked={g.finger_undo}
        onCheckedChange={(v) => set({ finger_undo: v })}
        label="نقرتان بإصبعين = تراجع، بثلاثة أصابع = إعادة"
        description="باللمس فقط، ولا تعمل والقلم على الشاشة. البديل: زرّا التراجع والإعادة أو Ctrl/⌘ Z."
      />
    </section>
  );
}

// ─── palm rejection (G02) ──────────────────────────────────────────────────────────────────────────
const PALM_TEST_KEY = 'medlevo.ink.palmtest.v1';

interface PalmTestResult {
  at: number;
  level: string;
  hand: string;
  pen: number;
  rejected: number;
  stray: number;
}

function PalmSection() {
  const { inkSettings, prefs } = useInkInternal();
  const p = inkSettings.palm;
  const policy = palmPolicy(p.sensitivity, p.hand);
  const set = (patch: Partial<InkSettings['palm']>) => void updateInkSettings((s) => ({ ...s, palm: { ...s.palm, ...patch } }));
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-palm-h" dir="rtl">
      <h3 id="ink-palm-h" className="ml-ink-settings__h">رفض راحة اليد</h3>
      <p className="ml-ink-options__note">تقريبي على الويب: رفض راحة اليد الأصلي من النظام يحتاج تطبيقًا أصليًا. في وضع «القلم فقط» لا يكتب اللمس أبدًا.</p>
      <SegmentedControl
        label="الحساسية"
        showLabel
        fullWidth
        options={[
          { value: 'low', label: 'منخفضة' },
          { value: 'medium', label: 'متوسطة' },
          { value: 'high', label: 'عالية' },
        ]}
        value={p.sensitivity}
        onValueChange={(v) => set({ sensitivity: v })}
      />
      <SegmentedControl
        label="اليد التي تكتب بها"
        showLabel
        fullWidth
        options={[
          { value: 'right', label: 'اليمنى' },
          { value: 'left', label: 'اليسرى' },
        ]}
        value={p.hand}
        onValueChange={(v) => set({ hand: v })}
      />
      <dl className="ml-ink-palm__values">
        <div>
          <dt>لمسة أعرض من هذا تُعدّ راحة يد</dt>
          <dd>{`${policy.contactPx} بكسل`}</dd>
        </div>
        <div>
          <dt>يُتجاهل كل لمس بعد رفع القلم مدة</dt>
          <dd>{`${policy.afterPenMs} ملّي ثانية`}</dd>
        </div>
        <div>
          <dt>{`ويُتجاهل اللمس في جهة اليد ${p.hand === 'right' ? 'اليمنى' : 'اليسرى'} وأسفل القلم مدة`}</dt>
          <dd>{policy.zoneMs ? `${policy.zoneMs} ملّي ثانية` : 'معطّل'}</dd>
        </div>
      </dl>
      <PalmTestPad penOnly={prefs.penOnly} />
    </section>
  );
}

/** Write a line with the pen while the hand rests on the pad: it counts what would have become a stray mark. */
function PalmTestPad({ penOnly }: { penOnly: boolean }) {
  const { inkSettings } = useInkInternal();
  const [counts, setCounts] = useState({ pen: 0, rejected: 0, stray: 0 });
  const lastPenUp = useRef(-Infinity);
  const lastPen = useRef<{ x: number; y: number } | null>(null);
  const active = useRef(new Set<number>());
  const [last, setLast] = useState<PalmTestResult | null>(() => {
    try {
      const raw = localGet(PALM_TEST_KEY);
      return raw ? (JSON.parse(raw) as PalmTestResult) : null;
    } catch {
      return null;
    }
  });
  const policy = palmPolicy(inkSettings.palm.sensitivity, inkSettings.palm.hand);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.pointerType === 'pen') {
      lastPen.current = { x: e.clientX, y: e.clientY };
      setCounts((c) => ({ ...c, pen: c.pen + 1 }));
      return;
    }
    if (e.pointerType !== 'touch') return;
    const d = classifyPointerDown(e.nativeEvent, { penOnly, strokeActive: active.current.size > 0, sincePenUp: performance.now() - lastPenUp.current, palm: policy, lastPen: lastPen.current });
    active.current.add(e.pointerId);
    if (d === 'write') setCounts((c) => ({ ...c, stray: c.stray + 1 }));
    else setCounts((c) => ({ ...c, rejected: c.rejected + 1 }));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    active.current.delete(e.pointerId);
    if (e.pointerType === 'pen') lastPenUp.current = performance.now();
  };
  const record = () => {
    const r: PalmTestResult = { at: Date.now(), level: inkSettings.palm.sensitivity, hand: inkSettings.palm.hand, ...counts };
    localSet(PALM_TEST_KEY, JSON.stringify(r));
    setLast(r);
  };
  return (
    <div className="ml-ink-palm__test">
      <div className="ml-ink-palm__pad" role="img" aria-label="مساحة اختبار راحة اليد: اكتب سطرًا بالقلم ويدك مستندة هنا" onPointerDown={down} onPointerUp={up} onPointerCancel={up} style={{ touchAction: 'none' }}>
        <span aria-hidden="true">اكتب سطرًا بالقلم ويدك مستندة على هذه المساحة</span>
      </div>
      <p className="ml-ink-palm__counts" role="status">
        {`ضربات القلم: ${counts.pen.toLocaleString('ar-EG')} — لمسات رُفضت كراحة يد: ${counts.rejected.toLocaleString('ar-EG')} — علامات شاردة كانت ستُكتب: ${counts.stray.toLocaleString('ar-EG')}`}
      </p>
      <div className="ml-ink-palm__actions">
        <Button size="sm" onClick={record} disabled={counts.pen + counts.rejected + counts.stray === 0}>
          سجّل النتيجة على هذا الجهاز
        </Button>
        <Button size="sm" variant="plain" onClick={() => setCounts({ pen: 0, rejected: 0, stray: 0 })}>
          ابدأ من جديد
        </Button>
      </div>
      {last && (
        <p className="ml-ink-options__note">
          {`آخر نتيجة مسجّلة (${new Date(last.at).toLocaleString('ar-EG')}، حساسية ${last.level === 'low' ? 'منخفضة' : last.level === 'high' ? 'عالية' : 'متوسطة'}): ${last.stray ? `${last.stray.toLocaleString('ar-EG')} علامة شاردة — جرّب حساسية أعلى.` : 'لا علامات شاردة.'}`}
        </p>
      )}
      {penOnly && <p className="ml-ink-options__note">وضع «القلم فقط» مفعّل: اللمس لا يكتب، فلا علامات شاردة من اليد.</p>}
    </div>
  );
}

// ─── pen feel (G01) ────────────────────────────────────────────────────────────────────────────────
const NIBS: Array<{ key: 'pen' | 'fountain' | 'ball' | 'highlighter' | 'pencil'; label: string }> = [
  { key: 'pen', label: 'القلم' },
  { key: 'fountain', label: 'قلم الحبر' },
  { key: 'ball', label: 'القلم الجاف' },
  { key: 'pencil', label: 'الرصاص' },
  { key: 'highlighter', label: 'قلم التظليل' },
];

function FeelSection() {
  const { feelProfile, setFeelProfile, inkSettings } = useInkInternal();
  const [nib, setNib] = useState<(typeof NIBS)[number]['key']>('pen');
  const f = inkSettings.feel[nib];
  const set = (patch: Partial<InkNibFeel>) => void updateInkSettings((s) => ({ ...s, feel: { ...s.feel, [nib]: { ...s.feel[nib], ...patch } } }));
  const prof = profileOf(feelProfile);
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-feel-h" dir="rtl">
      <h3 id="ink-feel-h" className="ml-ink-settings__h">إحساس القلم</h3>
      <p className="ml-ink-options__note">يُحفظ الإحساس مع كل خط فيبدو كما كتبته على كل جهاز، وتغييره لاحقًا لا يغيّر ما كُتب.</p>
      <SegmentedControl label="ملف هذا الدفتر (على هذا الجهاز)" showLabel fullWidth options={FEEL_PROFILES.map((p) => ({ value: p.id, label: p.label_ar }))} value={feelProfile} onValueChange={(v) => setFeelProfile(v as FeelProfileId)} />
      <p className="ml-ink-options__note">{prof.hint_ar}</p>
      <fieldset className="ml-ink-feel" disabled={feelProfile !== 'custom'}>
        <legend className="ml-field__label">{feelProfile === 'custom' ? 'قيمك (مخصّص)' : 'قيم «مخصّص» — اختر «مخصّص» لاستعمالها'}</legend>
        <SegmentedControl label="القلم" size="sm" fullWidth options={NIBS.map((n) => ({ value: n.key, label: n.label }))} value={nib} onValueChange={(v) => setNib(v)} />
        <Range id="feel-smoothing" label="التنعيم" min={0} max={6} step={1} value={f.smoothing} text={`${f.smoothing} من 6`} onChange={(v) => set({ smoothing: v })} />
        {nib !== 'highlighter' && (
          <>
            <Range id="feel-floor" label="أقل ضغط" min={0} max={0.6} step={0.05} value={f.pressure_floor} text={`${Math.round(f.pressure_floor * 100)}٪`} onChange={(v) => set({ pressure_floor: Math.round(v * 100) / 100 })} />
            <SegmentedControl
              label="طرفا الخط"
              showLabel
              size="sm"
              fullWidth
              options={[
                { value: 'none', label: 'كامل' },
                { value: 'round', label: 'ناعم' },
                { value: 'sharp', label: 'مدبّب' },
              ]}
              value={f.taper}
              onValueChange={(v) => set({ taper: v })}
            />
            <Switch checked={f.constant} onCheckedChange={(v) => set({ constant: v })} label="سماكة ثابتة" description="لا تتغير السماكة مع الضغط حتى لو أبلغ عنه القلم." />
          </>
        )}
      </fieldset>
    </section>
  );
}

function Range({ id, label, min, max, step, value, text, onChange }: { id: string; label: string; min: number; max: number; step: number; value: number; text: string; onChange: (v: number) => void }) {
  return (
    <div className="ml-ink-options__group">
      <label className="ml-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ml-ink-width">
        <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={text} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="ml-ink-range__value">{text}</span>
      </div>
    </div>
  );
}

// ─── toolbar (G66) ─────────────────────────────────────────────────────────────────────────────────
function ToolbarSection({ available }: { available: readonly string[] }) {
  const { inkSettings, announce } = useInkInternal();
  const tb = inkSettings.toolbar;
  const [mode, setMode] = useState<StudyMode | 'all'>('all');
  const order = useMemo(() => {
    const named = tb.order.filter((id, i, a) => available.includes(id) && a.indexOf(id) === i);
    return [...named, ...available.filter((id) => !named.includes(id))];
  }, [tb.order, available]);
  const set = (patch: Partial<InkSettings['toolbar']>) => void updateInkSettings((s) => ({ ...s, toolbar: { ...s.toolbar, ...patch } }));
  const modeProfile = mode !== 'all' ? tb.modes[mode] : undefined;
  const hidden = new Set(mode === 'all' ? tb.hidden : (modeProfile?.hidden ?? tb.hidden));
  const setHidden = (next: Set<string>) => {
    if (mode === 'all') set({ hidden: [...next] });
    else set({ modes: { ...tb.modes, [mode]: { hidden: [...next] } } });
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    set({ order: next });
    announce(`نُقلت «${entryInfo(order[i]!).label}» إلى الموضع ${j + 1}.`);
  };
  const suggestion = mode !== 'all' ? MODE_SUGGESTIONS[mode] : undefined;
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-toolbar-h" dir="rtl">
      <h3 id="ink-toolbar-h" className="ml-ink-settings__h">شريط الأدوات</h3>
      <SegmentedControl
        label="مكان الشريط"
        showLabel
        fullWidth
        options={[
          { value: 'top', label: 'في الأعلى' },
          { value: 'start', label: 'جانب البداية' },
          { value: 'end', label: 'جانب النهاية' },
        ]}
        value={tb.dock}
        onValueChange={(v) => set({ dock: v })}
      />
      <p className="ml-ink-options__note">بالعربية: جانب البداية هو يمين الشاشة وجانب النهاية يسارها — اختر الجانب البعيد عن يدك.</p>
      <Switch checked={tb.recent} onCheckedChange={(v) => set({ recent: v })} label="زر للأداة السابقة" description="يعيدك بنقرة إلى الأداة التي استعملتها قبل الحالية." />
      <Switch checked={tb.insert_returns_to_lasso} onCheckedChange={(v) => set({ insert_returns_to_lasso: v })} label="بعد إدراج شيء يعود الشريط إلى التحديد الحر" description="بعد مربع نص أو ملاحظة أو صورة أو رابط أو شكل، يُحدَّد ما أدرجته لتحرّكه أو تغيّر حجمه." />
      <Select
        label="الترتيب والإظهار لـ"
        value={mode}
        options={[{ value: 'all', label: 'كل الأوضاع' }, ...STUDY_MODES.map((m) => ({ value: m, label: `وضع «${STUDY_MODE_LABELS_AR[m]}»` }))]}
        onValueChange={(v) => setMode(v as StudyMode | 'all')}
      />
      {mode !== 'all' && (
        <Switch
          checked={!!modeProfile}
          onCheckedChange={(v) => {
            const modes = { ...tb.modes };
            if (v) modes[mode] = { hidden: [...tb.hidden] };
            else delete modes[mode];
            set({ modes });
          }}
          label={`أدوات خاصة بوضع «${STUDY_MODE_LABELS_AR[mode]}»`}
          description="حين يكون هذا الوضع نشطًا يظهر الشريط بهذه الأدوات. الأداة النشطة تبقى ظاهرة دائمًا."
        />
      )}
      {suggestion && (
        <Button size="sm" variant="secondary" onClick={() => set({ modes: { ...tb.modes, [mode as StudyMode]: { hidden: suggestedHidden(mode as StudyMode, order) } } })}>
          {`طبّق الاقتراح — ${suggestion.label_ar}`}
        </Button>
      )}
      <ol className="ml-ink-tbl" aria-label="أدوات الشريط بترتيبها">
        {order.map((id, i) => {
          const info = entryInfo(id);
          const disabled = mode !== 'all' && !modeProfile;
          return (
            <li key={id} className="ml-ink-tbl__row">
              <span className="ml-ink-tbl__icon" aria-hidden="true">
                {info.icon}
              </span>
              <Switch
                className="ml-ink-tbl__switch"
                checked={!hidden.has(id)}
                disabled={disabled}
                onCheckedChange={(v) => {
                  const next = new Set(hidden);
                  if (v) next.delete(id);
                  else next.add(id);
                  setHidden(next);
                }}
                label={info.label}
              />
              <span className="ml-ink-slot__actions">
                <IconButton size="sm" label={`انقل «${info.label}» إلى الأمام`} icon={<ArrowUp size={16} />} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton size="sm" label={`انقل «${info.label}» إلى الخلف`} icon={<ArrowDown size={16} />} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
              </span>
            </li>
          );
        })}
      </ol>
      <Button size="sm" variant="plain" icon={<RotateCcw size={16} />} onClick={() => set({ order: [], hidden: [], dock: 'top', modes: {} })}>
        أعد الشريط كما كان
      </Button>
    </section>
  );
}

// ─── (parity N1 wave 2) snapping (G22) and the zoom writing window (G09) ─────────────────────────────
function AidsSection() {
  const { inkSettings } = useInkInternal();
  const sn = inkSettings.snap;
  const z = inkSettings.zoom;
  const setSnap = (patch: Partial<InkSettings['snap']>) => void updateInkSettings((s) => ({ ...s, snap: { ...s.snap, ...patch } }));
  const setZoom = (patch: Partial<InkSettings['zoom']>) => void updateInkSettings((s) => ({ ...s, zoom: { ...s.zoom, ...patch } }));
  const pct = (v: number) => `${Math.round(v * 100)}٪`;
  return (
    <section className="ml-ink-settings__section" aria-labelledby="ink-aids-h" dir="rtl">
      <h3 id="ink-aids-h" className="ml-ink-settings__h">المحاذاة</h3>
      <Switch checked={sn.enabled} onCheckedChange={(v) => setSnap({ enabled: v })} label="المحاذاة عند التحريك والرسم" description="حواف ما تحرّكه ومركزه تلتصق بأدلة ظاهرة. اضغط Alt أثناء السحب لتعطيلها مؤقتًا." />
      <fieldset className="ml-ink-feel" disabled={!sn.enabled}>
        <legend className="ml-field__label">تلتصق بـ</legend>
        <Switch checked={sn.items} onCheckedChange={(v) => setSnap({ items: v })} label="حواف العناصر الأخرى ومراكزها" />
        <Switch checked={sn.grid} onCheckedChange={(v) => setSnap({ grid: v })} label="خطوط الورقة (مسطّرة، منقطة، مربعات)" />
        <Switch checked={sn.regions} onCheckedChange={(v) => setSnap({ regions: v })} label="فقرات المحاضرة وأشكالها المعالجة" description="في صفحات المحاضرات: أسطر النص والفقرات وحدود الأشكال كما عالجها الخادم." />
      </fieldset>
      <h3 className="ml-ink-settings__h">نافذة الكتابة المكبّرة</h3>
      <SegmentedControl
        label="اتجاه التقدّم"
        showLabel
        size="sm"
        fullWidth
        options={[
          { value: 'auto', label: 'تلقائي (العربية من اليمين)' },
          { value: 'rtl', label: 'من اليمين إلى اليسار' },
          { value: 'ltr', label: 'من اليسار إلى اليمين' },
        ]}
        value={z.direction}
        onValueChange={(v) => setZoom({ direction: v as InkSettings['zoom']['direction'] })}
      />
      <Switch checked={z.auto_advance} onCheckedChange={(v) => setZoom({ auto_advance: v })} label="تقدّم تلقائي" description="بعد خط يصل إلى الجهة البعيدة من النافذة تتقدّم في اتجاه الكتابة، وفي آخر السطر تعود إلى بداية السطر التالي." />
      <Range id="zoom-line" label="ارتفاع السطر المكتوب" min={0.02} max={0.09} step={0.005} value={z.line_height} text={pct(z.line_height)} onChange={(v) => setZoom({ line_height: Math.round(v * 1000) / 1000 })} />
      <Range id="zoom-start" label="هامش بداية السطر" min={0} max={0.3} step={0.01} value={z.margin_start} text={pct(z.margin_start)} onChange={(v) => setZoom({ margin_start: Math.round(v * 100) / 100 })} />
      <Range id="zoom-end" label="هامش نهاية السطر" min={0} max={0.3} step={0.01} value={z.margin_end} text={pct(z.margin_end)} onChange={(v) => setZoom({ margin_end: Math.round(v * 100) / 100 })} />
      <Range id="zoom-gap" label="المسافة إلى السطر التالي" min={0} max={0.05} step={0.002} value={z.line_gap} text={pct(z.line_gap)} onChange={(v) => setZoom({ line_gap: Math.round(v * 1000) / 1000 })} />
      <SegmentedControl
        label="حجم النافذة"
        showLabel
        size="sm"
        fullWidth
        options={[
          { value: 'small', label: 'صغيرة' },
          { value: 'medium', label: 'متوسطة' },
          { value: 'large', label: 'كبيرة' },
        ]}
        value={z.strip}
        onValueChange={(v) => setZoom({ strip: v as InkSettings['zoom']['strip'] })}
      />
    </section>
  );
}
