// Single-owner authentication (§02, §49). There is no registration once the owner exists, no roles,
// no other users. Sessions are per device and revocable; recovery uses one-time codes (hashes only).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AuthStatusResponse,
  type LoginResponse,
  RECOVERY_CODE_COUNT,
  type RecoverResponse,
  type RecoveryCodesResponse,
  type SessionsResponse,
  type SetupResponse,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, RATE_LIMITS } from '../../lib/http';
import { clearSessionCookie, setSessionCookie } from './guard';
import { LoginLimiter } from './limiter';
import { dummyHashFor, generateRecoveryCode, hashSecret, normalizeRecoveryCode, verifySecret } from './password';
import { SessionStore, toSessionInfo } from './sessions';

export { registerAuthGuard, PUBLIC_ROUTES, type RequestAuth } from './guard';
export { hashSecret, verifySecret } from './password';

interface OwnerRow {
  id: 'owner';
  username: string;
  password_hash: string;
  recovery_codes_json: string;
  password_changed_at: number;
  created_at: number;
  updated_at: number;
}

const normUser = (u: string) => u.normalize('NFC').trim().toLowerCase();

export default async function authModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;
  const { config, db, clock } = ctx;
  const logN = config.auth.scryptLogN;
  const minLen = config.auth.passwordMinLength;
  const sessions = new SessionStore(db, clock, config.auth.sessionTtlMs);
  const limiter = new LoginLimiter(db, clock);

  const password = z.string().min(minLen).max(256);
  const username = z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[\p{L}\p{N}._-]+$/u, 'اسم المستخدم يقبل الحروف والأرقام و . _ - فقط، دون مسافات.');
  const deviceLabel = z.string().trim().max(100).optional();
  const deviceId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional();

  const setupBody = z.object({ username, password, device_label: deviceLabel, device_id: deviceId });
  const loginBody = z.object({ username: z.string().max(64), password: z.string().max(256), device_label: deviceLabel, device_id: deviceId });
  const passwordBody = z.object({ current_password: z.string().max(256), new_password: password });
  const recoverBody = z.object({ username: z.string().max(64), recovery_code: z.string().max(64), new_password: password });
  const regenBody = z.object({ password: z.string().max(256) });
  const idParams = z.object({ id: z.string().min(1).max(64) });

  const getOwner = () => db.get<OwnerRow>(`SELECT * FROM owner WHERE id = 'owner'`) ?? null;
  const clientIp = (req: FastifyRequest) => req.ip ?? 'unknown';
  const requireOwner = (): OwnerRow => {
    const o = getOwner();
    if (!o) throw new AppError('SETUP_REQUIRED', 'لم يُنشأ حساب المالك بعد. أكمل الإعداد الأولي أولًا.', 409);
    return o;
  };
  const issueCodes = async () => {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((c) => hashSecret(c, logN)));
    return { codes, hashes };
  };
  const codesNotice = 'احفظ رموز الاسترداد الآن في مكان آمن خارج هذا الجهاز. لن تظهر مرة أخرى، وكل رمز يُستخدم مرة واحدة فقط.';

  app.get('/status', async (req): Promise<AuthStatusResponse> => {
    const owner = getOwner();
    const auth = req.auth;
    const res: AuthStatusResponse = {
      setup_required: owner === null,
      authenticated: auth !== null && owner !== null,
      owner: auth && owner ? { username: owner.username } : null,
      session: auth ? toSessionInfo(auth.session, auth.sessionId) : null,
      password_min_length: minLen,
    };
    if (auth && owner) res.remaining_recovery_codes = (fromJson<string[]>(owner.recovery_codes_json, []) ?? []).length;
    return res;
  });

  app.post('/setup', { config: { rateLimit: RATE_LIMITS.setup } }, async (req, reply): Promise<SetupResponse> => {
    const alreadyMsg = 'تم إعداد حساب المالك مسبقًا. لا يمكن إنشاء حساب آخر؛ سجّل الدخول بدلًا من ذلك.';
    if (getOwner()) throw new AppError('ALREADY_SET_UP', alreadyMsg, 409);
    const body = parseBody(setupBody, req);
    if (normUser(body.password) === normUser(body.username)) {
      throw new AppError('VALIDATION_FAILED', 'كلمة المرور يجب ألا تطابق اسم المستخدم.', 400, {
        where: 'body',
        issues: [{ path: 'password', code: 'custom', message: 'اختر كلمة مرور مختلفة عن اسم المستخدم.' }],
      });
    }
    const passwordHash = await hashSecret(body.password, logN);
    const { codes, hashes } = await issueCodes();
    const now = clock.now();
    const created = db.tx(() => {
      if (getOwner()) throw new AppError('ALREADY_SET_UP', alreadyMsg, 409);
      db.run(
        `INSERT INTO owner (id, username, password_hash, recovery_codes_json, password_changed_at, created_at, updated_at)
         VALUES ('owner', ?, ?, ?, ?, ?, ?)`,
        [body.username.normalize('NFC'), passwordHash, toJson(hashes), now, now, now],
      );
      const s = sessions.create({ userAgent: req.headers['user-agent'], ip: clientIp(req), deviceLabel: body.device_label, deviceId: body.device_id });
      ctx.audit.record({ entityType: 'owner', entityId: 'owner', action: 'setup', summary: 'إنشاء حساب المالك' });
      return s;
    });
    setSessionCookie(reply, config, created.token, created.session.expires_at);
    return { ok: true, recovery_codes: codes, session: toSessionInfo(created.session, created.session.id), notice_ar: codesNotice };
  });

  app.post('/login', { config: { rateLimit: RATE_LIMITS.auth } }, async (req, reply): Promise<LoginResponse> => {
    const body = parseBody(loginBody, req);
    const ip = clientIp(req);
    const attempt = limiter.begin(ip);
    const owner = getOwner();
    if (!owner) {
      await verifySecret(body.password, await dummyHashFor(logN));
      throw new AppError('SETUP_REQUIRED', 'لم يُنشأ حساب المالك بعد. أكمل الإعداد الأولي أولًا.', 409);
    }
    const userOk = normUser(owner.username) === normUser(body.username);
    const passOk = await verifySecret(body.password, userOk ? owner.password_hash : await dummyHashFor(logN));
    if (!userOk || !passOk) {
      throw new AppError('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة.', 401);
    }
    const created = db.tx(() => {
      limiter.succeed(attempt);
      // same browser logging in again: retire its previous session instead of leaving a ghost device
      if (req.auth) sessions.revoke(req.auth.sessionId);
      return sessions.create({ userAgent: req.headers['user-agent'], ip, deviceLabel: body.device_label, deviceId: body.device_id });
    });
    sessions.prune();
    limiter.prune();
    setSessionCookie(reply, config, created.token, created.session.expires_at);
    return { ok: true, session: toSessionInfo(created.session, created.session.id) };
  });

  app.post('/logout', async (req, reply) => {
    if (req.auth) sessions.revoke(req.auth.sessionId);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get('/sessions', async (req): Promise<SessionsResponse> => {
    const current = req.auth?.sessionId ?? null;
    return { sessions: sessions.listActive().map((s) => toSessionInfo(s, current)) };
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = parseParams(idParams, req);
    if (!sessions.revoke(id)) throw new AppError('NOT_FOUND', 'الجلسة غير موجودة أو منتهية مسبقًا.', 404);
    ctx.audit.record({ entityType: 'auth_session', entityId: id, action: 'revoke', summary: 'إلغاء جلسة جهاز' });
    if (id === req.auth?.sessionId) clearSessionCookie(reply, config);
    return { ok: true, current: id === req.auth?.sessionId };
  });

  app.post('/password', { config: { rateLimit: RATE_LIMITS.auth } }, async (req) => {
    const body = parseBody(passwordBody, req);
    const attempt = limiter.begin(clientIp(req));
    const owner = requireOwner();
    if (!(await verifySecret(body.current_password, owner.password_hash))) {
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
    const now = clock.now();
    const revoked = db.tx(() => {
      db.run(`UPDATE owner SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = 'owner'`, [hash, now, now]);
      const n = sessions.revokeAllExcept(req.auth?.sessionId ?? null);
      ctx.audit.record({ entityType: 'owner', entityId: 'owner', action: 'password_change', summary: `تغيير كلمة المرور وإلغاء ${n} جلسة أخرى` });
      return n;
    });
    return { ok: true, revoked_sessions: revoked };
  });

  app.post('/recover', { config: { rateLimit: RATE_LIMITS.auth } }, async (req, reply): Promise<RecoverResponse> => {
    const body = parseBody(recoverBody, req);
    const attempt = limiter.begin(clientIp(req));
    const owner = requireOwner();
    const code = normalizeRecoveryCode(body.recovery_code);
    const userOk = normUser(owner.username) === normUser(body.username);
    const hashes = fromJson<string[]>(owner.recovery_codes_json, []) ?? [];
    const checks = hashes.length ? await Promise.all(hashes.map((h) => verifySecret(code, h))) : [await verifySecret(code, await dummyHashFor(logN)) && false];
    const matchIndex = userOk ? checks.findIndex(Boolean) : -1;
    const failMsg = 'اسم المستخدم أو رمز الاسترداد غير صحيح، أو أن الرمز استُخدم من قبل.';
    if (matchIndex < 0) throw new AppError('UNAUTHENTICATED', failMsg, 401);
    const usedHash = hashes[matchIndex]!;
    const newHash = await hashSecret(body.new_password, logN);
    const now = clock.now();
    const remaining = db.tx(() => {
      const fresh = requireOwner();
      const current = fromJson<string[]>(fresh.recovery_codes_json, []) ?? [];
      if (!current.includes(usedHash)) throw new AppError('UNAUTHENTICATED', failMsg, 401); // used concurrently
      const left = current.filter((h) => h !== usedHash);
      db.run(`UPDATE owner SET password_hash = ?, recovery_codes_json = ?, password_changed_at = ?, updated_at = ? WHERE id = 'owner'`, [
        newHash,
        toJson(left),
        now,
        now,
      ]);
      sessions.revokeAllExcept(null);
      limiter.succeed(attempt);
      ctx.audit.record({ entityType: 'owner', entityId: 'owner', action: 'recover', summary: 'استعادة الحساب برمز استرداد وإلغاء كل الجلسات' });
      return left.length;
    });
    clearSessionCookie(reply, config);
    return {
      ok: true,
      remaining_recovery_codes: remaining,
      notice_ar: 'تم تعيين كلمة مرور جديدة وإلغاء كل الجلسات. سجّل الدخول بكلمة المرور الجديدة.',
    };
  });

  app.post('/recovery-codes', { config: { rateLimit: RATE_LIMITS.auth } }, async (req): Promise<RecoveryCodesResponse> => {
    const body = parseBody(regenBody, req);
    const attempt = limiter.begin(clientIp(req));
    const owner = requireOwner();
    if (!(await verifySecret(body.password, owner.password_hash))) {
      throw new AppError('FORBIDDEN', 'كلمة المرور غير صحيحة.', 403);
    }
    limiter.succeed(attempt);
    const { codes, hashes } = await issueCodes();
    const now = clock.now();
    db.tx(() => {
      db.run(`UPDATE owner SET recovery_codes_json = ?, updated_at = ? WHERE id = 'owner'`, [toJson(hashes), now]);
      ctx.audit.record({ entityType: 'owner', entityId: 'owner', action: 'recovery_codes_regenerated', summary: 'إنشاء رموز استرداد جديدة (أُبطلت القديمة)' });
    });
    return { recovery_codes: codes, notice_ar: codesNotice };
  });
}
