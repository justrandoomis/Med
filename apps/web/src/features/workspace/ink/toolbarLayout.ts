// The writing toolbar's layout (parity N1, G66): the owner's order, hidden tools, dock side and per-study-mode profiles,
// plus the overflow fit. Pure (unit-tested); InkToolbar.tsx renders it.
import type { InkSettings, StudyMode } from '@medlevo/shared';
import type { InkToolId } from './types';

export type Family =
  | 'hand'
  | 'select_text'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'shape'
  | 'text'
  | 'sticky'
  | 'image'
  | 'link'
  | 'laser'
  // (N1 wave 2) the ruler is a switch (the pen stays the tool); the others are tools
  | 'ruler'
  | 'zoom_window'
  | 'insert_space'
  | 'measure';

export const ALL_FAMILIES: readonly Family[] = ['hand', 'select_text', 'pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text', 'sticky', 'image', 'link', 'laser', 'ruler', 'zoom_window', 'insert_space', 'measure'];

/** what keeps a place in the bar first when space is short (the rest moves to «المزيد») */
export const PRIORITY: readonly string[] = ['pen', 'options', 'undo', 'eraser', 'highlighter', 'hand', 'lasso', 'redo', 'recent', 'shape', 'text', 'sticky', 'image', 'link', 'select_text', 'laser', 'ruler', 'zoom_window', 'insert_space', 'measure'];

/** The toolbar entry of a tool: its family (pens, erasers and shapes share one button) or a registered tool's id. */
export function familyOf(t: InkToolId): string {
  if (t === 'pen' || t === 'fountain' || t === 'ball' || t === 'pencil') return 'pen';
  if (t === 'eraser_stroke' || t === 'eraser_point') return 'eraser';
  if (t === 'line' || t === 'arrow' || t === 'rect' || t === 'ellipse' || t === 'triangle' || t === 'polygon' || t === 'curved_arrow' || t === 'double_arrow' || t === 'connector') return 'shape';
  return t;
}

export interface ToolbarLayout {
  /** every available entry in the owner's order (hidden ones included) */
  order: string[];
  /** entries shown in the bar (the active tool is never hidden) */
  visible: string[];
  hidden: Set<string>;
  dock: InkSettings['toolbar']['dock'];
  vertical: boolean;
  /** the study mode whose profile is in force (null = the general layout) */
  profile: StudyMode | null;
}

/**
 * `available`: the entries this screen offers, in their built-in order (families, then registered tools). The owner's
 * order comes first; entries it does not name keep their built-in place after them.
 */
export function toolbarLayout(available: readonly string[], settings: InkSettings['toolbar'], mode: StudyMode | null, active: string | null): ToolbarLayout {
  const avail = new Set(available);
  const named = settings.order.filter((id, i, a) => avail.has(id) && a.indexOf(id) === i);
  const order = [...named, ...available.filter((id) => !named.includes(id))];
  const profile = mode && settings.modes[mode] ? mode : null;
  const hidden = new Set(profile ? settings.modes[profile]!.hidden : settings.hidden);
  if (active) hidden.delete(active);
  return { order, visible: order.filter((id) => !hidden.has(id)), hidden, dock: settings.dock, vertical: settings.dock !== 'top', profile };
}

/** How many controls fit in `size` px (the overflow button always keeps its place), by priority. */
export function fitSlots(priority: readonly string[], size: number, btn: number, gap = 4): Set<string> {
  if (!(size > 0)) return new Set(priority);
  const n = Math.max(1, Math.floor((size - 12 + gap) / (btn + gap)) - 1); // −1: «المزيد»; 12: separator
  return new Set(priority.slice(0, n));
}

/** The priority of the controls of a layout (with the options, undo and redo buttons): the built-in ranking, then the rest in the owner's order. */
export function layoutPriority(visible: readonly string[], extras: readonly string[]): string[] {
  const vis = new Set([...visible, ...extras, 'options', 'undo', 'redo']);
  const ranked = PRIORITY.filter((id) => vis.has(id));
  return [...ranked, ...visible.filter((id) => !ranked.includes(id))];
}

/** Suggested per-mode profiles (the owner applies them; nothing is hidden by default). */
export const MODE_SUGGESTIONS: Partial<Record<StudyMode, { label_ar: string; keep: readonly string[] }>> = {
  learn: { label_ar: 'تعلّم: اليد والقلم وقلم التظليل', keep: ['hand', 'pen', 'highlighter'] },
  exam: { label_ar: 'امتحن نفسك: اليد والتحديد الحر (والشريط حين يتوفر)', keep: ['hand', 'lasso', 'x:tape'] },
};

/** The hidden list of a suggested profile for these available entries. */
export function suggestedHidden(mode: StudyMode, available: readonly string[]): string[] {
  const keep = new Set(MODE_SUGGESTIONS[mode]?.keep ?? available);
  return available.filter((id) => !keep.has(id));
}
