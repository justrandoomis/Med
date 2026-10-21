// Ink engine provider: one per open document (contract in ./types.ts).
// Holds the document's ink store (memory + IndexedDB write-through + undo history), the tool
// state with per-tool presets, keyboard shortcuts and the sync applier registration.
//
// (parity N1) Also: the owner's `ink` settings (colour slots and meanings, gestures, palm rejection, pen feel, toolbar
// layout — synced through /api/settings), the pen-feel profile and lasso choice of this document (this device), the view
// filters («اعرض هذا المعنى فقط», «نسخة نظيفة للمراجعة») on the store's visibility seam, the temporary lasso of the
// circle + hold gesture, the recent tool, and the text-editor slot.
import { createContext, useCallback, useContext, useEffect, useInsertionEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type MutableRefObject } from 'react';
import type { InkSettings } from '@medlevo/shared';
import { ConfirmDialog } from '../../../design';
import { getSyncEngine } from '../../../lib/sync';
import { cappedWidth, feelFor, loadFeelProfile, saveFeelProfile, styleFeel, type FeelProfileId } from './feel';
import { meaningOf, slotsFor, useInkSettings } from './inkSettings';
import { contentTypeOf } from './kinds';
import { isInkStroke, isShape } from './model';
import { registerAnnotationApplier } from './persistence';
import { loadLassoPrefs, loadLastTool, loadPrefs, presetKeyFor, saveLassoPrefs, saveLastTool, savePrefs, clampPresetWidth, SHAPE_TOOL_IDS, type InkPrefs, type LassoPrefs, type ShapeToolId } from './prefs';
import { getDocumentStore, getClipboard, type InkDocumentStore, type PendingStep, type StepOutcome } from './store';
import { inkTool, useRegisteredInkTools } from './tools';
import type { InkController, InkProviderProps, InkTextEditorProps, InkToolId, InkToolState } from './types';
import type { RulerState } from './ruler';

/** A text box / sticky note being written (draft = not saved yet; empty drafts are discarded). */
export interface InkEditing {
  targetKey: string;
  kind: 'text' | 'sticky' | 'image';
  /** existing item id, or null for a draft */
  id: string | null;
  /** normalized position for a draft */
  at: [number, number];
}

export interface InkInternal {
  documentKey: string;
  store: InkDocumentStore;
  prefs: InkPrefs;
  updatePrefs: (fn: (p: InkPrefs) => InkPrefs) => void;
  toolRef: MutableRefObject<InkToolState>;
  editing: InkEditing | null;
  setEditing: (e: InkEditing | null) => void;
  capabilitiesOpen: boolean;
  setCapabilitiesOpen: (v: boolean) => void;
  announce: (msg: string) => void;
  // ── (parity N1) ──
  /** the owner's `ink` settings (validated, defaults filled in) */
  inkSettings: InkSettings;
  /** the editor mounted for text boxes (null = the engine's plain-text area) */
  textEditor: ComponentType<InkTextEditorProps> | null;
  /** G01: the pen-feel profile of this document (this device) */
  feelProfile: FeelProfileId;
  setFeelProfile: (p: FeelProfileId) => void;
  /** G17: the lasso's shape and type filter for this document (this device) */
  lasso: LassoPrefs;
  setLasso: (p: LassoPrefs) => void;
  /** G03: «اعرض هذا المعنى فقط» (null = every meaning) */
  legendFilter: string | null;
  setLegendFilter: (meaning: string | null) => void;
  /** G15: «نسخة نظيفة للمراجعة» — content types hidden in this session (empty = everything shown) */
  cleanHidden: ReadonlySet<string>;
  setCleanHidden: (types: ReadonlySet<string>) => void;
  /** G66: the tool used before the current one */
  recentTool: InkToolId | null;
  /** G14: circle + hold selected items: show them with the lasso, and come back to the pen when the selection ends */
  gestureSelect: (targetKey: string, ids: string[]) => void;
  /** G66: an insert tool placed items (hands back to the lasso when the owner chose so) */
  afterInsert: (targetKey: string, ids: string[]) => void;
  /** «إعدادات الكتابة» */
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  // ── (parity N1 wave 2) ──
  /** G08: the ruler on a page of this document (never saved as ink) */
  ruler: RulerState | null;
  setRuler: (r: RulerState | null) => void;
  /** G07: the eyedropper waits for a tap on a page (no EyeDropper API here); null = not waiting */
  colorPick: ((color: string | null) => void) | null;
  setColorPick: (fn: ((color: string | null) => void) | null) => void;
  /** G67: the page menu open on a page (long press, right click, the context-menu key) */
  pageMenu: PageMenuRequest | null;
  setPageMenu: (m: PageMenuRequest | null) => void;
  /** G11: pages shown as their neat copy (a derived view) in this session */
  neatPages: ReadonlySet<string>;
  toggleNeat: (targetKey: string) => void;
  /** G09: the zoom writing window's target (null = closed) */
  zoom: ZoomTarget | null;
  setZoom: (z: ZoomTarget | null) => void;
  /** G08: the page whose educational measurement panel is shown (one panel at a time; null = none yet) */
  measurePage: string | null;
  setMeasurePage: (targetKey: string | null) => void;
}

/** (N1 wave 2, G67) where the page menu was asked for */
export interface PageMenuRequest {
  targetKey: string;
  /** normalized point on the page */
  at: [number, number];
  /** the press was on printed text (the definition / review entries are offered when a host provides them) */
  printed: boolean;
  /** the printed text under the press, when known */
  text?: string | null;
}

/** (N1 wave 2, G09) the page and box the zoom writing window writes into */
export interface ZoomTarget {
  targetKey: string;
  anchor: import('@medlevo/shared').AnnotationAnchor;
  /** page height / page width */
  ar: number;
  /** page size in page units (for the strip's background) */
  pageW: number;
  box: import('@medlevo/shared').NormBox;
  dir: 'rtl' | 'ltr';
}

const InkContext = createContext<InkController | null>(null);
const InkInternalContext = createContext<InkInternal | null>(null);

export const TOOL_LABELS_AR: Record<InkToolId, string> = {
  hand: 'اليد (قراءة وتمرير)',
  select_text: 'تحديد النص',
  pen: 'قلم',
  fountain: 'قلم حبر',
  ball: 'قلم جاف',
  highlighter: 'قلم التظليل',
  eraser_stroke: 'ممحاة الضربة كاملة',
  eraser_point: 'ممحاة جزئية',
  lasso: 'التحديد الحر (Lasso)',
  line: 'خط مستقيم',
  arrow: 'سهم',
  rect: 'مستطيل',
  ellipse: 'شكل بيضاوي',
  text: 'مربع نص',
  sticky: 'ملاحظة لاصقة',
  image: 'إدراج صورة',
  link: 'رابط إلى صفحة',
  laser: 'مؤشر الليزر',
  // (parity N1 wave 2)
  pencil: 'قلم رصاص',
  triangle: 'مثلث',
  polygon: 'مضلّع',
  curved_arrow: 'سهم منحنٍ',
  double_arrow: 'سهم مزدوج',
  connector: 'موصِّل بين الأشكال',
  insert_space: 'أفسح مكانًا',
  measure: 'قياس تعليمي',
  zoom_window: 'نافذة الكتابة المكبّرة',
};

/** The Arabic name of any tool, registered ones included (N1 Wave 0). */
export function toolLabel(tool: InkToolId): string {
  return inkTool(tool)?.label_ar ?? TOOL_LABELS_AR[tool] ?? tool;
}

export function isWritingToolId(tool: InkToolId): boolean {
  return tool !== 'hand' && tool !== 'select_text';
}

const PEN_FAMILY: ReadonlySet<string> = new Set(['pen', 'fountain', 'ball', 'highlighter', 'pencil']);
/** tools that place one thing and are done (G66: they can hand back to the lasso) */
export const INSERT_TOOLS: ReadonlySet<string> = new Set(['text', 'sticky', 'image', 'link', ...SHAPE_TOOL_IDS]);

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(type);
  }
  return false;
}

function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]');
}

export function InkProvider({ documentKey, children, textEditor }: InkProviderProps) {
  const store = useMemo(() => getDocumentStore(documentKey), [documentKey]);
  const [prefs, setPrefs] = useState<InkPrefs>(() => loadPrefs());
  const [tool, setToolState] = useState<InkToolId>(() => loadLastTool(documentKey) ?? 'hand');
  const [editing, setEditing] = useState<InkEditing | null>(null);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const historyVersion = useSyncExternalStore(store.history.subscribe, store.history.getVersion, store.history.getVersion);
  const inkSettings = useInkSettings();
  const registered = useRegisteredInkTools();
  const [feelProfile, setFeelProfileState] = useState<FeelProfileId>(() => loadFeelProfile(documentKey));
  const [lasso, setLassoState] = useState<LassoPrefs>(() => loadLassoPrefs(documentKey));
  const [legendFilter, setLegendFilterState] = useState<string | null>(null);
  const [cleanHidden, setCleanHiddenState] = useState<ReadonlySet<string>>(() => new Set());
  const [recentTool, setRecentTool] = useState<InkToolId | null>(null);
  /** the tool to come back to when a gesture's (or an insert's) lasso selection ends */
  const returnTo = useRef<InkToolId | null>(null);
  // (parity N1 wave 2) session state of the ruler, the eyedropper, the page menu, the neat copy and the zoom window
  const [ruler, setRuler] = useState<RulerState | null>(null);
  const [colorPick, setColorPickState] = useState<((color: string | null) => void) | null>(null);
  const setColorPick = useCallback((fn: ((color: string | null) => void) | null) => setColorPickState(() => fn), []);
  const [pageMenu, setPageMenu] = useState<PageMenuRequest | null>(null);
  const [neatPages, setNeatPages] = useState<ReadonlySet<string>>(() => new Set());
  const [zoom, setZoom] = useState<ZoomTarget | null>(null);
  const [measurePage, setMeasurePage] = useState<string | null>(null);
  /** the tool in use, for callbacks (written at commit) */
  const toolNow = useRef(tool);
  useInsertionEffect(() => {
    toolNow.current = tool;
  });

  useEffect(() => {
    registerAnnotationApplier(getSyncEngine());
  }, []);

  const updatePrefs = useCallback((fn: (p: InkPrefs) => InkPrefs) => {
    setPrefs((p) => {
      const next = fn(p);
      savePrefs(next);
      return next;
    });
  }, []);

  const presetKey = presetKeyFor(tool);
  const preset = presetKey ? prefs.presets[presetKey] : null;
  const toolState: InkToolState = useMemo(() => {
    const color = preset?.color ?? prefs.presets.pen.color;
    const baseWidth = preset?.width ?? prefs.presets.pen.width;
    const pen = PEN_FAMILY.has(tool);
    const slots = presetKey ? slotsFor(inkSettings, presetKey) : null;
    const meaning = slots && preset ? meaningOf(slots, color, preset.slot) : undefined;
    const feel = pen ? styleFeel(feelFor(feelProfile, tool as 'pen', inkSettings)) : undefined;
    // (N1 wave 2, G04) dashes for pens and shapes (a highlighter stays solid)
    const dash = preset?.dash && tool !== 'highlighter' ? preset.dash : undefined;
    return {
      tool,
      color,
      width: pen && tool !== 'highlighter' ? cappedWidth(feelProfile, baseWidth) : baseWidth,
      penOnly: prefs.penOnly,
      shapeRecognition: prefs.shapeRecognition,
      ...(meaning ? { meaning } : {}),
      ...(feel ? { feel } : {}),
      gestures: inkSettings.gestures,
      palm: inkSettings.palm,
      eraserTypes: prefs.eraserTypes,
      lasso,
      ...(dash ? { dash } : {}),
      shapeOptions: prefs.shapeOptions,
      snap: inkSettings.snap,
    };
  }, [tool, preset, presetKey, prefs.presets.pen, prefs.penOnly, prefs.shapeRecognition, prefs.eraserTypes, prefs.shapeOptions, inkSettings, feelProfile, lasso]);
  const toolRef = useRef(toolState);
  // the latest tool for the pointer handlers of every layer, written at commit (before any layout effect) rather than
  // during render
  useInsertionEffect(() => {
    toolRef.current = toolState;
  });

  const announce = useCallback((msg: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(msg), 30);
  }, []);

  const setTool = useCallback(
    (t: InkToolId) => {
      returnTo.current = null;
      const prev = toolNow.current;
      if (prev !== t) setRecentTool(prev);
      toolNow.current = t;
      setToolState(t);
      if (t !== 'laser' && !inkTool(t)) saveLastTool(documentKey, t);
      updatePrefs((p) => {
        if (t === 'pen' || t === 'fountain' || t === 'ball' || t === 'pencil') return p.lastPen === t ? p : { ...p, lastPen: t };
        if (t === 'eraser_stroke' || t === 'eraser_point') return p.lastEraser === t ? p : { ...p, lastEraser: t };
        if ((SHAPE_TOOL_IDS as readonly string[]).includes(t)) return p.lastShape === t ? p : { ...p, lastShape: t as ShapeToolId };
        return p;
      });
      if (t !== 'lasso') store.setSelection(null);
      setEditing(null);
      announce(toolLabel(t));
    },
    [documentKey, store, updatePrefs, announce],
  );

  const setFeelProfile = useCallback(
    (p: FeelProfileId) => {
      setFeelProfileState(p);
      saveFeelProfile(documentKey, p);
    },
    [documentKey],
  );
  const setLasso = useCallback(
    (p: LassoPrefs) => {
      setLassoState(p);
      saveLassoPrefs(documentKey, p);
    },
    [documentKey],
  );

  // ── (G03, G15) view filters on the store's visibility seam: they last for this session and leave with the document ──
  const setLegendFilter = useCallback(
    (meaning: string | null) => {
      setLegendFilterState(meaning);
      store.setViewFilter(
        'legend',
        meaning === null ? null : (it) => !(isInkStroke(it) || isShape(it)) || (it.data as { style?: { meaning?: string } }).style?.meaning === meaning,
        meaning === null ? null : `legend:${meaning}`,
        {
          onCleared: () => {
            setLegendFilterState(null);
            announce('عُرض كل الحبر من جديد: كتبتَ بلون لا يحمل هذا المعنى.');
          },
        },
      );
      announce(meaning === null ? 'يُعرض كل الحبر.' : `يُعرض الحبر الذي معناه «${meaning}» فقط؛ بقية الحبر مخفية مؤقتًا ولم تُحذف.`);
    },
    [store, announce],
  );
  const setCleanHidden = useCallback(
    (types: ReadonlySet<string>) => {
      const set = new Set(types);
      setCleanHiddenState(set);
      store.setViewFilter('clean', set.size === 0 ? null : (it) => !set.has(contentTypeOf(it)), set.size === 0 ? null : `clean:${[...set].sort().join(',')}`, {
        onCleared: () => {
          setCleanHiddenState(new Set());
          announce('عُرض كل شيء من جديد: كتبتَ نوعًا كان مخفيًا في النسخة النظيفة.');
        },
      });
    },
    [store, announce],
  );
  useEffect(
    () => () => {
      store.setViewFilter('legend', null);
      store.setViewFilter('clean', null);
    },
    [store],
  );

  // ── (G14) circle + hold → a lasso selection; (G66) insert → back to the lasso; the pen comes back afterwards ──
  const showSelection = useCallback(
    (targetKey: string, ids: string[], message: string) => {
      const prev = toolNow.current;
      if (prev !== 'lasso') {
        returnTo.current = prev;
        setRecentTool(prev);
      }
      toolNow.current = 'lasso';
      setToolState('lasso');
      setEditing(null);
      store.setSelection({ targetKey, ids });
      announce(message);
    },
    [store, announce],
  );
  const gestureSelect = useCallback(
    (targetKey: string, ids: string[]) => {
      if (ids.length === 0) return;
      showSelection(targetKey, ids, `حُدّد ${ids.length.toLocaleString('ar-EG')} عنصر بالدائرة. Escape يعيدك إلى القلم.`);
    },
    [showSelection],
  );
  const insertReturns = inkSettings.toolbar.insert_returns_to_lasso;
  const afterInsert = useCallback(
    (targetKey: string, ids: string[]) => {
      if (!insertReturns || ids.length === 0) return;
      showSelection(targetKey, ids, 'أُضيف. التحديد الحر نشط الآن لتحريكه أو تغيير حجمه.');
    },
    [insertReturns, showSelection],
  );
  // the gesture's lasso ends with its selection: back to the tool the owner was writing with
  useEffect(
    () =>
      store.subscribeSelection(() => {
        if (store.getSelection() || !returnTo.current) return;
        const back = returnTo.current;
        returnTo.current = null;
        if (back === 'lasso') return;
        toolNow.current = back;
        setToolState(back);
      }),
    [store],
  );

  // (G11) the neat copy, per page, for this session (a view: nothing is written)
  const toggleNeat = useCallback(
    (targetKey: string) => {
      setNeatPages((prev) => {
        const next = new Set(prev);
        if (next.has(targetKey)) next.delete(targetKey);
        else next.add(targetKey);
        announce(next.has(targetKey) ? 'تُعرض النسخة المرتبة لهذه الصفحة (عرض فقط؛ الحبر الأصلي لم يتغير).' : 'عادت الصفحة إلى الحبر كما كتبته.');
        return next;
      });
    },
    [announce],
  );

  const controller: InkController = useMemo(() => {
    const key = presetKey;
    return {
      toolState,
      setTool,
      setColor: (color: string, slot?: number | null) => {
        if (!key) return;
        updatePrefs((p) => {
          const next = { ...p.presets[key], color };
          if (typeof slot === 'number') {
            next.slot = slot;
            // (N1 wave 2, G04) a slot that carries a line pattern brings it with it
            const sl = slotsFor(inkSettings, key)[slot];
            if (sl?.color === color) {
              if (sl.dash) next.dash = sl.dash;
              else delete next.dash;
            }
          } else delete next.slot;
          return { ...p, presets: { ...p.presets, [key]: next } };
        });
      },
      setWidth: (width: number) => {
        if (!key) return;
        updatePrefs((p) => ({ ...p, presets: { ...p.presets, [key]: { ...p.presets[key], width: clampPresetWidth(key, width) } } }));
      },
      setPenOnly: (v: boolean) => updatePrefs((p) => ({ ...p, penOnly: v })),
      setShapeRecognition: (v: boolean) => updatePrefs((p) => ({ ...p, shapeRecognition: v })),
      // (H3 item 1) a step whose writing changed since it was recorded waits for the owner (dialog below)
      undo: () => announce(stepAnnouncement(store.undoStep(), 'تراجع')),
      redo: () => announce(stepAnnouncement(store.redoStep(), 'إعادة')),
      canUndo: store.history.canUndo,
      canRedo: store.history.canRedo,
      isWritingTool: isWritingToolId(toolState.tool),
    };
    // historyVersion: canUndo/canRedo are read from the history object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolState, setTool, updatePrefs, store, presetKey, announce, historyVersion, inkSettings]);

  const internal: InkInternal = useMemo(
    () => ({
      documentKey,
      store,
      prefs,
      updatePrefs,
      toolRef,
      editing,
      setEditing,
      capabilitiesOpen,
      setCapabilitiesOpen,
      announce,
      inkSettings,
      textEditor: textEditor ?? null,
      feelProfile,
      setFeelProfile,
      lasso,
      setLasso,
      legendFilter,
      setLegendFilter,
      cleanHidden,
      setCleanHidden,
      recentTool,
      gestureSelect,
      afterInsert,
      settingsOpen,
      setSettingsOpen,
      ruler,
      setRuler,
      colorPick,
      setColorPick,
      pageMenu,
      setPageMenu,
      neatPages,
      toggleNeat,
      // the zoom writing window is open while its tool is in use (its box is kept for the session)
      zoom: tool === 'zoom_window' ? zoom : null,
      setZoom,
      // the measurement panel belongs to the page measured last, while the tool is in use
      measurePage: tool === 'measure' ? measurePage : null,
      setMeasurePage,
    }),
    [documentKey, store, prefs, updatePrefs, editing, capabilitiesOpen, announce, inkSettings, textEditor, feelProfile, setFeelProfile, lasso, setLasso, legendFilter, setLegendFilter, cleanHidden, setCleanHidden, recentTool, gestureSelect, afterInsert, settingsOpen, ruler, colorPick, setColorPick, pageMenu, neatPages, toggleNeat, zoom, measurePage, tool],
  );

  // keyboard shortcuts (layout independent: KeyboardEvent.code, so they work on an Arabic layout)
  const latest = useRef({ controller, prefs, tool, registered });
  useInsertionEffect(() => {
    latest.current = { controller, prefs, tool, registered };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || modalOpen()) return;
      const { controller: c, prefs: p, tool: current, registered: regs } = latest.current;
      const mod = e.ctrlKey || e.metaKey;
      const sel = store.getSelection();
      if (mod && !e.altKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          if (e.shiftKey) c.redo();
          else c.undo();
          return;
        }
        if (e.code === 'KeyY' && !e.shiftKey) {
          e.preventDefault();
          c.redo();
          return;
        }
        const textSelected = (window.getSelection?.()?.toString() ?? '') !== '';
        if (e.code === 'KeyC' && sel && !textSelected) {
          e.preventDefault();
          announce(`نُسخ ${store.copySelection()} عنصر`);
          return;
        }
        if (e.code === 'KeyV' && getClipboard() && !textSelected) {
          const n = store.paste();
          if (n) {
            e.preventDefault();
            announce(`أُلصق ${n} عنصر`);
          }
          return;
        }
        if (e.code === 'KeyD' && sel) {
          e.preventDefault();
          store.duplicateSelection();
          return;
        }
        return;
      }
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        store.deleteSelection();
        announce('حُذف التحديد');
        return;
      }
      if (e.key === 'Escape' && sel) {
        store.setSelection(null);
        return;
      }
      if (e.shiftKey) return;
      const map: Record<string, () => InkToolId> = {
        KeyP: () => p.lastPen,
        KeyH: () => 'highlighter',
        KeyE: () => (current === 'eraser_stroke' ? 'eraser_point' : current === 'eraser_point' ? 'eraser_stroke' : p.lastEraser),
        KeyL: () => 'lasso',
        KeyT: () => 'text',
        KeyS: () => {
          const order: readonly InkToolId[] = SHAPE_TOOL_IDS;
          const i = order.indexOf(current);
          return i >= 0 ? order[(i + 1) % order.length]! : p.lastShape;
        },
      };
      // (N1 Wave 0) shortcuts of registered tools
      for (const r of regs) if (r.shortcut) map[r.shortcut.code] = () => r.id;
      const pick = map[e.code];
      if (pick) {
        e.preventDefault();
        c.setTool(pick());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, announce]);

  const pending = useSyncExternalStore(store.subscribePending, store.getPendingSnapshot, store.getPendingSnapshot);

  return (
    <InkContext.Provider value={controller}>
      <InkInternalContext.Provider value={internal}>
        {children}
        <span className="ml-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
        <PendingStepDialog
          pending={pending}
          onApply={() => {
            if (store.confirmPendingStep()) announce(pending?.dir === 'redo' ? 'إعادة' : 'تراجع');
          }}
          onSkip={() => {
            store.skipPendingStep();
            announce('تُركت هذه الخطوة؛ لم يتغير شيء من الكتابة.');
          }}
        />
      </InkInternalContext.Provider>
    </InkContext.Provider>
  );
}

function stepAnnouncement(o: StepOutcome, done: string): string {
  if (o === 'done') return done;
  if (o === 'empty') return done === 'تراجع' ? 'لا يوجد ما يُتراجع عنه.' : 'لا يوجد ما يُعاد.';
  if (o === 'checking') return 'يُتحقق من الكتابة على هذا الجهاز قبل تنفيذ الخطوة…';
  return 'هذه الخطوة تحتاج تأكيدك قبل تنفيذها.';
}

/** Number of items in Arabic («عنصر واحد», «عنصران», «3 عناصر», «11 عنصرًا»). */
function itemsAr(n: number): string {
  if (n === 1) return 'عنصر واحد';
  if (n === 2) return 'عنصران';
  return n <= 10 ? `${n} عناصر` : `${n} عنصرًا`;
}

/**
 * (H3 item 1) An undo / redo step whose writing changed since it was recorded — erased on another device (a server
 * tombstone) or edited there — is never applied silently: the owner brings it back on purpose or skips the step.
 */
function PendingStepDialog({ pending, onApply, onSkip }: { pending: PendingStep | null; onApply: () => void; onSkip: () => void }) {
  const what = pending?.dir === 'redo' ? 'إعادة' : 'التراجع عن';
  const parts: string[] = [];
  if (pending?.revive) parts.push(`يعيد ${itemsAr(pending.revive)} من كتابتك حُذف بعد هذه الخطوة (على جهاز آخر أو على الخادم).`);
  if (pending?.changed) parts.push(`${itemsAr(pending.changed)} عُدّل بعد هذه الخطوة على جهاز آخر؛ تنفيذها يعيده إلى ما كان عليه قبل التعديل.`);
  return (
    <ConfirmDialog
      open={!!pending}
      title={pending ? `${what} «${pending.label_ar || 'خطوة'}»` : ''}
      impact={parts.join(' ')}
      confirmLabel={pending?.revive ? 'نفّذها وأعِد الكتابة' : 'نفّذها'}
      cancelLabel="تخطَّ هذه الخطوة"
      onConfirm={onApply}
      onCancel={onSkip}
    />
  );
}

export function useInk(): InkController {
  const ctx = useContext(InkContext);
  if (!ctx) throw new Error('useInk must be used inside <InkProvider>');
  return ctx;
}

export function useInkInternal(): InkInternal {
  const ctx = useContext(InkInternalContext);
  if (!ctx) throw new Error('ink components must be used inside <InkProvider>');
  return ctx;
}
