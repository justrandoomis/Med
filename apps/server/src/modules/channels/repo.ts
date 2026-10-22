// Channel repository (P1-T4 step 1): the SQL of the tree, closure, memberships, codes, invitations and roles in the
// SYSTEM database (`2050_directory`, `2100_permissions`). No policy here — callers (service.ts, access.ts) decide who
// may act; every method that lists people's rows is called only after the policy allowed it.
import type { ChannelKind, ChannelRole, JoinMethod, JoinPolicy, MembershipStatus } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: ChannelKind;
  title: string;
  title_en: string | null;
  ordinal: number | null;
  starts_on: string | null;
  ends_on: string | null;
  space_id: string | null;
  join_policy: JoinPolicy;
  rights_json: string;
  status: 'active' | 'archived';
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface AncestorRow extends NodeRow {
  /** 0 = the node itself */
  depth: number;
}

export interface MembershipRow {
  id: string;
  node_id: string;
  user_id: string;
  status: MembershipStatus;
  join_method: JoinMethod;
  join_code_id: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface JoinCodeRow {
  id: string;
  node_id: string;
  kind: 'class_code' | 'invite_link';
  secret_hash: string;
  hint: string;
  requires_approval: number;
  max_uses: number | null;
  use_count: number;
  expires_at: number;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
}

export interface InvitationRow {
  id: string;
  node_id: string;
  invitee_user_id: string;
  invited_by: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: number;
  created_at: number;
  decided_at: number | null;
}

export interface RoleRow {
  id: string;
  node_id: string;
  user_id: string;
  role: ChannelRole;
  granted_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface CourseFollowRow {
  user_id: string;
  subject_node_id: string;
  add_new_lectures: number;
  library_folder_id: string | null;
  created_at: number;
  ended_at: number | null;
}

export interface PersonRow {
  id: string;
  display_name: string;
  status: string;
}

const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');

export class ChannelRepo {
  constructor(
    /** the SYSTEM database */
    readonly db: Db,
    private readonly clock: Clock,
  ) {}

  // ───────── nodes and the closure ─────────

  node(id: string): NodeRow | null {
    return this.db.get<NodeRow>('SELECT * FROM channel_node WHERE id = ? AND deleted_at IS NULL', [id]) ?? null;
  }

  nodesByIds(ids: readonly string[]): NodeRow[] {
    if (ids.length === 0) return [];
    return this.db.all<NodeRow>(`SELECT * FROM channel_node WHERE id IN (${inList(ids.length)}) AND deleted_at IS NULL`, [...ids]);
  }

  nodeOfSpace(spaceId: string): NodeRow | null {
    return this.db.get<NodeRow>('SELECT * FROM channel_node WHERE space_id = ? AND deleted_at IS NULL', [spaceId]) ?? null;
  }

  roots(): NodeRow[] {
    return this.db.all<NodeRow>('SELECT * FROM channel_node WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY ordinal IS NULL, ordinal, title, id');
  }

  /** Descendants of `rootId` down to `depth` levels below it (the root excluded), in tree order of depth then title. */
  descendants(rootId: string, depth: number, limit: number): Array<NodeRow & { depth: number }> {
    return this.db.all<NodeRow & { depth: number }>(
      `SELECT n.*, c.depth AS depth FROM channel_closure c JOIN channel_node n ON n.id = c.descendant_id
        WHERE c.ancestor_id = ? AND c.depth BETWEEN 1 AND ? AND n.deleted_at IS NULL
        ORDER BY c.depth, n.ordinal IS NULL, n.ordinal, n.title, n.id LIMIT ?`,
      [rootId, depth, limit],
    );
  }

  /** The node and its ancestors, itself first (depth 0), the root last — one indexed lookup. */
  ancestors(id: string): AncestorRow[] {
    return this.db.all<AncestorRow>(
      `SELECT n.*, c.depth AS depth FROM channel_closure c JOIN channel_node n ON n.id = c.ancestor_id
        WHERE c.descendant_id = ? ORDER BY c.depth`,
      [id],
    );
  }

  /** Ancestor ids of many nodes at once: descendant → [ancestor ids, nearest first]. */
  ancestorIdsOf(ids: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = this.db.all<{ ancestor_id: string; descendant_id: string }>(
      `SELECT ancestor_id, descendant_id FROM channel_closure WHERE descendant_id IN (${inList(ids.length)}) ORDER BY descendant_id, depth`,
      [...ids],
    );
    for (const r of rows) {
      let list = out.get(r.descendant_id);
      if (!list) out.set(r.descendant_id, (list = []));
      list.push(r.ancestor_id);
    }
    return out;
  }

  /** «Is X inside Y?» (a node is inside itself). */
  isInside(descendantId: string, ancestorId: string): boolean {
    return this.db.get<{ x: number }>('SELECT 1 AS x FROM channel_closure WHERE ancestor_id = ? AND descendant_id = ?', [ancestorId, descendantId]) !== undefined;
  }

  /** The node and every node below it. */
  subtreeIds(id: string): string[] {
    return this.db.all<{ id: string }>('SELECT descendant_id AS id FROM channel_closure WHERE ancestor_id = ? ORDER BY depth, descendant_id', [id]).map((r) => r.id);
  }

  insertNode(row: Omit<NodeRow, 'created_at' | 'updated_at' | 'deleted_at' | 'rights_json' | 'status'>): NodeRow {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO channel_node (id, parent_id, kind, title, title_en, ordinal, starts_on, ends_on, space_id, join_policy, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [row.id, row.parent_id, row.kind, row.title, row.title_en, row.ordinal, row.starts_on, row.ends_on, row.space_id, row.join_policy, row.created_by, now, now],
    );
    // closure: the self row, then one row per ancestor of the parent
    this.db.run('INSERT INTO channel_closure (ancestor_id, descendant_id, depth) VALUES (?, ?, 0)', [row.id, row.id]);
    if (row.parent_id) {
      this.db.run(
        `INSERT INTO channel_closure (ancestor_id, descendant_id, depth)
         SELECT ancestor_id, ?, depth + 1 FROM channel_closure WHERE descendant_id = ?`,
        [row.id, row.parent_id],
      );
    }
    return this.node(row.id)!;
  }

  updateNode(id: string, patch: Partial<Pick<NodeRow, 'title' | 'title_en' | 'ordinal' | 'starts_on' | 'ends_on' | 'join_policy'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.db.run(`UPDATE channel_node SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), this.clock.now(), id]);
  }

  /**
   * Move a node (with its subtree) under a new parent: the closure rows that link the subtree to its old ancestors go,
   * new ones link it to the new parent's ancestors. The caller checked kinds and cycles.
   */
  moveNode(id: string, newParentId: string): void {
    this.db.run(
      `DELETE FROM channel_closure
        WHERE descendant_id IN (SELECT descendant_id FROM channel_closure WHERE ancestor_id = ?)
          AND ancestor_id NOT IN (SELECT descendant_id FROM channel_closure WHERE ancestor_id = ?)`,
      [id, id],
    );
    this.db.run(
      `INSERT INTO channel_closure (ancestor_id, descendant_id, depth)
       SELECT p.ancestor_id, s.descendant_id, p.depth + s.depth + 1
         FROM channel_closure p, channel_closure s
        WHERE p.descendant_id = ? AND s.ancestor_id = ?`,
      [newParentId, id],
    );
    this.db.run('UPDATE channel_node SET parent_id = ?, updated_at = ? WHERE id = ?', [newParentId, this.clock.now(), id]);
  }

  archiveSubtree(id: string): string[] {
    const ids = this.subtreeIds(id);
    const now = this.clock.now();
    this.db.run(`UPDATE channel_node SET status = 'archived', updated_at = ? WHERE id IN (${inList(ids.length)}) AND status = 'active'`, [now, ...ids]);
    return ids;
  }

  setSpaceTitle(spaceId: string, title: string): void {
    this.db.run('UPDATE space SET title = ?, updated_at = ? WHERE id = ?', [title, this.clock.now(), spaceId]);
  }

  setSpacesReadOnly(spaceIds: readonly string[]): void {
    if (spaceIds.length === 0) return;
    this.db.run(`UPDATE space SET status = 'read_only', updated_at = ? WHERE id IN (${inList(spaceIds.length)}) AND status = 'active'`, [this.clock.now(), ...spaceIds]);
  }

  // ───────── memberships ─────────

  membership(nodeId: string, userId: string): MembershipRow | null {
    return this.db.get<MembershipRow>('SELECT * FROM channel_membership WHERE node_id = ? AND user_id = ?', [nodeId, userId]) ?? null;
  }

  membershipById(id: string): MembershipRow | null {
    return this.db.get<MembershipRow>('SELECT * FROM channel_membership WHERE id = ?', [id]) ?? null;
  }

  /** The user's memberships on any of these nodes. */
  membershipsOn(userId: string, nodeIds: readonly string[]): MembershipRow[] {
    if (nodeIds.length === 0) return [];
    return this.db.all<MembershipRow>(`SELECT * FROM channel_membership WHERE user_id = ? AND node_id IN (${inList(nodeIds.length)})`, [userId, ...nodeIds]);
  }

  membershipsOfUser(userId: string): MembershipRow[] {
    return this.db.all<MembershipRow>('SELECT * FROM channel_membership WHERE user_id = ? ORDER BY created_at, id', [userId]);
  }

  /** Create or re-open the user's membership of a node (status and method as given). */
  upsertMembership(input: { nodeId: string; userId: string; status: MembershipStatus; method: JoinMethod; joinCodeId: string | null; decidedBy: string | null }): MembershipRow {
    const now = this.clock.now();
    const existing = this.membership(input.nodeId, input.userId);
    const decidedAt = input.decidedBy ? now : null;
    if (existing) {
      this.db.run(
        `UPDATE channel_membership SET status = ?, join_method = ?, join_code_id = ?, decided_by = ?, decided_at = ?, decision_reason = NULL, updated_at = ? WHERE id = ?`,
        [input.status, input.method, input.joinCodeId, input.decidedBy, decidedAt, now, existing.id],
      );
      return this.membershipById(existing.id)!;
    }
    const id = newId(now);
    this.db.run(
      `INSERT INTO channel_membership (id, node_id, user_id, status, join_method, join_code_id, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.nodeId, input.userId, input.status, input.method, input.joinCodeId, input.decidedBy, decidedAt, now, now],
    );
    return this.membershipById(id)!;
  }

  decideMembership(id: string, status: MembershipStatus, decidedBy: string, reason: string | null): void {
    const now = this.clock.now();
    this.db.run('UPDATE channel_membership SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?', [status, decidedBy, now, reason, now, id]);
  }

  /** Memberships ON a node (not inherited), oldest first, keyset-paged by (created_at, id). */
  membersPage(nodeId: string, status: MembershipStatus | undefined, after: { created_at: number; id: string } | null, limit: number): MembershipRow[] {
    const where = ['node_id = ?'];
    const params: (string | number)[] = [nodeId];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (after) {
      where.push('(created_at > ? OR (created_at = ? AND id > ?))');
      params.push(after.created_at, after.created_at, after.id);
    }
    return this.db.all<MembershipRow>(`SELECT * FROM channel_membership WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`, [...params, limit]);
  }

  /** Approved and pending memberships on the subtree (the archive preview). */
  liveMembershipCount(nodeIds: readonly string[]): number {
    if (nodeIds.length === 0) return 0;
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM channel_membership WHERE node_id IN (${inList(nodeIds.length)}) AND status IN ('approved','pending')`, [...nodeIds])!.n;
  }

  // ───────── codes ─────────

  insertCode(row: Omit<JoinCodeRow, 'use_count' | 'revoked_at' | 'created_at'>): JoinCodeRow {
    this.db.run(
      `INSERT INTO join_code (id, node_id, kind, secret_hash, hint, requires_approval, max_uses, use_count, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [row.id, row.node_id, row.kind, row.secret_hash, row.hint, row.requires_approval, row.max_uses, row.expires_at, row.created_by, this.clock.now()],
    );
    return this.code(row.id)!;
  }

  code(id: string): JoinCodeRow | null {
    return this.db.get<JoinCodeRow>('SELECT * FROM join_code WHERE id = ?', [id]) ?? null;
  }

  codeByHash(hash: string): JoinCodeRow | null {
    return this.db.get<JoinCodeRow>('SELECT * FROM join_code WHERE secret_hash = ?', [hash]) ?? null;
  }

  codesOfNode(nodeId: string, limit = 200): JoinCodeRow[] {
    return this.db.all<JoinCodeRow>('SELECT * FROM join_code WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [nodeId, limit]);
  }

  /** Take one use of a live code, atomically (false when it is revoked, expired or has no use left). */
  takeUse(codeId: string): boolean {
    return (
      this.db.run('UPDATE join_code SET use_count = use_count + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_uses IS NULL OR use_count < max_uses)', [codeId, this.clock.now()])
        .changes > 0
    );
  }

  /** Give a use back (the account creation that reserved it failed). */
  giveUseBack(codeId: string): void {
    this.db.run('UPDATE join_code SET use_count = use_count - 1 WHERE id = ? AND use_count > 0', [codeId]);
  }

  revokeCode(id: string): void {
    this.db.run('UPDATE join_code SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [this.clock.now(), id]);
  }

  /** Open (not revoked, not expired) codes on the subtree. */
  openCodeIds(nodeIds: readonly string[]): string[] {
    if (nodeIds.length === 0) return [];
    return this.db
      .all<{ id: string }>(`SELECT id FROM join_code WHERE node_id IN (${inList(nodeIds.length)}) AND revoked_at IS NULL AND expires_at > ?`, [...nodeIds, this.clock.now()])
      .map((r) => r.id);
  }

  // ───────── invitations ─────────

  invitation(id: string): InvitationRow | null {
    return this.db.get<InvitationRow>('SELECT * FROM channel_invitation WHERE id = ?', [id]) ?? null;
  }

  pendingInvitation(nodeId: string, userId: string): InvitationRow | null {
    return this.db.get<InvitationRow>(`SELECT * FROM channel_invitation WHERE node_id = ? AND invitee_user_id = ? AND status = 'pending'`, [nodeId, userId]) ?? null;
  }

  insertInvitation(nodeId: string, userId: string, invitedBy: string, expiresAt: number): InvitationRow {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run(`INSERT INTO channel_invitation (id, node_id, invitee_user_id, invited_by, status, expires_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`, [
      id,
      nodeId,
      userId,
      invitedBy,
      expiresAt,
      now,
    ]);
    return this.invitation(id)!;
  }

  /** The user's pending, unexpired invitations (expired ones are marked so first). */
  pendingInvitationsOf(userId: string): InvitationRow[] {
    const now = this.clock.now();
    this.db.run(`UPDATE channel_invitation SET status = 'expired' WHERE invitee_user_id = ? AND status = 'pending' AND expires_at <= ?`, [userId, now]);
    return this.db.all<InvitationRow>(`SELECT * FROM channel_invitation WHERE invitee_user_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 200`, [userId]);
  }

  /** Revoke the pending invitations into these nodes (an archive). */
  revokePendingInvitations(nodeIds: readonly string[]): void {
    if (nodeIds.length === 0) return;
    this.db.run(`UPDATE channel_invitation SET status = 'revoked', decided_at = ? WHERE node_id IN (${inList(nodeIds.length)}) AND status = 'pending'`, [this.clock.now(), ...nodeIds]);
  }

  decideInvitation(id: string, status: InvitationRow['status']): void {
    this.db.run('UPDATE channel_invitation SET status = ?, decided_at = ? WHERE id = ?', [status, this.clock.now(), id]);
  }

  // ───────── roles ─────────

  role(id: string): RoleRow | null {
    return this.db.get<RoleRow>('SELECT * FROM role_assignment WHERE id = ?', [id]) ?? null;
  }

  activeRole(nodeId: string, userId: string, role: ChannelRole): RoleRow | null {
    return this.db.get<RoleRow>('SELECT * FROM role_assignment WHERE node_id = ? AND user_id = ? AND role = ? AND revoked_at IS NULL', [nodeId, userId, role]) ?? null;
  }

  /** The user's active roles on any of these nodes. */
  rolesOn(userId: string, nodeIds: readonly string[]): RoleRow[] {
    if (nodeIds.length === 0) return [];
    return this.db.all<RoleRow>(`SELECT * FROM role_assignment WHERE user_id = ? AND revoked_at IS NULL AND node_id IN (${inList(nodeIds.length)})`, [userId, ...nodeIds]);
  }

  rolesOfUser(userId: string): RoleRow[] {
    return this.db.all<RoleRow>('SELECT * FROM role_assignment WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, id', [userId]);
  }

  /** Active roles held on any of these nodes (by anyone): the roles list of a node with its inherited ones. */
  rolesOnNodes(nodeIds: readonly string[]): RoleRow[] {
    if (nodeIds.length === 0) return [];
    return this.db.all<RoleRow>(`SELECT * FROM role_assignment WHERE revoked_at IS NULL AND node_id IN (${inList(nodeIds.length)}) ORDER BY created_at, id`, [...nodeIds]);
  }

  insertRole(nodeId: string, userId: string, role: ChannelRole, grantedBy: string): RoleRow {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run('INSERT INTO role_assignment (id, node_id, user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, nodeId, userId, role, grantedBy, now]);
    return this.role(id)!;
  }

  revokeRole(id: string, by: string): void {
    this.db.run('UPDATE role_assignment SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', [this.clock.now(), by, id]);
  }

  // ───────── course follows «تابع المادة» (step 2) ─────────

  courseFollow(userId: string, subjectNodeId: string): CourseFollowRow | null {
    return this.db.get<CourseFollowRow>('SELECT * FROM course_follow WHERE user_id = ? AND subject_node_id = ? AND ended_at IS NULL', [userId, subjectNodeId]) ?? null;
  }

  /** Follow (or change the follow's settings): one row per user and subject; an ended follow starts again from now. */
  upsertCourseFollow(userId: string, subjectNodeId: string, addNewLectures: boolean, libraryFolderId: string | null): CourseFollowRow {
    const now = this.clock.now();
    this.db.run(
      `INSERT INTO course_follow (user_id, subject_node_id, add_new_lectures, library_folder_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, subject_node_id) DO UPDATE SET
         add_new_lectures = excluded.add_new_lectures,
         library_folder_id = excluded.library_folder_id,
         created_at = CASE WHEN course_follow.ended_at IS NULL THEN course_follow.created_at ELSE excluded.created_at END,
         ended_at = NULL`,
      [userId, subjectNodeId, addNewLectures ? 1 : 0, libraryFolderId, now],
    );
    return this.courseFollow(userId, subjectNodeId)!;
  }

  endCourseFollow(userId: string, subjectNodeId: string): void {
    this.db.run('UPDATE course_follow SET ended_at = ? WHERE user_id = ? AND subject_node_id = ? AND ended_at IS NULL', [this.clock.now(), userId, subjectNodeId]);
  }

  /**
   * Active follows of a subject, keyset-paged by user id (P1-T5 seam: the course-follow stub fan-out reads the
   * library folder and `add_new_lectures` of each follower; it must still check that each one may enter the subject).
   */
  courseFollowersPage(subjectNodeId: string, afterUserId: string | null, limit: number): CourseFollowRow[] {
    return this.db.all<CourseFollowRow>('SELECT * FROM course_follow WHERE subject_node_id = ? AND ended_at IS NULL AND user_id > ? ORDER BY user_id LIMIT ?', [subjectNodeId, afterUserId ?? '', limit]);
  }

  /** Pending requests ON a node (the count in a join-request notice). */
  pendingCount(nodeId: string): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM channel_membership WHERE node_id = ? AND status = 'pending'`, [nodeId])!.n;
  }

  // ───────── people (display names only) ─────────

  people(ids: readonly string[]): Map<string, PersonRow> {
    const out = new Map<string, PersonRow>();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return out;
    for (const r of this.db.all<PersonRow>(`SELECT id, display_name, status FROM user_account WHERE id IN (${inList(unique.length)})`, unique)) out.set(r.id, r);
    return out;
  }

  /** An active account by id (invitations, role assignment). */
  activePerson(id: string): PersonRow | null {
    return this.db.get<PersonRow>(`SELECT id, display_name, status FROM user_account WHERE id = ? AND status = 'active'`, [id]) ?? null;
  }

  // ───────── account deletion ─────────

  /** Everything channel-shaped a deleted account still holds goes (membership rows stay as «left» for the audit trail). */
  forgetUser(userId: string): void {
    const now = this.clock.now();
    this.db.run(`UPDATE channel_membership SET status = 'left', updated_at = ? WHERE user_id = ? AND status IN ('pending','approved')`, [now, userId]);
    this.db.run('UPDATE role_assignment SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
    this.db.run(`UPDATE channel_invitation SET status = 'revoked', decided_at = ? WHERE invitee_user_id = ? AND status = 'pending'`, [now, userId]);
    this.db.run('UPDATE course_follow SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL', [now, userId]);
  }
}
