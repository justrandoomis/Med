// Ink engine provider: one per open document (contract in ./types.ts).
// Holds the document's ink store (memory + IndexedDB write-through + undo history), the tool
// state with per-tool presets, keyboard shortcuts and the sync applier registration.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { getSyncEngine } from '../../../lib/sync';
import { registerAnnotationApplier } from './persistence';
import { loadLastTool, loadPrefs, presetKeyFor, saveLastTool, savePrefs, clampPresetWidth, type InkPrefs } from './prefs';
import { getDocumentStore, getClipboard, type InkDocumentStore } from './store';
import type { InkController, InkProviderProps, InkToolId, InkToolState } from './types';

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
};

export function isWritingToolId(tool: InkToolId): boolean {
  return tool !== 'hand' && tool !== 'select_text';
}

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

export function InkProvider({ documentKey, children }: InkProviderProps) {
  const store = useMemo(() => getDocumentStore(documentKey), [documentKey]);
  const [prefs, setPrefs] = useState<InkPrefs>(() => loadPrefs());
  const [tool, setToolState] = useState<InkToolId>(() => loadLastTool(documentKey) ?? 'hand');
  const [editing, setEditing] = useState<InkEditing | null>(null);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const historyVersion = useSyncExternalStore(store.history.subscribe, store.history.getVersion, store.history.getVersion);

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
  const toolState: InkToolState = useMemo(
    () => ({
      tool,
      color: preset?.color ?? prefs.presets.pen.color,
      width: preset?.width ?? prefs.presets.pen.width,
      penOnly: prefs.penOnly,
      shapeRecognition: prefs.shapeRecognition,
    }),
    [tool, preset, prefs.presets.pen, prefs.penOnly, prefs.shapeRecognition],
  );
  const toolRef = useRef(toolState);
  toolRef.current = toolState;

  const announce = useCallback((msg: string) => {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(msg), 30);
  }, []);

  const setTool = useCallback(
    (t: InkToolId) => {
      setToolState(t);
      if (t !== 'laser') saveLastTool(documentKey, t);
      updatePrefs((p) => {
        if (t === 'pen' || t === 'fountain' || t === 'ball') return p.lastPen === t ? p : { ...p, lastPen: t };
        if (t === 'eraser_stroke' || t === 'eraser_point') return p.lastEraser === t ? p : { ...p, lastEraser: t };
        if (t === 'line' || t === 'arrow' || t === 'rect' || t === 'ellipse') return p.lastShape === t ? p : { ...p, lastShape: t };
        return p;
      });
      if (t !== 'lasso') store.setSelection(null);
      setEditing(null);
      announce(TOOL_LABELS_AR[t]);
    },
    [documentKey, store, updatePrefs, announce],
  );

  const controller: InkController = useMemo(() => {
    const key = presetKey;
    return {
      toolState,
      setTool,
      setColor: (color: string) => {
        if (!key) return;
        updatePrefs((p) => ({ ...p, presets: { ...p.presets, [key]: { ...p.presets[key], color } } }));
      },
      setWidth: (width: number) => {
        if (!key) return;
        updatePrefs((p) => ({ ...p, presets: { ...p.presets, [key]: { ...p.presets[key], width: clampPresetWidth(key, width) } } }));
      },
      setPenOnly: (v: boolean) => updatePrefs((p) => ({ ...p, penOnly: v })),
      setShapeRecognition: (v: boolean) => updatePrefs((p) => ({ ...p, shapeRecognition: v })),
      undo: () => {
        if (store.undo()) announce('تراجع');
      },
      redo: () => {
        if (store.redo()) announce('إعادة');
      },
      canUndo: store.history.canUndo,
      canRedo: store.history.canRedo,
      isWritingTool: isWritingToolId(toolState.tool),
    };
    // historyVersion: canUndo/canRedo are read from the history object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolState, setTool, updatePrefs, store, presetKey, announce, historyVersion]);

  const internal: InkInternal = useMemo(
    () => ({ documentKey, store, prefs, updatePrefs, toolRef, editing, setEditing, capabilitiesOpen, setCapabilitiesOpen, announce }),
    [documentKey, store, prefs, updatePrefs, editing, capabilitiesOpen, announce],
  );

  // keyboard shortcuts (layout independent: KeyboardEvent.code, so they work on an Arabic layout)
  const latest = useRef({ controller, prefs, tool });
  latest.current = { controller, prefs, tool };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || modalOpen()) return;
      const { controller: c, prefs: p, tool: current } = latest.current;
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
          const order: InkToolId[] = ['line', 'arrow', 'rect', 'ellipse'];
          const i = order.indexOf(current);
          return i >= 0 ? order[(i + 1) % order.length]! : p.lastShape;
        },
      };
      const pick = map[e.code];
      if (pick) {
        e.preventDefault();
        c.setTool(pick());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, announce]);

  return (
    <InkContext.Provider value={controller}>
      <InkInternalContext.Provider value={internal}>
        {children}
        <span className="ml-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      </InkInternalContext.Provider>
    </InkContext.Provider>
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
