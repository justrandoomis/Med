// In-memory model of one open document's ink (all its pages), the write-through to IndexedDB and
// the undo history. The UI updates synchronously from memory; persistence is queued (strictly in
// order) and never awaited by input handling (§55: writing never waits for storage or network).
import { newId, type AnnotationAnchor, type NormBox } from '@medlevo/shared';
import { getDb, type MedLevoDB } from '../../../lib/localdb';
import { broadcast, onAnnotationRowsChanged, type AnnotationRowsChanged } from './events';
import { InkHistory, type ItemChange } from './history';
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
import { SpatialGrid } from './spatial';

export type PageEvent =
  | { kind: 'items'; dirty: NormBox[] | 'all'; ids: string[] }
  | { kind: 'selection' }
  | { kind: 'hidden'; ids: string[] }
  | { kind: 'loaded' };

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
  private inFlight = new Map<string, number>();
  private status: PersistStatus = { state: 'idle' };
  private statusListeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private unsubscribeEvents: () => void;
  private selectionVersion = 0;

  constructor(
    readonly documentKey: string,
    private readonly db: MedLevoDB = getDb(),
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribeEvents = onAnnotationRowsChanged((e) => {
      // a failed refresh must never surface as an unhandled rejection; the page keeps what it shows
      this.onExternalChange(e).catch(() => undefined);
    });
  }

  dispose(): void {
    this.unsubscribeEvents();
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
    const real = changes.filter((c) => c.before !== c.after);
    if (real.length === 0) return;
    this.applyInMemory(real);
    if (opts.record !== false) {
      if (opts.amend) this.history.amendLast(real);
      else this.history.push({ label_ar, changes: real });
    }
    this.persist(real);
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
      if (c.after && !c.after.deleted_at) {
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
        for (const c of batch) this.failed.delete(c.id);
        broadcast(keys, batch.map((c) => c.id));
        if (this.failed.size === 0) this.setStatus({ state: 'idle' });
      } catch {
        // keep the changes in memory and try them again with the next write (never dropped)
        for (const c of batch) this.failed.set(c.id, c.targetKey);
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
   * succeeds.
   */
  private retryChanges(changes: readonly ItemChange[]): ItemChange[] {
    if (this.failed.size === 0) return [];
    const inBatch = new Set(changes.map((c) => c.id));
    const out: ItemChange[] = [];
    for (const [id, targetKey] of this.failed) {
      if (inBatch.has(id)) continue;
      const current = this.pages.get(targetKey)?.items.get(id) ?? null;
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

  undo(): boolean {
    const changes = this.history.undo();
    if (!changes) return false;
    this.commit('', changes, { record: false });
    return true;
  }

  redo(): boolean {
    const changes = this.history.redo();
    if (!changes) return false;
    this.commit('', changes, { record: false });
    return true;
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
          if (prev) dirty.push(itemBBox(prev, page.ar));
          this.putInMemory(page, it);
          dirty.push(itemBBox(it, page.ar));
        }
        this.emit(page, { kind: 'items', dirty, ids: [] });
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

  recolorSelection(color: string): void {
    this.editSelection('تغيير اللون', (it, now) => recolorItem(it, color, now));
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
      if (it.locked) continue;
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

  /** Paste the clipboard onto `targetKey` (another page is fine). New ids; one undo step. */
  paste(targetKey: string | null = this.activeTargetKey): number {
    const page = targetKey ? this.pages.get(targetKey) : undefined;
    if (!clipboard || !page || !page.anchor || !targetKey) return 0;
    const now = this.now();
    const offset = clipboard.from === targetKey ? 0.02 : 0;
    const m: Mat = [1, 0, 0, 1, offset, offset * page.ar];
    let z = page.maxZ + 1;
    const changes: ItemChange[] = [];
    for (const src of clipboard.items) {
      const copy = cloneItem(src, newId(now), page.anchor, now, z++);
      const placed = offset ? transformItem(copy, m, page.ar, now) : copy;
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
