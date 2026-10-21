// Per-tool colour/width presets and pen-mode preferences, remembered on this device
// (localStorage, every access wrapped — private mode / blocked storage must never break writing).
import type { InkPenTool } from '@medlevo/shared';
import { isKnownColor } from './palette';
import type { InkToolId } from './types';
import { userStorage } from '../../../lib/userStorage';

/** (N1 wave 2) the pencil has its own preset (its strokes are stored as pen strokes with a graphite texture) */
export type PresetKey = InkPenTool | 'shape' | 'text' | 'pencil';

export interface ToolPreset {
  color: string;
  /** stroke width as a fraction of the page width (text: font size as a fraction of the page width) */
  width: number;
  /** (N1, G03) index of the colour slot the owner picked (its meaning is saved with each stroke); absent = custom colour */
  slot?: number;
  /** (N1 wave 2, G04) line pattern of new strokes / shapes of this tool (absent = solid) */
  dash?: 'dash' | 'dot';
}

/** (N1 wave 2, G20 / G21) options of new shapes and connectors (this device) */
export interface ShapeOptions {
  head: 'activation' | 'inhibition' | 'conversion' | null;
  /** a fill colour token for closed shapes (null = no fill) */
  fill: string | null;
  /** rounded corners for rectangles */
  corner: boolean;
  route: 'straight' | 'elbow' | 'curve';
}
export const DEFAULT_SHAPE_OPTIONS: ShapeOptions = { head: null, fill: null, corner: false, route: 'straight' };

/** (N1, G15) what the eraser may remove (a stroke of another type under it stays). */
export interface EraserTypes {
  pen: boolean;
  highlighter: boolean;
  shape: boolean;
  /** the reader's highlights on printed text (off by default: the eraser never touched them before N1) */
  text_highlight: boolean;
}

export const DEFAULT_ERASER_TYPES: EraserTypes = { pen: true, highlighter: true, shape: true, text_highlight: false };

export type ShapeToolId = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle' | 'polygon' | 'curved_arrow' | 'double_arrow' | 'connector';
export const SHAPE_TOOL_IDS: readonly ShapeToolId[] = ['line', 'arrow', 'double_arrow', 'curved_arrow', 'rect', 'ellipse', 'triangle', 'polygon', 'connector'];

export interface InkPrefs {
  presets: Record<PresetKey, ToolPreset>;
  lastPen: 'pen' | 'fountain' | 'ball' | 'pencil';
  lastEraser: 'eraser_stroke' | 'eraser_point';
  lastShape: ShapeToolId;
  penOnly: boolean;
  shapeRecognition: boolean;
  /** (N1, G15) the eraser's type filter */
  eraserTypes: EraserTypes;
  /** (N1 wave 2) options of new shapes */
  shapeOptions: ShapeOptions;
}

// ─── local storage (this device). Every access goes through these two helpers, wrapped: private mode / blocked
// storage must never break writing (and the per-user storage of P1-T1 has one place to plug in). ───
export function localGet(key: string): string | null {
  try {
    return userStorage.get(key);
  } catch {
    return null;
  }
}

export function localSet(key: string, value: string | null): void {
  try {
    userStorage.set(key, value);
  } catch {
    // storage unavailable: the choice still applies for this session
  }
}

export const WIDTH_RANGE: Record<PresetKey, { min: number; max: number }> = {
  pen: { min: 0.0008, max: 0.012 },
  fountain: { min: 0.0008, max: 0.012 },
  ball: { min: 0.0006, max: 0.008 },
  highlighter: { min: 0.008, max: 0.04 },
  shape: { min: 0.0008, max: 0.012 },
  text: { min: 0.014, max: 0.05 },
  pencil: { min: 0.0008, max: 0.012 },
};

export const DEFAULT_PRESETS: Record<PresetKey, ToolPreset> = {
  pen: { color: 'ink-black', width: 0.0025 },
  fountain: { color: 'ink-blue', width: 0.003 },
  ball: { color: 'ink-blue', width: 0.0018 },
  highlighter: { color: 'hl-yellow', width: 0.018 },
  shape: { color: 'ink-blue', width: 0.0025 },
  text: { color: 'ink-black', width: 0.022 },
  pencil: { color: 'ink-black', width: 0.0024 },
};

const KEY = 'medlevo.ink.prefs.v1';

function defaultPenOnly(): boolean {
  // phones without a fine pointer: fingers must be able to write by default
  try {
    const coarseOnly = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
    return !coarseOnly;
  } catch {
    return true;
  }
}

export function defaultPrefs(): InkPrefs {
  return {
    presets: structuredClone(DEFAULT_PRESETS),
    lastPen: 'pen',
    lastEraser: 'eraser_stroke',
    lastShape: 'arrow',
    penOnly: defaultPenOnly(),
    shapeRecognition: true,
    eraserTypes: { ...DEFAULT_ERASER_TYPES },
    shapeOptions: { ...DEFAULT_SHAPE_OPTIONS },
  };
}

export function clampPresetWidth(key: PresetKey, w: number): number {
  const r = WIDTH_RANGE[key];
  if (!Number.isFinite(w)) return DEFAULT_PRESETS[key].width;
  return Math.min(r.max, Math.max(r.min, w));
}

/** Parses stored prefs defensively: unknown/invalid values fall back to defaults. */
export function parsePrefs(raw: unknown): InkPrefs {
  const d = defaultPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<InkPrefs>;
  const presets = { ...d.presets };
  if (r.presets && typeof r.presets === 'object') {
    for (const k of Object.keys(presets) as PresetKey[]) {
      const p = (r.presets as Record<string, Partial<ToolPreset>>)[k];
      if (!p) continue;
      presets[k] = {
        color: typeof p.color === 'string' && isKnownColor(p.color) ? p.color : d.presets[k].color,
        width: typeof p.width === 'number' ? clampPresetWidth(k, p.width) : d.presets[k].width,
      };
      if (typeof p.slot === 'number' && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < 12) presets[k].slot = p.slot;
      if (p.dash === 'dash' || p.dash === 'dot') presets[k].dash = p.dash;
    }
  }
  const so = (r.shapeOptions ?? {}) as Partial<ShapeOptions>;
  const shapeOptions: ShapeOptions = {
    head: so.head === 'activation' || so.head === 'inhibition' || so.head === 'conversion' ? so.head : null,
    fill: typeof so.fill === 'string' && isKnownColor(so.fill) ? so.fill : null,
    corner: so.corner === true,
    route: so.route === 'elbow' || so.route === 'curve' ? so.route : 'straight',
  };
  const er = (r.eraserTypes ?? {}) as Partial<EraserTypes>;
  const eraserTypes: EraserTypes = {
    pen: typeof er.pen === 'boolean' ? er.pen : DEFAULT_ERASER_TYPES.pen,
    highlighter: typeof er.highlighter === 'boolean' ? er.highlighter : DEFAULT_ERASER_TYPES.highlighter,
    shape: typeof er.shape === 'boolean' ? er.shape : DEFAULT_ERASER_TYPES.shape,
    text_highlight: typeof er.text_highlight === 'boolean' ? er.text_highlight : DEFAULT_ERASER_TYPES.text_highlight,
  };
  return {
    presets,
    lastPen: r.lastPen === 'fountain' || r.lastPen === 'ball' || r.lastPen === 'pen' || r.lastPen === 'pencil' ? r.lastPen : d.lastPen,
    lastEraser: r.lastEraser === 'eraser_point' || r.lastEraser === 'eraser_stroke' ? r.lastEraser : d.lastEraser,
    lastShape: (SHAPE_TOOL_IDS as readonly string[]).includes(r.lastShape as string) ? (r.lastShape as ShapeToolId) : d.lastShape,
    penOnly: typeof r.penOnly === 'boolean' ? r.penOnly : d.penOnly,
    shapeRecognition: typeof r.shapeRecognition === 'boolean' ? r.shapeRecognition : d.shapeRecognition,
    eraserTypes,
    shapeOptions,
  };
}

export function loadPrefs(): InkPrefs {
  try {
    const raw = localGet(KEY);
    return parsePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: InkPrefs): void {
  localSet(KEY, JSON.stringify(p));
}

// ─── (N1, G17) the lasso's mode and type filter, remembered per document on this device ───
export type LassoMode = 'free' | 'rect';
/** the lasso chips: what a selection may contain */
export interface LassoTypes {
  ink: boolean;
  shape: boolean;
  text: boolean;
  image: boolean;
  link: boolean;
}
export interface LassoPrefs {
  mode: LassoMode;
  types: LassoTypes;
}
export const DEFAULT_LASSO: LassoPrefs = { mode: 'free', types: { ink: true, shape: true, text: true, image: true, link: true } };
const LASSO_KEY = 'medlevo.ink.lasso.v1:';

export function parseLassoPrefs(raw: unknown): LassoPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<LassoPrefs>;
  const t = (r.types && typeof r.types === 'object' ? r.types : {}) as Partial<LassoTypes>;
  const types = { ...DEFAULT_LASSO.types };
  for (const k of Object.keys(types) as Array<keyof LassoTypes>) if (typeof t[k] === 'boolean') types[k] = t[k]!;
  // a filter that lets nothing through would make the lasso look broken: fall back to everything
  const any = Object.values(types).some(Boolean);
  return { mode: r.mode === 'rect' ? 'rect' : 'free', types: any ? types : { ...DEFAULT_LASSO.types } };
}

export function loadLassoPrefs(documentKey: string): LassoPrefs {
  try {
    const raw = localGet(LASSO_KEY + documentKey);
    return parseLassoPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_LASSO, types: { ...DEFAULT_LASSO.types } };
  }
}

export function saveLassoPrefs(documentKey: string, p: LassoPrefs): void {
  localSet(LASSO_KEY + documentKey, JSON.stringify(p));
}

const TOOL_KEY = 'medlevo.ink.tool.v1:';
const TOOLS: readonly InkToolId[] = [
  'hand',
  'select_text',
  'pen',
  'fountain',
  'ball',
  'highlighter',
  'eraser_stroke',
  'eraser_point',
  'lasso',
  'line',
  'arrow',
  'rect',
  'ellipse',
  'text',
  'sticky',
  'laser',
  // (N1 wave 2) the measure tool and the zoom window are not remembered (they open on purpose)
  'pencil',
  'triangle',
  'polygon',
  'curved_arrow',
  'double_arrow',
  'connector',
  'insert_space',
];

export function loadLastTool(documentKey: string): InkToolId | null {
  const v = localGet(TOOL_KEY + documentKey);
  return v && (TOOLS as readonly string[]).includes(v) && v !== 'laser' ? (v as InkToolId) : null;
}

export function saveLastTool(documentKey: string, tool: InkToolId): void {
  localSet(TOOL_KEY + documentKey, tool);
}

/** Which preset a tool uses. */
export function presetKeyFor(tool: InkToolId): PresetKey | null {
  switch (tool) {
    case 'pen':
    case 'fountain':
    case 'ball':
    case 'highlighter':
    case 'pencil':
      return tool;
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
    case 'triangle':
    case 'polygon':
    case 'curved_arrow':
    case 'double_arrow':
    case 'connector':
      return 'shape';
    case 'text':
      return 'text';
    default:
      return null;
  }
}
