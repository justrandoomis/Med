// P1-T1 step 1 — the data-directory boot guard (ADR-0003 §3.1) and signed file links bound to a vault and a user.
//   * a fresh directory gets the multi-user layout: system.sqlite (system set only), then the marker, vaults/, spaces/;
//   * a single-owner directory (medlevo.sqlite), an unfinished migration (journal) or vault files without their system
//     DB are REFUSED — and the directory is left exactly as it was, byte for byte (the owner migration is step 3);
//   * a signed link carries {file, vault, user}: it works only in that vault, only while the vault is active, still
//     belongs to that user and the user is active; nobody can point it at another vault.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { openDb } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';
import { DataDirRefusedError, detectDataDir, JOURNAL_FILE, MARKER_FILE, prepareDataDir } from '../../src/system/layout';
import { type AuthHeaders, createTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app';
import { processTemplateDir } from '../helpers/template';
import { addUser, bootOnVaultFile, type ExtraUser } from '../helpers/tenancy';

/** Every file and directory under `dir` with its sha256 (directories as «dir»). */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        out[rel] = 'dir';
        walk(p);
      } else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const pathsOf = (dataDir: string) => ({
  dataDir,
  legacyDbPath: join(dataDir, 'medlevo.sqlite'),
  systemDbPath: join(dataDir, 'system.sqlite'),
  vaultsDir: join(dataDir, 'vaults'),
  spacesDir: join(dataDir, 'spaces'),
});

describe('data-directory boot guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'medlevo-layout-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh directory gets system.sqlite (system migrations only), the marker, vaults/ and spaces/ — and no single-owner file', () => {
    const p = pathsOf(join(dir, 'data'));
    expect(prepareDataDir(p, () => 1)).toEqual({ kind: 'fresh' });
    expect(existsSync(p.systemDbPath)).toBe(true);
    expect(existsSync(join(p.dataDir, MARKER_FILE))).toBe(true);
    expect(existsSync(p.vaultsDir) && existsSync(p.spacesDir)).toBe(true);
    expect(existsSync(p.legacyDbPath)).toBe(false);
    const db = openDb(p.systemDbPath);
    try {
      const versions = db.all<{ name: string }>('SELECT name FROM schema_migration ORDER BY name').map((r) => Number(r.name.slice(0, 4)));
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((v) => v >= 2000 && v < 3000)).toBe(true);
      expect(db.get(`SELECT name FROM sqlite_schema WHERE name = 'source'`)).toBeUndefined();
    } finally {
      db.close();
    }
    // no temp files, and a second boot just recognises the layout
    expect(readdirSync(p.dataDir).some((n) => n.includes('.tmp'))).toBe(false);
    const before = snapshotDir(p.dataDir);
    expect(prepareDataDir(p, () => 2)).toEqual({ kind: 'multi_user' });
    expect(snapshotDir(p.dataDir)).toEqual(before);
  });

  it('a system DB without the marker (a crash between the two) is finished, not refused', () => {
    const p = pathsOf(join(dir, 'data'));
    prepareDataDir(p, () => 1);
    rmSync(join(p.dataDir, MARKER_FILE));
    expect(detectDataDir(p)).toEqual({ kind: 'unfinished_fresh' });
    expect(prepareDataDir(p, () => 1)).toEqual({ kind: 'unfinished_fresh' });
    expect(detectDataDir(p)).toEqual({ kind: 'multi_user' });
  });

  for (const c of [
    {
      name: 'a single-owner data directory (medlevo.sqlite, R1-a and earlier)',
      state: 'legacy_single_owner',
      make: (d: string) => {
        const db = openDb(join(d, 'medlevo.sqlite'));
        migrate(db);
        db.run(`INSERT INTO owner_setting (key, value_json, updated_at) VALUES ('owner.note', '"بيانات المالك"', 1)`);
        db.close();
        mkdirSync(join(d, 'files', 'ab'), { recursive: true });
        writeFileSync(join(d, 'files', 'ab', 'abcdef'), 'owner file bytes');
        writeFileSync(join(d, 'secret.key'), 'not-a-real-secret');
      },
    },
    { name: 'an unfinished owner migration (journal present)', state: 'migration_in_progress', make: (d: string) => writeFileSync(join(d, JOURNAL_FILE), '{"step":"copy"}') },
    {
      name: 'vault files without their system DB',
      state: 'orphan_vaults',
      make: (d: string) => {
        mkdirSync(join(d, 'vaults'), { recursive: true });
        writeFileSync(join(d, 'vaults', 'X.sqlite'), 'x');
      },
    },
    { name: 'a marker without its system DB', state: 'orphan_vaults', make: (d: string) => writeFileSync(join(d, MARKER_FILE), 'x') },
  ] as const) {
    it(`refuses ${c.name} — through prepareDataDir AND a full server boot — leaving every byte as it was`, async () => {
      const dataDir = join(dir, 'data');
      mkdirSync(dataDir, { recursive: true });
      c.make(dataDir);
      const before = snapshotDir(dataDir);
      expect(() => prepareDataDir(pathsOf(dataDir), () => 1)).toThrow(DataDirRefusedError);
      try {
        prepareDataDir(pathsOf(dataDir), () => 1);
      } catch (e) {
        expect((e as DataDirRefusedError).state).toBe(c.state);
        expect((e as Error).message).toMatch(/[؀-ۿ]/); // an Arabic explanation…
        expect((e as Error).message).toMatch(/[A-Za-z]{4}/); // …and the English one for the operator's log
      }
      expect(snapshotDir(dataDir)).toEqual(before);
      const config = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: dataDir, MEDLEVO_ORIGIN: TEST_ORIGIN, MEDLEVO_LOG_LEVEL: 'silent' });
      await expect(buildApp({ config, overrides: { aiProvider: null, templateDir: processTemplateDir() } })).rejects.toBeInstanceOf(DataDirRefusedError);
      expect(snapshotDir(dataDir)).toEqual(before);
    });
  }
});

describe('signed file links', () => {
  let t: TestApp;
  let hA: AuthHeaders;
  let b: ExtraUser;
  let hB: AuthHeaders;
  let fileId: string;
  let vaultA: string;

  beforeAll(async () => {
    t = await createTestApp();
    hA = await t.login();
    b = await addUser(t, 'student-b');
    hB = await b.login();
    const binding = t.ownerBinding();
    vaultA = binding.kind === 'vault' ? binding.vaultId : '';
    fileId = (await t.ctx.files.put(Buffer.from('%PDF-1.4 owner A only'), { mime: 'application/pdf', originalName: 'a.pdf' })).id;
  }, 120_000);
  afterAll(async () => {
    await t?.close();
  });

  const link = async (h: AuthHeaders) => t.app.inject({ method: 'POST', url: `/api/files/${fileId}/token`, headers: h, payload: {} });
  const open = (url: string) => t.app.inject({ method: 'GET', url });

  it('works without a session in its own vault; another user cannot even get a link to the file', async () => {
    const r = await link(hA);
    expect(r.statusCode, r.body).toBe(200);
    const { url, token } = r.json() as { url: string; token: string };
    const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { d: string; u: string };
    expect(payload.d).toBe(`v:${vaultA}`);
    expect(payload.u).toBe(t.ctx.system.users.findForAuth('owner')!.id);
    const got = await open(url);
    expect(got.statusCode).toBe(200);
    expect(got.body).toContain('owner A only');
    expect((await link(hB)).statusCode).toBe(404);
  });

  it('is refused once the vault is not active or the user is suspended — and works again when restored', async () => {
    const { url } = (await link(hA)).json() as { url: string };
    t.ctx.system.db.run(`UPDATE vault SET status = 'locked' WHERE id = ?`, [vaultA]);
    expect((await open(url)).statusCode).toBe(403);
    t.ctx.system.db.run(`UPDATE vault SET status = 'active' WHERE id = ?`, [vaultA]);
    expect((await open(url)).statusCode).toBe(200);
    t.ctx.system.db.run(`UPDATE user_account SET status = 'suspended' WHERE username = 'owner'`);
    expect((await open(url)).statusCode).toBe(403);
    t.ctx.system.db.run(`UPDATE user_account SET status = 'active' WHERE username = 'owner'`);
    expect((await open(url)).statusCode).toBe(200);
  });

  it('cannot be pointed at another vault: an edited payload fails its signature; a link naming a vault of someone else is refused', async () => {
    const { token } = (await link(hA)).json() as { token: string };
    const [payload, sig] = token.split('.') as [string, string];
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...data, d: `v:${b.vault.id}`, u: b.user.id })).toString('base64url');
    expect((await open(`/api/files/t/${forged}.${sig}`)).statusCode).toBe(403);
    // even a correctly signed link is refused when the vault it names does not belong to the user it names
    const mismatched = t.ctx.binding.run({ kind: 'vault', vaultId: vaultA, viewer: { userId: b.user.id, deviceId: null, isPlatformAdmin: false } }, () => t.ctx.files.createToken(fileId, 60_000));
    expect((await open(`/api/files/t/${mismatched.token}`)).statusCode).toBe(403);
    // a link created outside any database (root context) is impossible
    expect(() => t.ctx.binding.runRoot(() => t.ctx.files.createToken(fileId, 60_000))).toThrow();
  });
});

describe('per-database work that used to run once at boot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'medlevo-onopen-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a vault opened by the pool gets its repairs on first open (correction history of a purged source is pruned)', async () => {
    const booted = await bootOnVaultFile(join(dir, 'data'), (path) => {
      const db = openDb(path);
      migrate(db);
      db.run(
        `INSERT INTO control_region_correction (id, region_id, version_id, source_id, action, before_text, after_text, created_at)
         VALUES ('C-ORPHAN', 'R1', 'V1', 'SOURCE-PURGED', 'correct', 'نص قديم', 'نص جديد', 1)`,
      );
      db.close();
    }, { nodeEnv: 'development' }); // production-like: no harness default, nothing is bound at boot
    try {
      const n = booted.ctx.binding.run(booted.ctx.tenancy.platformVaultBinding()!, () => booted.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM control_region_correction')!.n);
      expect(n).toBe(0);
    } finally {
      await booted.app.close();
    }
  });

  it('a production-like boot touches no vault database outside a binding (every boot-time repair is an open hook)', async () => {
    const { TenantBinding } = await import('../../src/system/binding');
    const original = TenantBinding.prototype.db;
    const unbound: string[] = [];
    TenantBinding.prototype.db = function (this: InstanceType<typeof TenantBinding>) {
      try {
        return original.call(this);
      } catch (e) {
        unbound.push(new Error('unbound access').stack ?? '');
        throw e;
      }
    };
    try {
      // boot twice on the same directory (the second boot finds an account and its vault), production-like
      const booted = await bootOnVaultFile(join(dir, 'data'), (path) => {
        const db = openDb(path);
        migrate(db);
        db.close();
      }, { nodeEnv: 'development' });
      await booted.app.close();
    } finally {
      TenantBinding.prototype.db = original;
    }
    // the only expected one: the AI budget asked at registration (status of the capability), answered «0 spent»
    const unexpected = unbound.filter((st) => !/AiOrchestrator\.budget/.test(st));
    expect(unexpected.map((st) => st.split('\n').slice(2, 6).join(' | '))).toEqual([]);
  });
});
