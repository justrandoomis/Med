// Writing toolbar (spec §26). Compact, one tab stop (design-system Toolbar, RTL arrow keys),
// Arabic names + shortcut hints on every tool, and an overflow menu on narrow screens (390 px).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Circle,
  ClipboardPaste,
  Ellipsis,
  Eraser,
  Hand,
  Highlighter,
  Info,
  Lasso,
  Minus,
  PenLine,
  Pointer,
  Redo2,
  Square,
  StickyNote,
  TextCursor,
  Type,
  Undo2,
} from 'lucide-react';
import { Button, IconButton, Kbd, Menu, MenuItem, MenuSeparator, Popover, SaveStatus, SegmentedControl, Toolbar, Tooltip, cx, isRtl, navKeyFor, stepIndex } from '../../../design';
import { CapabilityDialog } from './CapabilityPanel';
import { TOOL_LABELS_AR, useInk, useInkInternal } from './InkProvider';
import { colorLabel, colorsForTool, isHexColor, resolveInkColor } from './palette';
import { presetKeyFor, WIDTH_RANGE, type PresetKey } from './prefs';
import { currentPaperTone } from './render';
import { getClipboard } from './store';
import type { InkToolId } from './types';

type Family = 'hand' | 'select_text' | 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'text' | 'sticky' | 'laser';

function familyOf(t: InkToolId): Family {
  if (t === 'pen' || t === 'fountain' || t === 'ball') return 'pen';
  if (t === 'eraser_stroke' || t === 'eraser_point') return 'eraser';
  if (t === 'line' || t === 'arrow' || t === 'rect' || t === 'ellipse') return 'shape';
  return t as Family;
}

const FAMILY_ICONS: Record<Family, ReactNode> = {
  hand: <Hand size={18} />,
  select_text: <TextCursor size={18} />,
  pen: <PenLine size={18} />,
  highlighter: <Highlighter size={18} />,
  eraser: <Eraser size={18} />,
  lasso: <Lasso size={18} />,
  shape: <Square size={18} />,
  text: <Type size={18} />,
  sticky: <StickyNote size={18} />,
  laser: <Pointer size={18} />,
};

const FAMILY_LABELS: Record<Family, string> = {
  hand: TOOL_LABELS_AR.hand,
  select_text: TOOL_LABELS_AR.select_text,
  pen: 'القلم',
  highlighter: TOOL_LABELS_AR.highlighter,
  eraser: 'الممحاة',
  lasso: TOOL_LABELS_AR.lasso,
  shape: 'الأشكال',
  text: TOOL_LABELS_AR.text,
  sticky: TOOL_LABELS_AR.sticky,
  laser: TOOL_LABELS_AR.laser,
};

const FAMILY_SHORTCUT: Partial<Record<Family, string>> = { pen: 'P', highlighter: 'H', eraser: 'E', lasso: 'L', shape: 'S', text: 'T' };

const ALL_FAMILIES: Family[] = ['hand', 'select_text', 'pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text', 'sticky', 'laser'];
type Slot = Family | 'options' | 'undo' | 'redo';
/** what keeps a place in the bar first when space is short (the rest moves to «المزيد») */
const PRIORITY: Slot[] = ['pen', 'options', 'undo', 'eraser', 'highlighter', 'hand', 'lasso', 'redo', 'shape', 'text', 'sticky', 'select_text', 'laser'];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

function buttonSize(): number {
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 44 : 40;
  } catch {
    return 40;
  }
}

/** How many controls fit in `width` px (the overflow button always keeps its place). */
export function visibleSlots(width: number, btn: number, gap = 4): Set<Slot> {
  if (!(width > 0)) return new Set(PRIORITY);
  const n = Math.max(1, Math.floor((width - 12 + gap) / (btn + gap)) - 1); // −1: «المزيد»; 12: separator
  return new Set(PRIORITY.slice(0, n));
}

export function InkToolbar() {
  const ink = useInk();
  const { store, prefs, capabilitiesOpen, setCapabilitiesOpen, announce } = useInkInternal();
  const status = useSyncExternalStore(store.subscribeStatus, store.getStatus, store.getStatus);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const historyNoteId = useId();

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tool = ink.toolState.tool;
  const fam = familyOf(tool);
  const pickFamily = (f: Family) => {
    switch (f) {
      case 'pen':
        return ink.setTool(prefs.lastPen);
      case 'eraser':
        return ink.setTool(prefs.lastEraser);
      case 'shape':
        return ink.setTool(prefs.lastShape);
      default:
        return ink.setTool(f as InkToolId);
    }
  };
  const shown = visibleSlots(width, buttonSize());
  const presetKey = presetKeyFor(tool);
  const hasOptions = presetKey !== null || fam === 'eraser';
  const overflow = ALL_FAMILIES.filter((f) => !shown.has(f));
  const clip = getClipboard();
  const compact = width > 0 && overflow.length > 0;

  return (
    <div ref={rootRef} className={cx('ml-ink-toolbar', compact && 'ml-ink-toolbar--compact')} dir="rtl">
      <Toolbar label="أدوات الكتابة">
        {ALL_FAMILIES.filter((f) => shown.has(f)).map((f) => {
          const shortcut = FAMILY_SHORTCUT[f];
          const name = f === fam && f !== 'hand' && f !== 'select_text' ? `${FAMILY_LABELS[f]}: ${TOOL_LABELS_AR[tool]}` : FAMILY_LABELS[f];
          return (
            <Tooltip
              key={f}
              describe={false}
              content={
                <span className="ml-ink-tip">
                  {name}
                  {shortcut && <Kbd>{shortcut}</Kbd>}
                </span>
              }
            >
              <IconButton label={name} icon={FAMILY_ICONS[f]} pressed={fam === f} aria-keyshortcuts={shortcut} onClick={() => pickFamily(f)} />
            </Tooltip>
          );
        })}
        {hasOptions && shown.has('options') && <ToolOptions />}
        <span className="ml-ink-toolbar__sep" aria-hidden="true" />
        {shown.has('undo') && (
          <Tooltip
            describe={false}
            content={
              <span className="ml-ink-tip ml-ink-tip--stack">
                <span>
                  تراجع <Kbd>{`${MOD} Z`}</Kbd>
                </span>
                <span className="ml-ink-tip__note">يبقى السجل ما دام التطبيق مفتوحًا، ويبدأ من جديد بعد إعادة التحميل (الكتابة نفسها محفوظة).</span>
              </span>
            }
          >
            <IconButton label="تراجع" icon={<Undo2 size={18} />} disabled={!ink.canUndo} aria-keyshortcuts="Control+Z Meta+Z" aria-describedby={historyNoteId} onClick={ink.undo} />
          </Tooltip>
        )}
        {shown.has('redo') && (
          <Tooltip describe={false} content={<span className="ml-ink-tip">إعادة <Kbd>{`${MOD} ⇧ Z`}</Kbd></span>}>
            <IconButton label="إعادة" icon={<Redo2 size={18} />} disabled={!ink.canRedo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" onClick={ink.redo} />
          </Tooltip>
        )}
        <Menu label="المزيد من أدوات الكتابة" align="end" trigger={<IconButton label="المزيد من أدوات الكتابة" icon={<Ellipsis size={18} />} />}>
          {!shown.has('undo') && (
            <MenuItem icon={<Undo2 size={16} />} hint={`${MOD} Z`} disabled={!ink.canUndo} disabledReason="لا يوجد ما يُتراجع عنه." onSelect={ink.undo}>
              تراجع
            </MenuItem>
          )}
          {!shown.has('redo') && (
            <MenuItem icon={<Redo2 size={16} />} hint={`${MOD} ⇧ Z`} disabled={!ink.canRedo} disabledReason="لا يوجد ما يُعاد." onSelect={ink.redo}>
              إعادة
            </MenuItem>
          )}
          {overflow.map((f) => (
            <MenuItem key={f} icon={FAMILY_ICONS[f]} hint={fam === f ? 'مفعّلة' : FAMILY_SHORTCUT[f]} onSelect={() => pickFamily(f)}>
              {FAMILY_LABELS[f]}
            </MenuItem>
          ))}
          {(overflow.length > 0 || !shown.has('undo') || !shown.has('redo')) && <MenuSeparator />}
          <MenuItem
            icon={<ClipboardPaste size={16} />}
            hint={`${MOD} V`}
            disabled={!clip || !store.activeTargetKey}
            disabledReason={!clip ? 'لا يوجد ما يُلصق: حدّد كتابة بالتحديد الحر وانسخها أولًا.' : 'المس الصفحة التي تريد اللصق فيها أولًا.'}
            onSelect={() => announce(`أُلصق ${store.paste()} عنصر`)}
          >
            لصق
          </MenuItem>
          <MenuItem onSelect={() => ink.setPenOnly(!ink.toolState.penOnly)} hint={ink.toolState.penOnly ? 'مفعّل' : 'معطّل'}>
            {ink.toolState.penOnly ? 'القلم فقط: مفعّل (الإصبع للتمرير)' : 'القلم فقط: معطّل (الإصبع يكتب)'}
          </MenuItem>
          <MenuItem onSelect={() => ink.setShapeRecognition(!ink.toolState.shapeRecognition)} hint={ink.toolState.shapeRecognition ? 'مفعّل' : 'معطّل'}>
            {ink.toolState.shapeRecognition ? 'تحسين الأشكال عند التوقف: مفعّل' : 'تحسين الأشكال عند التوقف: معطّل'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Info size={16} />} onSelect={() => setCapabilitiesOpen(true)}>
            قدرات القلم على هذا الجهاز
          </MenuItem>
        </Menu>
        {status.state === 'error' && (
          <span className="ml-ink-toolbar__error">
            <SaveStatus state="error" compact detail={status.message} />
            <Button size="sm" variant="plain" onClick={() => store.retrySave()}>
              إعادة الحفظ
            </Button>
          </span>
        )}
      </Toolbar>
      <p id={historyNoteId} className="ml-visually-hidden">سجل التراجع يبقى ما دام التطبيق مفتوحًا؛ بعد إعادة التحميل تبقى الكتابة محفوظة ويبدأ السجل من جديد.</p>
      <CapabilityDialog open={capabilitiesOpen} onClose={() => setCapabilitiesOpen(false)} />
    </div>
  );
}

const PEN_VARIANTS = [
  { value: 'pen', label: 'قلم' },
  { value: 'fountain', label: 'قلم حبر' },
  { value: 'ball', label: 'جاف' },
] as const;
const ERASER_VARIANTS = [
  { value: 'eraser_stroke', label: 'الضربة كاملة' },
  { value: 'eraser_point', label: 'جزئية' },
] as const;
const SHAPE_VARIANTS = [
  { value: 'line', label: 'خط', icon: <Minus size={14} /> },
  { value: 'arrow', label: 'سهم', icon: <ArrowUpRight size={14} /> },
  { value: 'rect', label: 'مستطيل', icon: <Square size={14} /> },
  { value: 'ellipse', label: 'بيضاوي', icon: <Circle size={14} /> },
] as const;

/** Colour / width / variant popover for the current tool. */
function ToolOptions() {
  const ink = useInk();
  const tool = ink.toolState.tool;
  const fam = familyOf(tool);
  const key = presetKeyFor(tool);
  const color = ink.toolState.color;
  const shown = key ? resolveInkColor(color, currentPaperTone(), null) : 'transparent';
  const label = key ? `خيارات ${TOOL_LABELS_AR[tool]}: ${colorLabel(color)}` : `خيارات ${TOOL_LABELS_AR[tool]}`;
  return (
    <Popover
      label={label}
      trigger={
        <IconButton label={label} className="ml-ink-style-btn" icon={key ? <span className="ml-ink-swatch" style={{ background: shown }} /> : <Ellipsis size={18} />} />
      }
    >
      <div className="ml-ink-options" dir="rtl">
        {fam === 'pen' && <SegmentedControl label="نوع القلم" size="sm" fullWidth options={PEN_VARIANTS} value={tool as 'pen'} onValueChange={(v) => ink.setTool(v)} />}
        {fam === 'eraser' && <SegmentedControl label="نوع الممحاة" size="sm" fullWidth options={ERASER_VARIANTS} value={tool as 'eraser_stroke'} onValueChange={(v) => ink.setTool(v)} />}
        {fam === 'shape' && <SegmentedControl label="الشكل" size="sm" fullWidth options={SHAPE_VARIANTS} value={tool as 'line'} onValueChange={(v) => ink.setTool(v)} />}
        {fam === 'eraser' && (
          <p className="ml-ink-options__note">
            {tool === 'eraser_point'
              ? 'الممحاة الجزئية تقسم الخط إلى أجزاء جديدة وتحتفظ بالأصل للتراجع.'
              : 'تمحو كل خط تلمسه. زر الممحاة في القلم (إن وُجد) يمحو دائمًا.'}
          </p>
        )}
        {key && <ColorPicker presetKey={key} />}
        {key && <WidthSlider presetKey={key} />}
      </div>
    </Popover>
  );
}

function ColorPicker({ presetKey }: { presetKey: PresetKey }) {
  const ink = useInk();
  const groupRef = useRef<HTMLDivElement>(null);
  const colors = colorsForTool(presetKey === 'text' ? 'text' : presetKey === 'shape' ? 'shape' : presetKey);
  const current = ink.toolState.color;
  const idx = Math.max(0, colors.findIndex((c) => c.token === current));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(groupRef.current), orientation: 'horizontal' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(idx, step, colors.length, () => false);
    const c = colors[next];
    if (!c) return;
    ink.setColor(c.token);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="ml-ink-options__group">
      <span className="ml-field__label" id={`ink-colors-${presetKey}`}>
        اللون
      </span>
      <div ref={groupRef} role="radiogroup" aria-labelledby={`ink-colors-${presetKey}`} className="ml-ink-colors" onKeyDown={onKeyDown}>
        {colors.map((c, i) => {
          const checked = c.token === current;
          return (
            <button
              key={c.token}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={c.label_ar}
              tabIndex={checked || (i === 0 && !colors.some((x) => x.token === current)) ? 0 : -1}
              className="ml-ink-color"
              onClick={() => ink.setColor(c.token)}
            >
              <span className="ml-ink-swatch" style={{ background: resolveInkColor(c.token, currentPaperTone(), null) }} aria-hidden="true" />
            </button>
          );
        })}
        <label className="ml-ink-color ml-ink-color--custom" data-checked={isHexColor(current) ? '' : undefined}>
          <span className="ml-visually-hidden">لون مخصّص</span>
          <input type="color" value={isHexColor(current) ? current : '#2346c8'} onChange={(e) => ink.setColor(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

function WidthSlider({ presetKey }: { presetKey: PresetKey }) {
  const ink = useInk();
  const r = WIDTH_RANGE[presetKey];
  const steps = 40;
  // logarithmic: fine control for thin pens
  const toSlider = (w: number) => Math.round((Math.log(w / r.min) / Math.log(r.max / r.min)) * steps);
  const fromSlider = (v: number) => r.min * (r.max / r.min) ** (v / steps);
  const value = toSlider(ink.toolState.width);
  const text = presetKey === 'text' ? 'حجم الخط' : 'السماكة';
  const pct = Math.round((value / steps) * 100);
  const preview = Math.max(1, Math.min(24, ink.toolState.width * 600));
  return (
    <div className="ml-ink-options__group">
      <label className="ml-field__label" htmlFor={`ink-width-${presetKey}`}>
        {text}
      </label>
      <div className="ml-ink-width">
        <input
          id={`ink-width-${presetKey}`}
          type="range"
          min={0}
          max={steps}
          step={1}
          value={value}
          aria-valuetext={`${text}: ${pct <= 33 ? 'رفيع' : pct <= 66 ? 'متوسط' : 'عريض'}`}
          onChange={(e) => ink.setWidth(fromSlider(Number(e.target.value)))}
        />
        <span className="ml-ink-width__preview" aria-hidden="true">
          <span style={{ height: preview, background: resolveInkColor(ink.toolState.color, currentPaperTone(), null) }} />
        </span>
      </div>
    </div>
  );
}
