// Bulk removal of the owner's writing (parity N1, G15): «امسح الصفحة» and «احذف كل … في الدفتر».
//
// Nothing is hard-deleted (§47): each item becomes a tombstone through the store (IndexedDB + outbox, synced like every
// other change), the whole action is ONE undo step, the owner sees the count per type before anything happens, and the
// action is kept in «المحذوف بالجملة» on this device so it can be restored later (after the undo history moved on, after
// a reload). Printed PDF content is never touched: only annotations are. Items of hidden or read-only layers and locked
// items are left alone (the count says only what will really go).
import type { AnnotationAnchor } from '@medlevo/shared';
import { kvGet, kvSet, type MedLevoDB } from '../../../lib/localdb';
import type { ItemChange } from './history';
import { contentTypeLabel, contentTypeOf, isEngineKind, type InkContentType } from './kinds';
import { itemFromRow, type InkItem } from './model';
import type { InkDocumentStore } from './store';

export interface BulkPlan {
  label_ar: string;
  changes: ItemChange[];
  /** items per content type */
  byType: Record<string, number>;
  total: number;
  /** pages the plan touches */
  pages: number;
}

/** The content types «احذف كل …» offers, in this order. */
export const DELETABLE_TYPES: readonly InkContentType[] = ['pen', 'highlighter', 'shape', 'text', 'sticky', 'image', 'link', 'text_highlight'];

function removable(store: InkDocumentStore, it: InkItem): boolean {
  return !it.deleted_at && !it.locked && store.isVisible(it) && store.isEditable(it);
}

function plan(label: string, items: Array<{ it: InkItem; targetKey: string }>): BulkPlan {
  const byType: Record<string, number> = {};
  const pages = new Set<string>();
  for (const { it, targetKey } of items) {
    const t = contentTypeOf(it);
    byType[t] = (byType[t] ?? 0) + 1;
    pages.add(targetKey);
  }
  return { label_ar: label, changes: items.map(({ it, targetKey }) => ({ id: it.id, targetKey, before: it, after: null })), byType, total: items.length, pages: pages.size };
}

/** Kinds of annotation the owner writes that bulk actions may remove (bookmarks and notes are not ink). */
function bulkKind(kind: string): boolean {
  return isEngineKind(kind) || kind === 'text_highlight';
}

/**
 * Items of one page as they are now: the engine's memory for an open page (it may be ahead of storage), this device's
 * storage for the rest (and for the reader's text highlights).
 */
async function pageItems(store: InkDocumentStore, targetKey: string): Promise<InkItem[]> {
  const page = store.page(targetKey);
  const out: InkItem[] = [];
  const rows = await store.localDb.annotations.where('targetKey').equals(targetKey).toArray();
  for (const r of rows) {
    if (r.deletedAt || !bulkKind(r.kind)) continue;
    if (page?.loaded && isEngineKind(r.kind)) continue; // taken from memory below
    out.push(itemFromRow(r));
  }
  if (page?.loaded) out.push(...page.items.values());
  return out;
}

/** What «امسح الصفحة» would remove on one page (`types`: only these content types; null = all). */
export async function planClearPage(store: InkDocumentStore, targetKey: string, types: ReadonlySet<string> | null = null): Promise<BulkPlan> {
  const items = (await pageItems(store, targetKey)).filter((it) => removable(store, it) && (!types || types.has(contentTypeOf(it))));
  return plan('مسح الصفحة', items.map((it) => ({ it, targetKey })));
}

/**
 * The pages of a document (target keys): a notebook's note pages, or a source version's pages that carry annotations and
 * the note pages inserted into it. Pages open in the engine are always included.
 */
export async function documentTargets(store: InkDocumentStore, documentKey: string): Promise<string[]> {
  const db: MedLevoDB = store.localDb;
  const keys = new Set<string>();
  try {
    if (documentKey.startsWith('notebook:')) {
      const nodeId = documentKey.slice('notebook:'.length);
      for (const p of await db.notePages.where('nodeId').equals(nodeId).toArray()) if (!p.deletedAt) keys.add(`note_page:${p.id}`);
    } else {
      const [sourceId, versionId] = documentKey.split(':');
      if (sourceId && versionId) {
        for (const p of await db.notePages.where('sourceId').equals(sourceId).toArray()) if (!p.deletedAt) keys.add(`note_page:${p.id}`);
        await db.annotations
          .filter((r) => {
            const a = r.anchor as AnnotationAnchor | null;
            return !!a && a.type === 'page' && a.source_id === sourceId && a.version_id === versionId;
          })
          .each((r) => {
            keys.add(r.targetKey);
          });
      }
    }
  } catch {
    // storage unavailable: the pages open now are still listed
  }
  return [...keys];
}

/** What «احذف كل … في الدفتر» would remove: every item of `type` on the document's pages (and the pages open now). */
export async function planDeleteByType(store: InkDocumentStore, type: InkContentType, extraTargets: readonly string[] = []): Promise<BulkPlan> {
  const targets = new Set([...(await documentTargets(store, store.documentKey)), ...extraTargets]);
  const items: Array<{ it: InkItem; targetKey: string }> = [];
  for (const targetKey of targets) {
    for (const it of await pageItems(store, targetKey)) if (contentTypeOf(it) === type && removable(store, it)) items.push({ it, targetKey });
  }
  return plan(`حذف كل ${contentTypeLabel(type, 2)}`, items);
}

// ── «المحذوف بالجملة»: bulk removals kept on this device for restoring ──
export interface TrashEntry {
  id: string;
  label_ar: string;
  at: number;
  total: number;
  byType: Record<string, number>;
  items: Array<{ id: string; targetKey: string }>;
}

const TRASH_KEY = 'ink.bulkTrash.v1:';
const TRASH_MAX = 20;

export async function listTrash(store: InkDocumentStore): Promise<TrashEntry[]> {
  try {
    return ((await kvGet<TrashEntry[]>(store.localDb, TRASH_KEY + store.documentKey)) ?? []).slice().sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

async function saveTrash(store: InkDocumentStore, entries: TrashEntry[]): Promise<void> {
  await kvSet(store.localDb, TRASH_KEY + store.documentKey, entries.slice(-TRASH_MAX));
}

/** Applies a plan: tombstones in ONE undo step, kept in «المحذوف بالجملة». Returns the number of items removed. */
export async function applyBulk(store: InkDocumentStore, p: BulkPlan, now = Date.now()): Promise<number> {
  if (p.total === 0) return 0;
  store.commit(p.label_ar, p.changes);
  if (store.getSelection()) store.setSelection(null);
  const entry: TrashEntry = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, label_ar: p.label_ar, at: now, total: p.total, byType: p.byType, items: p.changes.map((c) => ({ id: c.id, targetKey: c.targetKey })) };
  try {
    const all = await kvGet<TrashEntry[]>(store.localDb, TRASH_KEY + store.documentKey);
    await saveTrash(store, [...(all ?? []), entry]);
  } catch {
    // the removal itself is saved; only the restore list could not be written
  }
  return p.total;
}

/**
 * Restores a bulk removal from «المحذوف بالجملة»: the items still removed come back exactly as they were (one undo step);
 * items brought back or changed since are left as they are. Returns the number restored.
 */
export async function restoreTrash(store: InkDocumentStore, entryId: string): Promise<number> {
  const all = (await kvGet<TrashEntry[]>(store.localDb, TRASH_KEY + store.documentKey)) ?? [];
  const entry = all.find((e) => e.id === entryId);
  if (!entry) return 0;
  const rows = await store.localDb.annotations.bulkGet(entry.items.map((i) => i.id));
  const changes: ItemChange[] = [];
  rows.forEach((r, i) => {
    if (!r || !r.deletedAt) return;
    const it = itemFromRow(r);
    changes.push({ id: it.id, targetKey: entry.items[i]!.targetKey, before: null, after: { ...it, deleted_at: null, layer_id: it.layer_id ?? null } });
  });
  if (changes.length) store.commit('استعادة من المحذوف بالجملة', changes);
  await saveTrash(
    store,
    all.filter((e) => e.id !== entryId),
  );
  return changes.length;
}

/** «١٢ خطًا بالقلم، ٣ تظليلات بالقلم» — the per-type count, in the order of DELETABLE_TYPES. */
export function describeCounts(byType: Record<string, number>): string {
  const parts: string[] = [];
  const order = [...DELETABLE_TYPES, ...Object.keys(byType).filter((t) => !(DELETABLE_TYPES as readonly string[]).includes(t))];
  for (const t of order) {
    const n = byType[t];
    if (n) parts.push(`${n.toLocaleString('ar-EG')} ${contentTypeLabel(t, n)}`);
  }
  return parts.join('، ');
}
