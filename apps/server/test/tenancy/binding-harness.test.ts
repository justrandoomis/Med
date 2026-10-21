// P1-T1 step 0 — the `withTestBinding(app, fn)` test harness (ARCHITECTURE_DELTA §1.1). Direct database access from
// test code (ctx.db.*, jobs.drain(), jobs.enqueue outside a request) will go through it once requests bind a vault
// (step 1). In step 0 there is one owner database and nothing to bind, so it is a no-op that only runs `fn`: it must
// return what `fn` returns, await what `fn` awaits and let errors through untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, withTestBinding } from '../helpers/app';
import { withTestBinding as fromBindingModule } from '../helpers/binding';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe('withTestBinding (step 0: no-op harness)', () => {
  it('is exported from the app helpers and from helpers/binding (one function)', () => {
    expect(withTestBinding).toBe(fromBindingModule);
  });

  it('runs a synchronous body and returns its value; direct database access works inside it', () => {
    const n = withTestBinding(t, () => t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration')!.n);
    expect(n).toBeGreaterThan(30);
  });

  it('runs an async body and resolves with its value', async () => {
    const v = await withTestBinding(t, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return t.ctx.db.get<{ x: number }>('SELECT 1 AS x')!.x;
    });
    expect(v).toBe(1);
  });

  it('lets errors through unchanged (sync throw and async rejection)', async () => {
    const boom = new Error('boom');
    expect(() =>
      withTestBinding(t, () => {
        throw boom;
      }),
    ).toThrow(boom);
    await expect(withTestBinding(t, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('accepts the bare app context as well as the TestApp (the forms existing tests hold)', () => {
    expect(withTestBinding(t.ctx, () => 'ctx')).toBe('ctx');
    expect(withTestBinding(t.app, () => 'app')).toBe('app');
  });
});
