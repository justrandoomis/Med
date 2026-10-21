// One directory per test worker process for the migrated vault template (P1-T1 step 1): every createTestApp copies
// the template (≈ 10 ms) instead of running all base migrations again (≈ 0.4 s). Removed when the process exits.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string | null = null;

export function processTemplateDir(): string {
  if (dir) return dir;
  dir = mkdtempSync(join(tmpdir(), 'medlevo-vault-template-'));
  const d = dir;
  process.once('exit', () => rmSync(d, { recursive: true, force: true }));
  return d;
}
