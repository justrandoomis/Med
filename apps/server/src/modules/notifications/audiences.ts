// Who a notification is for (P1-T4 step 2; ARCHITECTURE_DELTA §12 «recipients»). An audience is stored with the fan-out
// row as plain JSON and paged by user id (keyset), so a fan-out to thousands resumes exactly where a crash or a failed
// step left it. Built-in audiences read the system DB; later tracks register their own from their plugin
// (`registerAudience`: P1-T5 — holders of a copy of a lecture through `lecture_copy`, followers of a publication) so this
// module never reads their tables.
//
// The audience only NAMES candidates. Whether each one is told is decided per recipient by the fan-out: the account is
// active, the kind is not switched off, the person is not excluded, and they may still open what it is about.
import type { ChannelRole } from '@medlevo/shared';
import type { Db } from '../../db/db';

export type AudienceSpec =
  /** explicit people (sorted and de-duplicated when published; at most MAX_EXPLICIT_RECIPIENTS) */
  | { kind: 'users'; user_ids: string[] }
  /** who decides join requests on a node: Admins and Assistants here or above — the platform admins when nobody holds such a role */
  | { kind: 'node_approvers'; node_id: string }
  /** who moderates a scope: Admins, Assistants and Subject Moderators here or above — the platform admins when nobody does */
  | { kind: 'scope_moderators'; node_id: string }
  /** «تابع المادة»: active course follows of a subject */
  | { kind: 'course_followers'; subject_node_id: string }
  /** an audience another module registered (string params only: they are stored as JSON) */
  | { kind: 'registered'; name: string; params: Record<string, string> };

/** The next user ids strictly after `after` (ascending), at most `limit` of them. */
export type AudiencePager = (params: Record<string, string>, after: string | null, limit: number) => string[];

export interface AudiencePage {
  ids: string[];
  /** where the next page starts; null = this was the last page */
  next: string | null;
  /** the page already holds the platform admins standing in for a chain without role holders */
  fallback?: boolean;
}

/** Audiences of role holders that fall back to the platform admins when nobody in the chain can be told. */
export const ROLE_AUDIENCES: ReadonlySet<AudienceSpec['kind']> = new Set(['node_approvers', 'scope_moderators']);
/** The cursor that continues a role audience with the platform admins (review P1-T4 step 2, R1). */
export const PLATFORM_ADMINS_CURSOR = 'pa:';

export const MAX_EXPLICIT_RECIPIENTS = 10_000;

const APPROVER_ROLES: readonly ChannelRole[] = ['admin', 'assistant'];
const MODERATOR_ROLES: readonly ChannelRole[] = ['admin', 'assistant', 'subject_moderator'];

export class Audiences {
  private readonly registered = new Map<string, AudiencePager>();

  constructor(private readonly db: Db) {}

  register(name: string, pager: AudiencePager): void {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name)) throw new Error(`notification audience name not allowed: ${name}`);
    this.registered.set(name, pager);
  }

  has(name: string): boolean {
    return this.registered.has(name);
  }

  page(spec: AudienceSpec, cursor: string | null, limit: number): AudiencePage {
    switch (spec.kind) {
      case 'users': {
        const after = cursor ?? '';
        const ids = spec.user_ids.filter((id) => id > after).slice(0, limit);
        return { ids, next: ids.length === limit && spec.user_ids.some((id) => id > ids[ids.length - 1]!) ? ids[ids.length - 1]! : null };
      }
      case 'node_approvers':
        return this.rolesOrPlatformAdmins(spec.node_id, APPROVER_ROLES, cursor, limit);
      case 'scope_moderators':
        return this.rolesOrPlatformAdmins(spec.node_id, MODERATOR_ROLES, cursor, limit);
      case 'course_followers': {
        const ids = this.db
          .all<{ user_id: string }>('SELECT user_id FROM course_follow WHERE subject_node_id = ? AND ended_at IS NULL AND user_id > ? ORDER BY user_id LIMIT ?', [spec.subject_node_id, cursor ?? '', limit])
          .map((r) => r.user_id);
        return { ids, next: ids.length === limit ? ids[ids.length - 1]! : null };
      }
      case 'registered': {
        const pager = this.registered.get(spec.name);
        if (!pager) throw new Error(`notification audience not registered: ${spec.name}`);
        const ids = [...new Set(pager(spec.params, cursor, limit))].filter((id) => typeof id === 'string' && (cursor === null || id > cursor)).sort();
        if (ids.length > limit) throw new Error(`notification audience ${spec.name} returned more than ${limit} ids`);
        return { ids, next: ids.length === limit ? ids[ids.length - 1]! : null };
      }
    }
  }

  /**
   * Role holders on the node or an ancestor (cursor «r:<last id>»); when the chain has none at all, the platform admins
   * instead (cursor «pa:<last id>») — someone must hear about a join request or a report. The fan-out also continues
   * with the platform admins when the role holders exist but none of them may be told (the only moderator wrote the
   * reported content, or holds the role on a suspended account — review P1-T4 step 2, R1).
   */
  private rolesOrPlatformAdmins(nodeId: string, roles: readonly ChannelRole[], cursor: string | null, limit: number): AudiencePage {
    if (cursor === null || cursor.startsWith('r:')) {
      const after = cursor ? cursor.slice(2) : '';
      const ids = this.db
        .all<{ user_id: string }>(
          `SELECT DISTINCT ra.user_id AS user_id FROM role_assignment ra JOIN channel_closure c ON c.ancestor_id = ra.node_id
            WHERE c.descendant_id = ? AND ra.revoked_at IS NULL AND ra.role IN (${roles.map(() => '?').join(',')}) AND ra.user_id > ?
            ORDER BY ra.user_id LIMIT ?`,
          [nodeId, ...roles, after, limit],
        )
        .map((r) => r.user_id);
      if (cursor === null && ids.length === 0) return this.platformAdmins('', limit);
      return { ids, next: ids.length === limit ? `r:${ids[ids.length - 1]!}` : null };
    }
    if (cursor.startsWith(PLATFORM_ADMINS_CURSOR)) return this.platformAdmins(cursor.slice(PLATFORM_ADMINS_CURSOR.length), limit);
    throw new Error('notification audience cursor not understood');
  }

  private platformAdmins(after: string, limit: number): AudiencePage {
    const ids = this.db
      .all<{ id: string }>(`SELECT id FROM user_account WHERE is_platform_admin = 1 AND status = 'active' AND id > ? ORDER BY id LIMIT ?`, [after, limit])
      .map((r) => r.id);
    return { ids, next: ids.length === limit ? `${PLATFORM_ADMINS_CURSOR}${ids[ids.length - 1]!}` : null, fallback: true };
  }
}
