// TEST-ONLY crash points for the owner migration (P1-T1 step 3, test/tenancy/owner-migration.test.ts): with
// MEDLEVO_TEST_HOOKS=1 and MEDLEVO_TEST_MIGRATION_PAUSE_AT=<point>, the process prints «PAUSED <point>» to stderr when
// it reaches that point and then hangs, so a test can kill it with SIGKILL exactly there. Both variables are ignored
// unless MEDLEVO_TEST_HOOKS is exactly «1»; nothing in production sets them.
import type { MigrationHooks } from './ownerMigration';

export function testPauseHook(env: NodeJS.ProcessEnv = process.env): MigrationHooks | undefined {
  if (env.MEDLEVO_TEST_HOOKS !== '1') return undefined;
  const point = env.MEDLEVO_TEST_MIGRATION_PAUSE_AT;
  if (!point) return undefined;
  return {
    at(p: string) {
      if (p !== point) return;
      process.stderr.write(`PAUSED ${p}\n`);
      const cell = new Int32Array(new SharedArrayBuffer(4));
      // block this thread (the test kills the process); never returns on its own
      for (;;) Atomics.wait(cell, 0, 0, 60_000);
    },
  };
}
