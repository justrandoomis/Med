// P1-T4 step 1 — no open sign-up (PRD Q2/Q3, AOS-2.11–2.13, 21.1; ARCHITECTURE_DELTA §7.2 POST /api/auth/register):
// an account is created only by joining with a valid class code or invite link (P1-T1's JoinTokenVerifier, implemented
// by modules/channels) or by the platform admin. The new account gets its own vault, signs in on this device, is never a
// platform admin, and joins the channel the proof names. A wrong proof creates nothing; a taken name gives the code's
// use back; the per-IP ceiling holds for registrations too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChannelNodeView, JoinCodesResponse, RegisterWithJoinResponse } from '@medlevo/shared';
import { CSRF, sessionCookie } from '../helpers/app';
import { call, type ChannelWorld, channelWorld, createCode, createNode, ok } from './helpers';

let w: ChannelWorld;
let subj: ChannelNodeView;
let open: ChannelNodeView;

beforeAll(async () => {
  w = await channelWorld({ env: { MEDLEVO_LOGIN_IP_FAILURES_PER_HOUR: '25' } });
  const uni = await createNode(w.t, w.pa, null, 'university', 'جامعة التسجيل');
  subj = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة التسجيل');
  open = await createNode(w.t, w.pa, uni.id, 'subject', 'مادة مفتوحة', { join_policy: 'open_with_code' });
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const register = (body: Record<string, unknown>, ip?: string) =>
  w.t.app.inject({ method: 'POST', url: '/api/auth/register', headers: { ...CSRF, 'user-agent': 'vitest-register', ...(ip ? { 'x-forwarded-for': ip } : {}) }, payload: body });
const users = () => w.t.ctx.system.users.countInternal();

describe('registration needs a valid join proof', () => {
  it('a class code creates the account with its own vault, signs it in, and files a pending membership', async () => {
    const code = (await createCode(w.t, w.pa, subj.id)).code!;
    const before = users();
    const r = await register({ username: 'new_student', display_name: 'طالب جديد', password: 'student-password-123', join: { code }, device_id: 'DEV_NEW_1', device_label: 'iPad' });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as RegisterWithJoinResponse;
    expect(body.user).toMatchObject({ username: 'new_student', display_name: 'طالب جديد', is_platform_admin: false });
    expect(body.recovery_codes).toHaveLength(10);
    expect(body.membership).toMatchObject({ status: 'pending', join_method: 'class_code', node: { id: subj.id } });
    expect(users()).toBe(before + 1);
    // signed in on this device: the cookie works, and the account has its own vault
    const h = { cookie: sessionCookie(r), ...CSRF };
    const me = ok<{ id: string; vault_id: string; is_platform_admin: boolean }>(await call(w.t, h, 'GET', '/api/accounts/me'));
    expect(me.is_platform_admin).toBe(false);
    expect(me.vault_id).not.toBe(w.t.ctx.tenancy.platformVaultBinding()!.vaultId);
    expect(w.t.ctx.system.db.get<{ device_id: string }>('SELECT device_id FROM auth_session WHERE user_id = ?', [body.user.id])!.device_id).toBe('DEV_NEW_1');
    // the code counted one use
    const codes = ok<JoinCodesResponse>(await call(w.t, w.pa, 'GET', `/api/channels/nodes/${subj.id}/codes`));
    expect(codes.codes.find((c) => c.hint === code.slice(-2))!.use_count).toBe(1);
  });

  it('an invite link token works too (approved when the code says so)', async () => {
    const link = await createCode(w.t, w.pa, open.id, { kind: 'invite_link', requires_approval: false });
    const token = link.link!.split('/join/')[1]!;
    const r = await register({ username: 'linked_student', display_name: 'طالب بالرابط', password: 'student-password-456', join: { invite_token: token } });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as RegisterWithJoinResponse).membership).toMatchObject({ status: 'approved', join_method: 'invite_link' });
  });

  it('no proof, a wrong proof, an invitation id or a request to be platform admin creates nothing', async () => {
    const before = users();
    const base = { username: 'no_way_in', display_name: 'لا', password: 'student-password-789' };
    expect((await register(base)).statusCode).toBe(400);
    const wrong = await register({ ...base, join: { code: 'ZZZZ-ZZZZ' } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('JOIN_CODE_INVALID');
    expect((await register({ ...base, join: { invitation_id: 'INV1' } })).statusCode).toBe(400);
    const code = (await createCode(w.t, w.pa, subj.id)).code!;
    expect((await register({ ...base, join: { code }, is_platform_admin: true })).statusCode).toBe(400);
    expect(users()).toBe(before);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('a taken username is refused and gives the code’s use back; a short password is refused first', async () => {
    const one = await createCode(w.t, w.pa, subj.id, { max_uses: 1 });
    const taken = await register({ username: 'owner', display_name: 'مالك مزيف', password: 'student-password-000', join: { code: one.code! } });
    expect(taken.statusCode).toBe(409);
    const short = await register({ username: 'short_pw', display_name: 'قصير', password: 'short', join: { code: one.code! } });
    expect(short.statusCode).toBe(400);
    // the single use is still there for the right person
    const r = await register({ username: 'right_person', display_name: 'الشخص الصحيح', password: 'student-password-111', join: { code: one.code! } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await register({ username: 'too_late', display_name: 'متأخر', password: 'student-password-222', join: { code: one.code! } })).statusCode).toBe(400);
  });

  it('first-run setup stays closed once an account exists (no second platform admin from the network)', async () => {
    const r = await w.t.app.inject({ method: 'POST', url: '/api/auth/setup', headers: CSRF, payload: { username: 'second_admin', password: 'admin-password-123' } });
    expect(r.statusCode).toBe(409);
  });

  it('the per-IP ceiling on wrong proofs holds for registrations (429 after the ceiling)', async () => {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await register({ username: `guess_${i}`, display_name: 'تخمين', password: 'student-password-333', join: { code: `QQQQ-QQ${String(i).padStart(2, '0')}` } });
      if (r.statusCode === 429) limited = true;
      else expect(r.statusCode).toBe(400);
    }
    expect(limited).toBe(true);
  });
});
