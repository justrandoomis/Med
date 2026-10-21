// `withTestBinding(app, fn)` — the test harness of ARCHITECTURE_DELTA §1.1 (P1-T1 step 0).
//
// Once requests bind a user's vault (P1-T1 step 1), direct database access from test code — `ctx.db.*`, `jobs.drain()`,
// `jobs.enqueue` outside a request — must run inside an explicit binding, or it throws NO_TENANT_BOUND. Tests then wrap
// such access in `withTestBinding(t, () => …)` (the harness will also apply it around each test body by default).
//
// Step 0: there is exactly one owner database and nothing to bind, so this is a NO-OP that runs `fn` and returns what
// it returns (a value or a promise), letting errors through unchanged. Landing it now lets new suites use the final
// form from the start; step 1 gives it a body without touching its callers.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../src/context';

/** Anything a test holds that identifies the app: the TestApp, the Fastify instance or the context. */
export type TestBindingTarget = { ctx: AppContext } | FastifyInstance | AppContext;

export function withTestBinding<T>(target: TestBindingTarget, fn: () => T): T {
  void target; // step 1: resolve the test user's vault from `target` and run `fn` inside `ctx.binding.run(…)`
  return fn();
}
