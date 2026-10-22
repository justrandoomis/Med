// Server test run setup (GATE-1, review P1-T5 step 3 R3-N): ONE directory per run for the migrated vault / space
// templates the test apps copy (see helpers/template.ts), removed when the run ends. Worker processes are stopped with a
// signal, so a per-process directory removed on 'exit' was never removed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    medlevoTemplateDir: string;
  }
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'medlevo-vault-template-run-'));
  project.provide('medlevoTemplateDir', dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
