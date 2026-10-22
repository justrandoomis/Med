// The forks module's view of the SYSTEM database (P1-T5 step 2; ARCHITECTURE_DELTA §4.1 `2060_lecture_copy`, §6.3).
//
// `lecture_copy` (this track's table) says which user holds a stub of which official lecture version and how many
// personal items sit on it — never content, titles or item ids. It is written ONLY by the copy / stub / reanchor
// services right after they changed the user's vault (idempotent upserts keyed by user + lecture + version), and read
// ONLY by jobs (fan-out of new versions, withdrawal notices, the purge refusal) and as suppressed group counts.
// Read-only uses of other tracks' system tables: `course_follow` (P1-T4) for «تابع المادة» fan-out, `space` / `vault` /
// `user_account` (P1-T1) to find a user's vault and the registered spaces. This is the only file of the module that
// holds the system DB handle (test/tenancy/import-boundary.test.ts lists it).
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';

export interface HoldingRow {
  user_id: string;
  space_id: string;
  lecture_id: string;
  version_id: string;
  personal_items: number;
  updated_at: number;
}

export class ForksSystem {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.system.db;
  }

  /** Replace the user's rows for one lecture with the versions their vault holds now (one system transaction). */
  setHoldings(userId: string, spaceId: string, lectureId: string, versions: ReadonlyArray<{ version_id: string; personal_items: number }>): void {
    const now = this.ctx.clock.now();
    this.db.tx(() => {
      const keep = new Set(versions.map((v) => v.version_id));
      for (const r of this.db.all<{ version_id: string }>('SELECT version_id FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ?', [userId, spaceId, lectureId])) {
        if (!keep.has(r.version_id)) this.db.run('DELETE FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ? AND version_id = ?', [userId, spaceId, lectureId, r.version_id]);
      }
      for (const v of versions) {
        this.db.run(
          `INSERT INTO lecture_copy (user_id, space_id, lecture_id, version_id, personal_items, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, space_id, lecture_id, version_id) DO UPDATE SET personal_items = excluded.personal_items, updated_at = excluded.updated_at`,
          [userId, spaceId, lectureId, v.version_id, Math.max(0, Math.trunc(v.personal_items)), now],
        );
      }
    });
  }

  /** The user no longer holds a copy of the lecture (their stub was purged). */
  dropHoldings(userId: string, spaceId: string, lectureId: string): void {
    this.db.run('DELETE FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ?', [userId, spaceId, lectureId]);
  }

  holdingsOf(userId: string, spaceId: string, lectureId: string): HoldingRow[] {
    return this.db.all<HoldingRow>('SELECT * FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ? ORDER BY version_id', [userId, spaceId, lectureId]);
  }

  /** Holders of a copy of the lecture, keyset-paged by user id (jobs and the notification audience only). */
  holdersPage(spaceId: string, lectureId: string, after: string | null, limit: number): string[] {
    return this.db
      .all<{ user_id: string }>('SELECT DISTINCT user_id FROM lecture_copy WHERE space_id = ? AND lecture_id = ? AND user_id > ? ORDER BY user_id LIMIT ?', [spaceId, lectureId, after ?? '', limit])
      .map((r) => r.user_id);
  }

  /** How many users hold a copy of the lecture (any version). */
  holderCount(spaceId: string, lectureId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(DISTINCT user_id) AS n FROM lecture_copy WHERE space_id = ? AND lecture_id = ?', [spaceId, lectureId])?.n ?? 0;
  }

  /** Users with personal items on any of these versions, and the items (the purge refusal: counts, never names). */
  personalItemsOn(spaceId: string, versionIds: readonly string[]): { users: number; items: number } {
    if (versionIds.length === 0) return { users: 0, items: 0 };
    const r = this.db.get<{ users: number; items: number | null }>(
      `SELECT COUNT(DISTINCT user_id) AS users, SUM(personal_items) AS items FROM lecture_copy
        WHERE space_id = ? AND personal_items > 0 AND version_id IN (${versionIds.map(() => '?').join(',')})`,
      [spaceId, ...versionIds],
    );
    return { users: r?.users ?? 0, items: r?.items ?? 0 };
  }

  /** Users holding a stub of one of these versions (the purge re-counts them before deciding). */
  holdersOfVersions(spaceId: string, versionIds: readonly string[]): string[] {
    if (versionIds.length === 0) return [];
    return this.db
      .all<{ user_id: string }>(`SELECT DISTINCT user_id FROM lecture_copy WHERE space_id = ? AND version_id IN (${versionIds.map(() => '?').join(',')}) ORDER BY user_id`, [spaceId, ...versionIds])
      .map((r) => r.user_id);
  }

  /** «تابع المادة» with «add new lectures» on: active follows of active accounts, keyset-paged by user id. */
  courseFollowersPage(subjectNodeId: string, after: string | null, limit: number): Array<{ user_id: string; library_folder_id: string | null }> {
    try {
      return this.db.all<{ user_id: string; library_folder_id: string | null }>(
        `SELECT f.user_id, f.library_folder_id FROM course_follow f JOIN user_account u ON u.id = f.user_id
          WHERE f.subject_node_id = ? AND f.ended_at IS NULL AND f.add_new_lectures = 1 AND u.status = 'active' AND f.user_id > ?
          ORDER BY f.user_id LIMIT ?`,
        [subjectNodeId, after ?? '', limit],
      );
    } catch {
      return []; // the channels tables are not there (a deployment without P1-T4): nobody follows anything
    }
  }

  /** The active vault of an active account (background work binds it explicitly). */
  vaultOf(userId: string): string | null {
    return (
      this.db.get<{ id: string }>(`SELECT v.id FROM vault v JOIN user_account u ON u.id = v.user_id WHERE v.user_id = ? AND v.status = 'active' AND u.status = 'active'`, [userId])?.id ?? null
    );
  }

  /**
   * The vault of a user whatever its state (the purge refusal must not skip a vault it cannot read right now — locked
   * for a restore, or an account suspended or pending deletion — review P1-T5 s2 R-D). Null: no vault, or deleted.
   */
  vaultStateOf(userId: string): { id: string; readable: boolean } | null {
    const v = this.db.get<{ id: string; status: string; user_status: string }>(
      `SELECT v.id, v.status, u.status AS user_status FROM vault v JOIN user_account u ON u.id = v.user_id WHERE v.user_id = ?`,
      [userId],
    );
    if (!v || v.status === 'deleted' || v.user_status === 'deleted') return null;
    return { id: v.id, readable: v.status === 'active' };
  }

  /** The account a vault belongs to (background work inside a vault has no viewer). */
  userOfVault(vaultId: string): string | null {
    return this.db.get<{ user_id: string }>('SELECT user_id FROM vault WHERE id = ?', [vaultId])?.user_id ?? null;
  }

  /** The vault of the signed-in viewer (null while it cannot be used). */
  vaultOfViewer(viewer: Viewer): string | null {
    return this.vaultOf(viewer.userId);
  }

  /** The title of a registered space (the subject's name; P1-T4 keeps it current). */
  spaceTitleOf(spaceId: string): string | null {
    return this.db.get<{ title: string }>('SELECT title FROM space WHERE id = ?', [spaceId])?.title ?? null;
  }

  /** Registered spaces that can be read (federated search, link candidates). */
  readableSpaces(): string[] {
    return this.db.all<{ id: string }>(`SELECT id FROM space WHERE status IN ('active','read_only') ORDER BY id`).map((r) => r.id);
  }

  /** The subjects the viewer may read official content in: an approved membership or a role there (gate 2 rules). */
  spacesOfViewer(viewer: Viewer): Array<{ spaceId: string; subjectNodeId: string; moderator: boolean }> {
    const out: Array<{ spaceId: string; subjectNodeId: string; moderator: boolean }> = [];
    for (const spaceId of this.readableSpaces()) {
      const m = this.ctx.authz.memberships.accessToSpace(viewer, spaceId);
      if (!m || m.pending) continue;
      out.push({ spaceId, subjectNodeId: m.subjectNodeId, moderator: m.access === 'moderator' });
    }
    return out;
  }
}

// ───────────────────────────── publications (P1-T5 step 3; 2150_publications) ─────────────────────────────

export type PublicationStatusValue = 'active' | 'hidden_by_moderator' | 'withdrawn' | 'author_deleted';

export interface PublicationRow {
  id: string;
  space_id: string;
  lecture_id: string;
  subject_node_id: string;
  author_user_id: string;
  kind: 'explanation' | 'voice_explanation' | 'crowd_notes';
  title: string;
  summary: string | null;
  visibility: 'specific_users' | 'followers' | 'course' | 'public';
  status: PublicationStatusValue;
  head_version_no: number;
  published_at: number;
  updated_at: number;
  hidden_reason_ar: string | null;
  hidden_at: number | null;
  hidden_by: string | null;
  withdrawn_at: number | null;
  client_key: string | null;
}

export interface PublicationCopyRow {
  user_id: string;
  publication_id: string;
  mode: 'independent' | 'followed';
  applied_version_no: number;
  pending_version_no: number | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

/**
 * The publication index and the holders of forks / followed copies (system DB). Content never lives here: titles,
 * the live head number and the moderation state only; `publication_copy` says who holds a copy, never what is in it.
 */
export class PublicationIndex {
  constructor(private readonly ctx: AppContext) {}

  private get db() {
    return this.ctx.system.db;
  }

  get(id: string): PublicationRow | null {
    return this.db.get<PublicationRow>('SELECT * FROM publication WHERE id = ?', [id]) ?? null;
  }

  byClientKey(authorUserId: string, key: string): PublicationRow | null {
    return this.db.get<PublicationRow>('SELECT * FROM publication WHERE author_user_id = ? AND client_key = ?', [authorUserId, key]) ?? null;
  }

  /** Insert the index row of a new publication (idempotent by id: a retried publish finds the row). */
  insert(row: Omit<PublicationRow, 'hidden_reason_ar' | 'hidden_at' | 'hidden_by' | 'withdrawn_at' | 'status'>): void {
    this.db.run(
      `INSERT INTO publication (id, space_id, lecture_id, subject_node_id, author_user_id, kind, title, summary, visibility, status, head_version_no, published_at, updated_at, client_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [row.id, row.space_id, row.lecture_id, row.subject_node_id, row.author_user_id, row.kind, row.title, row.summary, row.visibility, row.head_version_no, row.published_at, row.updated_at, row.client_key],
    );
  }

  /** The live head moves forward only (a replayed or late write never moves it back). */
  setHead(id: string, versionNo: number): void {
    this.db.run('UPDATE publication SET head_version_no = ?, updated_at = ? WHERE id = ? AND head_version_no < ?', [versionNo, this.ctx.clock.now(), id, versionNo]);
  }

  patch(id: string, p: { title?: string; summary?: string | null }): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (p.title !== undefined) {
      sets.push('title = ?');
      params.push(p.title);
    }
    if (p.summary !== undefined) {
      sets.push('summary = ?');
      params.push(p.summary);
    }
    if (sets.length === 0) return;
    this.db.run(`UPDATE publication SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, this.ctx.clock.now(), id]);
  }

  withdraw(id: string): void {
    const now = this.ctx.clock.now();
    this.db.run(`UPDATE publication SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE id = ? AND status IN ('active','hidden_by_moderator')`, [now, now, id]);
  }

  /** A moderator's hide / restore (called inside P1-T4's moderation transaction on this same database). */
  setModerationState(id: string, state: 'visible' | 'hidden', by: { userId: string; reasonAr: string }): void {
    const now = this.ctx.clock.now();
    if (state === 'hidden') {
      this.db.run(
        `UPDATE publication SET status = 'hidden_by_moderator', hidden_reason_ar = ?, hidden_at = ?, hidden_by = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
        [by.reasonAr, now, by.userId, now, id],
      );
    } else {
      this.db.run(
        `UPDATE publication SET status = 'active', hidden_reason_ar = NULL, hidden_at = NULL, hidden_by = NULL, updated_at = ? WHERE id = ? AND status = 'hidden_by_moderator'`,
        [now, id],
      );
    }
  }

  /** Active publications of a lecture, newest first, keyset-paged by (updated_at, id). */
  activeOfLecture(spaceId: string, lectureId: string, after: { updated_at: number; id: string } | null, limit: number): PublicationRow[] {
    const where = [`space_id = ?`, `lecture_id = ?`, `status = 'active'`];
    const params: Array<string | number> = [spaceId, lectureId];
    if (after) {
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(after.updated_at, after.updated_at, after.id);
    }
    return this.db.all<PublicationRow>(`SELECT * FROM publication WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`, [...params, limit]);
  }

  /** Every publication of a lecture in any state (the space purge withdraws them). */
  ofLecture(spaceId: string, lectureId: string): PublicationRow[] {
    return this.db.all<PublicationRow>('SELECT * FROM publication WHERE space_id = ? AND lecture_id = ? ORDER BY id', [spaceId, lectureId]);
  }

  /** Q14: an account's publications leave every listing; its readers' copies keep what they have. */
  authorDeleted(userId: string): { publications: number } {
    const now = this.ctx.clock.now();
    return this.db.tx(() => {
      const r = this.db.run(`UPDATE publication SET status = 'author_deleted', withdrawn_at = COALESCE(withdrawn_at, ?), updated_at = ? WHERE author_user_id = ? AND status <> 'author_deleted'`, [now, now, userId]);
      this.db.run('UPDATE publication_copy SET ended_at = ?, updated_at = ? WHERE user_id = ? AND ended_at IS NULL', [now, now, userId]);
      // AOS-21.18: the grants the account held as a copy holder go with its copies
      this.ctx.system.acl.revokeAllOfUserInternal(userId);
      return { publications: r.changes };
    });
  }

  /** Every publication of an account, in any state (account deletion: whose copies must lose the name, review R3-F). */
  ofAuthor(userId: string): PublicationRow[] {
    return this.db.all<PublicationRow>('SELECT * FROM publication WHERE author_user_id = ? ORDER BY id', [userId]);
  }

  /** Everyone else who holds (or held) a fork or followed copy of a publication, keyset-paged by user id. */
  holdersPage(publicationId: string, exceptUserId: string, after: string | null, limit: number): string[] {
    return this.db
      .all<{ user_id: string }>('SELECT user_id FROM publication_copy WHERE publication_id = ? AND user_id <> ? AND user_id > ? ORDER BY user_id LIMIT ?', [publicationId, exceptUserId, after ?? '', limit])
      .map((r) => r.user_id);
  }

  /** How many publications an account has, and how many of them others hold a fork of (the deletion preview, Q14). */
  countsOfAuthor(userId: string): { total: number; forked_by_others: number } {
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM publication WHERE author_user_id = ? AND status IN ('active','hidden_by_moderator')`, [userId])?.n ?? 0;
    const forked =
      this.db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT p.id) AS n FROM publication p JOIN publication_copy c ON c.publication_id = p.id
          WHERE p.author_user_id = ? AND p.status IN ('active','hidden_by_moderator') AND c.mode = 'independent' AND c.user_id <> ?`,
        [userId, userId],
      )?.n ?? 0;
    return { total, forked_by_others: forked };
  }

  // ── holders of forks and followed copies ──

  copyOf(userId: string, publicationId: string): PublicationCopyRow | null {
    return this.db.get<PublicationCopyRow>('SELECT * FROM publication_copy WHERE user_id = ? AND publication_id = ?', [userId, publicationId]) ?? null;
  }

  /** The user holds a live fork or followed copy (authz: holders still read a hidden or withdrawn explanation's state). */
  holds(userId: string, publicationId: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM publication_copy WHERE user_id = ? AND publication_id = ? AND ended_at IS NULL', [userId, publicationId]);
  }

  upsertCopy(userId: string, publicationId: string, mode: PublicationCopyRow['mode'], applied: number, pending: number | null): void {
    const now = this.ctx.clock.now();
    // AOS-21.18: holding a fork or a followed copy is a durable `view` grant on the publication (system `acl_grant`),
    // read by the one policy (authz/rules/publications.ts) — written with the copy row, in the same system DB
    const space = this.db.get<{ space_id: string }>('SELECT space_id FROM publication WHERE id = ?', [publicationId])?.space_id;
    if (space) this.ctx.system.acl.grantInternal({ resourceType: 'publication', resourceDb: space, resourceId: publicationId, granteeUserId: userId, permission: 'view', grantedBy: userId });
    this.db.run(
      `INSERT INTO publication_copy (user_id, publication_id, mode, applied_version_no, pending_version_no, created_at, updated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, publication_id) DO UPDATE SET mode = excluded.mode, applied_version_no = excluded.applied_version_no,
         pending_version_no = excluded.pending_version_no, updated_at = excluded.updated_at, ended_at = NULL`,
      [userId, publicationId, mode, applied, pending, now, now],
    );
  }

  endCopy(userId: string, publicationId: string): void {
    const now = this.ctx.clock.now();
    this.db.run('UPDATE publication_copy SET ended_at = ?, updated_at = ? WHERE user_id = ? AND publication_id = ? AND ended_at IS NULL', [now, now, userId, publicationId]);
    const space = this.db.get<{ space_id: string }>('SELECT space_id FROM publication WHERE id = ?', [publicationId])?.space_id;
    if (space) this.ctx.system.acl.revokeInternal({ resourceType: 'publication', resourceDb: space, resourceId: publicationId, granteeUserId: userId });
  }

  /** Followers of a publication (live followed copies of active accounts), keyset-paged by user id. */
  followersPage(publicationId: string, after: string | null, limit: number): string[] {
    return this.db
      .all<{ user_id: string }>(
        `SELECT c.user_id FROM publication_copy c JOIN user_account u ON u.id = c.user_id
          WHERE c.publication_id = ? AND c.mode = 'followed' AND c.ended_at IS NULL AND u.status = 'active' AND c.user_id > ?
          ORDER BY c.user_id LIMIT ?`,
        [publicationId, after ?? '', limit],
      )
      .map((r) => r.user_id);
  }
}

const publicationIndexes = new WeakMap<object, PublicationIndex>();
export function publicationIndex(ctx: AppContext): PublicationIndex {
  let s = publicationIndexes.get(ctx.system);
  if (!s) {
    s = new PublicationIndex(ctx);
    publicationIndexes.set(ctx.system, s);
  }
  return s;
}

const instances = new WeakMap<object, ForksSystem>();
export function forksSystem(ctx: AppContext): ForksSystem {
  let s = instances.get(ctx.system);
  if (!s) {
    s = new ForksSystem(ctx);
    instances.set(ctx.system, s);
  }
  return s;
}
