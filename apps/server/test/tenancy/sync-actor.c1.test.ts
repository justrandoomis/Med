// AOS-21.29 (ARCHITECTURE_DELTA §8.2–§8.3, ADR-0004 §2.2) — SyncOperations:
//   * the author of an op is the SESSION's user, never anything in the payload (sync_operation.actor_user_id);
//   * device_id must be an active device of that user: a device the account never saw is registered on its first push
//     (it is this signed-in client), a REVOKED one is answered `rejected/device_unknown`, retryable, never recorded —
//     the same op_id succeeds from a fresh device id;
//   * transient causes (`quota_exceeded`, `not_a_member`) are answered retryable and never recorded, so the queued op
//     succeeds once the cause is fixed; final rejections stay recorded (a retry is answered `duplicate`);
//   * an op_id already recorded for ANOTHER actor is `rejected/op_id_taken` with no entity and no stored result, never
//     recorded — the client re-issues it under a new op_id.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncOpResult, SyncPushResponse } from '@medlevo/shared';
import { AppError } from '../../src/lib/errors';
import { newId } from '../../src/lib/ids';
import { MODULES, type ModuleEntry } from '../../src/modules';
import { createTestApp, CSRF, type AuthHeaders, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

/** what the probe entity does next: 'ok' applies; a code makes it throw that AppError */
let mode: 'ok' | 'quota' | 'pending' | 'invalid' = 'ok';
const probe: ModuleEntry = {
  name: 'c1sync',
  prefix: '/api/c1sync',
  plugin: async (_app, { ctx }) => {
    ctx.sync.registerEntity('c1_probe', {
      apply: (op, tx) => {
        if (mode === 'quota') throw new AppError('QUOTA_EXCEEDED', 'لا مساحة كافية في حسابك الآن.', 409, { kind: 'storage' });
        if (mode === 'pending') throw new AppError('MEMBERSHIP_PENDING', 'طلب انضمامك ينتظر الموافقة.', 403);
        if (mode === 'invalid') throw new AppError('VALIDATION_FAILED', 'بيانات غير صالحة.', 400);
        tx.touch('c1_probe', op.entity_id);
        return { result: 'applied', entity: { id: op.entity_id } };
      },
      serialize: (id) => ({ id }),
    });
  },
};

let t: TestApp;
let sara: ExtraUser;
let h: AuthHeaders;

beforeAll(async () => {
  t = await createTestApp({ modules: [...MODULES, probe] });
  await t.login();
  sara = await addUser(t, 'sara-sync');
  h = await sara.login();
}, 120_000);
afterAll(async () => {
  await t?.close();
});

async function push(device: string, opId: string, payload: unknown = { v: 1 }): Promise<SyncOpResult> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: { ...h, ...CSRF },
    payload: { ops: [{ op_id: opId, device_id: device, entity_type: 'c1_probe', entity_id: newId(), op: 'upsert', payload }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as SyncPushResponse).results[0]!;
}

const recorded = (opId: string) => t.ctx.binding.run({ kind: 'vault', vaultId: sara.vault.id, viewer: null }, () => t.ctx.sync.operation(opId));
const actorOf = (opId: string) =>
  t.ctx.binding.run({ kind: 'vault', vaultId: sara.vault.id, viewer: null }, () => t.ctx.db.get<{ a: string | null }>('SELECT actor_user_id AS a FROM sync_operation WHERE op_id = ?', [opId])?.a);

describe('AOS-21.29 — the actor of a sync op comes from the session', () => {
  it('records the session user as the actor, whatever the payload claims', async () => {
    mode = 'ok';
    const op = newId();
    const r = await push('DEVSARA1', op, { actor_user_id: 'someone-else', author: 'someone-else' });
    expect(r.result).toBe('applied');
    expect(actorOf(op)).toBe(sara.user.id);
  });
});

describe('AOS-21.29 — device check', () => {
  it("a device the account never saw is this signed-in client: registered on its first push", async () => {
    mode = 'ok';
    const r = await push('DEVSARANEW', newId());
    expect(r.result).toBe('applied');
    const list = (await t.app.inject({ method: 'GET', url: '/api/accounts/me/devices', headers: h })).json() as { devices: Array<{ device_id: string }> };
    expect(list.devices.map((d) => d.device_id)).toContain('DEVSARANEW');
  });

  it('a revoked device is answered device_unknown, retryable, NOT recorded; the same op succeeds from a new device id', async () => {
    mode = 'ok';
    await t.app.inject({ method: 'POST', url: '/api/accounts/me/devices', headers: { ...h, ...CSRF }, payload: { device_id: 'DEVSARAOLD' } });
    expect((await t.app.inject({ method: 'DELETE', url: '/api/accounts/me/devices/DEVSARAOLD', headers: { ...h, ...CSRF } })).statusCode).toBe(200);
    const op = newId();
    const r = await push('DEVSARAOLD', op);
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'device_unknown', retryable: true });
    expect(r.entity).toBeUndefined();
    expect(recorded(op)).toBeNull();
    const again = await push('DEVSARAFRESH', op);
    expect(again.result).toBe('applied');
  });
});

describe('AOS-21.29 — transient rejections are never recorded', () => {
  it('quota_exceeded: retryable, not recorded; the queued op applies once there is room', async () => {
    const op = newId();
    mode = 'quota';
    const r = await push('DEVSARA1', op);
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'quota_exceeded', retryable: true });
    expect(recorded(op)).toBeNull();
    mode = 'ok';
    expect((await push('DEVSARA1', op)).result).toBe('applied');
  });

  it('not_a_member (membership pending): retryable, not recorded; applies after approval', async () => {
    const op = newId();
    mode = 'pending';
    const r = await push('DEVSARA1', op);
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'not_a_member', retryable: true });
    expect(recorded(op)).toBeNull();
    mode = 'ok';
    expect((await push('DEVSARA1', op)).result).toBe('applied');
  });

  it('a FINAL rejection stays recorded: the retry is answered duplicate with the original verdict', async () => {
    const op = newId();
    mode = 'invalid';
    const r = await push('DEVSARA1', op);
    expect(r.result).toBe('rejected');
    expect(r.retryable).toBeFalsy();
    expect(recorded(op)).not.toBeNull();
    mode = 'ok';
    expect(await push('DEVSARA1', op)).toMatchObject({ result: 'duplicate', original_result: 'rejected' });
  });
});

describe('AOS-21.29 — an op_id recorded for another actor', () => {
  it('is op_id_taken: no entity, no stored result, not recorded for this actor; a new op_id applies', async () => {
    mode = 'ok';
    const op = newId();
    // an op recorded for another actor under this op_id (e.g. a relayed op, §8.6)
    t.ctx.binding.run({ kind: 'vault', vaultId: sara.vault.id, viewer: null }, () =>
      t.ctx.db.run(
        `INSERT INTO sync_operation (op_id, device_id, entity_type, entity_id, op, payload_json, result, result_detail, server_seq, received_at, actor_user_id)
         VALUES (?, 'DEVOTHER', 'c1_probe', 'E-OTHER', 'upsert', '{"secret":"of another actor"}', 'rejected', 'تفاصيل خاصة بفاعل آخر', 0, ?, 'another-user')`,
        [op, Date.now()],
      ),
    );
    const r = await push('DEVSARA1', op);
    expect(r).toMatchObject({ result: 'rejected', detail_code: 'op_id_taken', retryable: true });
    expect(r.entity).toBeUndefined();
    expect(r.original_result).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('فاعل آخر');
    expect(actorOf(op)).toBe('another-user'); // untouched
    expect((await push('DEVSARA1', newId())).result).toBe('applied');
  });
});
