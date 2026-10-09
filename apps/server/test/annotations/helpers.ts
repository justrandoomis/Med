// Test fixtures for the annotations module: a source with versions and pages written directly to the DB
// (the library/sources tracks own the real upload path), plus sync op builders.
import { newId, type AnnotationDTO, type InkData, type NoteDTO, type RichText, type StudySessionDTO, type SyncOp } from '@medlevo/shared';
import type { TestApp } from '../helpers/app';

export interface SourceFixture {
  sourceId: string;
  versionId: string;
  pageIds: string[];
  version2Id: string;
  v2PageIds: string[];
}

/** A lecture with two versions; v1 has 4 pages labelled 11–14 (AC-04), v2 has 2 pages. */
export function createSourceFixture(t: TestApp, title = 'محاضرة الزائدة الدودية'): SourceFixture {
  const now = t.clock.now();
  const db = t.ctx.db;
  const sourceId = newId(now);
  const versionId = newId(now);
  const version2Id = newId(now);
  db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, ?, 'lecture', ?, ?)`, [sourceId, title, now, now]);
  db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, created_at)
     VALUES (?, ?, 1, 'original', 'hash-v1', 'application/pdf', 'pdf', 4, ?)`,
    [versionId, sourceId, now],
  );
  db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, content_hash, mime, format, page_count, created_at)
     VALUES (?, ?, 2, 'replacement', 'hash-v2', 'application/pdf', 'pdf', 2, ?)`,
    [version2Id, sourceId, now],
  );
  db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
  const pageIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = newId(now);
    pageIds.push(id);
    db.run(
      `INSERT INTO source_page (id, version_id, page_index, printed_label, printed_label_origin, kind, width, height, unit, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pdf_page_labels', 'page', 595, 842, 'pt', ?, ?)`,
      [id, versionId, i, String(11 + i), now, now],
    );
  }
  const v2PageIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = newId(now);
    v2PageIds.push(id);
    db.run(
      `INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, created_at, updated_at) VALUES (?, ?, ?, 'page', 595, 842, 'pt', ?, ?)`,
      [id, version2Id, i, now, now],
    );
  }
  return { sourceId, versionId, pageIds, version2Id, v2PageIds };
}

let opCounter = 0;
export function op(o: Partial<SyncOp> & Pick<SyncOp, 'entity_type' | 'entity_id'>): SyncOp {
  opCounter++;
  return { op_id: newId() + String(opCounter).padStart(4, '0').slice(-4), device_id: 'DEVICE_A', op: 'upsert', payload: {}, client_ts: Date.now(), ...o };
}

export function pageAnchor(f: SourceFixture, pageIndex = 0) {
  return { type: 'page' as const, source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[pageIndex]!, page_index: pageIndex, space: 'page_norm' as const };
}

export function inkData(x = 0.2, y = 0.3): InkData {
  return {
    v: 1,
    points: [
      [x, y, 0, 0.5],
      [x + 0.05, y + 0.01, 16, 0.6],
      [x + 0.1, y + 0.02, 32, 0.55],
    ],
    style: { tool: 'pen', color: 'ink-blue', width: 0.0025 },
    bbox: { x, y, w: 0.1, h: 0.02 },
    pressure_available: true,
    tilt_available: false,
  };
}

export function inkPayload(f: SourceFixture, opts: { pageIndex?: number; x?: number } = {}): Partial<AnnotationDTO> {
  return { kind: 'ink', tool: 'pen', anchor: pageAnchor(f, opts.pageIndex ?? 0), data: inkData(opts.x ?? 0.2), layer: 'ink', z: 0, locked: false };
}

export function rt(text: string): RichText {
  return { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] };
}

export function notePayload(f: SourceFixture | null, text: string, pageIndex = 0): Partial<NoteDTO> {
  return { title: null, body: rt(text), anchor: f ? pageAnchor(f, pageIndex) : null, origin: 'owner' };
}

export function sessionPayload(f: SourceFixture, pageIndex: number, zoom = 1): Partial<StudySessionDTO> {
  return { source_id: f.sourceId, version_id: f.versionId, mode: 'learn', view: 'original', location: { page_index: pageIndex, page_id: f.pageIds[pageIndex], zoom, rotation: 0, layout: 'continuous' } };
}
