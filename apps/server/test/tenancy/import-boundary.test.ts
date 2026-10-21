// P1-T1 step 1 — import boundaries of the tenancy layer (ARCHITECTURE_DELTA §1.1). A source scan, so that a later
// track cannot quietly reach around the binding:
//   * the system DB handle (`ctx.system.db`) and the *Internal repository methods are used only by the listed files;
//   * a second database in one request (`ctx.dbs`) only by the copy services of later tracks (none in R1-b step 1);
//   * database files are opened by path (`openDb`, `new DatabaseSync`) only by the pool, the boot guard, the context,
//     the backup / restore code and the command-line tools — never by a module behind the pool's back.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    const allowed = new Set([
      'src/app.ts', // GET /api/health: SELECT 1
      'src/context.ts',
      'src/modules/auth/index.ts', // limiter + session revocation transactions
      'src/modules/data/backups.ts', // the instance backup snapshots the system DB (VACUUM INTO)
      'src/modules/platform/index.ts', // counts only
      'src/modules/accounts/deletion.ts', // step 2: one system transaction per deletion step
    ]);
    const users = usersOf(/\bsystem\.db\b/).filter((f) => !f.startsWith('src/system/'));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('*Internal repository methods (no viewer) are used only by the binding / auth / jobs / boot-time code', () => {
    const allowed = new Set([
      'src/context.ts',
      'src/modules/auth/guard.ts',
      'src/modules/auth/index.ts',
      'src/modules/auth/clientGate.ts', // step 3: is the session's account user #1 (an old client may act only as user #1)
      'src/modules/authz/hook.ts',
      'src/modules/data/backups.ts',
      'src/modules/data/offsite.ts',
      'src/modules/files/blobs.ts', // bytes are kept while several databases share the blob store
      'src/modules/jobs/queue.ts',
      // P1-T1 step 2 — the blob registry / GC, uploads, quotas and the AI ledger are internal APIs of these files:
      'src/modules/files/gc.ts', // mark-and-sweep over every registered database
      'src/modules/files/index.ts', // maintenance tick (last sweep)
      'src/modules/files/uploads.ts', // expiry of upload sessions
      'src/modules/ai/budget.ts', // atomic reservations in the system ledger
      'src/modules/accounts/deletion.ts', // finishing a deletion (no viewer: background)
      'src/modules/accounts/export.ts', // the export job (bound to the user's own vault)
      'src/modules/platform/index.ts', // platform-admin quotas and counts
      'src/modules/data/vault-backup.ts', // platform-admin per-vault backup / restore
    ]);
    const users = usersOf(/\.[a-zA-Z]+Internal\(/).filter((f) => !f.startsWith('src/system/'));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('a second database in one request (ctx.dbs) only in the copy services of later tracks — none yet', () => {
    const copyServices = /^src\/modules\/(forks|channels|social|search|evidence|studybook|data)\//;
    const users = usersOf(/\bdbs\.(vault|space)\(/).filter((f) => f !== 'src/context.ts');
    expect(users.filter((f) => !copyServices.test(f))).toEqual([]);
    expect(users).toEqual([]); // R1-b step 1: no copy service exists yet
  });

  it('database files are opened by path only by the pool, the boot guard, the context, backup / restore and the CLIs', () => {
    const allowed = new Set([
      'src/cli/backup.ts',
      'src/cli/eval.ts',
      'src/context.ts',
      'src/db/db.ts',
      'src/modules/data/backup.ts',
      'src/modules/data/restore.ts',
      'src/modules/data/vault-backup.ts', // step 2: the new epoch of a vault restored in place (pool closed first)
      'src/modules/files/gc.ts', // step 2: the GC mark pass reads every database READ-ONLY (never creates a file)
      'src/system/layout.ts',
      'src/system/pool.ts',
      // step 3: the owner migration reads / moves the single-owner database and builds the system DB beside it; the
      // maintenance page reads the owner row to check the owner's password (nothing is written)
      'src/system/ownerMigration.ts',
      'src/system/maintenance.ts',
    ]);
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
