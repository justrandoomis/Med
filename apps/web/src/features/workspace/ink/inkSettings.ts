// The `ink` part of the owner's settings (parity N1): colour slots and their meanings (G03), gestures (G14), palm
// rejection (G02), the «مخصّص» pen feel (G01) and the toolbar layout (G66).
//
// Stored with the other owner settings (GET / PATCH /api/settings through lib/settings.ts), so it follows the owner to
// every device; the settings store keeps a copy and the unsent change on this device, so it works offline and is sent
// when the connection is back. This module only reads that store and sends the WHOLE `ink` object on each change (a
// partial object would depend on how the store merges), always parsed defensively first.
import { useSyncExternalStore } from 'react';
import { DEFAULT_INK_SETTINGS, INK_MAX_SLOTS, parseInkSettings, type InkSettings, type InkSlot, type InkSlotTool } from '@medlevo/shared';
import { settingsStore } from '../../../lib/settings';
import { HIGHLIGHTER_COLORS, isKnownColor, PEN_COLORS } from './palette';

/** Where the settings live: the app's settings store (tests install an in-memory one). */
export interface InkSettingsBackend {
  get(): unknown;
  subscribe(l: () => void): () => void;
  update(ink: InkSettings): Promise<void>;
}

const appBackend: InkSettingsBackend = {
  get: () => settingsStore.get().settings.ink,
  subscribe: (l) => settingsStore.subscribe(l),
  update: (ink) => settingsStore.update({ ink }),
};

let backend: InkSettingsBackend = appBackend;
let memo: { raw: unknown; parsed: InkSettings } | null = null;
const localListeners = new Set<() => void>();

/** Tests only: replace the backend (null = the app's settings store). */
export function setInkSettingsBackend(b: InkSettingsBackend | null): void {
  backend = b ?? appBackend;
  memo = null;
  localListeners.forEach((l) => l());
}

/** An in-memory backend (tests, the test harness). */
export function memoryInkSettingsBackend(initial: unknown = undefined): InkSettingsBackend & { value: unknown; updates: InkSettings[] } {
  const listeners = new Set<() => void>();
  const b = {
    value: initial,
    updates: [] as InkSettings[],
    get: () => b.value,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    update: async (ink: InkSettings) => {
      b.value = ink;
      b.updates.push(ink);
      listeners.forEach((l) => l());
    },
  };
  return b;
}

/** The current `ink` settings, every part validated (an invalid part falls back to its default). Stable identity. */
export function getInkSettings(): InkSettings {
  let raw: unknown;
  try {
    raw = backend.get();
  } catch {
    raw = undefined;
  }
  if (memo && memo.raw === raw) return memo.parsed;
  const parsed = raw === undefined ? DEFAULT_INK_SETTINGS : parseInkSettings(raw);
  memo = { raw, parsed };
  return parsed;
}

function subscribe(l: () => void): () => void {
  localListeners.add(l);
  const off = backend.subscribe(l);
  return () => {
    localListeners.delete(l);
    off();
  };
}

export function useInkSettings(): InkSettings {
  return useSyncExternalStore(subscribe, getInkSettings, getInkSettings);
}

/** Changes the `ink` settings (applied at once on this device; sent to the server, or kept until the connection is back). */
export function updateInkSettings(fn: (s: InkSettings) => InkSettings): Promise<void> {
  const next = parseInkSettings(fn(getInkSettings()));
  return backend.update(next).catch(() => undefined);
}

// ─── colour slots (G03) ─────────────────────────────────────────────────────────────────────────
/** The built-in slots of a tool: the palette's tokens, without meanings. */
export function defaultSlots(tool: InkSlotTool): InkSlot[] {
  return (tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS).map((c) => ({ color: c.token }));
}

/** The owner's slots for a tool (the built-in ones when none were saved); unknown colours are dropped. */
export function slotsFor(s: InkSettings, tool: InkSlotTool): InkSlot[] {
  const own = s.palettes[tool]?.filter((x) => isKnownColor(x.color));
  return own && own.length ? own : defaultSlots(tool);
}

export function setSlots(tool: InkSlotTool, slots: InkSlot[] | null): Promise<void> {
  return updateInkSettings((s) => {
    const palettes = { ...s.palettes };
    if (slots === null) delete palettes[tool];
    else palettes[tool] = slots.slice(0, INK_MAX_SLOTS);
    return { ...s, palettes };
  });
}

/** The meaning of the slot the owner picked (by its index, else the first slot of that colour). */
export function meaningOf(slots: readonly InkSlot[], color: string, index?: number | null): string | undefined {
  const at = index != null ? slots[index] : undefined;
  if (at && at.color === color) return at.meaning;
  return slots.find((x) => x.color === color)?.meaning;
}

export interface LegendEntry {
  tool: InkSlotTool;
  color: string;
  meaning: string;
}

/** Every slot that carries a meaning, across tools (the colour legend). */
export function legendOf(s: InkSettings): LegendEntry[] {
  const out: LegendEntry[] = [];
  for (const [tool, slots] of Object.entries(s.palettes) as Array<[InkSlotTool, InkSlot[] | undefined]>) {
    for (const x of slots ?? []) if (x.meaning) out.push({ tool, color: x.color, meaning: x.meaning });
  }
  return out;
}
