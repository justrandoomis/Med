// Integration (I1 #10): no screen that merely says «قيد البناء» is reachable. Every feature's routes.tsx renders a
// real screen; the unused PlaceholderScreen (round-1 scaffolding) was removed. Unfinished parts are disabled with a
// reason through the capability registry instead (ARCHITECTURE §0.7).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe('no placeholder screens', () => {
  it('no source file renders or imports a placeholder screen', () => {
    const offenders = files(SRC).filter((f) => {
      const t = readFileSync(f, 'utf8');
      return t.includes('PlaceholderScreen') || t.includes('هذه الشاشة قيد البناء');
    });
    expect(offenders).toEqual([]);
  });

  it('every features/*/routes.tsx points at real screens (lazy imports of the feature\'s own screens)', () => {
    const features = readdirSync(join(SRC, 'features')).filter((d) => statSync(join(SRC, 'features', d)).isDirectory());
    const withRoutes = features.filter((d) => {
      try {
        return statSync(join(SRC, 'features', d, 'routes.tsx')).isFile();
      } catch {
        return false;
      }
    });
    expect(withRoutes.length).toBeGreaterThan(15);
    for (const d of withRoutes) {
      const t = readFileSync(join(SRC, 'features', d, 'routes.tsx'), 'utf8');
      expect(t, d).not.toMatch(/Placeholder|قيد البناء/);
      expect(t, d).toMatch(/lazy:|element:/);
    }
  });
});
