// GATE-1 (review P1-T5 step 3, finding R3-N): the migrated-vault template directory of the server tests is ONE per test
// run, created and removed by the run's global setup (test/global-setup.ts). Before, every worker process made its own
// `medlevo-vault-template-*` directory and removed it on 'exit' — but vitest stops its fork workers with a signal, so
// 'exit' never ran: each full run left ≈ 240 × 4 MB behind (8 437 directories, ~17 GB, filled the disk once).
import { existsSync } from 'node:fs';
import { expect, inject, it } from 'vitest';
import { processTemplateDir } from '../helpers/template';

it('every test file of the run uses the run’s one template directory (no per-process directory to leak)', () => {
  const run = inject('medlevoTemplateDir');
  expect(run).toMatch(/medlevo-vault-template-run-/);
  expect(existsSync(run)).toBe(true);
  expect(processTemplateDir()).toBe(run);
});
