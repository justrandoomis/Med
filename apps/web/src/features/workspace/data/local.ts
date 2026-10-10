// Local-first rows for the workspace (§26, §47): notes, note pages, study sessions and the reader's own
// annotations (bookmarks, text highlights). Writes go to IndexedDB + outbox in one transaction and never
// wait for the network; pulled server entities are mapped back by the appliers below.
import {
  annotationTargetKey,
  newId,
  type AnnotationAnchor,
  type AnnotationDTO,
  type NoteDTO,
  type NotePageDTO,
  type RichText,
  type StudySessionDTO,
} from '@medlevo/shared';
import type { AnnotationRow, MedLevoDB, NotePageRow, NoteRow, OutboxRecord, StudySessionRow } from '../../../lib/localdb';
import { kvSet } from '../../../lib/localdb';
import { peekDeviceId } from '../../../lib/deviceId';
import { writeAndEnqueue, type SyncApplier, type SyncEngine } from '../../../lib/sync';
import type { ReaderLocation } from '../model/session';

// ───────── rows the workspace stores (baseline row types + a few fields) ─────────
export interface WorkspaceNoteRow extends NoteRow {
  /** source the note belongs to (page anchors) */
  sourceId?: string | null;
  deviceId?: string | null;
}

export interface WorkspaceSessionRow extends StudySessionRow {
  location: ReaderLocation;
  deviceId?: string | null;
  /** set by the applier when a newer position arrived from another device (pull) */
  remoteChange?: { deviceId: string | null; at: number; location: ReaderLocation; versionId: string | null } | null;
}

/** Ops that still protect the local row from being overwritten by a server copy. */
export function blockingOps(localOps: readonly OutboxRecord[]): OutboxRecord[] {
  return localOps.filter((o) => o.status === 'pending' || !o.acknowledgedAt);
}

/**
 * Notes: a `conflict` result is always conflict_kept_both — the server already saved this device's text as
 * a separate note (conflict_of_id) that arrives through pull. Such an op must NOT keep protecting the
 * original row: the original follows the server (the other device's text), otherwise this device shows its
 * own text twice, never sees the other text, and every later edit carries the stale rev and spawns yet
 * another conflict copy. Only unsent edits and unacknowledged rejections protect a note.
 */
export function noteBlockingOps(localOps: readonly OutboxRecord[]): OutboxRecord[] {
  return localOps.filter((o) => o.status === 'pending' || (o.status === 'rejected' && !o.acknowledgedAt));
}

// ───────── notes ─────────
export function noteRowFromDTO(n: NoteDTO): WorkspaceNoteRow {
  const anchor = n.anchor;
  return {
    id: n.id,
    nodeId: n.node_id,
    anchorKey: anchor ? annotationTargetKey(anchor) : null,
    title: n.title,
    body: n.body,
    anchor,
    origin: n.origin,
    conflictOfId: n.conflict_of_id,
    sourceId: anchor?.type === 'page' ? anchor.source_id : null,
    deviceId: n.device_id,
    rev: n.rev,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    deletedAt: n.deleted_at,
    syncState: 'synced',
  };
}

export function notePayload(row: WorkspaceNoteRow): Partial<NoteDTO> {
  return {
    id: row.id,
    node_id: row.nodeId ?? null,
    title: row.title ?? null,
    body: row.body as RichText,
    anchor: (row.anchor as AnnotationAnchor | null | undefined) ?? null,
    origin: row.origin ?? 'owner',
    created_at: row.createdAt,
  };
}

export async function saveNote(db: MedLevoDB, input: { id?: string; body: RichText; title?: string | null; anchor: AnnotationAnchor | null; nodeId?: string | null }, existing?: WorkspaceNoteRow | null): Promise<WorkspaceNoteRow> {
  const now = Date.now();
  const anchor = input.anchor;
  const row: WorkspaceNoteRow = {
    ...(existing ?? {}),
    id: existing?.id ?? input.id ?? newId(now),
    nodeId: input.nodeId ?? existing?.nodeId ?? null,
    anchorKey: anchor ? annotationTargetKey(anchor) : null,
    title: input.title ?? existing?.title ?? null,
    body: input.body,
    anchor,
    origin: existing?.origin ?? 'owner',
    conflictOfId: existing?.conflictOfId ?? null,
    sourceId: anchor?.type === 'page' ? anchor.source_id : (existing?.sourceId ?? null),
    rev: existing?.rev ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.notes, row, { entity_type: 'note', op: 'upsert', base_rev: existing?.rev ?? null, payload: notePayload(row) });
  return row;
}

export async function deleteNote(db: MedLevoDB, row: WorkspaceNoteRow): Promise<void> {
  const now = Date.now();
  // (writeAndEnqueue would send the whole row for a null payload; a tombstone needs only the id)
  await writeAndEnqueue(db, db.notes, { ...row, deletedAt: now, updatedAt: now }, { entity_type: 'note', op: 'delete', base_rev: row.rev ?? null, payload: { id: row.id } });
}

// ───────── annotations written by the reader (bookmark, text_highlight) ─────────
export function annotationRowFromDTO(a: AnnotationDTO): AnnotationRow {
  return {
    id: a.id,
    targetKey: annotationTargetKey(a.anchor),
    kind: a.kind,
    tool: a.tool,
    anchor: a.anchor,
    data: a.data,
    layer: a.layer,
    z: a.z,
    locked: a.locked,
    anchorStatus: a.anchor_status,
    input: a.input,
    rev: a.rev,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    deletedAt: a.deleted_at,
    syncState: 'synced',
  };
}

export function annotationPayload(row: AnnotationRow): Partial<AnnotationDTO> {
  return {
    id: row.id,
    kind: row.kind as AnnotationDTO['kind'],
    tool: row.tool ?? null,
    anchor: row.anchor as AnnotationAnchor,
    data: row.data as AnnotationDTO['data'],
    layer: row.layer ?? 'ink',
    z: row.z ?? 0,
    locked: row.locked ?? false,
    created_at: row.createdAt,
  };
}

export async function createAnnotation(db: MedLevoDB, input: Pick<AnnotationRow, 'kind' | 'anchor' | 'data'> & { layer: AnnotationRow['layer']; tool?: string | null }): Promise<AnnotationRow> {
  const now = Date.now();
  const anchor = input.anchor as AnnotationAnchor;
  const row: AnnotationRow = {
    id: newId(now),
    targetKey: annotationTargetKey(anchor),
    kind: input.kind,
    tool: input.tool ?? null,
    anchor,
    data: input.data,
    layer: input.layer,
    z: 0,
    locked: false,
    anchorStatus: 'ok',
    input: null,
    rev: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    syncState: 'pending_sync',
  };
  await writeAndEnqueue(db, db.annotations, row, { entity_type: 'annotation', op: 'upsert', base_rev: null, payload: annotationPayload(row) });
  return row;
}

export async function deleteAnnotation(db: MedLevoDB, row: AnnotationRow): Promise<void> {
  const now = Date.now();
  await writeAndEnqueue(db, db.annotations, { ...row, deletedAt: now, updatedAt: now }, { entity_type: 'annotation', op: 'delete', base_rev: row.rev ?? null, payload: { id: row.id } });
}

/**
 * Seed IndexedDB with the server's annotations for a document (opened online). A row with unsynced
 * local ops is never overwritten; a newer local row is kept.
 */
export async function mergeServerAnnotations(db: MedLevoDB, list: readonly AnnotationDTO[]): Promise<number> {
  let written = 0;
  await db.transaction('rw', [db.annotations, db.outbox], async () => {
    for (const a of list) {
      const ops = await db.outbox.where('[entity_type+entity_id]').equals(['annotation', a.id]).filter((o) => o.status !== 'synced').toArray();
      if (blockingOps(ops).length > 0) continue;
      const cur = await db.annotations.get(a.id);
      if (cur && (cur.rev ?? 0) >= a.rev) continue;
      await db.annotations.put(annotationRowFromDTO(a));
      written++;
    }
  });
  return written;
}

export async function mergeServerNotes(db: MedLevoDB, list: readonly NoteDTO[]): Promise<number> {
  let written = 0;
  await db.transaction('rw', [db.notes, db.outbox], async () => {
    for (const n of list) {
      const ops = await db.outbox.where('[entity_type+entity_id]').equals(['note', n.id]).filter((o) => o.status !== 'synced').toArray();
      if (noteBlockingOps(ops).length > 0) continue;
      const cur = (await db.notes.get(n.id)) as WorkspaceNoteRow | undefined;
      if (cur && (cur.rev ?? 0) >= n.rev) continue;
      await db.notes.put(noteRowFromDTO(n));
      written++;
    }
  });
  return written;
}

// ───────── note pages ─────────
export function notePageRowFromDTO(p: NotePageDTO): NotePageRow {
  return {
    id: p.id,
    nodeId: p.node_id,
    sourceId: p.source_id,
    afterPageIndex: p.after_page_index,
    title: p.title,
    template: p.template,
    width: p.width,
    height: p.height,
    sortOrder: p.sort_order,
    rev: p.rev,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    deletedAt: p.deleted_at,
    syncState: 'synced',
  };
}

// ───────── study sessions ─────────
export function sessionRowFromDTO(s: StudySessionDTO): WorkspaceSessionRow {
  return {
    id: s.id,
    sourceId: s.source_id,
    versionId: s.version_id,
    mode: s.mode,
    view: s.view,
    location: (s.location ?? {}) as ReaderLocation,
    scope: s.scope,
    deviceId: s.device_id,
    rev: s.rev,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    syncState: 'synced',
    remoteChange: null,
  };
}

export function sessionPayload(row: WorkspaceSessionRow): Partial<StudySessionDTO> {
  return {
    id: row.id,
    source_id: row.sourceId ?? null,
    version_id: row.versionId ?? null,
    mode: row.mode,
    view: row.view,
    location: row.location,
    created_at: row.createdAt,
  };
}

export async function saveSession(db: MedLevoDB, row: WorkspaceSessionRow): Promise<void> {
  const next: WorkspaceSessionRow = { ...row, updatedAt: Date.now(), remoteChange: null, syncState: 'pending_sync' };
  await writeAndEnqueue(db, db.studySessions, next, { entity_type: 'study_session', op: 'upsert', base_rev: row.rev ?? null, payload: sessionPayload(next) });
}

/**
 * After the owner answered a session conflict (§46): this session's ops still waiting in the outbox were
 * built on the revision the server refused, so they would be refused again (and the owner asked again).
 * They move onto the server's revision; when the owner chose the other device's place they carry that
 * place, so a queued older position can never overwrite the choice.
 */
export async function rebasePendingSessionOps(db: MedLevoDB, server: StudySessionDTO, adoptServer: boolean): Promise<number> {
  let n = 0;
  await db.transaction('rw', db.outbox, async () => {
    const ops = await db.outbox
      .where('[entity_type+entity_id]')
      .equals(['study_session', server.id])
      .filter((o) => o.status === 'pending')
      .toArray();
    for (const o of ops) {
      const patch: Partial<OutboxRecord> = { base_rev: server.rev };
      if (adoptServer) patch.payload = sessionPayload(sessionRowFromDTO(server));
      await db.outbox.update(o.seq!, patch);
      n++;
    }
  });
  return n;
}

/** Latest local session of a source (this device). */
export async function latestLocalSession(db: MedLevoDB, sourceId: string): Promise<WorkspaceSessionRow | null> {
  const rows = (await db.studySessions.where('sourceId').equals(sourceId).toArray()) as WorkspaceSessionRow[];
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows[0] ?? null;
}

export const SESSION_CONFLICT_KEY = (sessionId: string) => `workspace.session.conflict.${sessionId}`;

// ───────── appliers (pull + push results → IndexedDB) ─────────
const noteApplier: SyncApplier = async (change, { db, localOps, source }) => {
  const dto = change.entity as NoteDTO | null;
  if (!dto || typeof dto !== 'object' || !dto.id) return;
  const blocking = noteBlockingOps(localOps);
  if (blocking.length > 0) {
    // our own op was acknowledged while a later edit waits: keep the text, follow the server revision
    if (source === 'push' && blocking.every((o) => o.status === 'pending')) {
      const cur = await db.notes.get(dto.id);
      if (cur && (cur.rev ?? 0) < dto.rev) await db.notes.update(dto.id, { rev: dto.rev });
    }
    return;
  }
  await db.notes.put(noteRowFromDTO(dto));
};

const notePageApplier: SyncApplier = async (change, { db, localOps, source }) => {
  const dto = change.entity as NotePageDTO | null;
  if (!dto || typeof dto !== 'object' || !dto.id) return;
  const blocking = blockingOps(localOps);
  if (blocking.length > 0) {
    if (source === 'push' && blocking.every((o) => o.status === 'pending')) {
      const cur = await db.notePages.get(dto.id);
      if (cur && (cur.rev ?? 0) < dto.rev) await db.notePages.update(dto.id, { rev: dto.rev });
    }
    return;
  }
  await db.notePages.put(notePageRowFromDTO(dto));
};

const sessionApplier: SyncApplier = async (change, { db, localOps, source }) => {
  const dto = change.entity as StudySessionDTO | null;
  if (!dto || typeof dto !== 'object' || !dto.id) return;
  const conflicts = localOps.filter((o) => o.status === 'conflict' && !o.acknowledgedAt);
  if (conflicts.length > 0) {
    // the server refused to overwrite a newer position from another device: ask the owner (§46)
    await kvSet(db, SESSION_CONFLICT_KEY(dto.id), dto);
    return;
  }
  const cur = (await db.studySessions.get(dto.id)) as WorkspaceSessionRow | undefined;
  const pending = localOps.filter((o) => o.status === 'pending');
  if (pending.length > 0) {
    if (source === 'push' && cur && (cur.rev ?? 0) < dto.rev) await db.studySessions.update(dto.id, { rev: dto.rev });
    return;
  }
  const row = sessionRowFromDTO(dto);
  if (source === 'pull' && cur && dto.device_id && dto.device_id !== peekDeviceId()) {
    // another device moved: keep the change visible to an open reader without jumping by itself
    const moved = (cur.location?.page_index ?? 0) !== (row.location.page_index ?? 0) || cur.versionId !== row.versionId;
    if (moved) row.remoteChange = { deviceId: dto.device_id, at: dto.updated_at, location: row.location, versionId: row.versionId ?? null };
  }
  await db.studySessions.put(row);
};

let registered: SyncEngine | null = null;

/** Registers the workspace's appliers once per engine ('annotation' belongs to the ink engine). */
export function registerWorkspaceAppliers(engine: SyncEngine): void {
  if (registered === engine) return;
  registered = engine;
  engine.registerApplier('note', noteApplier);
  engine.registerApplier('note_page', notePageApplier);
  engine.registerApplier('study_session', sessionApplier);
}

export const __test = { noteApplier, notePageApplier, sessionApplier };
