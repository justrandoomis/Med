// .env.example documents every setting the server reads (I1 #9). Regression: MEDLEVO_SETUP_TOKEN (round 4,
// modules/auth/setup-token.ts) and MEDLEVO_SOFFICE_AVAILABLE (sources/upload.ts) were read from the environment but
// missing from the example, so an operator could not learn about them from the file they copy.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('.env.example', () => {
  it('names every MEDLEVO_* / provider variable the server reads', () => {
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const read = new Set<string>();
    // the config schema (config.ts) …
    const config = readFileSync(join(REPO_ROOT, 'apps', 'server', 'src', 'config.ts'), 'utf8');
    for (const m of config.matchAll(/^\s+((?:MEDLEVO|ANTHROPIC)_[A-Z0-9_]+): z\./gm)) read.add(m[1]!);
    // … and every direct read anywhere in the server
    for (const f of sourceFiles(join(REPO_ROOT, 'apps', 'server', 'src'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/process\.env(?:\.|\[['"])((?:MEDLEVO|ANTHROPIC)_[A-Z0-9_]+)/g)) read.add(m[1]!);
    }
    expect(read.size).toBeGreaterThan(10);
    expect(read).toContain('MEDLEVO_SETUP_TOKEN');
    const missing = [...read].filter((k) => !documented.has(k)).sort();
    expect(missing).toEqual([]);
    // and no secret value is ever committed in the example
    for (const line of example.split('\n')) {
      if (/^(ANTHROPIC_API_KEY|MEDLEVO_SETUP_TOKEN)=/.test(line)) expect(line.split('=')[1]).toBe('');
    }
  });
});
