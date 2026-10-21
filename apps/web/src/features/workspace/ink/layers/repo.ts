// Layers on this device (Academic OS P1-T2 step 1): Dexie `layers` (T1's v3 schema bump) + the outbox, never waiting
// for the network. The sync entity is `annotation_layer` (server: annotations/layers.ts). A layer the owner creates
// offline is usable at once; its op reaches the server before any stroke written on it (the outbox keeps order).
import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { defaultPersonalLayerId, newId, type AnnotationLayerDTO, type ClientLayerKind } from '@medlevo/shared';
import { getDb, type LayerRow, type MedLevoDB } from '../../../../lib/localdb';
import { writeAndEnqueue, type SyncApplier, type SyncEngine } from '../../../../lib/sync';
import { documentLayers, type LayerInfo } from './model';

export const LAYER_ENTITY = 'annotation_layer';

export function layerRowFromDTO(d: AnnotationLayerDTO): LayerRow {
  return {
    id: d.id,
    documentKey: d.document_key,
    kind: d.kind,
    title: d.title,
    writable: d.writable,
    frozen: d.frozen,
    visible: d.visible,
    locked: d.locked,
    color: d.color,
    sortOrder: d.sort_order,
    origin: d.origin ?? null,
    rev: d.rev,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    deletedAt: d.deleted_at,
    syncState: 'synced',
  };
}

function layerPayload(row: LayerRow): Record<string, unknown> {
  return {
    id: row.id,
    document_key: row.documentKey,
    kind: row.kind,
    title: row.title,
    visible: row.visible,
    locked: row.locked,
    color: row.color ?? null,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
  };
}

/** A new layer of the owner (personal / answers / explanation), usable at once, synced later. */
export async function createLayer(db: MedLevoDB, input: { documentKey: string; title: string; kind: ClientLayerKind; sortOrder?: number }): Promise<LayerRow> {
  const now = Date.now();
  // after the document's other layers (a small ordinal: the server accepts |sort_order| ≤ 1e12, a timestamp is larger)
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const rows = await db.layers.where('documentKey').equals(input.documentKey).toArray();
    sortOrder = rows.reduce((m, r) => (r.deletedAt || !Number.isFinite(r.sortOrder) || Math.abs(r.sortOrder) >= 1e9 ? m : Math.max(m, r.sortOrder)), 0) + 1;
  }
  const row: LayerRow = {
    id: newId(now),
    documentKey: input.documentKey,
    kind: input.kind,
    title: input.title.trim(),
    writable: true,
    frozen: false,
    visible: true,
    locked: false,
    color: null,
    sortOrder,
    origin: null,
    rev: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.layers, row, { entity_type: LAYER_ENTITY, op: 'upsert', base_rev: null, payload: layerPayload(row) });
  return row;
}

/**
 * Rename, recolour, (un)lock, change the default visibility of a layer. A never-renamed «ملاحظاتي» becomes a row with its
 * derived id (its items keep `layer_id` absent). Followed layers accept presentation changes only (the server says so).
 */
export async function updateLayer(db: MedLevoDB, layer: LayerInfo, patch: Partial<Pick<LayerRow, 'title' | 'visible' | 'locked' | 'color' | 'sortOrder'>>): Promise<LayerRow> {
  const now = Date.now();
  const base: LayerRow = layer.row ?? {
    id: defaultPersonalLayerId(layer.documentKey),
    documentKey: layer.documentKey,
    kind: 'personal',
    title: layer.title,
    writable: true,
    frozen: false,
    visible: true,
    locked: false,
    color: null,
    sortOrder: layer.sortOrder,
    origin: null,
    rev: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  };
  const row: LayerRow = { ...base, ...patch, ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), updatedAt: now, syncState: 'pending_sync' };
  await writeAndEnqueue(db, db.layers, row, { entity_type: LAYER_ENTITY, op: 'upsert', base_rev: base.rev ?? null, payload: layerPayload(row) });
  return row;
}

/**
 * (P1-T2 review) Live items of a layer on EVERY page this device holds (all versions of the document, its note pages,
 * notes without a page) — the panel's per-page counts only cover the pages in view, so «empty» is decided here.
 */
export async function countLayerItems(db: MedLevoDB, layerId: string): Promise<number> {
  const [a, n] = await Promise.all([
    db.annotations.where('layerId').equals(layerId).filter((r) => !r.deletedAt).count(),
    db.notes.where('layerId').equals(layerId).filter((r) => !r.deletedAt).count(),
  ]);
  return a + n;
}

/** Deletes an EMPTY layer of the owner (the panel only offers it then; the server refuses a non-empty one). */
export async function deleteLayer(db: MedLevoDB, layer: LayerInfo): Promise<void> {
  if (!layer.row || layer.isDefault) return;
  const now = Date.now();
  await writeAndEnqueue(db, db.layers, { ...layer.row, deletedAt: now, updatedAt: now }, { entity_type: LAYER_ENTITY, op: 'delete', base_rev: layer.row.rev ?? null, payload: { id: layer.row.id } });
}

// ─── sync applier ──────────────────────────────────────────────────────────────────────────
const isDto = (v: unknown): v is AnnotationLayerDTO => !!v && typeof v === 'object' && typeof (v as AnnotationLayerDTO).id === 'string' && typeof (v as AnnotationLayerDTO).document_key === 'string';

/** Pulled / pushed layers: a row with unsynced local edits is never overwritten; older revs are ignored. */
export const layerApplier: SyncApplier = async (change, { db, localOps }) => {
  if (localOps.some((o) => o.status === 'pending' || (!o.acknowledgedAt && o.status === 'rejected'))) return;
  const dto = change.entity;
  const cur = await db.layers.get(change.entity_id);
  if (!isDto(dto)) {
    // gone on the server (a purge of its document): a tombstone, never a hard delete
    if (cur && !cur.deletedAt) await db.layers.put({ ...cur, deletedAt: Date.now(), syncState: 'synced' });
    return;
  }
  if (cur?.rev != null && dto.rev < cur.rev) return;
  await db.layers.put(layerRowFromDTO(dto));
};

const registered = new WeakSet<SyncEngine>();
export function registerLayerApplier(engine: SyncEngine): void {
  if (registered.has(engine)) return;
  registered.add(engine);
  engine.registerApplier(LAYER_ENTITY, layerApplier);
}

// ─── hooks ─────────────────────────────────────────────────────────────────────────────────
/** The document's layers, live from IndexedDB («ملاحظاتي» always first). */
export function useDocumentLayers(documentKey: string | null, db: MedLevoDB = getDb()): LayerInfo[] {
  const [layers, setLayers] = useState<LayerInfo[]>(() => (documentKey ? documentLayers([], documentKey) : []));
  useEffect(() => {
    if (!documentKey) return;
    const sub = liveQuery(() => db.layers.where('documentKey').equals(documentKey).toArray()).subscribe({
      next: (rows) => setLayers(documentLayers(rows, documentKey)),
      error: () => setLayers(documentLayers([], documentKey)),
    });
    return () => sub.unsubscribe();
  }, [db, documentKey]);
  return layers;
}

/** Live item counts per layer id on the given pages (annotations + notes), for the panel. */
export function useLayerItemCounts(documentKey: string | null, targetKeys: readonly string[], db: MedLevoDB = getDb()): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const keysJoined = targetKeys.join('|');
  useEffect(() => {
    if (!documentKey) return;
    const defId = defaultPersonalLayerId(documentKey);
    const keys = keysJoined ? keysJoined.split('|') : [];
    const sub = liveQuery(async () => {
      const m = new Map<string, number>();
      if (keys.length === 0) return m;
      const rows = await db.annotations.where('targetKey').anyOf(keys).toArray();
      for (const r of rows) {
        if (r.deletedAt) continue;
        const k = r.layerId ?? defId;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      const notes = await db.notes.where('anchorKey').anyOf(keys).toArray();
      for (const n of notes) {
        if (n.deletedAt) continue;
        const k = n.layerId ?? defId;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    }).subscribe({ next: setCounts, error: () => setCounts(new Map()) });
    return () => sub.unsubscribe();
  }, [db, documentKey, keysJoined]);
  return counts;
}
