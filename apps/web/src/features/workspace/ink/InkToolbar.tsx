// Writing toolbar (spec §26). Compact, one tab stop (design-system Toolbar, RTL arrow keys),
// Arabic names + shortcut hints on every tool, and an overflow menu on narrow screens (390 px).
//
// (parity N1) The owner arranges it (G66: order, hidden tools, dock at the top or on the start / end side, a slot for the
// previous tool, per-study-mode profiles — all in «إعدادات الكتابة», synced with the other settings); tools registered by
// other tracks appear after the built-in ones; the options of the current tool carry the colour slots and their meanings
// (G03), the eraser's type filter (G15) and the lasso's chips and rectangle mode (G17); «المزيد» opens the page actions
// (clear the page, delete by type, the bulk-removal list, the clean review view, the colour legend).
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  ArrowUpRight,
  BetweenHorizontalStart,
  BookOpenCheck,
  Circle,
  DraftingCompass,
  Pentagon,
  Pipette,
  Ruler,
  ScanText,
  Spline,
  Triangle,
  Waypoints,
  ZoomIn,
  ClipboardPaste,
  Ellipsis,
  Eraser,
  Hand,
  Highlighter,
  History,
  ImagePlus,
  Info,
  Lasso,
  Link2,
  ListFilter,
  Minus,
  PenLine,
  Pointer,
  Redo2,
  Settings2,
  SlidersHorizontal,
  Square,
  SquareDashed,
  StickyNote,
  TextCursor,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { CONNECTOR_ROUTE_LABELS_AR, INK_MAX_SLOTS, PATHWAY_HEAD_LABELS_AR, type InkSlot } from '@medlevo/shared';
import { Button, Dialog, IconButton, Kbd, Menu, MenuItem, MenuSeparator, Popover, SaveStatus, SegmentedControl, Toolbar, Tooltip, cx, isRtl, navKeyFor, stepIndex } from '../../../design';
import { CapabilityDialog } from './CapabilityPanel';
import { FEEL_PROFILES, type FeelProfileId } from './feel';
import { InkDialogs, type InkDialogKind } from './InkDialogs';
import { TOOL_LABELS_AR, toolLabel, useInk, useInkInternal } from './InkProvider';
import { InkSettingsDialog } from './InkSettingsDialog';
import { LASSO_CHIP_LABELS_AR, LASSO_CHIPS } from './kinds';
import { colorLabel, isHexColor, resolveInkColor } from './palette';
import { presetKeyFor, WIDTH_RANGE, type EraserTypes, type PresetKey } from './prefs';
import { currentPaperTone } from './render';
import { getClipboard } from './store';
import { useStudyMode } from './studyMode';
import { ALL_FAMILIES, familyOf, fitSlots, layoutPriority, toolbarLayout, type Family } from './toolbarLayout';
import { inkTool, useRegisteredInkTools } from './tools';
import { useInkHost } from './host';
import { insertImage } from './images';
import type { InkToolId } from './types';
// (parity N1 wave 2)
import { eyedropperPath, pickWithApi } from './eyedropper';
import { legendOf, setSlots, slotsFor } from './inkSettings';
import { placeRuler } from './ruler';
import { ZoomWindow } from './zoomWindow';

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
  image: <ImagePlus size={18} />,
  link: <Link2 size={18} />,
  laser: <Pointer size={18} />,
  ruler: <Ruler size={18} />,
  zoom_window: <ZoomIn size={18} />,
  insert_space: <BetweenHorizontalStart size={18} />,
  measure: <DraftingCompass size={18} />,
};

export const FAMILY_LABELS: Record<Family, string> = {
  hand: TOOL_LABELS_AR.hand,
  select_text: TOOL_LABELS_AR.select_text,
  pen: 'القلم',
  highlighter: TOOL_LABELS_AR.highlighter,
  eraser: 'الممحاة',
  lasso: TOOL_LABELS_AR.lasso,
  shape: 'الأشكال',
  text: TOOL_LABELS_AR.text,
  sticky: TOOL_LABELS_AR.sticky,
  image: TOOL_LABELS_AR.image,
  link: TOOL_LABELS_AR.link,
  laser: TOOL_LABELS_AR.laser,
  ruler: 'المسطرة',
  zoom_window: TOOL_LABELS_AR.zoom_window,
  insert_space: TOOL_LABELS_AR.insert_space,
  measure: TOOL_LABELS_AR.measure,
};

const FAMILY_SHORTCUT: Partial<Record<Family, string>> = { pen: 'P', highlighter: 'H', eraser: 'E', lasso: 'L', shape: 'S', text: 'T' };

/** The name, icon and shortcut of a toolbar entry (a family or a registered tool). */
export function entryInfo(id: string): { label: string; icon: ReactNode; shortcut?: string } {
  if ((ALL_FAMILIES as readonly string[]).includes(id)) return { label: FAMILY_LABELS[id as Family], icon: FAMILY_ICONS[id as Family], shortcut: FAMILY_SHORTCUT[id as Family] };
  const t = inkTool(id);
  return { label: t?.label_ar ?? id, icon: t?.icon ?? <SlidersHorizontal size={18} />, shortcut: t?.shortcut?.label };
}

/** The order the overflow decisions used before N1 (kept for the measured fit of the default layout). */
const LEGACY_PRIORITY = ['pen', 'options', 'undo', 'eraser', 'highlighter', 'hand', 'lasso', 'redo', 'shape', 'text', 'sticky', 'image', 'link', 'select_text', 'laser'];

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
export function visibleSlots(width: number, btn: number, gap = 4, without?: string): Set<string> {
  return fitSlots(without ? LEGACY_PRIORITY.filter((p) => p !== without) : LEGACY_PRIORITY, width, btn, gap);
}

export function InkToolbar() {
  const ink = useInk();
  const host = useInkHost();
  const internal = useInkInternal();
  const { store, prefs, capabilitiesOpen, setCapabilitiesOpen, announce, inkSettings, recentTool, settingsOpen, setSettingsOpen, legendFilter, cleanHidden, ruler, setRuler, neatPages, toggleNeat } = internal;
  const status = useSyncExternalStore(store.subscribeStatus, store.getStatus, store.getStatus);
  const registered = useRegisteredInkTools();
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  const [dialog, setDialog] = useState<InkDialogKind | null>(null);
  const [optionsDialog, setOptionsDialog] = useState(false);
  const optionsLabel = useToolOptionsLabel();
  const historyNoteId = useId();
  const tb = inkSettings.toolbar;
  const mode = useStudyMode(Object.keys(tb.modes).length > 0, host?.studyMode);
  const vertical = tb.dock !== 'top';

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setSize(vertical ? Math.max(200, window.innerHeight - 140) : Math.round(el.clientWidth));
    const ro = new ResizeObserver((entries) => (vertical ? measure() : setSize(Math.round(entries[0]?.contentRect.width ?? el.clientWidth))));
    ro.observe(el);
    if (vertical) {
      measure();
      window.addEventListener('resize', measure);
    }
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [vertical]);

  const tool = ink.toolState.tool;
  const fam = familyOf(tool);
  /** the page the owner is on (the ruler and the neat copy act on it) */
  const pageHere = () => store.activeTargetKey ?? host?.currentPage()?.targetKey ?? null;
  const toggleRuler = () => {
    if (ruler) {
      setRuler(null);
      announce('أُخفيت المسطرة.');
      return;
    }
    const key = pageHere();
    if (!key) {
      announce('المس الصفحة التي تريد المسطرة عليها أولًا.');
      return;
    }
    setRuler(placeRuler(key));
    announce('ظهرت المسطرة على الصفحة: اسحبها بإصبع، وأدرها بإصبعين أو بمقبضها أو بـ [ و ]. الخط الذي يبدأ على حافتها يستقيم عليها. لا تُحفظ كحبر.');
  };
  const pickFamily = (f: string) => {
    switch (f) {
      case 'ruler':
        return toggleRuler();
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
  // links need a host that knows the pages they can open (reader / notebook)
  const available = [...ALL_FAMILIES.filter((f) => f !== 'link' || !!host?.links), ...registered.map((r) => r.id)];
  const layout = toolbarLayout(available, tb, mode, fam);
  const recent = tb.recent && recentTool && familyOf(recentTool) !== fam && recentTool !== 'laser' ? recentTool : null;
  const presetKey = presetKeyFor(tool);
  const hasOptions = presetKey !== null || fam === 'eraser' || fam === 'image' || fam === 'link' || fam === 'lasso' || fam === 'insert_space' || fam === 'measure' || fam === 'zoom_window' || !!inkTool(tool)?.Options;
  const defaultLayout = tb.order.length === 0 && layout.hidden.size === 0 && !recent && registered.length === 0 && !vertical;
  // the default layout fits exactly as before N1; an arranged one fits by the same ranking
  const shown = defaultLayout ? visibleSlots(size, buttonSize(), 4, host?.links ? undefined : 'link') : fitSlots(layoutPriority(layout.visible, recent ? ['recent'] : []), size, buttonSize());
  const inBar = layout.visible.filter((id) => shown.has(id));
  const overflow = layout.visible.filter((id) => !shown.has(id));
  const clip = getClipboard();
  const compact = size > 0 && overflow.length > 0;
  const tip = (label: string, shortcut?: string) => (
    <span className="ml-ink-tip">
      {label}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </span>
  );

  const bar = (
    <div ref={rootRef} className={cx('ml-ink-toolbar', compact && 'ml-ink-toolbar--compact', vertical && 'ml-ink-toolbar--docked')} data-dock={tb.dock} data-profile={layout.profile ?? undefined} dir="rtl">
      <Toolbar label="أدوات الكتابة" orientation={vertical ? 'vertical' : 'horizontal'}>
        {inBar.map((id) => {
          const info = entryInfo(id);
          const name = id === fam && id !== 'hand' && id !== 'select_text' && !inkTool(id) ? `${info.label}: ${toolLabel(tool)}` : info.label;
          return (
            <Tooltip key={id} describe={false} content={tip(name, info.shortcut)}>
              <IconButton label={name} icon={info.icon} pressed={id === 'ruler' ? !!ruler : fam === id} aria-keyshortcuts={info.shortcut} onClick={() => pickFamily(id)} />
            </Tooltip>
          );
        })}
        {recent && shown.has('recent') && (
          <Tooltip describe={false} content={tip(`العودة إلى: ${toolLabel(recent)}`)}>
            <IconButton label={`الأداة السابقة: ${toolLabel(recent)}`} icon={<span className="ml-ink-recent">{entryInfo(familyOf(recent)).icon}</span>} onClick={() => ink.setTool(recent)} />
          </Tooltip>
        )}
        {hasOptions && shown.has('options') && <ToolOptions onOpenSettings={() => setSettingsOpen(true)} />}
        <span className="ml-ink-toolbar__sep" aria-hidden="true" />
        {shown.has('undo') && (
          <Tooltip
            describe={false}
            content={
              <span className="ml-ink-tip ml-ink-tip--stack">
                <span>
                  تراجع <Kbd>{`${MOD} Z`}</Kbd>
                </span>
                <span className="ml-ink-tip__note">سجل التراجع محفوظ على هذا الجهاز ويبقى بعد إعادة التحميل أو إغلاق التطبيق (آخر الخطوات ضمن حد للحجم).</span>
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
          {overflow.map((id) => {
            const info = entryInfo(id);
            return (
              <MenuItem key={id} icon={info.icon} hint={(id === 'ruler' ? !!ruler : fam === id) ? 'مفعّلة' : info.shortcut} onSelect={() => pickFamily(id)}>
                {info.label}
              </MenuItem>
            );
          })}
          {hasOptions && !shown.has('options') && (
            <MenuItem icon={<SlidersHorizontal size={16} />} onSelect={() => setOptionsDialog(true)}>
              {`${optionsLabel}…`}
            </MenuItem>
          )}
          {recent && !shown.has('recent') && (
            <MenuItem icon={<History size={16} />} onSelect={() => ink.setTool(recent)}>
              {`الأداة السابقة: ${toolLabel(recent)}`}
            </MenuItem>
          )}
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
          <MenuItem icon={<ListFilter size={16} />} hint={legendFilter ? 'مفعّل' : undefined} onSelect={() => setDialog('legend')}>
            دليل الألوان ومعانيها…
          </MenuItem>
          <MenuItem icon={<BookOpenCheck size={16} />} hint={cleanHidden.size ? 'مفعّلة' : undefined} onSelect={() => setDialog('clean')}>
            نسخة نظيفة للمراجعة…
          </MenuItem>
          {/* (N1 wave 4, G11) the neat copy of the page in view: a derived view, the ink is never changed */}
          <MenuItem
            icon={<ScanText size={16} />}
            hint={(() => {
              const k = pageHere();
              return k && neatPages.has(k) ? 'مفعّلة' : undefined;
            })()}
            disabled={!pageHere()}
            disabledReason="المس الصفحة التي تريد نسختها المرتبة أولًا."
            onSelect={() => {
              const k = pageHere();
              if (k) toggleNeat(k);
            }}
          >
            النسخة المرتبة لهذه الصفحة (عرض فقط)
          </MenuItem>
          <MenuItem icon={<Eraser size={16} />} disabled={!store.activeTargetKey && !host?.currentPage()} disabledReason="المس الصفحة التي تريد مسحها أولًا." onSelect={() => setDialog('clear_page')}>
            امسح الصفحة…
          </MenuItem>
          <MenuItem icon={<Trash2 size={16} />} onSelect={() => setDialog('delete_type')}>
            احذف كل نوع في الدفتر…
          </MenuItem>
          <MenuItem icon={<History size={16} />} onSelect={() => setDialog('trash')}>
            المحذوف بالجملة…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Settings2 size={16} />} onSelect={() => setSettingsOpen(true)}>
            إعدادات الكتابة…
          </MenuItem>
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
      <p id={historyNoteId} className="ml-visually-hidden">سجل التراجع محفوظ على هذا الجهاز ويبقى بعد إعادة التحميل أو إغلاق التطبيق، ضمن حد للحجم تسقط بعده أقدم الخطوات. خطوة تغيّرت كتابتها بعدها على جهاز آخر لا تُنفّذ قبل سؤالك.</p>
      <CapabilityDialog open={capabilitiesOpen} onClose={() => setCapabilitiesOpen(false)} />
      <InkSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} available={available} />
      <InkDialogs open={dialog} onClose={() => setDialog(null)} />
      <ToolOptionsDialog open={optionsDialog && hasOptions} onClose={() => setOptionsDialog(false)} onOpenSettings={() => setSettingsOpen(true)} />
      {/* (N1 wave 2, G09) the docked writing window, while its tool is in use */}
      {internal.zoom && <ZoomWindow />}
    </div>
  );
  // (G66) docked on a side, the bar floats over the page: rendered at the app's root (still inert under a modal), so a
  // header with a backdrop filter or a transform never becomes its containing block (it stays centred on the screen's side)
  return vertical && typeof document !== 'undefined' ? createPortal(bar, document.getElementById('root') ?? document.body) : bar;
}

const PEN_VARIANTS = [
  { value: 'pen', label: 'قلم' },
  { value: 'fountain', label: 'قلم حبر' },
  { value: 'ball', label: 'جاف' },
  { value: 'pencil', label: 'رصاص' },
] as const;
/** (N1 wave 2, G04) line patterns: never colour alone — the name says it */
const DASH_CHOICES = [
  { value: 'solid', label: 'متصل' },
  { value: 'dash', label: 'متقطع' },
  { value: 'dot', label: 'منقّط' },
] as const;
const ERASER_VARIANTS = [
  { value: 'eraser_stroke', label: 'الضربة كاملة' },
  { value: 'eraser_point', label: 'جزئية' },
] as const;
const SHAPE_VARIANTS = [
  { value: 'line', label: 'خط', icon: <Minus size={14} /> },
  { value: 'arrow', label: 'سهم', icon: <ArrowUpRight size={14} /> },
  { value: 'double_arrow', label: 'سهم مزدوج', icon: <ArrowLeftRight size={14} /> },
  { value: 'curved_arrow', label: 'سهم منحنٍ', icon: <Spline size={14} /> },
  { value: 'rect', label: 'مستطيل', icon: <Square size={14} /> },
  { value: 'ellipse', label: 'بيضاوي', icon: <Circle size={14} /> },
  { value: 'triangle', label: 'مثلث', icon: <Triangle size={14} /> },
  { value: 'polygon', label: 'مضلّع', icon: <Pentagon size={14} /> },
  { value: 'connector', label: 'موصِّل', icon: <Waypoints size={14} /> },
] as const;
const LASSO_MODES = [
  { value: 'free', label: 'حر', icon: <Lasso size={14} /> },
  { value: 'rect', label: 'مستطيل', icon: <SquareDashed size={14} /> },
] as const;
const ERASER_TYPES: Array<{ key: keyof EraserTypes; label: string }> = [
  { key: 'pen', label: 'القلم' },
  { key: 'highlighter', label: 'التظليل بالقلم' },
  { key: 'shape', label: 'الأشكال' },
  { key: 'text_highlight', label: 'تظليل النص المطبوع' },
];

/** Colour / width / variant popover for the current tool. */
/** «خيارات قلم: أسود — دواء»: the name of the current tool's options (its colour and the colour's meaning, never colour alone). */
function useToolOptionsLabel(): string {
  const ink = useInk();
  const tool = ink.toolState.tool;
  const key = presetKeyFor(tool);
  const meaning = ink.toolState.meaning;
  // the lasso's options are named by what they hold (a name distinct from the lasso button's own)
  if (tool === 'lasso') return 'خيارات التحديد (الشكل والأنواع)';
  return key ? `خيارات ${toolLabel(tool)}: ${colorLabel(ink.toolState.color)}${meaning ? ` — ${meaning}` : ''}` : `خيارات ${toolLabel(tool)}`;
}

function ToolOptions({ onOpenSettings }: { onOpenSettings: () => void }) {
  const ink = useInk();
  const key = presetKeyFor(ink.toolState.tool);
  const shown = key ? resolveInkColor(ink.toolState.color, currentPaperTone(), null) : 'transparent';
  const label = useToolOptionsLabel();
  return (
    <Popover
      label={label}
      trigger={
        <IconButton label={label} className="ml-ink-style-btn" icon={key ? <span className="ml-ink-swatch" style={{ background: shown }} /> : <SlidersHorizontal size={18} />} />
      }
    >
      <ToolOptionsBody onOpenSettings={onOpenSettings} />
    </Popover>
  );
}

/**
 * (N1) The same options in a dialog, from «المزيد» when the options button has no room in the bar (a narrow bar beside the
 * study rail, a phone): the colour slots and meanings, the eraser filter, the lasso chips and the pen feel stay reachable.
 */
function ToolOptionsDialog({ open, onClose, onOpenSettings }: { open: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const label = useToolOptionsLabel();
  return (
    <Dialog open={open} onClose={onClose} title={label} size="sm">
      {open && <ToolOptionsBody onOpenSettings={onOpenSettings} />}
    </Dialog>
  );
}

/** The options of the current tool (the popover's and the dialog's content). */
function ToolOptionsBody({ onOpenSettings }: { onOpenSettings: () => void }) {
  const ink = useInk();
  const { feelProfile, setFeelProfile } = useInkInternal();
  const tool = ink.toolState.tool;
  const fam = familyOf(tool);
  const key = presetKeyFor(tool);
  const registered = inkTool(tool);
  return (
    <div className="ml-ink-options" dir="rtl">
      {fam === 'pen' && <SegmentedControl label="نوع القلم" size="sm" fullWidth options={PEN_VARIANTS} value={tool as 'pen'} onValueChange={(v) => ink.setTool(v)} />}
      {fam === 'eraser' && <SegmentedControl label="نوع الممحاة" size="sm" fullWidth options={ERASER_VARIANTS} value={tool as 'eraser_stroke'} onValueChange={(v) => ink.setTool(v)} />}
      {fam === 'shape' && <ChoiceChips label="الشكل" options={SHAPE_VARIANTS} value={tool} onChange={(v) => ink.setTool(v as InkToolId)} />}
      {fam === 'shape' && <ShapeOptionsPanel />}
      {((fam === 'pen' && tool !== 'highlighter') || fam === 'shape') && key && <DashChoice presetKey={key} />}
      {fam === 'insert_space' && <p className="ml-ink-options__note">اسحب من حيث تريد المكان: إلى الأسفل يُنزل كل ما كتبته تحت ذلك الخط، وإلى الجانب يزيح ما بعد النقطة على السطر (إلى اليسار في العربية). خطوة تراجع واحدة. النص المطبوع في الملف لا يتحرك.</p>}
      {fam === 'measure' && <p className="ml-ink-options__note">اسحب خطًا لقياس طوله أو خطين لقياس الزاوية بينهما، وعايِر أولًا من شريط مقياس ظاهر في الصورة. النتيجة تقدير تعليمي — ليست قياسًا سريريًا، ولا تُحفظ كحبر.</p>}
      {fam === 'zoom_window' && <p className="ml-ink-options__note">المس الصفحة حيث تريد أن تكتب: تظهر نافذة مكبّرة في أسفل الشاشة، وما تكتبه فيها يُحفظ في ذلك المكان من الصفحة. تتقدّم من اليمين إلى اليسار للعربية.</p>}
      {fam === 'eraser' && (
        <p className="ml-ink-options__note">
          {tool === 'eraser_point'
            ? 'الممحاة الجزئية تقسم الخط إلى أجزاء جديدة وتحتفظ بالأصل للتراجع.'
            : 'تمحو كل خط تلمسه. زر الممحاة في القلم (إن وُجد) يمحو دائمًا.'}
        </p>
      )}
      {fam === 'eraser' && <EraserFilter />}
      {fam === 'lasso' && <LassoOptions />}
      {fam === 'image' && <ImageOptions />}
      {fam === 'link' && <p className="ml-ink-options__note">اسحب مستطيلًا حول ما تريد ربطه (أو المس الصفحة)، ثم اختر الصفحة التي يفتحها. الرابط لا يغيّر الصفحة، ويُفتح بأداة اليد أو تحديد النص، و«العودة» ترجعك.</p>}
      {registered?.hint_ar && <p className="ml-ink-options__note">{registered.hint_ar}</p>}
      {registered?.Options && <registered.Options />}
      {key && <ColorPicker presetKey={key} onEdit={onOpenSettings} />}
      {key && <WidthSlider presetKey={key} />}
      {(fam === 'pen' || fam === 'highlighter') && (
        <SegmentedControl
          label="إحساس القلم في هذا الدفتر"
          showLabel
          size="sm"
          fullWidth
          options={FEEL_PROFILES.map((p) => ({ value: p.id, label: p.label_ar }))}
          value={feelProfile}
          onValueChange={(v) => setFeelProfile(v as FeelProfileId)}
        />
      )}
    </div>
  );
}

/** (N1, G15) what the eraser may remove */
function EraserFilter() {
  const { prefs, updatePrefs } = useInkInternal();
  const t = prefs.eraserTypes;
  return (
    <fieldset className="ml-ink-options__group ml-ink-chips">
      <legend className="ml-field__label">تمحو الممحاة</legend>
      <div className="ml-ink-chips__row">
        {ERASER_TYPES.map((x) => (
          <button
            key={x.key}
            type="button"
            className="ml-ink-chip"
            aria-pressed={t[x.key]}
            onClick={() => {
              const next = { ...t, [x.key]: !t[x.key] };
              // a filter that lets nothing through would make the eraser look broken
              if (!Object.values(next).some(Boolean)) return;
              updatePrefs((p) => ({ ...p, eraserTypes: next }));
            }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <p className="ml-ink-options__note">ما لا تختاره يبقى تحت الممحاة كما هو. النص المطبوع في الملف لا يُمحى أبدًا.</p>
    </fieldset>
  );
}

/** (N1, G17) the lasso's shape and chips, remembered for this document on this device */
function LassoOptions() {
  const { lasso, setLasso } = useInkInternal();
  return (
    <div className="ml-ink-options__group">
      <SegmentedControl label="شكل التحديد" size="sm" fullWidth options={LASSO_MODES} value={lasso.mode} onValueChange={(v) => setLasso({ ...lasso, mode: v })} />
      <fieldset className="ml-ink-chips">
        <legend className="ml-field__label">يحدّد</legend>
        <div className="ml-ink-chips__row">
          {LASSO_CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              className="ml-ink-chip"
              aria-pressed={lasso.types[c]}
              onClick={() => {
                const types = { ...lasso.types, [c]: !lasso.types[c] };
                if (!Object.values(types).some(Boolean)) return;
                setLasso({ ...lasso, types });
              }}
            >
              {LASSO_CHIP_LABELS_AR[c]}
            </button>
          ))}
          <button type="button" className="ml-ink-chip ml-ink-chip--action" onClick={() => setLasso({ ...lasso, types: { ink: true, shape: false, text: false, image: false, link: false } })}>
            حبري فقط
          </button>
        </div>
      </fieldset>
      <p className="ml-ink-options__note">تظليل النص المطبوع لا يُحدَّد ولا يُحرَّك بالتحديد الحر أبدًا.</p>
    </div>
  );
}

/** «اختر صورة…» for the page the owner is on (keyboard path to the image tool; the tap card does the same). */
function ImageOptions() {
  const host = useInkHost();
  const { store, announce } = useInkInternal();
  const [error, setError] = useState<string | null>(null);
  const here = host?.currentPage() ?? null;
  return (
    <div className="ml-ink-options__group">
      <p className="ml-ink-options__note">المس الصفحة حيث تريد الصورة، أو الصقها (Ctrl/⌘ V)، أو اخترها هنا لتوضع في وسط الصفحة الحالية. لا تُغيَّر الصفحة نفسها.</p>
      <label className="ml-ink-linkbtn ml-ink-image-card__pick">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="ml-visually-hidden"
          aria-label="اختر صورة لإدراجها في الصفحة الحالية"
          disabled={!here}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file || !here) return;
            setError(null);
            void insertImage({ store, targetKey: here.targetKey, anchor: here.anchor, file, at: [0.5, 0.4], ar: here.ar, pageWidthPt: here.pageWidthPt }).then((r) => {
              if (r.ok) announce('أُدرجت الصورة في الصفحة الحالية.');
              else setError(r.reason);
            });
          }}
        />
        {here ? 'اختر صورة للصفحة الحالية…' : 'افتح صفحة أولًا'}
      </label>
      {error && (
        <p className="ml-ink-image-card__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** (N1, G03) the tool's colour slots (the owner's own, else the built-in palette), each with its meaning */
function ColorPicker({ presetKey, onEdit }: { presetKey: PresetKey; onEdit: () => void }) {
  const ink = useInk();
  const { inkSettings, prefs, legendFilter, setLegendFilter } = useInkInternal();
  const groupRef = useRef<HTMLDivElement>(null);
  const slots: InkSlot[] = slotsFor(inkSettings, presetKey);
  const current = ink.toolState.color;
  const picked = prefs.presets[presetKey].slot;
  const idx = picked != null && slots[picked]?.color === current ? picked : slots.findIndex((c) => c.color === current);
  const pick = (i: number) => {
    const s = slots[i];
    if (s) ink.setColor(s.color, i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(groupRef.current), orientation: 'horizontal' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(Math.max(0, idx), step, slots.length, () => false);
    pick(next);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  const meanings = legendOf(inkSettings).filter((l) => l.tool === presetKey);
  return (
    <div className="ml-ink-options__group">
      <span className="ml-field__label" id={`ink-colors-${presetKey}`}>
        اللون
      </span>
      <div ref={groupRef} role="radiogroup" aria-labelledby={`ink-colors-${presetKey}`} className="ml-ink-colors" onKeyDown={onKeyDown}>
        {slots.map((c, i) => {
          const checked = i === idx;
          const name = c.meaning ? `${colorLabel(c.color)} — ${c.meaning}` : colorLabel(c.color);
          return (
            <button
              key={`${i}:${c.color}`}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name}
              title={name}
              tabIndex={checked || (i === 0 && idx < 0) ? 0 : -1}
              className="ml-ink-color"
              data-meaning={c.meaning ? '' : undefined}
              onClick={() => pick(i)}
            >
              <span className="ml-ink-swatch" style={{ background: resolveInkColor(c.color, currentPaperTone(), null) }} aria-hidden="true" />
              {/* (review) a visible name, shown on e-ink where every pen colour becomes a near-black grey */}
              <span className="ml-ink-color__name" aria-hidden="true">
                {c.meaning ?? colorLabel(c.color)}
              </span>
            </button>
          );
        })}
        <label className="ml-ink-color ml-ink-color--custom" data-checked={isHexColor(current) && idx < 0 ? '' : undefined}>
          <span className="ml-visually-hidden">لون مخصّص</span>
          <input type="color" value={isHexColor(current) ? current : '#2346c8'} onChange={(e) => ink.setColor(e.target.value)} />
        </label>
      </div>
      {meanings.length > 0 && (
        <p className="ml-ink-options__note" aria-live="off">
          {ink.toolState.meaning ? `يُحفظ مع كل خط: «${ink.toolState.meaning}».` : 'هذا اللون بلا معنى.'}
          {legendFilter ? (
            <button type="button" className="ml-ink-linkbtn" onClick={() => setLegendFilter(null)}>
              اعرض كل المعاني
            </button>
          ) : (
            ink.toolState.meaning && (
              <button type="button" className="ml-ink-linkbtn" onClick={() => setLegendFilter(ink.toolState.meaning!)}>
                {`اعرض «${ink.toolState.meaning}» فقط`}
              </button>
            )
          )}
        </p>
      )}
      {/* (N1 wave 2, G07) */}
      <EyedropperButton presetKey={presetKey} />
      <button type="button" className="ml-ink-linkbtn" onClick={onEdit}>
        رتّب الألوان وسمِّ معانيها…
      </button>
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
  const value = Math.max(0, Math.min(steps, toSlider(ink.toolState.width)));
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

// ─── (parity N1 wave 2) ─────────────────────────────────────────────────────────────────────────────
/** A wrapping group of choice chips (one radio group: one tab stop, arrows move — RTL aware). */
function ChoiceChips({ label, options, value, onChange }: { label: string; options: ReadonlyArray<{ value: string; label: string; icon?: ReactNode }>; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(ref.current), orientation: 'horizontal' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(idx, step, options.length, () => false);
    onChange(options[next]!.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="ml-ink-options__group ml-ink-chips">
      <span className="ml-field__label" id={id}>
        {label}
      </span>
      <div ref={ref} role="radiogroup" aria-labelledby={id} className="ml-ink-chips__row" onKeyDown={onKeyDown}>
        {options.map((o, i) => (
          <button key={o.value} type="button" role="radio" aria-checked={i === idx} tabIndex={i === idx ? 0 : -1} className="ml-ink-chip ml-ink-chip--choice" onClick={() => onChange(o.value)}>
            {o.icon && <span className="ml-ink-chip__icon" aria-hidden="true">{o.icon}</span>}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** (G04) the line pattern of this tool's new strokes / shapes (kept with the tool's preset on this device) */
function DashChoice({ presetKey }: { presetKey: PresetKey }) {
  const { prefs, updatePrefs, announce } = useInkInternal();
  const v = prefs.presets[presetKey].dash ?? 'solid';
  return (
    <SegmentedControl
      label="نمط الخط"
      showLabel
      size="sm"
      fullWidth
      options={DASH_CHOICES}
      value={v}
      onValueChange={(next) => {
        updatePrefs((p) => {
          const preset = { ...p.presets[presetKey] };
          if (next === 'solid') delete preset.dash;
          else preset.dash = next as 'dash' | 'dot';
          return { ...p, presets: { ...p.presets, [presetKey]: preset } };
        });
        announce(next === 'solid' ? 'خط متصل.' : next === 'dash' ? 'خط متقطع (مثلًا: يحتاج تحققًا من المصدر).' : 'خط منقّط (مثلًا: بنى عميقة أو ألم محوَّل).');
      }}
    />
  );
}

const HEAD_CHOICES = [
  { value: 'none', label: 'رأس عادي' },
  { value: 'activation', label: `${PATHWAY_HEAD_LABELS_AR.activation} (→)` },
  { value: 'inhibition', label: `${PATHWAY_HEAD_LABELS_AR.inhibition} (⊣)` },
  { value: 'conversion', label: `${PATHWAY_HEAD_LABELS_AR.conversion} (⇢)` },
] as const;
const ROUTE_CHOICES = (['straight', 'elbow', 'curve'] as const).map((r) => ({ value: r, label: CONNECTOR_ROUTE_LABELS_AR[r] }));
const FILL_CHOICES = [{ value: 'none', label: 'بلا تعبئة' }, ...['hl-yellow', 'hl-green', 'hl-pink', 'hl-blue', 'hl-orange'].map((t) => ({ value: t, label: colorLabel(t) }))];

/** (G20 / G21) options of new shapes: the pathway head of arrows, the fill and corners of closed shapes, a connector's route */
function ShapeOptionsPanel() {
  const ink = useInk();
  const { prefs, updatePrefs } = useInkInternal();
  const tool = ink.toolState.tool;
  const o = prefs.shapeOptions;
  const set = (patch: Partial<typeof o>) => updatePrefs((p) => ({ ...p, shapeOptions: { ...p.shapeOptions, ...patch } }));
  const arrowLike = tool === 'arrow' || tool === 'curved_arrow' || tool === 'double_arrow' || tool === 'connector';
  const closed = tool === 'rect' || tool === 'ellipse' || tool === 'triangle' || tool === 'polygon';
  return (
    <>
      {tool === 'polygon' && <p className="ml-ink-options__note">المس كل زاوية، ثم المس الزاوية الأولى (أو اضغط Enter، أو المس الزاوية الأخيرة مرتين) لإغلاق المضلّع. Escape يلغيه.</p>}
      {tool === 'connector' && <p className="ml-ink-options__note">اسحب من حافة شكل إلى شكل آخر: يتصل الموصِّل بهما ويتبعهما عند تحريكهما. اختر نوع العلاقة الطبية من قائمة التحديد.</p>}
      {arrowLike && <ChoiceChips label="رأس السهم (ترميز المسارات)" options={HEAD_CHOICES} value={o.head ?? 'none'} onChange={(v) => set({ head: v === 'none' ? null : (v as 'activation') })} />}
      {tool === 'connector' && <ChoiceChips label="مسار الموصِّل" options={ROUTE_CHOICES} value={o.route} onChange={(v) => set({ route: v as 'straight' })} />}
      {closed && <ChoiceChips label="التعبئة" options={FILL_CHOICES} value={o.fill ?? 'none'} onChange={(v) => set({ fill: v === 'none' ? null : v })} />}
      {tool === 'rect' && (
        <button type="button" className="ml-ink-chip" aria-pressed={o.corner} onClick={() => set({ corner: !o.corner })}>
          زوايا مستديرة
        </button>
      )}
    </>
  );
}

/**
 * (G07) «التقط لونًا من الصفحة»: the browser's EyeDropper where it exists, else the next tap on the page reads the colour
 * MedLevo drew there. The colour becomes this tool's colour and is kept in its colour slots (synced).
 */
function EyedropperButton({ presetKey }: { presetKey: PresetKey }) {
  const ink = useInk();
  const { inkSettings, announce, setColorPick, colorPick } = useInkInternal();
  const path = eyedropperPath();
  const keep = (hex: string | null) => {
    if (!hex) {
      announce('لم يُقرأ لون في هذا الموضع (لا يوجد ما رُسم هناك). جرّب موضعًا آخر.');
      return;
    }
    const slots = slotsFor(inkSettings, presetKey);
    let index = slots.findIndex((x) => x.color === hex);
    if (index < 0 && slots.length < INK_MAX_SLOTS) {
      index = slots.length;
      void setSlots(presetKey, [...slots, { color: hex }]);
    }
    ink.setColor(hex, index >= 0 ? index : null);
    announce(index >= 0 ? `التُقط اللون ${hex} وحُفظ في ألوانك (الموضع ${(index + 1).toLocaleString('ar-EG')}).` : `التُقط اللون ${hex}. ألوانك ممتلئة (١٢ لونًا): يُستعمل الآن دون أن يُحفظ في موضع.`);
  };
  return (
    <button
      type="button"
      className="ml-ink-linkbtn ml-ink-eyedropper"
      aria-pressed={colorPick ? true : undefined}
      onClick={() => {
        if (path === 'api') {
          void pickWithApi().then((hex) => (hex ? keep(hex) : announce('أُلغي التقاط اللون.')));
          return;
        }
        if (colorPick) {
          setColorPick(null);
          announce('أُلغي التقاط اللون.');
          return;
        }
        setColorPick((hex) => {
          setColorPick(null);
          keep(hex);
        });
        announce('المس الصفحة حيث اللون الذي تريده (صورة نسيجية مثلًا). يُقرأ ما رسمه التطبيق في ذلك الموضع. اضغط الزر مرة أخرى للإلغاء.');
      }}
    >
      <Pipette size={16} aria-hidden="true" />
      {colorPick ? 'المس الصفحة لالتقاط اللون… (إلغاء)' : 'التقط لونًا من الصفحة'}
    </button>
  );
}
