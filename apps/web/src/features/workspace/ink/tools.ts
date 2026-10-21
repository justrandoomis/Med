// Toolbar tool registry (parity N1 Wave 0 seam — docs/research/NOTE_APP_FEATURE_PARITY.md B.3).
//
// Other tracks add a writing tool from their own folder (N4 the tape, N5 the record button): an id (`x:<name>`), an
// icon, an Arabic name, an optional keyboard shortcut (KeyboardEvent.code, so it works on any keyboard layout), an
// optional options panel, and the pointer handler that turns a press on a page into items. The toolbar lists registered
// tools after the built-in ones (the owner can reorder or hide them, G66); the page layer hands pointer input to the
// active registered tool. Writing through `ctx.commit` is one undo step and is saved like every other ink change.
import { useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import type { AnnotationAnchor } from '@medlevo/shared';
import type { ItemChange } from './history';
import type { InkItem } from './model';
import type { InkDocumentStore } from './store';

/** Ids of registered tools. */
export type RegisteredToolId = `x:${string}`;

export function isRegisteredToolId(id: string): id is RegisteredToolId {
  return id.startsWith('x:');
}

/** What a registered tool's pointer handler can use on the page it was pressed on. */
export interface InkToolPointerContext {
  store: InkDocumentStore;
  targetKey: string;
  anchor: AnnotationAnchor;
  /** page height / page width */
  ar: number;
  pointerType: string;
  /** client px → normalized page point (unrotated page box) */
  toNorm(clientX: number, clientY: number): [number, number];
  /** css px → iso units (one iso unit = the page width) */
  pxToIso(px: number): number;
  /** z of the next item on top of the page */
  nextZ(): number;
  /** commits item changes as ONE undo step (saved to this device, then synced) */
  commit(label_ar: string, changes: ItemChange[]): void;
  /** repaint the live layer (call after the session's state changed) */
  requestLive(): void;
  /** tell the owner (screen-reader announcement) */
  announce(message: string): void;
}

/** One press of a registered tool, from pointer down to up / cancel. */
export interface InkToolPointerSession {
  move?(at: [number, number], e: PointerEvent): void;
  up?(at: [number, number], e: PointerEvent): void;
  /** the press was cancelled (another finger, the layer went away): nothing of this press is committed */
  cancel?(): void;
  /** draws the press's preview on the live layer; the context maps page units (W × H) to device pixels */
  drawLive?(ctx: CanvasRenderingContext2D, page: { W: number; H: number }): void;
}

export interface InkToolSpec {
  id: RegisteredToolId;
  label_ar: string;
  icon: ReactNode;
  /** KeyboardEvent.code of the shortcut (e.g. 'KeyK') and how it is shown (e.g. 'K'); never one of the built-ins */
  shortcut?: { code: string; label: string };
  /** a short explanation shown in the tool's options and as its tooltip */
  hint_ar?: string;
  /** options panel content (shown in the toolbar's options popover) */
  Options?: ComponentType;
  /**
   * Called on pointer down on a page while the tool is active. Returns the press's session, or null to ignore the press
   * (e.g. the tool needs something the page does not have).
   */
  pointerDown(ctx: InkToolPointerContext, at: [number, number], e: PointerEvent): InkToolPointerSession | null;
  /** items this tool creates are of this kind (for «احذف كل …» counts and the toolbar's recent slot) */
  creates?: string;
}

const registry = new Map<RegisteredToolId, InkToolSpec>();
const listeners = new Set<() => void>();
let snapshot: InkToolSpec[] = [];
const BUILT_IN_SHORTCUTS = new Set(['KeyP', 'KeyH', 'KeyE', 'KeyL', 'KeyT', 'KeyS', 'KeyZ', 'KeyY', 'KeyC', 'KeyV', 'KeyD']);

function changed() {
  snapshot = [...registry.values()];
  listeners.forEach((l) => l());
}

/** Registers a tool; returns a function that removes it again. */
export function registerInkTool(spec: InkToolSpec): () => void {
  if (!isRegisteredToolId(spec.id)) throw new Error(`ink tool id «${spec.id}» must start with «x:»`);
  if (spec.shortcut && BUILT_IN_SHORTCUTS.has(spec.shortcut.code)) throw new Error(`ink tool «${spec.id}»: shortcut ${spec.shortcut.code} is taken`);
  registry.set(spec.id, spec);
  changed();
  return () => {
    if (registry.get(spec.id) === spec) {
      registry.delete(spec.id);
      changed();
    }
  };
}

export function inkTool(id: string): InkToolSpec | undefined {
  return isRegisteredToolId(id) ? registry.get(id) : undefined;
}

export function registeredInkTools(): InkToolSpec[] {
  return snapshot;
}

export function subscribeInkTools(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The registered tools, re-rendering when one is added or removed. */
export function useRegisteredInkTools(): InkToolSpec[] {
  return useSyncExternalStore(subscribeInkTools, registeredInkTools, registeredInkTools);
}

/** Changes made by a registered tool on items it created (helper for tools: one new item). */
export function newItemChange(targetKey: string, item: InkItem): ItemChange {
  return { id: item.id, targetKey, before: null, after: item };
}
