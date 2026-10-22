// P1-T1 step 1 — import boundaries of the tenancy layer (ARCHITECTURE_DELTA §1.1). A source scan, so that a later
// track cannot quietly reach around the binding:
//   * the system DB handle (`ctx.system.db`) and the *Internal repository methods are used only by the listed files;
//   * a second database in one request (`ctx.dbs`) only by the copy services of later tracks (none in R1-b step 1);
//   * database files are opened by path (`openDb`, `new DatabaseSync`) only by the pool, the boot guard, the context,
//     the backup / restore code and the command-line tools — never by a module behind the pool's back.
// AOS-21.47: the allow-lists live in tools/eslint/module-boundaries.mjs, the ESLint rule `medlevo/module-boundaries`
// that `npm run lint` applies (module-boundaries.eslint.c1.test.ts); this scan keeps checking the same lists.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERNAL_CALL_FILES, OPEN_DB_FILES, SECOND_DB_FILES, SECOND_DB_MODULES, SYSTEM_DB_FILES } from '../../../../tools/eslint/module-boundaries.mjs';

const SRC = join(__dirname, '..', '..', 'src');

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push({ file: relative(join(SRC, '..'), p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(SRC);
  return out;
}

/** Strip // and /* *\/ comments so documentation never counts as a use. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function usersOf(re: RegExp): string[] {
  return sources()
    .filter((s) => re.test(code(s.text)))
    .map((s) => s.file)
    .sort();
}

describe('tenancy import boundaries', () => {
  it('the system DB handle is used only by the system layer, the context, auth, health, platform status and the instance backup', () => {
    const allowed = new Set(SYSTEM_DB_FILES);
    const users = usersOf(/\bsystem\.db\b/).filter((f) => !f.startsWith('src/system/'));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('*Internal repository methods (no viewer) are used only by the binding / auth / jobs / boot-time code', () => {
    const allowed = new Set(INTERNAL_CALL_FILES);
    const users = usersOf(/\.[a-zA-Z]+Internal\(/).filter((f) => !f.startsWith('src/system/'));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('a second database in one request (ctx.dbs) only in the copy services of later tracks — none yet', () => {
    const copyServices = SECOND_DB_MODULES;
    const users = usersOf(/\bdbs\.(vault|space)\(/).filter((f) => f !== 'src/context.ts');
    expect(users.filter((f) => !copyServices.test(f))).toEqual([]);
    // P1-T5 step 2: the copy services — stubs from the space, lazy pinning, the purge recount in vaults, promote from a vault
    expect(users).toEqual([...SECOND_DB_FILES].sort());
  });

  it('database files are opened by path only by the pool, the boot guard, the context, backup / restore and the CLIs', () => {
    const allowed = new Set(OPEN_DB_FILES);
    const users = usersOf(/\bopenDb\(|new DatabaseSync\(/);
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('no module keeps its own default database: nothing outside the context builds the bound proxy or a TenantBinding', () => {
    const users = usersOf(/\bcreateBoundDb\(|new TenantBinding\(/).filter((f) => !f.startsWith('src/system/'));
    expect(users).toEqual(['src/context.ts']);
  });
});

describe('per-database memory', () => {
  it('no cache or memo is keyed by the bound proxy `ctx.db` (one object for EVERY vault) — key by `ctx.db.raw` instead', () => {
    // ctx.db is the same object in every binding, so a WeakMap keyed by it would share one cache between users
    const offenders = sources()
      .filter((s) => /\b(memo|cache|caches|Memo|Cache)[A-Za-z]*\.(get|set|delete|has)\(\s*ctx\.db\s*[,)]/.test(code(s.text)) || /WeakMap<Db\b/.test(code(s.text)))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
