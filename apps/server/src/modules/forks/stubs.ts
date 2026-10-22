// Vault STUBS of official lectures (P1-T5 step 2; ARCHITECTURE_DELTA §6.1, §6.3, §6.5; ADR-0003 §3.3).
//
// A stub is the official lecture's skeleton in the user's OWN vault, under the SPACE's ids: the `source` (is_stub = 1,
// origin_space_id / origin_lecture_id), the published `source_version` rows the user holds, their `source_page` rows,
// the page fingerprints and the official page maps between the held versions. So `annotation.anchor_json` names the
// same version and page ids in the vault and in the space, and P1-T2's one-tap note copy works on the stub as on any
// source of the vault. NEVER copied: chunks, FTS rows, region text, Course Brain rows, jobs — retrieval reads them in
// the space (evidence/retrieval.ts) and cited regions are pinned lazily (pin.ts). Files are not copied either: the
// vault gets its own `stored_file` row for the official blob (same sha256, same content-addressed bytes) — that row is
// the authorisation inside this database — and a blob reference hint.
//
// Everything here runs with the USER'S VAULT bound (`ctx.db`) and reads the space through `ctx.dbs.space()` (the copy
// services' explicit second handle, ARCHITECTURE_DELTA §1.1). Writes to the vault happen in one transaction; replaying
// a stub copy (a retried job, «ابدأ الدراسة» twice, a second device) changes nothing.
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { AppError } from '../../lib/errors';
import { FileStore } from '../files/store';

export const CHANNELS_FOLDER_TITLE_AR = 'موادي من القنوات';

export interface SpaceLectureRow {
  id: string;
  subject_node_id: string;
  source_id: string;
  title: string;
  lecture_no: number | null;
  lecture_no_origin: 'detected' | 'moderator' | null;
  held_on: string | null;
  status: 'draft' | 'in_review' | 'published' | 'withdrawn';
  head_version_id: string | null;
  withdrawn_reason: 'replaced' | 'error' | 'rights_takedown' | 'other' | null;
  withdrawn_note: string | null;
  withdrawn_at: number | null;
  takedown_at: number | null;
}

export interface SpaceVersionRow {
  id: string;
  source_id: string;
  version_no: number;
  kind: string;
  derived_from_version_id: string | null;
  file_id: string | null;
  original_file_id: string | null;
  display_file_id: string | null;
  content_hash: string;
  mime: string;
  file_name: string | null;
  format: string;
  page_count: number | null;
  pagination: string;
  processing_status: string;
  processing_summary_json: string | null;
  note: string | null;
  created_at: number;
  /** official_version_publish */
  published_at: number;
  previous_version_id: string | null;
  change_note: string | null;
  page_map_status: string | null;
}

interface StoredFileRow {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  storage_key: string;
  original_name: string | null;
  created_at: number;
}

/** Deterministic ids for rows a job or a replay may write twice. */
export function derivedId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 26)}`;
}

/** The space's database (copy services only; ARCHITECTURE_DELTA §1.1). Null when the space is not registered. */
export function spaceDb(ctx: AppContext, spaceId: string): Db | null {
  try {
    return ctx.dbs.space(spaceId);
  } catch {
    return null;
  }
}

export function spaceLecture(space: Db, lectureId: string): SpaceLectureRow | null {
  return (
    space.get<SpaceLectureRow>(
      `SELECT id, subject_node_id, source_id, title, lecture_no, lecture_no_origin, held_on, status, head_version_id, withdrawn_reason, withdrawn_note, withdrawn_at, takedown_at
         FROM official_lecture WHERE id = ?`,
      [lectureId],
    ) ?? null
  );
}

/** The PUBLISHED versions of an official lecture, oldest first (drafts never leave the space). */
export function publishedVersions(space: Db, lecture: Pick<SpaceLectureRow, 'id' | 'source_id'>): SpaceVersionRow[] {
  return space.all<SpaceVersionRow>(
    `SELECT v.id, v.source_id, v.version_no, v.kind, v.derived_from_version_id, v.file_id, v.original_file_id, v.display_file_id, v.content_hash, v.mime, v.file_name,
            v.format, v.page_count, v.pagination, v.processing_status, v.processing_summary_json, v.note, v.created_at,
            p.published_at, p.previous_version_id, p.change_note, p.page_map_status
       FROM source_version v JOIN official_version_publish p ON p.version_id = v.id AND p.lecture_id = ?
      WHERE v.source_id = ? ORDER BY v.version_no`,
    [lecture.id, lecture.source_id],
  );
}

/**
 * A published lecture a member may open (status published, or withdrawn after it was published and not taken down —
 * the stub of a withdrawn lecture stays readable for those who hold it, never created anew). Null otherwise: drafts,
 * lectures of another space and unknown ids all look the same to the caller.
 */
export function openableLecture(space: Db, lectureId: string, opts: { allowWithdrawn?: boolean } = {}): SpaceLectureRow | null {
  const l = spaceLecture(space, lectureId);
  if (!l || !l.head_version_id) return null;
  if (l.status === 'published') return l;
  if (opts.allowWithdrawn && l.status === 'withdrawn' && l.takedown_at === null) return l;
  return null;
}

/** «موادي من القنوات» › <subject>: deterministic folders in the vault (the same ids on every device and replay). */
export function ensureChannelsFolder(ctx: AppContext, spaceId: string, subjectTitle: string): string {
  const now = ctx.clock.now();
  const rootId = derivedId('lib', 'channels');
  const subjectId = derivedId('lib', 'space', spaceId);
  ctx.db.run(
    `INSERT INTO library_node (id, parent_id, kind, title, sort_order, created_at, updated_at) VALUES (?, NULL, 'folder', ?, -1, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [rootId, CHANNELS_FOLDER_TITLE_AR, now, now],
  );
  ctx.db.run(`UPDATE library_node SET deleted_at = NULL, trash_root_id = NULL WHERE id = ? AND deleted_at IS NOT NULL`, [rootId]);
  ctx.db.run(
    `INSERT INTO library_node (id, parent_id, kind, title, sort_order, created_at, updated_at) VALUES (?, ?, 'subject', ?, 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [subjectId, rootId, (subjectTitle || 'مادة').slice(0, 200), now, now],
  );
  ctx.db.run(`UPDATE library_node SET deleted_at = NULL, trash_root_id = NULL WHERE id = ? AND deleted_at IS NOT NULL`, [subjectId]);
  return subjectId;
}

/** A folder the user chose, if it is theirs and alive; otherwise «موادي من القنوات» › subject. */
export function folderFor(ctx: AppContext, chosen: string | null | undefined, spaceId: string, subjectTitle: string): string {
  if (chosen && ctx.db.get(`SELECT 1 AS x FROM library_node WHERE id = ? AND deleted_at IS NULL`, [chosen])) return chosen;
  return ensureChannelsFolder(ctx, spaceId, subjectTitle);
}

export interface StubResult {
  sourceId: string;
  created: boolean;
  /** versions added to the vault by this call */
  addedVersionIds: string[];
  /** blobs the vault now references for the first time (hints are recorded after the transaction) */
  newFiles: Array<{ sha256: string; size: number; mime: string; storageKey: string }>;
}

/**
 * Make the bound vault hold a stub of the lecture with (at least) `versionIds` — published versions of THIS lecture.
 * Idempotent; never touches a personal item, a layer or a note. Throws NOT_FOUND for an unknown lecture or version.
 */
export function ensureStub(
  ctx: AppContext,
  input: { spaceId: string; lectureId: string; versionIds: readonly string[]; folderId: string | null; subjectTitle: string },
): StubResult {
  const space = spaceDb(ctx, input.spaceId);
  if (!space) throw new AppError('NOT_FOUND', 'العنصر غير موجود.', 404);
  const lecture = spaceLecture(space, input.lectureId);
  if (!lecture) throw new AppError('NOT_FOUND', 'العنصر غير موجود.', 404);
  const published = publishedVersions(space, lecture);
  const byId = new Map(published.map((v) => [v.id, v]));
  for (const id of input.versionIds) if (!byId.has(id)) throw new AppError('NOT_FOUND', 'الإصدار غير موجود.', 404);
  const now = ctx.clock.now();
  const newFiles: StubResult['newFiles'] = [];
  const fileMap = new Map<string, string | null>();

  /** the vault's stored_file id for a space file (same blob by sha256; a new row when the vault has none) */
  const vaultFile = (spaceFileId: string | null): string | null => {
    if (!spaceFileId) return null;
    if (fileMap.has(spaceFileId)) return fileMap.get(spaceFileId)!;
    const f = space.get<StoredFileRow>('SELECT * FROM stored_file WHERE id = ?', [spaceFileId]);
    if (!f) {
      fileMap.set(spaceFileId, null); // taken down (or never stored): the stub keeps the placeholder
      return null;
    }
    const mine = ctx.db.get<{ id: string }>('SELECT id FROM stored_file WHERE sha256 = ?', [f.sha256]);
    if (mine) {
      fileMap.set(spaceFileId, mine.id);
      return mine.id;
    }
    // the space's id when it is free in this vault (ULIDs: practically always), else a derived one
    const id = ctx.db.get('SELECT 1 AS x FROM stored_file WHERE id = ?', [f.id]) ? derivedId('sf', f.sha256) : f.id;
    ctx.db.run('INSERT INTO stored_file (id, sha256, size, mime, storage_key, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      f.sha256,
      f.size,
      f.mime,
      FileStore.storageKeyFor(f.sha256),
      f.original_name,
      now,
    ]);
    newFiles.push({ sha256: f.sha256, size: f.size, mime: f.mime, storageKey: FileStore.storageKeyFor(f.sha256) });
    fileMap.set(spaceFileId, id);
    return id;
  };

  return ctx.db.tx((): StubResult => {
    const existing = ctx.db.get<{ id: string; is_stub: number; origin_space_id: string | null; origin_lecture_id: string | null; deleted_at: number | null }>(
      'SELECT id, is_stub, origin_space_id, origin_lecture_id, deleted_at FROM source WHERE id = ?',
      [lecture.source_id],
    );
    if (existing && (existing.is_stub !== 1 || existing.origin_space_id !== input.spaceId || existing.origin_lecture_id !== lecture.id)) {
      throw new AppError('CONFLICT', 'يوجد في مكتبتك مصدر بالمعرّف نفسه لا يخص هذه المحاضرة؛ لم يتغير شيء.', 409);
    }
    const byOrigin = ctx.db.get<{ id: string }>('SELECT id FROM source WHERE origin_space_id = ? AND origin_lecture_id = ?', [input.spaceId, lecture.id]);
    if (byOrigin && byOrigin.id !== lecture.source_id) throw new AppError('CONFLICT', 'توجد نسخة أخرى من هذه المحاضرة في مكتبتك؛ لم يتغير شيء.', 409);
    let created = false;
    if (!existing) {
      const node = folderFor(ctx, input.folderId, input.spaceId, input.subjectTitle);
      ctx.db.run(
        `INSERT INTO source (id, title, source_type, source_type_origin, node_id, metadata_status, processing_status, lecture_no, lecture_no_origin, held_on, held_on_origin,
                             origin_space_id, origin_lecture_id, is_stub, created_at, updated_at)
         VALUES (?, ?, 'lecture', 'owner', ?, 'unknown', 'pending', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [lecture.source_id, lecture.title, node, lecture.lecture_no, lecture.lecture_no ? (lecture.lecture_no_origin ?? 'moderator') : null, lecture.held_on, lecture.held_on ? 'moderator' : null, input.spaceId, lecture.id, now, now],
      );
      created = true;
    } else if (existing.deleted_at !== null) {
      // a stub the user trashed comes back where it was when they start studying it again (their items were kept)
      ctx.db.run('UPDATE source SET deleted_at = NULL, trash_root_id = NULL, updated_at = ? WHERE id = ?', [now, lecture.source_id]);
    }
    const added: string[] = [];
    const wanted = published.filter((v) => input.versionIds.includes(v.id));
    for (const v of wanted) {
      if (ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [v.id])) continue;
      const derived = v.derived_from_version_id && ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [v.derived_from_version_id]) ? v.derived_from_version_id : null;
      ctx.db.run(
        `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, original_file_id, display_file_id, content_hash, mime, file_name, format,
                                     page_count, pagination, processing_status, processing_summary_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.id,
          lecture.source_id,
          v.version_no,
          v.kind,
          derived,
          vaultFile(v.file_id),
          vaultFile(v.original_file_id),
          vaultFile(v.display_file_id),
          v.content_hash,
          v.mime,
          v.file_name,
          v.format,
          v.page_count,
          v.pagination,
          v.processing_status,
          v.processing_summary_json,
          v.note,
          v.created_at,
        ],
      );
      const pages = space.all<Record<string, unknown> & { id: string; render_file_id: string | null; thumbnail_file_id: string | null }>('SELECT * FROM source_page WHERE version_id = ?', [v.id]);
      for (const p of pages) {
        const row: Record<string, unknown> = { ...p, render_file_id: vaultFile(p.render_file_id), thumbnail_file_id: vaultFile(p.thumbnail_file_id) };
        const cols = Object.keys(row);
        ctx.db.run(`INSERT INTO source_page (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] as never));
      }
      for (const f of space.all<Record<string, unknown>>('SELECT * FROM page_fingerprint WHERE version_id = ?', [v.id])) {
        const cols = Object.keys(f);
        ctx.db.run(`INSERT OR IGNORE INTO page_fingerprint (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => f[c] as never));
      }
      added.push(v.id);
    }
    // the official page maps between consecutive held versions (moderator decisions included), so P1-T2's note copy
    // uses the map the subject's moderators confirmed instead of computing its own
    const held = published.filter((v) => !!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [v.id]));
    for (let i = 1; i < held.length; i++) copyPageMap(ctx, space, held[i - 1]!.id, held[i]!.id);
    const latest = held[held.length - 1];
    if (latest) {
      ctx.db.run(
        `UPDATE source SET current_version_id = ?, processing_status = ?, title = ?, lecture_no = ?, lecture_no_origin = ?, held_on = ?, held_on_origin = ?, updated_at = ?
          WHERE id = ? AND (current_version_id IS NOT ? OR title <> ? OR processing_status <> ?)`,
        [
          latest.id,
          latest.processing_status,
          lecture.title,
          lecture.lecture_no,
          lecture.lecture_no ? (lecture.lecture_no_origin ?? 'moderator') : null,
          lecture.held_on,
          lecture.held_on ? 'moderator' : null,
          now,
          lecture.source_id,
          latest.id,
          lecture.title,
          latest.processing_status,
        ],
      );
    }
    return { sourceId: lecture.source_id, created, addedVersionIds: added, newFiles };
  });
}

/** Copy the space's stored page map from → to (when it is ready there) unless the vault has a current one. */
function copyPageMap(ctx: AppContext, space: Db, from: string, to: string): void {
  const run = space.get<Record<string, unknown> & { status: string; computed_at: number }>('SELECT * FROM page_map_run WHERE from_version_id = ? AND to_version_id = ?', [from, to]);
  if (!run || run.status !== 'ready') return;
  const mine = ctx.db.get<{ computed_at: number }>('SELECT computed_at FROM page_map_run WHERE from_version_id = ? AND to_version_id = ?', [from, to]);
  if (mine && mine.computed_at >= run.computed_at) return;
  ctx.db.run('DELETE FROM version_page_map WHERE from_version_id = ? AND to_version_id = ?', [from, to]);
  for (const r of space.all<Record<string, unknown>>('SELECT * FROM version_page_map WHERE from_version_id = ? AND to_version_id = ?', [from, to])) {
    const cols = Object.keys(r);
    ctx.db.run(`INSERT INTO version_page_map (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => r[c] as never));
  }
  const cols = Object.keys(run);
  ctx.db.run(
    `INSERT INTO page_map_run (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(from_version_id, to_version_id) DO UPDATE SET ${cols.filter((c) => c !== 'from_version_id' && c !== 'to_version_id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
    cols.map((c) => run[c] as never),
  );
}

/** After the stub transaction: the vault references these blobs (registry hints, P1-T1). */
export function recordStubFiles(ctx: AppContext, r: Pick<StubResult, 'newFiles'>): void {
  for (const f of r.newFiles) {
    try {
      ctx.blobs.referenced(f);
    } catch (e) {
      ctx.log.warn({ err: e }, 'could not record the blob hint of a stub file');
    }
  }
}

/** The stub of an official lecture in the bound vault (null: none). */
export function stubOf(ctx: AppContext, spaceId: string, lectureId: string): { id: string; current_version_id: string | null; deleted_at: number | null; node_id: string | null } | null {
  return (
    ctx.db.get<{ id: string; current_version_id: string | null; deleted_at: number | null; node_id: string | null }>(
      'SELECT id, current_version_id, deleted_at, node_id FROM source WHERE origin_space_id = ? AND origin_lecture_id = ? AND is_stub = 1',
      [spaceId, lectureId],
    ) ?? null
  );
}

/** Versions of the stub, oldest first. */
export function stubVersions(ctx: AppContext, sourceId: string): Array<{ id: string; version_no: number }> {
  return ctx.db.all<{ id: string; version_no: number }>('SELECT id, version_no FROM source_version WHERE source_id = ? ORDER BY version_no', [sourceId]);
}

/**
 * Personal items of the vault on each version of a source: live annotations and notes anchored to its pages (what
 * `lecture_copy.personal_items` reports — counts only). Items of a followed explanation (authored by its explainer,
 * P1-T5 step 3) are not the user's and are not counted.
 */
export function personalItemsByVersion(ctx: AppContext, sourceId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of stubVersions(ctx, sourceId)) out.set(v.id, 0);
  for (const r of ctx.db.all<{ version_id: string; n: number }>(
    `SELECT p.version_id, COUNT(DISTINCT t.annotation_id) AS n FROM annotation_target t JOIN source_page p ON p.id = t.target_id JOIN annotation a ON a.id = t.annotation_id
      WHERE t.target_type = 'source_page' AND a.deleted_at IS NULL AND a.author_user_id IS NULL AND p.version_id IN (SELECT id FROM source_version WHERE source_id = ?)
      GROUP BY p.version_id`,
    [sourceId],
  )) {
    out.set(r.version_id, (out.get(r.version_id) ?? 0) + r.n);
  }
  for (const r of ctx.db.all<{ version_id: string; n: number }>(
    `SELECT p.version_id, COUNT(*) AS n FROM note n JOIN source_page p ON n.anchor_target_key = 'source_page:' || p.id
      WHERE n.deleted_at IS NULL AND n.author_user_id IS NULL AND p.version_id IN (SELECT id FROM source_version WHERE source_id = ?)
      GROUP BY p.version_id`,
    [sourceId],
  )) {
    out.set(r.version_id, (out.get(r.version_id) ?? 0) + r.n);
  }
  return out;
}
