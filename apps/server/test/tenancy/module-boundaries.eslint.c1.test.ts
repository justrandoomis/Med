// AOS-21.47 — the module boundaries are an ESLint rule (`medlevo/module-boundaries`, tools/eslint/module-boundaries.mjs)
// that the repository's own lint configuration applies to every server source file: a cross-database access outside the
// allow-listed modules, or a space route outside the allow-list of ARCHITECTURE_DELTA §5.5, fails `npm run lint`.
// (The source scan of import-boundary.test.ts uses the same allow-lists.)
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/config';
import { SPACE_ROUTES } from '../../src/modules/authz/spaceRoutes';
import { declaredSpaceRoutes } from '../../../../tools/eslint/module-boundaries.mjs';

const RULE = 'medlevo/module-boundaries';
// the repository's own eslint.config.js (so the test fails when the rule is not wired into `npm run lint`)
const eslint = new ESLint({ cwd: REPO_ROOT });

async function lint(rel: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: join(REPO_ROOT, 'apps', 'server', rel) });
  return (res?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.message);
}

describe('AOS-21.47 — module boundaries as an ESLint rule', () => {
  it('the rule is on for every server source file in the lint configuration', async () => {
    const cfg = (await eslint.calculateConfigForFile(join(REPO_ROOT, 'apps', 'server', 'src', 'modules', 'library', 'index.ts'))) as { rules?: Record<string, unknown> };
    const level = cfg.rules?.[RULE];
    expect(Array.isArray(level) ? level[0] : level).toBe(2);
  });

  it('flags the system DB handle, *Internal() calls, a second database, opening a file by path and a home-made binding outside the allow-lists', async () => {
    const bad = [
      `export const a = (ctx: any) => ctx.system.db.get('SELECT 1');`,
      `export const b = (ctx: any) => ctx.system.users.byIdInternal('u');`,
      `export const c = (ctx: any) => ctx.dbs.space('s');`,
      `export const d = (ctx: any) => ctx.dbs.vault('v');`,
      `import { openDb } from '../../db/db'; export const e = () => openDb('/tmp/x.sqlite');`,
      `import { DatabaseSync } from 'node:sqlite'; export const f = () => new DatabaseSync('/tmp/x.sqlite');`,
      `import { TenantBinding } from '../../system/binding'; export const g = (o: any) => new TenantBinding(o);`,
    ];
    for (const code of bad) expect(await lint('src/modules/library/sneaky.ts', code), code).toHaveLength(1);
  });

  it('the same code passes in the allow-listed files', async () => {
    expect(await lint('src/modules/channels/service.ts', `export const a = (ctx: any) => ctx.system.db.get('SELECT 1');`)).toEqual([]);
    expect(await lint('src/modules/forks/stubs.ts', `export const c = (ctx: any) => ctx.dbs.space('s');`)).toEqual([]);
    expect(await lint('src/system/repos.ts', `export const b = (r: any) => r.users.byIdInternal('u');`)).toEqual([]);
    expect(await lint('src/modules/data/backup.ts', `import { openDb } from '../../db/db'; export const e = () => openDb('/tmp/x.sqlite');`)).toEqual([]);
  });

  it('a copy service outside the copy-service folders is refused even if listed by mistake (folder rule)', async () => {
    expect(await lint('src/modules/notes/copier.ts', `export const c = (ctx: any) => ctx.dbs.space('s');`)).toHaveLength(1);
  });

  it('space routes: only the mounting files, only MOUNTED declarations of spaceRoutes.ts, only the listed module prefix', async () => {
    // a module of its own mounting a space route
    expect(await lint('src/modules/library/index.ts', `export default async (app: any) => { app.get('/:spaceId/notes', async () => ({})); };`)).toHaveLength(1);
    // the lectures plugin mounting a route that is not declared (or declared but not mounted)
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.get('/:spaceId/lectures/:lectureId/secret', async () => ({})); };`)).toHaveLength(1);
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.post('/:spaceId/files/:id/token', async () => ({})); };`)).toHaveLength(1);
    // a declared, mounted route with the wrong method
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.delete('/:spaceId/lectures', async () => ({})); };`)).toHaveLength(1);
    // declared and mounted: fine
    expect(await lint('src/modules/lectures/index.ts', `export default async (app: any) => { app.get('/:spaceId/lectures', async () => ({})); };`)).toEqual([]);
    // the module table: only the lectures entry carries the /api/spaces prefix
    expect(await lint('src/modules/index.ts', `const p: any = null; export const M = [{ name: 'library', prefix: '/api/spaces', plugin: p }];`)).toHaveLength(1);
    expect(await lint('src/modules/index.ts', `const p: any = null; export const M = [{ name: 'lectures', prefix: '/api/spaces', plugin: p }];`)).toEqual([]);
  });

  it("the rule's reading of spaceRoutes.ts equals the allow-list in force (SPACE_ROUTES)", () => {
    const fromModule = new Set(SPACE_ROUTES.map((r) => `${(r as { method?: string }).method ?? ''} ${r.path}`));
    expect([...declaredSpaceRoutes()].sort()).toEqual([...fromModule].sort());
  });

  it('the whole server source tree is clean under the rule', async () => {
    const results = await eslint.lintFiles([join(REPO_ROOT, 'apps', 'server', 'src', '**', '*.ts')]);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId === RULE).map((m) => `${r.filePath}:${m.line} ${m.message}`));
    expect(hits).toEqual([]);
  }, 180_000);
});
