// Credential-guessing limiter backed by login_attempt (survives restarts).
//  * at most 5 failed attempts per IP per minute
//  * after 10 consecutive failures from an IP (since its last success, within 24h) an exponential
//    lockout applies: 1 min, 2, 4, … capped at 1 hour after the latest failure
// Per-IP (not global) so an attacker cannot lock the owner out from every network.
import type { Db } from '../../db/db';
import { Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export const LOGIN_LIMITS = {
  perMinute: 5,
  windowMs: 60_000,
  lockoutAfter: 10,
  lockoutBaseMs: 60_000,
  lockoutMaxMs: 60 * 60_000,
  lookbackMs: 24 * 60 * 60_000,
};

export class LoginLimiter {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Throws RATE_LIMITED (429, Retry-After) when this IP must wait. */
  assertAllowed(ip: string): void {
    const now = this.clock.now();
    const recent = this.db.all<{ created_at: number }>(
      'SELECT created_at FROM login_attempt WHERE ip = ? AND succeeded = 0 AND created_at > ? ORDER BY created_at ASC',
      [ip, now - LOGIN_LIMITS.windowMs],
    );
    if (recent.length >= LOGIN_LIMITS.perMinute) {
      const oldest = recent[recent.length - LOGIN_LIMITS.perMinute]!.created_at;
      throw Errors.rateLimited((oldest + LOGIN_LIMITS.windowMs - now) / 1000);
    }
    const lastSuccess = this.db.get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM login_attempt WHERE ip = ? AND succeeded = 1', [ip])?.t ?? 0;
    const since = Math.max(lastSuccess, now - LOGIN_LIMITS.lookbackMs);
    const f = this.db.get<{ n: number; last: number | null }>(
      'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM login_attempt WHERE ip = ? AND succeeded = 0 AND created_at > ?',
      [ip, since],
    );
    const failures = f?.n ?? 0;
    if (failures >= LOGIN_LIMITS.lockoutAfter && f?.last) {
      const lockMs = Math.min(LOGIN_LIMITS.lockoutBaseMs * 2 ** (failures - LOGIN_LIMITS.lockoutAfter), LOGIN_LIMITS.lockoutMaxMs);
      const until = f.last + lockMs;
      if (now < until) {
        throw Errors.rateLimited((until - now) / 1000, 'تم إيقاف محاولات الدخول مؤقتًا بسبب محاولات فاشلة متكررة. انتظر قليلًا ثم أعد المحاولة، أو استخدم رمز استرداد.');
      }
    }
  }

  /**
   * Check the limits AND reserve the attempt as a failure in one synchronous step, BEFORE the (async)
   * password hash is verified. Concurrent requests therefore see each other: a burst of parallel guesses
   * cannot all pass `assertAllowed` before any failure is recorded. Call `succeed(id)` once the
   * credential is verified; anything else (wrong secret, error, crash) stays counted as a failure.
   */
  begin(ip: string): string {
    this.assertAllowed(ip);
    const now = this.clock.now();
    const id = newId(now);
    this.db.run('INSERT INTO login_attempt (id, ip, succeeded, created_at) VALUES (?, ?, 0, ?)', [id, ip, now]);
    return id;
  }

  /** Mark a reserved attempt as successful (resets the consecutive-failure count for this IP). */
  succeed(attemptId: string): void {
    this.db.run('UPDATE login_attempt SET succeeded = 1 WHERE id = ?', [attemptId]);
  }

  prune(): void {
    this.db.run('DELETE FROM login_attempt WHERE created_at < ?', [this.clock.now() - 30 * 24 * 60 * 60_000]);
  }
}
