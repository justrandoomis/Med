// AOS-21.47 — review of track C1 (2026-10-22): the `medlevo/module-boundaries` rule matched only the literal shapes
// `x.system.db`, `x.dbs.vault(…)` and `app.get('/:spaceId/…')`. Ordinary JavaScript reached the same handles past it:
//   * destructuring — `const { db } = ctx.system`, `const { vault } = ctx.dbs`;
//   * computed access — `ctx.system['db']`, `ctx.dbs['space'](…)`;
//   * Fastify's other route forms — `app.route({ method, url: '/:spaceId/…' })`, `app.all('/:spaceId/…')`.
// Each now fails `npm run lint` outside the allow-lists, and is still allowed inside them.
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';

const RULE = 'medlevo/module-boundaries';
const eslint = new ESLint({ cwd: REPO_ROOT });

async function lint(rel: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(REPO_ROOT, 'apps', 'server', rel) });
  return (res?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe('AOS-21.47 (review) — the boundary rule is not bypassed by ordinary syntax', () => {
  it('destructuring or computed access to the system DB handle and the second-database handles is flagged', async () => {
    const bad = [
      `export const a = (ctx: any) => { const { db } = ctx.system; return db.get('SELECT 1'); };`,
      `export const a2 = (ctx: any) => { const { db: sys } = ctx.system; return sys.get('SELECT 1'); };`,
      `export const b = (ctx: any) => ctx.system['db'].get('SELECT 1');`,
      `export const c = (ctx: any) => { const { vault } = ctx.dbs; return vault('v'); };`,
      `export const d = (ctx: any) => ctx.dbs['space']('s');`,
    ];
    for (const code of bad) expect(await lint('src/modules/library/sneaky.ts', code), code).toHaveLength(1);
  });

  it('the same shapes stay allowed in the allow-listed files', async () => {
    expect(await lint('src/modules/channels/service.ts', `export const a = (ctx: any) => { const { db } = ctx.system; return db.get('SELECT 1'); };`)).toEqual([]);
    expect(await lint('src/modules/forks/stubs.ts', `export const c = (ctx: any) => { const { space } = ctx.dbs; return space('s'); };`)).toEqual([]);
    // an unrelated `db` / `vault` binding is not a boundary crossing
    expect(await lint('src/modules/library/fine.ts', `export const f = (ctx: any) => { const { db } = ctx; const { vault } = ctx.config; return [db, vault]; };`)).toEqual([]);
  });

  it("Fastify's other route forms under /:spaceId are held to the same allow-list", async () => {
    // app.route({...}) in a module of its own
    expect(await lint('src/modules/library/index.ts', `export default async (app: any) => { app.route({ method: 'GET', url: '/:spaceId/notes', handler: async () => ({}) }); };`)).toHaveLength(1);
    // app.all — every method at once
    expect(await lint('src/modules/library/index.ts', `export default async (app: any) => { app.all('/:spaceId/notes', async () => ({})); };`)).toHaveLength(1);
    // in the mounting file: an undeclared route through app.route, a declared one through app.route
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.route({ method: 'GET', url: '/:spaceId/secret', handler: async () => ({}) }); };`)).toHaveLength(1);
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.route({ method: 'GET', url: '/:spaceId/lectures', handler: async () => ({}) }); };`)).toEqual([]);
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.all('/:spaceId/lectures', async () => ({})); };`)).toHaveLength(1);
  });
});
