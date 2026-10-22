// The migrated vault / space templates for the test apps (P1-T1 step 1): every createTestApp copies the template
// (≈ 10 ms) instead of running all base migrations again (≈ 0.4 s). The pool names each template by its migrations'
// fingerprint and writes it atomically, so every worker of a run shares ONE directory: the run's global setup creates it
// and removes it when the run ends (GATE-1, review P1-T5 step 3 R3-N — a per-worker directory removed on 'exit' leaked,
// because vitest stops its workers with a signal). Outside that setup (another vitest config) a per-process directory
// is used as before.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';

let dir: string | null = null;

export function processTemplateDir(): string {
  if (dir) return dir;
  let provided: string | undefined;
  try {
    provided = inject('medlevoTemplateDir');
  } catch {
    provided = undefined;
  }
  if (provided) {
    dir = provided;
    return dir;
  }
  dir = mkdtempSync(join(tmpdir(), 'medlevo-vault-template-'));
  const d = dir;
  process.once('exit', () => rmSync(d, { recursive: true, force: true }));
  return d;
}
