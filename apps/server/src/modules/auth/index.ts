// Authentication (§49) on the system DB (P1-T1 step 1, ADR-0003 §3.1). Each account has its own sessions, recovery
// codes and vault. First-run setup creates the FIRST account — the platform admin — and only while no account
// exists; there is no open registration here (accounts join with a class code / invitation: P1-T4, `JoinTokenVerifier`).
// Sessions are per device and revocable; recovery uses one-time codes (hashes only). Every listing or revocation a
// user can trigger is limited to that user's own sessions.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AuthStatusResponse,
  type LoginResponse,
  type MeLite,
  RECOVERY_CODE_COUNT,
  type RecoverResponse,
  type RecoveryCodesResponse,
  type SessionsResponse,
  type SetupResponse,
} from '@medlevo/shared';
import type { ModuleOptions, ModulePlugin } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, RATE_LIMITS } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import { normalizeUsername, UserRepo, type UserRow } from '../../system/repos';
import { accountUnavailableError } from '../../system/tenancy';
import { clientTooOldError, isOldClient, isUserOne } from './clientGate';
import { createSetupTokenGate, type SetupTokenOptions } from './setup-token';
import { clearSessionCookie, setSessionCookie } from './guard';
import { LoginLimiter } from './limiter';
import { dummyHashFor, generateRecoveryCode, hashSecret, normalizeRecoveryCode, verifySecret } from './password';
import { toSessionInfo } from './sessions';

export { registerAuthGuard, PUBLIC_ROUTES, type RequestAuth } from './guard';
export { hashSecret, verifySecret } from './password';
export { isLoopbackHost, type SetupTokenOptions } from './setup-token';

/**
 * Registration with a class code, an invite link or an invitation (ARCHITECTURE_DELTA §7.2 POST /api/auth/register)
 * is verified by the channels module (P1-T4), which implements this interface. Until then there is no verifier and
 * the route is not mounted: accounts other than the first one cannot be created from the network.
 */
export interface JoinTokenVerifier {
  /** validates the join proof; returns what the new account joins, or throws JOIN_CODE_INVALID */
  verify(join: { code: string } | { invite_token: string } | { invitation_id: string }, ip: string): { describeAr: string };
}

export interface AuthModuleOptions extends SetupTokenOptions {
  joinVerifier?: JoinTokenVerifier | null;
}

/**
 * The auth module. `createAuthModule({ setupToken, announceSetupToken })` exists for tests; the default export
 * reads MEDLEVO_SETUP_TOKEN from the environment and prints a generated one-time token to the server log
 * (track D1: first-run setup token hardening, see ./setup-token.ts).
 */
export function createAuthModule(tokenOpts: AuthModuleOptions = {}): ModulePlugin {
  return (app, opts) => authModule(app, opts, tokenOpts);
}

export default createAuthModule();

async function authModule(app: FastifyInstance, opts: ModuleOptions, tokenOpts: AuthModuleOptions): Promise<void> {
  const { ctx } = opts;
  const { config, clock } = ctx;
  const users = ctx.system.users;
  const sessions = ctx.system.sessions;
  const logN = config.auth.scryptLogN;
  const minLen = config.auth.passwordMinLength;
  const limiter = new LoginLimiter(ctx.system.db, clock, config.auth.loginIpFailuresPerHour);

  const password = z.string().min(minLen).max(256);
  const username = z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[\p{L}\p{N}._-]+$/u, 'اسم المستخدم يقبل الحروف والأرقام و . _ - فقط، دون مسافات.');
  const displayName = z.string().trim().min(1).max(80).optional();
  const deviceLabel = z.string().trim().max(100).optional();
  const deviceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional();

  const setupBody = z.object({ username, password, display_name: displayName, device_label: deviceLabel, device_id: deviceId, setup_token: z.string().max(200).optional() });
  const loginBody = z.object({ username: z.string().max(64), password: z.string().max(256), device_label: deviceLabel, device_id: deviceId });
  const passwordBody = z.object({ current_password: z.string().max(256), new_password: password });
  const recoverBody = z.object({ username: z.string().max(64), recovery_code: z.string().max(64), new_password: password });
  const regenBody = z.object({ password: z.string().max(256) });
  const idParams = z.object({ id: z.string().min(1).max(64) });

  const setupGate = createSetupTokenGate(ctx, { ownerExists: users.countInternal() > 0, ...tokenOpts });
  const clientIp = (req: FastifyRequest) => req.ip ?? 'unknown';
  const viewerOf = (req: FastifyRequest): Viewer => {
    if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
    return req.viewer;
  };
  const meOf = (req: FastifyRequest): UserRow => {
    const me = users.me(viewerOf(req));
    if (!me) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
    return me;
  };
  const issueCodes = async () => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => hashSecret(c, logN)));
    return { codes, hashes };
  };
  const meLite = (u: UserRow): MeLite => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_platform_admin: u.is_platform_admin === 1,
    // P1-T1 step 3: user #1 claims what a device kept from before accounts (legacy IndexedDB, un-prefixed keys)
    owns_legacy_device_data: isUserOne(ctx, u.id),
  });
  const codesNotice = 'احفظ رموز الاسترداد الآن في مكان آمن خارج هذا الجهاز. لن تظهر مرة أخرى، وكل رمز يُستخدم مرة واحدة فقط.';
  const audit = (req: FastifyRequest, userId: string | null, action: string, summary: string, details?: Record<string, unknown>) =>
    ctx.system.securityAudit.record({ actorUserId: userId, actorRole: 'self', action, summary, ip: clientIp(req), details: details ?? null });

  app.get('/status', async (req): Promise<AuthStatusResponse> => {
    const count = users.countInternal();
    const auth = req.auth;
    const res: AuthStatusResponse = {
      setup_required: count === 0,
      authenticated: auth !== null,
      // the account's login name (kept under `owner` for the web client of R1-a)
      owner: auth ? { username: auth.user.username } : null,
      session: auth ? toSessionInfo(auth.session, auth.sessionId) : null,
      password_min_length: minLen,
    };
    if (count === 0 && setupGate.required) res.setup_token_required = true;
    if (auth) {
      res.remaining_recovery_codes = UserRepo.recoveryHashes(auth.user).length;
      res.user = meLite(auth.user);
    }
    return res;
  });

  app.post('/setup', { config: { rateLimit: RATE_LIMITS.setup } }, async (req, reply): Promise<SetupResponse> => {
    const alreadyMsg = 'تم إعداد الحساب الأول مسبقًا. لا يمكن إنشاء حساب آخر من هنا؛ سجّل الدخول بدلًا من ذلك.';
    if (users.countInternal() > 0) throw new AppError('ALREADY_SET_UP', alreadyMsg, 409);
    const body = parseBody(setupBody, req);
    if (setupGate.required) {
      // reachable from the network before any account exists: only the holder of the setup token may claim it
      const attempt = limiter.begin(clientIp(req), null, 'setup');
      if (!setupGate.check(body.setup_token)) {
        throw new AppError('FORBIDDEN', setupGate.reasonAr(), 403, { setup_token_required: true });
      }
      limiter.succeed(attempt);
    }
    if (normalizeUsername(body.password) === normalizeUsername(body.username)) {
      throw new AppError('VALIDATION_FAILED', 'كلمة المرور يجب ألا تطابق اسم المستخدم.', 400, {
        where: 'body',
        issues: [{ path: 'password', code: 'custom', message: 'اختر كلمة مرور مختلفة عن اسم المستخدم.' }],
      });
    }
    const passwordHash = await hashSecret(body.password, logN);
    const { codes, hashes } = await issueCodes();
    // the first account is the platform admin (ADR-0003 §7 Q4); it gets its own vault
    const { user, vault } = ctx.tenancy.createAccount(
      { username: body.username, displayName: body.display_name ?? body.username.normalize('NFC'), passwordHash, recoveryHashes: hashes, isPlatformAdmin: true, timezone: config.timezone },
      { onlyIfNoUsers: true },
    );
    const created = sessions.create({ userId: user.id, userAgent: req.headers['user-agent'], ip: clientIp(req), deviceLabel: body.device_label, deviceId: body.device_id });
    setupGate.consume();
    audit(req, user.id, 'setup', 'إنشاء الحساب الأول (مسؤول المنصة)');
    ctx.tenancy.inVault(vault.id, () => ctx.audit.record({ entityType: 'owner', entityId: user.id, action: 'setup', summary: 'إنشاء الحساب' }));
    setSessionCookie(reply, config, created.token, created.session.expires_at);
    return { ok: true, recovery_codes: codes, session: toSessionInfo(created.session, created.session.id), notice_ar: codesNotice, user: meLite(user) };
  });

  app.post('/login', { config: { rateLimit: RATE_LIMITS.auth } }, async (req, reply): Promise<LoginResponse> => {
    const body = parseBody(loginBody, req);
    const ip = clientIp(req);
    if (users.countInternal() === 0) {
      await verifySecret(body.password, await dummyHashFor(logN));
      throw new AppError('SETUP_REQUIRED', 'لم يُنشأ أي حساب بعد. أكمل الإعداد الأولي أولًا.', 409);
    }
    const norm = normalizeUsername(body.username).slice(0, 64);
    const attempt = limiter.begin(ip, norm, 'login');
    const user = users.findForAuth(body.username);
    const usable = user !== null && user.status === 'active';
    const passOk = await verifySecret(body.password, usable ? user.password_hash : await dummyHashFor(logN));
    if (!usable || !passOk) {
      throw new AppError('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
    }
    limiter.succeed(attempt);
    // P1-T1 step 3: a pre-multi-user client (no x-medlevo-client) may sign in only as user #1, whose local data it
    // holds; as anyone else it would push user #1's queued writes under that account (clientGate.ts)
    if (isOldClient(req) && !isUserOne(ctx, user.id)) throw clientTooOldError();
    // the password is right but the account cannot be used right now (its vault is locked for a restore or a migration,
    // or being deleted): say so — a session would only meet 401s (P1-T1 step 1 review)
    if (!ctx.tenancy.vaultUsable(user.id)) throw accountUnavailableError();
    // same browser logging in again: retire its previous session instead of leaving a ghost device
    if (req.auth) sessions.revoke(req.auth.user.id, req.auth.sessionId);
    const created = sessions.create({ userId: user.id, userAgent: req.headers['user-agent'], ip, deviceLabel: body.device_label, deviceId: body.device_id });
    sessions.prune();
    limiter.prune();
    audit(req, user.id, 'login', 'تسجيل دخول', { device_label: created.session.device_label });
    setSessionCookie(reply, config, created.token, created.session.expires_at);
    return { ok: true, session: toSessionInfo(created.session, created.session.id) };
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth) sessions.revoke(req.auth.user.id, req.auth.sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get('/sessions', async (req): Promise<SessionsResponse> => {
    const v = viewerOf(req);
    const current = req.auth?.sessionId ?? null;
    return { sessions: sessions.listActive(v.userId).map((s) => toSessionInfo(s, current)) };
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = parseParams(idParams, req);
    const v = viewerOf(req);
    if (!sessions.revoke(v.userId, id)) throw new AppError('NOT_FOUND', 'الجلسة غير موجودة أو منتهية مسبقًا.', 404);
    ctx.audit.record({ entityType: 'auth_session', entityId: id, action: 'revoke', summary: 'إلغاء جلسة جهاز' });
    audit(req, v.userId, 'session_revoke', 'إلغاء جلسة جهاز');
    if (id === req.auth?.sessionId) clearSessionCookie(reply, config);
    return { ok: true, current: id === req.auth?.sessionId };
  });

  app.post('/password', { config: { rateLimit: RATE_LIMITS.auth } }, async (req) => {
    const body = parseBody(passwordBody, req);
    const me = meOf(req);
    const attempt = limiter.begin(clientIp(req), me.username_norm, 'password');
    if (!(await verifySecret(body.current_password, me.password_hash))) {
      throw new AppError('FORBIDDEN', 'كلمة المرور الحالية غير صحيحة.', 403);
    }
    limiter.succeed(attempt);
    if (body.new_password === body.current_password) {
      throw new AppError('VALIDATION_FAILED', 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.', 400, {
        where: 'body',
        issues: [{ path: 'new_password', code: 'custom', message: 'اختر كلمة مرور جديدة مختلفة.' }],
      });
    }
    const hash = await hashSecret(body.new_password, logN);
    const v = viewerOf(req);
    const revoked = ctx.system.db.tx(() => {
      users.setPassword(v, hash);
      return sessions.revokeAllExcept(v.userId, req.auth?.sessionId ?? null);
    });
    ctx.audit.record({ entityType: 'owner', entityId: v.userId, action: 'password_change', summary: `تغيير كلمة المرور وإلغاء ${revoked} جلسة أخرى` });
    audit(req, v.userId, 'password_change', `تغيير كلمة المرور وإلغاء ${revoked} جلسة أخرى`);
    return { ok: true, revoked_sessions: revoked };
  });

  app.post('/recover', { config: { rateLimit: RATE_LIMITS.auth } }, async (req, reply): Promise<RecoverResponse> => {
    const body = parseBody(recoverBody, req);
    const ip = clientIp(req);
    if (users.countInternal() === 0) throw new AppError('SETUP_REQUIRED', 'لم يُنشأ أي حساب بعد. أكمل الإعداد الأولي أولًا.', 409);
    const norm = normalizeUsername(body.username).slice(0, 64);
    const attempt = limiter.begin(ip, norm, 'recover');
    const user = users.findForAuth(body.username);
    const code = normalizeRecoveryCode(body.recovery_code);
    const hashes = user && user.status === 'active' ? UserRepo.recoveryHashes(user) : [];
    const checks = hashes.length ? await Promise.all(hashes.map((h) => verifySecret(code, h))) : [(await verifySecret(code, await dummyHashFor(logN))) && false];
    const matchIndex = checks.findIndex(Boolean);
    const failMsg = 'اسم المستخدم أو رمز الاسترداد غير صحيح، أو أن الرمز استُخدم من قبل.';
    if (matchIndex < 0 || !user) {
      // a wrong code counts like a wrong password: after repeated failures the account is slowed (a valid code is not)
      const wait = limiter.accountWaitSeconds(norm);
      if (wait > 0) throw limiter.slowedError(wait);
      throw new AppError('UNAUTHENTICATED', failMsg, 401);
    }
    const usedHash = hashes[matchIndex]!;
    const newHash = await hashSecret(body.new_password, logN);
    const remaining = ctx.system.db.tx(() => {
      const fresh = users.byIdInternal(user.id);
      const current = fresh ? UserRepo.recoveryHashes(fresh) : [];
      if (!current.includes(usedHash)) throw new AppError('UNAUTHENTICATED', failMsg, 401); // used concurrently
      const left = current.filter((h) => h !== usedHash);
      users.setPasswordAndCodesForAuth(user.id, newHash, left);
      sessions.revokeAllExcept(user.id, null);
      limiter.succeed(attempt);
      return left.length;
    });
    audit(req, user.id, 'recover', 'استعادة الحساب برمز استرداد وإلغاء كل الجلسات');
    const vault = ctx.system.vaults.ofUserInternal(user.id);
    if (vault) ctx.tenancy.inVault(vault.id, () => ctx.audit.record({ entityType: 'owner', entityId: user.id, action: 'recover', summary: 'استعادة الحساب برمز استرداد وإلغاء كل الجلسات' }));
    clearSessionCookie(reply, config);
    return {
      ok: true,
      remaining_recovery_codes: remaining,
      notice_ar: 'تم تعيين كلمة مرور جديدة وإلغاء كل الجلسات. سجّل الدخول بكلمة المرور الجديدة.',
    };
  });

  app.post('/recovery-codes', { config: { rateLimit: RATE_LIMITS.auth } }, async (req): Promise<RecoveryCodesResponse> => {
    const body = parseBody(regenBody, req);
    const me = meOf(req);
    const attempt = limiter.begin(clientIp(req), me.username_norm, 'password');
    if (!(await verifySecret(body.password, me.password_hash))) {
      throw new AppError('FORBIDDEN', 'كلمة المرور غير صحيحة.', 403);
    }
    limiter.succeed(attempt);
    const { codes, hashes } = await issueCodes();
    users.setRecoveryCodes(viewerOf(req), hashes);
    ctx.audit.record({ entityType: 'owner', entityId: me.id, action: 'recovery_codes_regenerated', summary: 'إنشاء رموز استرداد جديدة (أُبطلت القديمة)' });
    audit(req, me.id, 'recovery_codes_regenerated', 'إنشاء رموز استرداد جديدة');
    return { recovery_codes: codes, notice_ar: codesNotice };
  });
}
