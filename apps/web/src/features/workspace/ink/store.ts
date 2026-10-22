// In-memory model of one open document's ink (all its pages), the write-through to IndexedDB and
// the undo history. The UI updates synchronously from memory; persistence is queued (strictly in
// order) and never awaited by input handling (§55: writing never waits for storage or network).
//
// (Academic OS P1-T2 — the parity plan's N1 Wave 0 «visibility predicate» seam, ADR-0004 R5) `setVisibility(fn)` and
// `setEditability(fn)` decide which items are drawn, hit, erased and lassoed, and which can be moved, recoloured, re-
// stacked or deleted (items of read-only layers can still be selected and COPIED). `setActiveLayer(id)` names the
// layer new writing goes to (null = the default personal layer «ملاحظاتي»). Layers (ink/layers/*) set them; with
// nothing set every item is visible and editable exactly as before.
import { newId, stableStringify, type AnnotationAnchor, type NormBox } from '@medlevo/shared';
import { getDb, type MedLevoDB } from '../../../lib/localdb';
import { broadcast, onAnnotationRowsChanged, type AnnotationRowsChanged } from './events';
import { InkHistory, invertChanges, type Command, type ItemChange } from './history';
import { loadHistory, saveHistory } from './historyLog';
import { unionBox, type Mat } from './math';
import {
  cloneItem,
  isEngineItem,
  itemBBox,
  itemFromRow,
  recolorItem,
  rewidthItem,
  transformItem,
  withLock,
  withZ,
  type InkItem,
} from './model';
import { loadRows, loadTarget, persistChanges } from './persistence';
import { followConnectors, reattachCopy } from './connectors';
import { SpatialGrid } from './spatial';

export type PageEvent =
  | { kind: 'items'; dirty: NormBox[] | 'all'; ids: string[] }
  | { kind: 'selection' }
  | { kind: 'hidden'; ids: string[] }
  | { kind: 'loaded' }
  /** (P1-T2) the layer view changed (visibility / editability); `store.visibilityKey` tells whether drawing changed */
  | { kind: 'view' };

export interface PageModel {
  targetKey: string;
  anchor: AnnotationAnchor | null;
  /** pageHeight / pageWidth */
  ar: number;
  items: Map<string, InkItem>;
  index: SpatialGrid;
  loaded: boolean;
  loading: Promise<void> | null;
  listeners: Set<(e: PageEvent) => void>;
  /** ids changed in memory before the initial load finished (the load must not overwrite them) */
  touchedBeforeLoad: Set<string>;
  maxZ: number;
  minZ: number;
}

export interface InkSelection {
  targetKey: string;
  ids: string[];
}

export type PersistStatus = { state: 'idle' | 'saving' } | { state: 'error'; message: string };

/**
 * (H3 item 1) What an undo / redo did: applied (`done`), nothing to do (`empty`), waiting for the owner because the
 * step's items changed since it was recorded (`confirm` — see `getPendingStep`), or checking this device's copy of
 * items on pages that are not open (`checking`, settles by itself).
 */
export type StepOutcome = 'done' | 'empty' | 'confirm' | 'checking';

/**
 * A step that is not applied silently: `revive` items were erased (by another device / the server) after the step and
 * the step would bring them back; `changed` items were changed elsewhere since and the step would overwrite that.
 */
export interface PendingStep {
  dir: 'undo' | 'redo';
  label_ar: string;
  revive: number;
  changed: number;
}

/** null = absent or tombstoned */
function aliveItem(it: InkItem | null | undefined): InkItem | null {
  return it && !it.deleted_at ? it : null;
}
function itemState(it: InkItem): string {
  return stableStringify({ kind: it.kind, tool: it.tool, anchor: it.anchor, data: it.data, layer: it.layer, z: it.z, locked: it.locked });
}
function sameState(a: InkItem | null, b: InkItem | null): boolean {
  if (!a || !b) return a === b;
  return a === b || itemState(a) === itemState(b);
}

const NUDGE_LABEL = 'تحريك بالأسهم';

const SAVE_ERROR_AR = 'تعذّر حفظ الكتابة على هذا الجهاز (مساحة التخزين ممتلئة أو محجوبة). ما زالت ظاهرة أمامك؛ ستُعاد محاولة الحفظ مع الكتابة التالية.';

/** Copied items (shared by every open document → copy on one page, paste on another). */
let clipboard: { items: InkItem[]; ar: number; from: string } | null = null;

export function getClipboard() {
  return clipboard;
}

export class InkDocumentStore {
  readonly history = new InkHistory();
  private pages = new Map<string, PageModel>();
  private hidden = new Set<string>();
  private selection: InkSelection | null = null;
  activeTargetKey: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  /**
   * id → page of every item whose last IndexedDB write failed: memory is ahead of IndexedDB, so it
   * is never refreshed from it, and the retry writes the item's CURRENT state (never the stale
   * change that failed — a later successful write of the same item supersedes it).
   */
  private failed = new Map<string, string>();
  /**
   * (review of N1 wave 1) the state each failed write meant to store. An item the engine does not hold in memory — on a
   * page that is not open (a bulk delete, an undo after a reload) or of a kind the reader draws (a text highlight) — has
   * no «current state» to retry with: the retry writes this one instead (never a tombstone in place of a restore).
   */
  private failedIntent = new Map<string, InkItem | null>();
  private inFlight = new Map<string, number>();
  private status: PersistStatus = { state: 'idle' };
  private statusListeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private unsubscribeEvents: () => void;
  private selectionVersion = 0;
  /** (H3 item 1) resolves once the command log of this document was read back from IndexedDB */
  readonly historyReady: Promise<void>;
  private historySave: Promise<void> = Promise.resolve();
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private historyDirty = false;
  private unsubscribeHistory: () => void = () => undefined;
  private removePageHide: () => void = () => undefined;
  private pending: (PendingStep & { cmd: Command; changes: ItemChange[] }) | null = null;
  private checking: Promise<void> | null = null;
  private pendingListeners = new Set<() => void>();
  /** (P1-T2) visibility / editability predicates and the layer new writing goes to */
  private visibleFn: ((it: InkItem) => boolean) | null = null;
  private editableFn: ((it: InkItem) => boolean) | null = null;
  private activeLayer: string | null = null;
  private visibleKey = '';
  private visibleSeq = 0;
  private activeLayerScope: ((it: InkItem) => boolean) | null = null;
  private layerViewVersion = 0;
  private layerViewListeners = new Set<() => void>();
  /** called when new writing lands on a layer that is hidden in this session (the host shows it again) */
  onWriteToHiddenLayer: ((layerId: string | null) => void) | null = null;
  /**
   * (N1 Wave 0) named view filters ANDed with the layers' predicate: the colour-legend filter, «نسخة نظيفة للمراجعة», an
   * export toggle (N5). Each has a key (the same visible set → the same key, so cached tiles are reused).
   */
  private viewFilters = new Map<string, { fn: (it: InkItem) => boolean; key: string; onCleared?: () => void }>();
  /** Called when new writing lands on a layer hidden in this session (the layers view shows it again). */
  setWriteToHiddenLayerHandler(fn: ((layerId: string | null) => void) | null): void {
    this.onWriteToHiddenLayer = fn;
  }

  constructor(
    readonly documentKey: string,
    private readonly db: MedLevoDB = getDb(),
    private readonly now: () => number = Date.now,
    opts: { persistHistory?: boolean } = {},
  ) {
    this.unsubscribeEvents = onAnnotationRowsChanged((e) => {
      // a failed refresh must never surface as an unhandled rejection; the page keeps what it shows
      this.onExternalChange(e).catch(() => undefined);
    });
    if (opts.persistHistory === false) {
      this.historyReady = Promise.resolve();
      return;
    }
    // the history survives a reload / closing the app (H3 item 1): read the log, then keep it written
    this.historyReady = loadHistory(db, documentKey)
      .then((saved) => {
        if (saved) this.history.restore(saved.undo, saved.redo);
      })
      .catch(() => undefined);
    this.unsubscribeHistory = this.history.subscribe(() => this.scheduleHistorySave());
    if (typeof window !== 'undefined') {
      const hide = () => void this.flushHistory();
      window.addEventListener('pagehide', hide);
      this.removePageHide = () => window.removeEventListener('pagehide', hide);
    }
  }

  /** (N1) this device's database (bulk actions read pages that are not open). */
  get localDb(): MedLevoDB {
    return this.db;
  }

  dispose(): void {
    this.unsubscribeEvents();
    this.unsubscribeHistory();
    this.removePageHide();
    if (this.historyDirty) void this.flushHistory();
  }

  // ── the command log (H3 item 1) ──
  private scheduleHistorySave(): void {
    this.historyDirty = true;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      void this.flushHistory();
    }, 400);
  }

  /** Writes the command log now (also on page hide; a failed write keeps the in-memory history as it is). */
  flushHistory(): Promise<void> {
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    this.historySave = this.historySave
      .then(() => this.historyReady)
      .then(async () => {
        if (!this.historyDirty) return;
        this.historyDirty = false;
        const { undo, redo } = this.history.snapshot();
        await saveHistory(this.db, this.documentKey, undo, redo, this.now());
      })
      .catch(() => {
        this.historyDirty = true;
      });
    return this.historySave;
  }

  // ── pages ──
  attachPage(targetKey: string, anchor: AnnotationAnchor | null, ar: number): PageModel {
    let page = this.pages.get(targetKey);
    if (!page) {
      page = {
        targetKey,
        anchor,
        ar: ar > 0 && Number.isFinite(ar) ? ar : 1,
        items: new Map(),
        index: new SpatialGrid(),
        loaded: false,
        loading: null,
        listeners: new Set(),
        touchedBeforeLoad: new Set(),
        maxZ: 0,
        minZ: 0,
      };
      this.pages.set(targetKey, page);
    } else {
      if (anchor) page.anchor = anchor;
      if (ar > 0 && Number.isFinite(ar) && Math.abs(ar - page.ar) > 1e-9) {
        page.ar = ar;
        this.reindex(page);
      }
    }
    if (!page.loaded && !page.loading) page.loading = this.load(page);
    return page;
  }

  page(targetKey: string): PageModel | undefined {
    return this.pages.get(targetKey);
  }

  whenLoaded(targetKey: string): Promise<void> {
    return this.pages.get(targetKey)?.loading ?? Promise.resolve();
  }

  private reindex(page: PageModel) {
    page.index.clear();
    for (const it of page.items.values()) page.index.insert(it.id, itemBBox(it, page.ar));
  }

  private async load(page: PageModel): Promise<void> {
    try {
      const items = await loadTarget(this.db, page.targetKey);
      for (const it of items) {
        if (page.touchedBeforeLoad.has(it.id) || page.items.has(it.id)) continue;
        this.putInMemory(page, it);
      }
    } catch {
      // IndexedDB unavailable: the page still accepts writing in memory; saving reports the error
    } finally {
      page.loaded = true;
      page.loading = null;
      page.touchedBeforeLoad.clear();
      this.emit(page, { kind: 'loaded' });
      this.emit(page, { kind: 'items', dirty: 'all', ids: [] });
    }
  }

  subscribePage(targetKey: string, l: (e: PageEvent) => void): () => void {
    const page = this.pages.get(targetKey);
    if (!page) throw new Error('attachPage first');
    page.listeners.add(l);
    return () => page.listeners.delete(l);
  }

  private emit(page: PageModel, e: PageEvent) {
    page.listeners.forEach((l) => l(e));
  }

  items(targetKey: string): InkItem[] {
    const page = this.pages.get(targetKey);
    return page ? [...page.items.values()] : [];
  }

  item(targetKey: string, id: string): InkItem | undefined {
    return this.pages.get(targetKey)?.items.get(id);
  }

  query(targetKey: string, box: NormBox): InkItem[] {
    const page = this.pages.get(targetKey);
    if (!page) return [];
    const out: InkItem[] = [];
    for (const id of page.index.query(box)) {
      const it = page.items.get(id);
      if (it) out.push(it);
    }
    return out;
  }

  // ── (P1-T2) layers: visibility / editability predicates (render, hit-test, eraser, lasso) ──
  /** Items for which `fn` is false are not drawn, hit, erased or lassoed. `null` = every item is visible. */
  setVisibility(fn: ((it: InkItem) => boolean) | null, key: string | null = null): void {
    this.visibleFn = fn;
    // the same visible set → the same key (cached tiles of that set are reused); an anonymous predicate → a new key
    this.visibleKey = fn ? (key ?? `anon:${++this.visibleSeq}`) : '';
    this.layerViewChanged();
  }
  /**
   * (N1 Wave 0) A named view filter, applied with the layers' predicate wherever `isVisible` is asked (render, hit-test,
   * eraser, lasso, the page summary). `null` removes it. `onCleared` runs when the store drops the filter because new
   * writing would be hidden by it (the owner always sees what they write).
   */
  setViewFilter(name: string, fn: ((it: InkItem) => boolean) | null, key: string | null = null, opts: { onCleared?: () => void } = {}): void {
    if (!fn) {
      if (!this.viewFilters.delete(name)) return;
    } else {
      this.viewFilters.set(name, { fn, key: key ?? `anon:${++this.visibleSeq}`, onCleared: opts.onCleared });
    }
    this.layerViewChanged();
  }
  /** The names of the view filters in force. */
  viewFilterNames(): string[] {
    return [...this.viewFilters.keys()];
  }
  /** Names the current visible set ('' = everything visible); the tile cache keys its grids by it. */
  get visibilityKey(): string {
    if (this.viewFilters.size === 0) return this.visibleKey;
    const parts = [...this.viewFilters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, f]) => `${n}=${f.key}`);
    return `${this.visibleKey}|${parts.join('|')}`;
  }
  /** Items for which `fn` is false can be selected and copied but never moved, recoloured, restacked or deleted. */
  setEditability(fn: ((it: InkItem) => boolean) | null): void {
    this.editableFn = fn;
    this.layerViewChanged();
  }
  /**
   * The layer new writing goes to (`layer_id`; null = the default personal layer). `scope`: the items it applies to
   * (another document's page in the same store — the split pane — gets its own default layer instead).
   */
  setActiveLayer(layerId: string | null, scope: ((it: InkItem) => boolean) | null = null): void {
    this.activeLayerScope = scope;
    if (this.activeLayer === layerId) return;
    this.activeLayer = layerId;
    this.layerViewVersion++;
    this.layerViewListeners.forEach((l) => l());
  }
  getActiveLayer = (): string | null => this.activeLayer;
  isVisible(it: InkItem): boolean {
    if (this.visibleFn && !this.visibleFn(it)) return false;
    if (this.viewFilters.size) for (const f of this.viewFilters.values()) if (!f.fn(it)) return false;
    return true;
  }
  isEditable(it: InkItem): boolean {
    return !this.editableFn || this.editableFn(it);
  }
  getLayerViewVersion = (): number => this.layerViewVersion;
  subscribeLayerView = (l: () => void): (() => void) => {
    this.layerViewListeners.add(l);
    return () => this.layerViewListeners.delete(l);
  };
  private layerViewChanged(): void {
    this.layerViewVersion++;
    // a selection may now hold items that are hidden: drop those (read-only ones stay selectable for copying)
    const sel = this.selection;
    if (sel) {
      const page = this.pages.get(sel.targetKey);
      const keep = sel.ids.filter((id) => {
        const it = page?.items.get(id);
        return !!it && this.isVisible(it);
      });
      if (keep.length !== sel.ids.length) this.setSelection(keep.length ? { targetKey: sel.targetKey, ids: keep } : null);
      else if (page) this.emit(page, { kind: 'selection' });
    }
    for (const page of this.pages.values()) this.emit(page, { kind: 'view' });
    this.layerViewListeners.forEach((l) => l());
  }

  /**
   * (N1) Items of a kind the engine does not hold in memory (the reader's text highlights), read fresh from this
   * device's storage — the eraser and «امسح الصفحة» work on the stored state, never on a stale copy.
   */
  async loadForeignItems(targetKey: string, kind: string): Promise<InkItem[]> {
    try {
      const rows = await this.db.annotations.where('[targetKey+kind]').equals([targetKey, kind]).toArray();
      return rows.filter((r) => !r.deletedAt).map(itemFromRow);
    } catch {
      return [];
    }
  }

  /** (N1 wave 2) the page the owner wrote on last (paste, «امسح الصفحة» without a host) */
  markActive(targetKey: string): void {
    this.activeTargetKey = targetKey;
  }

  nextZ(targetKey: string): number {
    return (this.pages.get(targetKey)?.maxZ ?? 0) + 1;
  }

  private putInMemory(page: PageModel, it: InkItem) {
    page.items.set(it.id, it);
    page.index.insert(it.id, itemBBox(it, page.ar));
    if (it.z > page.maxZ) page.maxZ = it.z;
    if (it.z < page.minZ) page.minZ = it.z;
  }

  private removeFromMemory(page: PageModel, id: string) {
    page.items.delete(id);
    page.index.remove(id);
  }

  // ── hidden (being transformed / point-erased: drawn by the live layer instead) ──
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }
  setHidden(targetKey: string, ids: readonly string[], hidden: boolean): void {
    const page = this.pages.get(targetKey);
    let changed = false;
    for (const id of ids) {
      if (hidden ? !this.hidden.has(id) : this.hidden.has(id)) {
        if (hidden) this.hidden.add(id);
        else this.hidden.delete(id);
        changed = true;
      }
    }
    if (changed && page) this.emit(page, { kind: 'hidden', ids: [...ids] });
  }

  // ── commits ──
  /**
   * Apply changes in memory now, record them for undo, persist them in order. Returns immediately.
   * `record: false` for undo/redo themselves.
   */
  commit(label_ar: string, changes: ItemChange[], opts: { record?: boolean; amend?: boolean } = {}): void {
    let real = changes.filter((c) => c.before !== c.after);
    if (real.length === 0) return;
    // (P1-T2) new writing goes to the active layer (an item that names its layer — an undo, a split piece — keeps it).
    // With «ملاحظاتي» active nothing is stamped: the item stays exactly as written and lands on the default layer.
    const isNew = (c: ItemChange) => !c.before && !!c.after && c.after.layer_id === undefined;
    if (real.some(isNew)) {
      const layer = this.activeLayer;
      const scope = this.activeLayerScope;
      if (layer) real = real.map((c) => (isNew(c) && (!scope || scope(c.after!)) ? { ...c, after: { ...c.after!, layer_id: layer } } : c));
      if (this.visibleFn && real.some((c) => !c.before && c.after && !this.visibleFn!(c.after))) this.onWriteToHiddenLayer?.(layer);
      // (N1) a view filter that would hide the new writing is lifted (and its owner told, to say so)
      if (this.viewFilters.size) {
        const lifted = [...this.viewFilters.entries()].filter(([, f]) => real.some((c) => !c.before && c.after && isEngineItem(c.after) && !f.fn(c.after)));
        if (lifted.length) {
          for (const [name] of lifted) this.viewFilters.delete(name);
          this.layerViewChanged();
          for (const [, f] of lifted) f.onCleared?.();
        }
      }
    }
    // (N1 wave 2, G21) connectors attached to a shape this step moves, resizes or turns follow it in the SAME step (an
    // undo / redo replays the recorded states, attachments included)
    if (opts.record !== false) real = this.withFollowers(real);
    this.applyInMemory(real);
    if (opts.record !== false) {
      if (opts.amend) this.history.amendLast(real, label_ar || undefined);
      else this.history.push({ label_ar, changes: real });
    }
    this.persist(real);
  }

  /** (N1 wave 2, G21) the step's changes plus the connectors that follow the shapes it changed */
  private withFollowers(changes: ItemChange[]): ItemChange[] {
    if (!changes.some((c) => c.after?.kind === 'shape')) return changes;
    let out = changes;
    const now = this.now();
    for (const targetKey of new Set(changes.map((c) => c.targetKey))) {
      const page = this.pages.get(targetKey);
      if (!page) continue;
      const follow = followConnectors(page.items, out, targetKey, page.ar, now);
      if (follow.length === 0) continue;
      const byId = new Map(follow.map((f) => [f.id, f]));
      out = out.map((c) => (c.targetKey === targetKey && byId.has(c.id) ? { ...c, after: byId.get(c.id)!.after } : c));
      const present = new Set(out.filter((c) => c.targetKey === targetKey).map((c) => c.id));
      out = [...out, ...follow.filter((f) => !present.has(f.id) && this.isEditable(f.before!) && !f.before!.locked)];
    }
    return out;
  }

  private applyInMemory(changes: readonly ItemChange[]) {
    const byPage = new Map<PageModel, { dirty: NormBox[]; ids: string[] }>();
    for (const c of changes) {
      const page = this.pages.get(c.targetKey);
      if (!page) continue;
      let acc = byPage.get(page);
      if (!acc) byPage.set(page, (acc = { dirty: [], ids: [] }));
      const prev = page.items.get(c.id);
      if (prev) acc.dirty.push(itemBBox(prev, page.ar));
      // (N1) kinds the engine only erases (the reader's text highlights) are written, never held in the page memory
      if (c.after && !c.after.deleted_at && isEngineItem(c.after)) {
        this.putInMemory(page, c.after);
        acc.dirty.push(itemBBox(c.after, page.ar));
      } else {
        this.removeFromMemory(page, c.id);
      }
      acc.ids.push(c.id);
      if (!page.loaded) page.touchedBeforeLoad.add(c.id);
    }
    for (const [page, acc] of byPage) {
      if (this.selection?.targetKey === page.targetKey) {
        const keep = this.selection.ids.filter((id) => page.items.has(id));
        if (keep.length !== this.selection.ids.length) this.setSelection(keep.length ? { targetKey: page.targetKey, ids: keep } : null);
      }
      this.emit(page, { kind: 'items', dirty: acc.dirty, ids: acc.ids });
    }
  }

  private persist(changes: ItemChange[]) {
    for (const c of changes) this.inFlight.set(c.id, (this.inFlight.get(c.id) ?? 0) + 1);
    const retry = this.retryChanges(changes);
    const batch = retry.length ? [...retry, ...changes] : changes;
    if (batch.length === 0) return;
    this.setStatus({ state: 'saving' });
    this.chain = this.chain.then(async () => {
      try {
        const keys = await persistChanges(this.db, batch, this.now());
        // whatever failed before for these ids is now superseded by what was just written
        for (const c of batch) {
          this.failed.delete(c.id);
          this.failedIntent.delete(c.id);
        }
        broadcast(keys, batch.map((c) => c.id));
        if (this.failed.size === 0) this.setStatus({ state: 'idle' });
      } catch {
        // keep the changes in memory and try them again with the next write (never dropped)
        for (const c of batch) {
          this.failed.set(c.id, c.targetKey);
          this.failedIntent.set(c.id, c.after);
        }
        this.setStatus({ state: 'error', message: SAVE_ERROR_AR });
      } finally {
        for (const c of changes) {
          const n = (this.inFlight.get(c.id) ?? 1) - 1;
          if (n <= 0) this.inFlight.delete(c.id);
          else this.inFlight.set(c.id, n);
        }
      }
    });
  }

  /**
   * Items whose earlier write failed, as changes carrying their CURRENT in-memory state (null =
   * removed → tombstone). Ids that the new batch writes anyway are skipped (the batch has the
   * newest state). Built when the write is queued; ids leave `failed` only once a write of them
   * succeeds. (Review of N1 wave 1) An item the engine does not hold in memory — its page is not open, or it is a kind
   * the reader draws — is retried with the state its failed write meant to store.
   */
  private retryChanges(changes: readonly ItemChange[]): ItemChange[] {
    if (this.failed.size === 0) return [];
    const inBatch = new Set(changes.map((c) => c.id));
    const out: ItemChange[] = [];
    for (const [id, targetKey] of this.failed) {
      if (inBatch.has(id)) continue;
      const page = this.pages.get(targetKey);
      const intent = this.failedIntent.get(id);
      const inMemory = !!page?.loaded && (intent === undefined || intent === null || isEngineItem(intent));
      const current = inMemory ? (page!.items.get(id) ?? null) : (intent ?? page?.items.get(id) ?? null);
      out.push({ id, targetKey, before: null, after: current });
    }
    return out;
  }

  /** Resolves when every queued write reached IndexedDB (tests, page unload). */
  flush(): Promise<void> {
    return this.chain;
  }

  /** Retry writes that failed (also happens automatically with the next write). */
  retrySave(): void {
    if (this.failed.size === 0) return;
    this.persist([]);
  }

  getStatus = (): PersistStatus => this.status;
  subscribeStatus = (l: () => void): (() => void) => {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  };
  private setStatus(s: PersistStatus) {
    if (s.state === this.status.state && (s.state !== 'error' || (this.status.state === 'error' && this.status.message === s.message))) return;
    this.status = s;
    this.statusListeners.forEach((l) => l());
  }

  /** Undo the last step (see `undoStep`); false when there is nothing to undo. */
  undo(): boolean {
    return this.undoStep() !== 'empty';
  }

  redo(): boolean {
    return this.redoStep() !== 'empty';
  }

  /**
   * (H3 item 1) Undo with a check: the step is applied only if its items are still as it left them. An item erased
   * since (another device, a server tombstone) that the step would bring back, or an item changed elsewhere that it
   * would overwrite, makes it wait for the owner (`getPendingStep` → `confirmPendingStep` / `skipPendingStep`). Items
   * of pages that are not open are checked against this device's copy first (`checking`).
   */
  undoStep(): StepOutcome {
    return this.step('undo');
  }

  redoStep(): StepOutcome {
    return this.step('redo');
  }

  /**
   * (AOS-1.24) how many items the last undo / redo left alone because they now carry another person's writing (the
   * announcement says so; 0 in every single-writer case).
   */
  lastForeign = 0;

  getPendingStep = (): PendingStep | null => (this.pending ? { dir: this.pending.dir, label_ar: this.pending.label_ar, revive: this.pending.revive, changed: this.pending.changed } : null);
  private pendingSnapshot: PendingStep | null = null;
  /** stable snapshot for useSyncExternalStore */
  getPendingSnapshot = (): PendingStep | null => this.pendingSnapshot;
  subscribePending = (l: () => void): (() => void) => {
    this.pendingListeners.add(l);
    return () => this.pendingListeners.delete(l);
  };
  private setPending(p: (PendingStep & { cmd: Command; changes: ItemChange[] }) | null): void {
    this.pending = p;
    this.pendingSnapshot = this.getPendingStep();
    this.pendingListeners.forEach((l) => l());
  }

  /** Resolves when an asynchronous step check has finished (tests). */
  stepSettled(): Promise<void> {
    return this.checking ?? Promise.resolve();
  }

  /** The owner chose to apply the pending step anyway (bringing the erased writing back on purpose). */
  confirmPendingStep(): boolean {
    const p = this.pending;
    if (!p) return false;
    this.setPending(null);
    const top = p.dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (top !== p.cmd) return false; // the history moved on meanwhile
    this.apply(p.dir, p.changes);
    return true;
  }

  /** The owner chose to skip the pending step: it leaves the history; nothing is changed. */
  skipPendingStep(): void {
    const p = this.pending;
    if (!p) return;
    this.setPending(null);
    const top = p.dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (top === p.cmd) this.history.drop(p.dir);
  }

  private step(dir: 'undo' | 'redo'): StepOutcome {
    if (this.pending) return 'confirm';
    if (this.checking) return 'checking';
    const cmd = dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (!cmd) return 'empty';
    const changes = dir === 'undo' ? invertChanges(cmd.changes) : cmd.changes.map((c) => ({ ...c }));
    // pages that are not open, and kinds the engine does not hold in memory (N1: text highlights), are checked against
    // this device's stored copy
    const unloaded = changes.filter((c) => !this.pages.get(c.targetKey)?.loaded || !isEngineChange(c));
    if (unloaded.length === 0) return this.decide(dir, cmd, changes, (c) => this.memoryState(c));
    const ids = unloaded.map((c) => c.id);
    this.checking = loadRows(this.db, ids)
      .then((rows) => {
        const stored = new Map(ids.map((id, i) => [id, aliveItem(rows[i] && !rows[i]!.deletedAt ? itemFromRow(rows[i]!) : null)]));
        const top = dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
        if (top !== cmd) return;
        this.decide(dir, cmd, changes, (c) => (this.pages.get(c.targetKey)?.loaded && isEngineChange(c) ? this.memoryState(c) : (stored.get(c.id) ?? null)));
      })
      .catch(() => undefined)
      .finally(() => {
        this.checking = null;
      });
    return 'checking';
  }

  private memoryState(c: ItemChange): InkItem | null {
    return aliveItem(this.pages.get(c.targetKey)?.items.get(c.id));
  }

  private decide(dir: 'undo' | 'redo', cmd: Command, changes: ItemChange[], current: (c: ItemChange) => InkItem | null): StepOutcome {
    let revive = 0;
    let changed = 0;
    let foreign = 0;
    const effective: ItemChange[] = [];
    for (const c of changes) {
      const now = current(c);
      const expected = aliveItem(c.before);
      const target = aliveItem(c.after);
      // (AOS-1.24) undo / redo revert only this account's OWN operations: an item that now carries another person's
      // writing (another author than the step left — a multi-writer layer, or a copy re-attributed to someone else) is
      // never changed by this account's history, not even after «نفّذها». The change leaves the step.
      if (now && authorOf(now) !== authorOf(expected ?? target)) {
        foreign++;
        continue;
      }
      if (sameState(now, target)) continue; // already as the step wants it (e.g. removing what was erased elsewhere)
      effective.push(c);
      if (sameState(now, expected)) continue;
      if (!now && expected) revive += target ? 1 : 0; // erased after the step (another device / server tombstone)
      else changed++; // changed elsewhere since: the step would overwrite it
    }
    if (revive === 0 && changed === 0) {
      this.apply(dir, effective);
      this.lastForeign = foreign;
      return 'done';
    }
    this.lastForeign = foreign;
    this.setPending({ dir, label_ar: cmd.label_ar, revive, changed, cmd, changes: effective });
    return 'confirm';
  }

  private apply(dir: 'undo' | 'redo', changes: ItemChange[]): void {
    const top = dir === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
    if (dir === 'undo') this.history.undo();
    else this.history.redo();
    // (H3 review) only what was applied can be redone / undone again: a change skipped because the item was already as
    // the step wanted it (erased elsewhere) never comes back silently with the opposite step
    if (top && changes.length !== top.changes.length) {
      const applied = new Set(changes.map((c) => c.id));
      this.history.narrowTop(dir === 'undo' ? 'redo' : 'undo', (c) => applied.has(c.id));
    }
    if (changes.length) this.commit('', changes, { record: false });
  }

  private busy(id: string): boolean {
    return this.inFlight.has(id) || this.failed.has(id);
  }

  // ── changes coming from sync (pull / push results) or other tabs ──
  private async onExternalChange(e: AnnotationRowsChanged) {
    for (const key of e.targetKeys) {
      const page = this.pages.get(key);
      if (!page || !page.loaded) continue;
      if (e.ids === null) {
        const items = await loadTarget(this.db, key);
        const live = new Set(items.map((i) => i.id));
        const dirty: NormBox[] = [];
        for (const id of [...page.items.keys()]) {
          if (!live.has(id) && !this.busy(id)) {
            dirty.push(itemBBox(page.items.get(id)!, page.ar));
            this.removeFromMemory(page, id);
          }
        }
        for (const it of items) {
          if (this.busy(it.id)) continue;
          const prev = page.items.get(it.id);
          // (P1-T2) an item that did not change (same revision and time) is left as it is: no repaint, and the tile
          // cache of a dense page stays warm when a whole-page reload brings the same rows back
          if (prev && sameRow(prev, it)) continue;
          if (prev) dirty.push(itemBBox(prev, page.ar));
          this.putInMemory(page, it);
          dirty.push(itemBBox(it, page.ar));
        }
        if (dirty.length) this.emit(page, { kind: 'items', dirty, ids: [] });
        continue;
      }
      const ids = e.ids.filter((id) => !this.busy(id));
      if (ids.length === 0) continue;
      const rows = await loadRows(this.db, ids);
      const dirty: NormBox[] = [];
      ids.forEach((id, i) => {
        if (this.busy(id)) return;
        const row = rows[i];
        const prev = page.items.get(id);
        if (prev) dirty.push(itemBBox(prev, page.ar));
        const item = row && !row.deletedAt && row.targetKey === key ? itemFromRow(row) : null;
        if (item && isEngineItem(item)) {
          this.putInMemory(page, item);
          dirty.push(itemBBox(item, page.ar));
        } else if (prev) {
          this.removeFromMemory(page, id);
        }
      });
      if (dirty.length) this.emit(page, { kind: 'items', dirty, ids });
    }
  }

  // ── selection ──
  getSelection = (): InkSelection | null => this.selection;
  getSelectionVersion = (): number => this.selectionVersion;
  subscribeSelection = (l: () => void): (() => void) => {
    this.selectionListeners.add(l);
    return () => this.selectionListeners.delete(l);
  };

  setSelection(sel: InkSelection | null): void {
    const prev = this.selection;
    this.selection = sel && sel.ids.length ? sel : null;
    this.selectionVersion++;
    if (prev) {
      const p = this.pages.get(prev.targetKey);
      if (p) this.emit(p, { kind: 'selection' });
    }
    if (this.selection && this.selection.targetKey !== prev?.targetKey) {
      const p = this.pages.get(this.selection.targetKey);
      if (p) this.emit(p, { kind: 'selection' });
    }
    this.selectionListeners.forEach((l) => l());
  }

  selectedItems(): InkItem[] {
    const sel = this.selection;
    if (!sel) return [];
    const page = this.pages.get(sel.targetKey);
    if (!page) return [];
    return sel.ids.map((id) => page.items.get(id)).filter((x): x is InkItem => !!x);
  }

  selectionBBox(): NormBox | null {
    const sel = this.selection;
    const page = sel ? this.pages.get(sel.targetKey) : undefined;
    if (!sel || !page) return null;
    let b: NormBox | null = null;
    for (const it of this.selectedItems()) b = unionBox(b, itemBBox(it, page.ar));
    return b;
  }

  // ── selection actions (each is ONE undo step) ──
  private editSelection(label_ar: string, fn: (it: InkItem, now: number) => InkItem | null, opts: { includeLocked?: boolean } = {}): void {
    const sel = this.selection;
    if (!sel) return;
    const now = this.now();
    const changes: ItemChange[] = [];
    for (const it of this.selectedItems()) {
      // (P1-T2, R5) items of a read-only layer are copied, never changed or deleted
      if (!this.isEditable(it)) continue;
      if (it.locked && !opts.includeLocked) continue;
      const after = fn(it, now);
      if (after !== it) changes.push({ id: it.id, targetKey: sel.targetKey, before: it, after });
    }
    this.commit(label_ar, changes);
  }

  transformSelection(m: Mat): void {
    const page = this.selection ? this.pages.get(this.selection.targetKey) : undefined;
    if (!page) return;
    this.editSelection('نقل/تحجيم/تدوير', (it, now) => transformItem(it, m, page.ar, now));
  }

  private lastNudge: { at: number; ids: string } | null = null;
  /**
   * (N1, G19) Moves the selection by an iso offset (arrow keys). Presses within a second of each other on the same
   * selection are one undo step.
   */
  nudgeSelection(dx: number, dy: number): void {
    const sel = this.selection;
    const page = sel ? this.pages.get(sel.targetKey) : undefined;
    if (!sel || !page) return;
    const now = this.now();
    const ids = sel.ids.slice().sort().join(',');
    const top = this.history.peekUndo();
    const amend = !!this.lastNudge && this.lastNudge.ids === ids && now - this.lastNudge.at < 1000 && top?.label_ar === NUDGE_LABEL;
    const m: Mat = [1, 0, 0, 1, dx, dy];
    const changes: ItemChange[] = [];
    for (const it of this.selectedItems()) {
      if (!this.isEditable(it) || it.locked) continue;
      const after = transformItem(it, m, page.ar, now);
      if (after !== it) changes.push({ id: it.id, targetKey: sel.targetKey, before: it, after });
    }
    if (changes.length === 0) return;
    this.commit(NUDGE_LABEL, changes, { amend });
    this.lastNudge = { at: now, ids };
  }

  /** `meaning` (N1, G03): the meaning of the colour slot picked (null = none; undefined = keep each item's). */
  recolorSelection(color: string, meaning?: string | null): void {
    this.editSelection('تغيير اللون', (it, now) => recolorItem(it, color, now, meaning));
  }

  rewidthSelection(width: number): void {
    this.editSelection('تغيير السماكة', (it, now) => rewidthItem(it, width, now));
  }

  deleteSelection(): void {
    this.editSelection('حذف', () => null);
    this.setSelection(null);
  }

  setSelectionLocked(locked: boolean): void {
    this.editSelection(locked ? 'قفل' : 'فك القفل', (it, now) => (it.locked === locked ? it : withLock(it, locked, now)), { includeLocked: true });
  }

  /** Bring the selection to the front (`up`) or send it to the back. */
  restackSelection(up: boolean): void {
    const sel = this.selection;
    const page = sel ? this.pages.get(sel.targetKey) : undefined;
    if (!sel || !page) return;
    const items = this.selectedItems().sort((a, b) => a.z - b.z);
    let z = up ? page.maxZ + 1 : page.minZ - items.length;
    const now = this.now();
    const changes: ItemChange[] = [];
    for (const it of items) {
      if (it.locked || !this.isEditable(it)) continue;
      changes.push({ id: it.id, targetKey: sel.targetKey, before: it, after: withZ(it, z++, now) });
    }
    this.commit(up ? 'إحضار إلى الأمام' : 'إرسال إلى الخلف', changes);
  }

  copySelection(): number {
    const sel = this.selection;
    const page = sel ? this.pages.get(sel.targetKey) : undefined;
    if (!sel || !page) return 0;
    const items = this.selectedItems();
    clipboard = { items, ar: page.ar, from: sel.targetKey };
    return items.length;
  }

  /**
   * Paste the clipboard onto `targetKey` (another page is fine). New ids, on the active layer (a copy of a read-only
   * layer's item becomes the owner's own writing); one undo step.
   */
  paste(targetKey: string | null = this.activeTargetKey, opts: { offset?: boolean; at?: [number, number] } = {}): number {
    const page = targetKey ? this.pages.get(targetKey) : undefined;
    if (!clipboard || !page || !page.anchor || !targetKey) return 0;
    const now = this.now();
    const offset = clipboard.from === targetKey && opts.offset !== false ? 0.02 : 0;
    let m: Mat = [1, 0, 0, 1, offset, offset * page.ar];
    // (N1 wave 2, G67) «الصق هنا»: the copied items centred where the owner pressed
    if (opts.at) {
      let b: NormBox | null = null;
      for (const it of clipboard.items) b = unionBox(b, itemBBox(it, clipboard.ar));
      if (b) m = [1, 0, 0, 1, opts.at[0] - (b.x + b.w / 2), (opts.at[1] - (b.y + b.h / 2)) * page.ar];
    }
    const moved = m[4] !== 0 || m[5] !== 0;
    let z = page.maxZ + 1;
    const changes: ItemChange[] = [];
    // (review of N1 wave 2, G21) a pasted diagram's connectors attach to the pasted shapes, never to the originals
    const newIds = new Map(clipboard.items.map((src) => [src.id, newId(now)]));
    for (const src of clipboard.items) {
      const copy: InkItem = { ...reattachCopy(cloneItem(src, newIds.get(src.id)!, page.anchor, now, z++), newIds), layer_id: null };
      if (!this.activeLayerScope || this.activeLayerScope(copy)) copy.layer_id = this.activeLayer;
      delete copy.author_user_id;
      delete copy.origin;
      delete copy.migrated_from_id;
      const placed = moved ? transformItem(copy, m, page.ar, now) : copy;
      changes.push({ id: placed.id, targetKey, before: null, after: placed });
    }
    this.commit('لصق', changes);
    this.setSelection({ targetKey, ids: changes.map((c) => c.id) });
    return changes.length;
  }

  duplicateSelection(): number {
    if (this.copySelection() === 0) return 0;
    return this.paste(this.selection?.targetKey ?? null);
  }

  /** (P1-T2) «انسخ إلى طبقتي»: the selection copied in place onto the active layer (read-only originals stay). */
  copySelectionToActiveLayer(): number {
    if (this.copySelection() === 0) return 0;
    return this.paste(this.selection?.targetKey ?? null, { offset: false });
  }

  /** (P1-T2) the selection holds at least one item of a read-only layer (or another author's item) */
  selectionHasReadOnly(): boolean {
    return this.selectedItems().some((it) => !this.isEditable(it));
  }

}

/** Who wrote an item: null = this vault's own user (an item of another author names them). */
function authorOf(it: InkItem | null | undefined): string | null {
  return it?.author_user_id ?? null;
}

/** The change is about an item the engine keeps in memory (not a reader kind it only erases). */
function isEngineChange(c: ItemChange): boolean {
  const it = c.after ?? c.before;
  return !it || isEngineItem(it);
}

/** Two copies of an item that are the same row: same revision, same change time, same layer and author. */
function sameRow(a: InkItem, b: InkItem): boolean {
  return a.rev === b.rev && a.updated_at === b.updated_at && (a.deleted_at ?? null) === (b.deleted_at ?? null) && (a.layer_id ?? null) === (b.layer_id ?? null) && a.z === b.z && a.locked === b.locked && JSON.stringify(a.anchor) === JSON.stringify(b.anchor);
}

// ─── registry: one store per open document; survives remounts (tab switches) while the app runs ──
const stores = new Map<string, InkDocumentStore>();

export function getDocumentStore(documentKey: string): InkDocumentStore {
  let s = stores.get(documentKey);
  if (!s) stores.set(documentKey, (s = new InkDocumentStore(documentKey)));
  return s;
}

/** Tests only. */
export function __resetStores(): void {
  stores.forEach((s) => s.dispose());
  stores.clear();
  clipboard = null;
}
