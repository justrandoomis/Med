// Sessions (system DB, P1-T1 step 1): opaque 32-byte random token in an HttpOnly cookie; only sha256(token) is stored.
// 30-day sliding expiry (refreshed at most every few minutes to avoid a write per request). Moved from the single-owner
// database to DATA_DIR/system.sqlite with one change: every session belongs to a user (`user_id`), and every listing
// or revocation a user can trigger is limited to that user's own sessions.
import type { SessionInfo } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { randomToken, sha256 } from '../../lib/hash';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';
import { deviceLabelFromUserAgent } from '../../lib/useragent';

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_id: string | null;
  device_label: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/** last_seen/expiry are refreshed when older than this */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export class SessionStore {
  constructor(
    /** the SYSTEM database */
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ttlMs: number,
  ) {}

  create(meta: { userId: string; userAgent?: string | null; ip?: string | null; deviceLabel?: string | null; deviceId?: string | null }): { token: string; session: SessionRow } {
    const now = this.clock.now();
    const token = randomToken(32);
    const ua = meta.userAgent ? meta.userAgent.slice(0, 512) : null;
    const row: SessionRow = {
      id: newId(now),
      user_id: meta.userId,
      token_hash: sha256(token),
      device_id: meta.deviceId ?? null,
      device_label: (meta.deviceLabel?.trim() || deviceLabelFromUserAgent(ua)).slice(0, 100),
      user_agent: ua,
      ip: meta.ip ?? null,
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.ttlMs,
      revoked_at: null,
    };
    this.db.run(
      `INSERT INTO auth_session (id, user_id, token_hash, device_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [row.id, row.user_id, row.token_hash, row.device_id, row.device_label, row.user_agent, row.ip, row.created_at, row.last_seen_at, row.expires_at],
    );
    return { token, session: row };
  }

  /** Active session for a raw cookie token, or null. */
  findActive(token: string | undefined): SessionRow | null {
    if (!token || token.length < 20 || token.length > 200) return null;
    const row = this.db.get<SessionRow>('SELECT * FROM auth_session WHERE token_hash = ?', [sha256(token)]);
    if (!row || row.revoked_at !== null || row.expires_at <= this.clock.now()) return null;
    return row;
  }

  /** Sliding expiry. Returns the new expiry when refreshed (caller re-issues the cookie), else null. */
  touch(row: SessionRow, ip: string | null): number | null {
    const now = this.clock.now();
    if (now - row.last_seen_at < SESSION_TOUCH_INTERVAL_MS) return null;
    const expires = now + this.ttlMs;
    this.db.run('UPDATE auth_session SET last_seen_at = ?, expires_at = ?, ip = COALESCE(?, ip) WHERE id = ?', [now, expires, ip, row.id]);
    return expires;
  }

  /** The user's own active sessions (never another user's). */
  listActive(userId: string): SessionRow[] {
    return this.db.all<SessionRow>('SELECT * FROM auth_session WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', [
      userId,
      this.clock.now(),
    ]);
  }

  /** Revoke one of the user's own sessions; another user's session id is «not found». */
  revoke(userId: string, id: string): boolean {
    const r = this.db.run('UPDATE auth_session SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [this.clock.now(), id, userId]);
    return r.changes > 0;
  }

  revokeAllExcept(userId: string, keepId: string | null): number {
    const now = this.clock.now();
    const r = keepId
      ? this.db.run('UPDATE auth_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?', [now, userId, keepId])
      : this.db.run('UPDATE auth_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
    return r.changes;
  }

  /** The device this session syncs from (first push), shown in the sessions list. */
  rememberDevice(userId: string, sessionId: string, deviceId: string): void {
    this.db.run('UPDATE auth_session SET device_id = COALESCE(device_id, ?) WHERE id = ? AND user_id = ?', [deviceId, sessionId, userId]);
  }

  /** housekeeping: drop long-expired/revoked rows */
  prune(olderThanMs = 90 * 24 * 60 * 60 * 1000): void {
    const cutoff = this.clock.now() - olderThanMs;
    this.db.run('DELETE FROM auth_session WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ?', [cutoff, cutoff]);
  }
}

export function toSessionInfo(row: SessionRow, currentId: string | null): SessionInfo {
  return {
    id: row.id,
    device_label: row.device_label,
    device_id: row.device_id,
    user_agent: row.user_agent,
    ip: row.ip,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    current: row.id === currentId,
  };
}
