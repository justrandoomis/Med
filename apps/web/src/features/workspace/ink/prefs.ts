// Per-tool colour/width presets and pen-mode preferences, remembered on this device
// (localStorage, every access wrapped — private mode / blocked storage must never break writing).
import type { InkPenTool } from '@medlevo/shared';
import { isKnownColor } from './palette';
import type { InkToolId } from './types';

export type PresetKey = InkPenTool | 'shape' | 'text';

export interface ToolPreset {
  color: string;
  /** stroke width as a fraction of the page width (text: font size as a fraction of the page width) */
  width: number;
}

export interface InkPrefs {
  presets: Record<PresetKey, ToolPreset>;
  lastPen: 'pen' | 'fountain' | 'ball';
  lastEraser: 'eraser_stroke' | 'eraser_point';
  lastShape: 'line' | 'arrow' | 'rect' | 'ellipse';
  penOnly: boolean;
  shapeRecognition: boolean;
}

export const WIDTH_RANGE: Record<PresetKey, { min: number; max: number }> = {
  pen: { min: 0.0008, max: 0.012 },
  fountain: { min: 0.0008, max: 0.012 },
  ball: { min: 0.0006, max: 0.008 },
  highlighter: { min: 0.008, max: 0.04 },
  shape: { min: 0.0008, max: 0.012 },
  text: { min: 0.014, max: 0.05 },
};

export const DEFAULT_PRESETS: Record<PresetKey, ToolPreset> = {
  pen: { color: 'ink-black', width: 0.0025 },
  fountain: { color: 'ink-blue', width: 0.003 },
  ball: { color: 'ink-blue', width: 0.0018 },
  highlighter: { color: 'hl-yellow', width: 0.018 },
  shape: { color: 'ink-blue', width: 0.0025 },
  text: { color: 'ink-black', width: 0.022 },
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
    }
  }
  return {
    presets,
    lastPen: r.lastPen === 'fountain' || r.lastPen === 'ball' || r.lastPen === 'pen' ? r.lastPen : d.lastPen,
    lastEraser: r.lastEraser === 'eraser_point' || r.lastEraser === 'eraser_stroke' ? r.lastEraser : d.lastEraser,
    lastShape: r.lastShape === 'line' || r.lastShape === 'rect' || r.lastShape === 'ellipse' || r.lastShape === 'arrow' ? r.lastShape : d.lastShape,
    penOnly: typeof r.penOnly === 'boolean' ? r.penOnly : d.penOnly,
    shapeRecognition: typeof r.shapeRecognition === 'boolean' ? r.shapeRecognition : d.shapeRecognition,
  };
}

export function loadPrefs(): InkPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    return parsePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPrefs();
  }
}

export function savePrefs(p: InkPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage unavailable: the choice still applies for this session
  }
}

const TOOL_KEY = 'medlevo.ink.tool.v1:';
const TOOLS: readonly InkToolId[] = ['hand', 'select_text', 'pen', 'fountain', 'ball', 'highlighter', 'eraser_stroke', 'eraser_point', 'lasso', 'line', 'arrow', 'rect', 'ellipse', 'text', 'sticky', 'laser'];

export function loadLastTool(documentKey: string): InkToolId | null {
  try {
    const v = window.localStorage.getItem(TOOL_KEY + documentKey);
    return v && (TOOLS as readonly string[]).includes(v) && v !== 'laser' ? (v as InkToolId) : null;
  } catch {
    return null;
  }
}

export function saveLastTool(documentKey: string, tool: InkToolId): void {
  try {
    window.localStorage.setItem(TOOL_KEY + documentKey, tool);
  } catch {
    // ignore
  }
}

/** Which preset a tool uses. */
export function presetKeyFor(tool: InkToolId): PresetKey | null {
  switch (tool) {
    case 'pen':
    case 'fountain':
    case 'ball':
    case 'highlighter':
      return tool;
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return 'shape';
    case 'text':
      return 'text';
    default:
      return null;
  }
}
