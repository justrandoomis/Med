// Join-attempt limiter (P1-T4 step 1; PRD AOS-2.11 «rate-limited»; BUILD_PLAN §3.6 «rate-limited per account
// (10/hour) with a high per-IP ceiling»). Backed by the system DB's `join_attempt`, so a restart does not reset it.
//   * per ACCOUNT: at most 10 wrong codes / links an hour → 429 RATE_LIMITED for that account only;
//   * per IP: a high ceiling on wrong proofs (MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR, default 300, as for sign-in): a
//     campus NAT puts a whole class behind one address. Each kind of attempt has its OWN address budget (review
//     P1-T4 step 1, R1): signed-in joins (codes and links together; each account also has its 10), and — with no
//     account behind them — the public preview, registrations with a class code and registrations with an invite
//     link, each apart. So one person behind the hall's address cannot spend the class's budget on the cheap public
//     preview (or on wrong registrations) and lock everyone out of joining for an hour: a flood of one kind only
//     stops that kind;
//   * only FAILURES are written (a public route never writes a row per request): every join path checks the limits,
//     verifies the proof and records a failure in one synchronous step — no await in between, so a parallel burst
//     cannot slip past the count.
import type { Db } from '../../db/db';
import { Errors } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { Clock } from '../../lib/time';

export const JOIN_LIMITS = {
  accountFailuresPerHour: 10,
  windowMs: 60 * 60_000,
  keepMs: 7 * 24 * 60 * 60_000,
};

export type JoinAttemptKind = 'code' | 'link' | 'preview' | 'register';

export class JoinLimiter {
  constructor(
    /** the SYSTEM database */
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly ipFailuresPerHour: number,
  ) {}

  private retryAfter(rows: { created_at: number }[], limit: number, now: number): number {
    const oldest = rows[rows.length - limit]!.created_at;
    return (oldest + JOIN_LIMITS.windowMs - now) / 1000;
  }

  /**
   * The address budget a failure of this kind counts against: signed-in joins share one (codes and links), every
   * anonymous kind (preview, registration with a class code — `register`, registration with an invite link — `link`
   * without an account) has its own.
   */
  private static bucket(kind: JoinAttemptKind, userId: string | null): { where: string; params: string[] } {
    if (userId !== null) return { where: `user_id IS NOT NULL AND kind IN ('code','link')`, params: [] };
    return { where: 'user_id IS NULL AND kind = ?', params: [kind] };
  }

  /** Throw 429 when this account, or this address for this kind of attempt, has used up its wrong attempts. Writes nothing. */
  check(kind: JoinAttemptKind, userId: string | null, ip: string): void {
    const now = this.clock.now();
    const since = now - JOIN_LIMITS.windowMs;
    const b = JoinLimiter.bucket(kind, userId);
    const byIp = this.db.all<{ created_at: number }>(`SELECT created_at FROM join_attempt WHERE ip = ? AND succeeded = 0 AND created_at > ? AND ${b.where} ORDER BY created_at`, [ip, since, ...b.params]);
    if (byIp.length >= this.ipFailuresPerHour) throw Errors.rateLimited(this.retryAfter(byIp, this.ipFailuresPerHour, now));
    if (userId !== null) {
      const byUser = this.db.all<{ created_at: number }>('SELECT created_at FROM join_attempt WHERE user_id = ? AND succeeded = 0 AND created_at > ? ORDER BY created_at', [userId, since]);
      if (byUser.length >= JOIN_LIMITS.accountFailuresPerHour) {
        throw Errors.rateLimited(this.retryAfter(byUser, JOIN_LIMITS.accountFailuresPerHour, now), 'أدخلت رموز انضمام غير صحيحة مرات كثيرة. انتظر قليلًا ثم أعد المحاولة، أو اطلب رمزًا جديدًا من مشرف القناة.');
      }
    }
  }

  /** Record one wrong proof. */
  fail(kind: JoinAttemptKind, userId: string | null, ip: string): void {
    const now = this.clock.now();
    this.db.run('INSERT INTO join_attempt (id, user_id, ip, kind, succeeded, created_at) VALUES (?, ?, ?, ?, 0, ?)', [newId(now), userId, ip, kind, now]);
  }

  prune(): void {
    this.db.run('DELETE FROM join_attempt WHERE created_at < ?', [this.clock.now() - JOIN_LIMITS.keepMs]);
  }
}
