// `withTestBinding(app, fn)` — the test harness of ARCHITECTURE_DELTA §1.1 (P1-T1 step 0 seam, real since step 1).
//
// Requests bind the session's own vault (the binding hook). Direct database access from test code — `ctx.db.*`,
// `jobs.drain()`, `jobs.enqueue` outside a request — runs inside an explicit binding: `withTestBinding(t, () => …)`
// binds the test user's vault (createTestApp) or, for an app built directly on an existing data dir, the vault of the
// first platform admin (user #1). The harness also applies that binding by default to code outside every context
// (TenantBinding.setHarnessDefault, NODE_ENV=test only), so the existing suites need no wrapper; new suites use this
// function to be explicit. `fn` may be sync or async; its value and its errors pass through unchanged.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../src/context';
import type { Binding } from '../../src/system/binding';

/** Anything a test holds that identifies the app: the TestApp, the Fastify instance or the context. */
export type TestBindingTarget = { ctx: AppContext; ownerBinding?: () => Binding } | FastifyInstance | AppContext;

function contextOf(target: TestBindingTarget): AppContext {
  if ('binding' in target && 'system' in target) return target as AppContext;
  return (target as { ctx: AppContext }).ctx;
}

/** The binding test code runs in: the test user's vault (created on first use by createTestApp's harness). */
export function testBinding(target: TestBindingTarget): Binding {
  const own = (target as { ownerBinding?: () => Binding }).ownerBinding;
  if (typeof own === 'function') return own();
  const ctx = contextOf(target);
  const b = ctx.binding.harnessDefault() ?? ctx.tenancy.platformVaultBinding();
  if (!b) throw new Error('withTestBinding: no test user / vault exists yet in this app');
  return b;
}

export function withTestBinding<T>(target: TestBindingTarget, fn: () => T): T {
  return contextOf(target).binding.run(testBinding(target), fn);
}
