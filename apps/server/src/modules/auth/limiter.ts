// Credential-guessing limiter backed by the system DB's login_attempt (survives restarts). P1-T1 step 1:
//  * per ACCOUNT a progressive delay: after 5 consecutive failures (since that account's last success, within 24 h)
//    each next attempt must wait 1 s, 2 s, 4 s … capped at 60 s after the latest failure → 429 LOGIN_SLOWED. Never a
//    hard lockout a classmate who knows the username could trigger before an exam, and a valid recovery code always
//    signs in (and resets the delay);
//  * per IP only a high ceiling (MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR, default 300) → 429 RATE_LIMITED, because a campus
//    NAT puts a whole class behind one address;
//  * the first-run setup token keeps its strict per-IP limit (5 wrong tokens per minute): it guards the creation of the
//    platform admin.
// An attempt is reserved as a failure BEFORE the (async) password hash runs, so a parallel burst sees itself.
import { AppError, Errors, formatWaitAr } from '../../lib/errors';
import type { Db } from '../../db/db';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export const LOGIN_LIMITS = {
  /** failures per account before the delay starts */
  accountFreeFailures: 5,
  accountBaseDelayMs: 1000,
  accountMaxDelayMs: 60_000,
  lookbackMs: 24 * 60 * 60_000,
  ipWindowMs: 60 * 60_000,
  /** strict per-IP rule of the first-run setup token */
  setupPerMinute: 5,
  setupWindowMs: 60_000,
};

export type AttemptMode = 'login' | 'recover' | 'setup' | 'password';

export class LoginLimiter {
  constructor(
    /** the SYSTEM database */
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ipFailuresPerHour: number,
  ) {}

  private assertIp(ip: string): void {
    const now = this.clock.now();
    const rows = this.db.all<{ created_at: number }>(
      'SELECT created_at FROM login_attempt WHERE ip = ? AND succeeded = 0 AND created_at > ? ORDER BY created_at ASC',
      [ip, now - LOGIN_LIMITS.ipWindowMs],
    );
    if (rows.length >= this.ipFailuresPerHour) {
      const oldest = rows[rows.length - this.ipFailuresPerHour]!.created_at;
      throw Errors.rateLimited((oldest + LOGIN_LIMITS.ipWindowMs - now) / 1000);
    }
  }

  private assertSetup(ip: string): void {
    const now = this.clock.now();
    const recent = this.db.all<{ created_at: number }>(
      `SELECT created_at FROM login_attempt WHERE ip = ? AND username_norm IS NULL AND succeeded = 0 AND created_at > ? ORDER BY created_at ASC`,
      [ip, now - LOGIN_LIMITS.setupWindowMs],
    );
    if (recent.length >= LOGIN_LIMITS.setupPerMinute) {
      const oldest = recent[recent.length - LOGIN_LIMITS.setupPerMinute]!.created_at;
      throw Errors.rateLimited((oldest + LOGIN_LIMITS.setupWindowMs - now) / 1000);
    }
  }

  /** Seconds this account must still wait, or 0. */
  accountWaitSeconds(usernameNorm: string): number {
    const now = this.clock.now();
    const lastSuccess = this.db.get<{ r: number | null }>('SELECT MAX(rowid) AS r FROM login_attempt WHERE username_norm = ? AND succeeded = 1', [usernameNorm])?.r ?? 0;
    const f = this.db.get<{ n: number; last: number | null }>(
      'SELECT COUNT(*) AS n, MAX(created_at) AS last FROM login_attempt WHERE username_norm = ? AND succeeded = 0 AND rowid > ? AND created_at > ?',
      [usernameNorm, lastSuccess, now - LOGIN_LIMITS.lookbackMs],
    );
    const failures = f?.n ?? 0;
    if (failures < LOGIN_LIMITS.accountFreeFailures || !f?.last) return 0;
    const wait = Math.min(LOGIN_LIMITS.accountBaseDelayMs * 2 ** (failures - LOGIN_LIMITS.accountFreeFailures), LOGIN_LIMITS.accountMaxDelayMs);
    const until = f.last + wait;
    return now < until ? (until - now) / 1000 : 0;
  }

  slowedError(waitSeconds: number): AppError {
    const s = Math.max(1, Math.ceil(waitSeconds));
    return new AppError(
      'LOGIN_SLOWED',
      `محاولات دخول فاشلة متكررة لهذا الحساب. انتظر ${formatWaitAr(s)} ثم أعد المحاولة، أو استخدم رمز استرداد.`,
      429,
      { retry_after_s: s },
      { 'retry-after': String(s) },
    );
  }

  /**
   * Check the limits AND reserve the attempt as a failure in one synchronous step, BEFORE the async hash runs.
   * Call `succeed(id)` once the credential is verified; anything else stays counted as a failure.
   *   login / password — per-IP ceiling, then the per-account delay
   *   recover          — per-IP ceiling only here: a VALID recovery code must always work; the caller applies the
   *                      per-account delay to a wrong code (`accountWaitSeconds` after the failure)
   *   setup            — the strict per-IP setup-token rule
   */
  begin(ip: string, usernameNorm: string | null, mode: AttemptMode): string {
    if (mode === 'setup') this.assertSetup(ip);
    else {
      this.assertIp(ip);
      if ((mode === 'login' || mode === 'password') && usernameNorm !== null) {
        const wait = this.accountWaitSeconds(usernameNorm);
        if (wait > 0) throw this.slowedError(wait);
      }
    }
    const now = this.clock.now();
    const id = newId(now);
    this.db.run('INSERT INTO login_attempt (id, ip, username_norm, succeeded, created_at) VALUES (?, ?, ?, 0, ?)', [id, ip, mode === 'setup' ? null : usernameNorm, now]);
    return id;
  }

  /** Mark a reserved attempt as successful (resets the account's consecutive-failure count). */
  succeed(attemptId: string): void {
    this.db.run('UPDATE login_attempt SET succeeded = 1 WHERE id = ?', [attemptId]);
  }

  prune(): void {
    this.db.run('DELETE FROM login_attempt WHERE created_at < ?', [this.clock.now() - 30 * 24 * 60 * 60_000]);
  }
}
