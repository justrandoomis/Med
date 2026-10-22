// Per-resource ACL grants (system `acl_grant`, migration 2100; ARCHITECTURE_DELTA §4.1, §5.1–§5.3; PRD AOS-21.18).
// The ONE policy (modules/authz) reads them through its grant provider (`has`); the copy services write them (a member
// who takes a fork or a followed copy of a course-only publication holds a durable `view` grant on it). Every write is
// an internal call (no viewer): the caller already passed the policy check for the action that creates the grant.
//
// A permission implies the ones below it: manage ⊇ edit ⊇ suggest ⊇ comment ⊇ view. A grant counts while it is not
// revoked and not expired.
import type { Db } from '../db/db';
import { newId } from '../lib/ids';
import type { Clock } from '../lib/time';
import type { Viewer } from './binding';

export const ACL_RESOURCE_TYPES = ['publication', 'collab_doc', 'recording_share', 'room'] as const;
export type AclResourceType = (typeof ACL_RESOURCE_TYPES)[number];
export const ACL_PERMISSIONS = ['view', 'comment', 'suggest', 'edit', 'manage'] as const;
export type AclPermission = (typeof ACL_PERMISSIONS)[number];

export interface AclGrantRow {
  id: string;
  resource_type: AclResourceType;
  resource_db: string;
  resource_id: string;
  grantee_user_id: string;
  permission: AclPermission;
  granted_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface AclGrantInput {
  resourceType: AclResourceType;
  /** 'system' or the id of the space holding the resource */
  resourceDb: string;
  resourceId: string;
  granteeUserId: string;
  permission: AclPermission;
  grantedBy: string;
  expiresAt?: number | null;
}

/** What the policy asks: does this viewer hold `permission` (or a higher one) on this resource right now? */
export interface GrantProvider {
  has(viewer: Viewer, resourceType: AclResourceType, resourceDb: string, resourceId: string, permission: AclPermission): boolean;
}

export const NO_GRANTS: GrantProvider = Object.freeze({ has: () => false });

/** the permissions that include `p` (p itself and every higher one) */
function atLeast(p: AclPermission): AclPermission[] {
  return ACL_PERMISSIONS.slice(ACL_PERMISSIONS.indexOf(p)) as AclPermission[];
}

export class AclGrantRepo implements GrantProvider {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  has(viewer: Viewer, resourceType: AclResourceType, resourceDb: string, resourceId: string, permission: AclPermission): boolean {
    const perms = atLeast(permission);
    return (
      this.db.get<{ x: number }>(
        `SELECT 1 AS x FROM acl_grant WHERE grantee_user_id = ? AND resource_type = ? AND resource_db = ? AND resource_id = ?
           AND permission IN (${perms.map(() => '?').join(',')}) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
        [viewer.userId, resourceType, resourceDb, resourceId, ...perms, this.clock.now()],
      ) !== undefined
    );
  }

  /** Internal (the copy services): grant once — an active identical grant is kept as it is. */
  grantInternal(g: AclGrantInput): void {
    this.db.tx(() => {
      const active = this.db.get<{ id: string }>(
        `SELECT id FROM acl_grant WHERE resource_type = ? AND resource_db = ? AND resource_id = ? AND grantee_user_id = ? AND permission = ? AND revoked_at IS NULL`,
        [g.resourceType, g.resourceDb, g.resourceId, g.granteeUserId, g.permission],
      );
      const now = this.clock.now();
      if (active) {
        // an expired grant is renewed by granting again
        this.db.run('UPDATE acl_grant SET expires_at = ? WHERE id = ?', [g.expiresAt ?? null, active.id]);
        return;
      }
      this.db.run(
        `INSERT INTO acl_grant (id, resource_type, resource_db, resource_id, grantee_user_id, permission, granted_by, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [newId(now), g.resourceType, g.resourceDb, g.resourceId, g.granteeUserId, g.permission, g.grantedBy, now, g.expiresAt ?? null],
      );
    });
  }

  /** Internal: revoke a grantee's grants on one resource (every permission unless one is named). Returns the count. */
  revokeInternal(g: { resourceType: AclResourceType; resourceDb: string; resourceId: string; granteeUserId: string; permission?: AclPermission }): number {
    const now = this.clock.now();
    return this.db.run(
      `UPDATE acl_grant SET revoked_at = ? WHERE resource_type = ? AND resource_db = ? AND resource_id = ? AND grantee_user_id = ? AND revoked_at IS NULL${g.permission ? ' AND permission = ?' : ''}`,
      [now, g.resourceType, g.resourceDb, g.resourceId, g.granteeUserId, ...(g.permission ? [g.permission] : [])],
    ).changes;
  }

  /** Internal (account deletion): every grant a user holds is revoked. */
  revokeAllOfUserInternal(userId: string): number {
    return this.db.run('UPDATE acl_grant SET revoked_at = ? WHERE grantee_user_id = ? AND revoked_at IS NULL', [this.clock.now(), userId]).changes;
  }

  /** Internal (diagnostics, tests): the active grants a user holds. */
  activeForInternal(userId: string): AclGrantRow[] {
    return this.db.all<AclGrantRow>(
      'SELECT * FROM acl_grant WHERE grantee_user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, id',
      [userId, this.clock.now()],
    );
  }
}
