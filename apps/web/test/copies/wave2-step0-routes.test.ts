// Wave-2 step 0 (BUILD_PLAN §3.2 «apps/web/src/app/*»: T4 adds the route imports of `features/lectures` and
// `features/copies`), updated by P1-T5 step 2 when its first screen landed (the official lecture page) and by step 3
// (the publication page). Nothing else is added — no placeholder screen and no decorative entry (AOS-23.3).
// Every route any feature contributes must carry a real screen (lazy / Component / element) or child routes.
import { describe, expect, it, vi } from 'vitest';
import type { RouteObject } from 'react-router-dom';

// the route table's layouts render the PWA update prompt, whose `virtual:pwa-register` module exists only in a Vite build
vi.mock('../../src/app/PwaUpdatePrompt', () => ({ PwaUpdatePrompt: () => null }));
import { buildRoutes, FEATURES } from '../../src/app/routes';
import { routes as lectures } from '../../src/features/lectures/routes';
import { routes as copies } from '../../src/features/copies/routes';

const all = (r: RouteObject[]): RouteObject[] => r.flatMap((x) => [x, ...all(x.children ?? [])]);
const count = (f: { shell?: RouteObject[]; fullBleed?: RouteObject[]; public?: RouteObject[] }) => (f.shell?.length ?? 0) + (f.fullBleed?.length ?? 0) + (f.public?.length ?? 0);

describe('features/lectures and features/copies in the app route table', () => {
  it('are imported by app/routes.tsx', () => {
    expect(FEATURES.lectures).toBe(lectures);
    expect(FEATURES.copies).toBe(copies);
  });

  it('P1-T5 steps 2–3: lectures adds the official lecture page and the publication page (lazy screens in the shell); copies are dialogs (no route)', async () => {
    expect(lectures.shell?.map((r) => r.path)).toEqual(['subjects/:spaceId/lectures/:lectureId', 'subjects/:spaceId/publications/:publicationId']);
    expect(lectures.fullBleed ?? []).toEqual([]);
    expect(lectures.public ?? []).toEqual([]);
    for (const r of lectures.shell!) {
      const screen = (await (r.lazy as () => Promise<unknown>)()) as { Component?: unknown };
      expect(typeof screen.Component).toBe('function');
    }
    expect(count(copies)).toBe(0);
    const without = { ...FEATURES };
    delete without.lectures;
    delete without.copies;
    const paths = (fs: typeof FEATURES) => all(buildRoutes(fs)).map((r) => `${r.id ?? ''}|${r.path ?? ''}|${String(r.index ?? '')}`);
    const added = paths(FEATURES).filter((p) => !paths(without).includes(p));
    expect(added).toEqual(['|subjects/:spaceId/lectures/:lectureId|', '|subjects/:spaceId/publications/:publicationId|']);
  });

  it('every route of every feature carries a screen or child routes (no route renders nothing)', () => {
    for (const [name, f] of Object.entries(FEATURES)) {
      for (const r of all([...(f.shell ?? []), ...(f.fullBleed ?? []), ...(f.public ?? [])])) {
        const ok = !!(r.lazy || r.Component || r.element || r.children?.length || r.loader);
        expect(ok, `${name}: ${r.path ?? '(index)'}`).toBe(true);
      }
    }
  });
});
