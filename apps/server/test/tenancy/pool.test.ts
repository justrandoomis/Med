// P1-T1 step 1 — the vault pool (ADR-0003 §3.2, ARCHITECTURE_DELTA §1): open / close / LRU, WAL, leases, the
// open-file limit, the template a new vault is copied from, and «a missing file is an error, never a fresh database».
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabasePool, effectivePoolSize, FD_RESERVE, FDS_PER_DATABASE, readOpenFileLimit } from '../../src/system/pool';
import { processTemplateDir } from '../helpers/template';

let dir: string;
let registry: Map<string, string>;
let pools: DatabasePool[];

function makePool(o: { maxOpen?: number; openFileLimit?: number | null; warn?: (m: string, d?: Record<string, unknown>) => void } = {}): DatabasePool {
  const p = new DatabasePool({
    vaultsDir: join(dir, 'vaults'),
    spacesDir: join(dir, 'spaces'),
    templateDir: processTemplateDir(),
    maxOpen: o.maxOpen ?? 3,
    now: () => Date.UTC(2026, 9, 21),
    openFileLimit: o.openFileLimit === undefined ? null : o.openFileLimit,
    warn: o.warn,
    resolver: { fileOf: (kind, id) => registry.get(`${kind}:${id}`) ?? null },
  });
  pools.push(p);
  return p;
}

function newVault(p: DatabasePool, id: string): void {
  registry.set(`vault:${id}`, p.createFile('vault', id));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-pool-'));
  registry = new Map();
  pools = [];
});
afterEach(() => {
  for (const p of pools) p.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('DatabasePool', () => {
  it('opens a registered vault once (hit after miss), in WAL mode, migrated', () => {
    const p = makePool();
    newVault(p, 'VA');
    const a = p.get('vault', 'VA');
    const b = p.get('vault', 'VA');
    expect(b).toBe(a);
    expect(p.stats()).toMatchObject({ open: 1, hits: 1, misses: 1 });
    expect(a.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    expect(a.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migration')!.n).toBeGreaterThan(30);
    // the base set only: no system table inside a vault
    expect(a.get(`SELECT name FROM sqlite_schema WHERE name = 'user_account'`)).toBeUndefined();
  });

  it('LRU: the least recently used connection is closed first when the pool is full', () => {
    const p = makePool({ maxOpen: 2 });
    for (const id of ['V1', 'V2', 'V3']) newVault(p, id);
    p.get('vault', 'V1');
    p.get('vault', 'V2');
    p.get('vault', 'V1'); // V1 is now the most recent
    p.get('vault', 'V3'); // evicts V2
    expect(p.isOpen('vault', 'V1')).toBe(true);
    expect(p.isOpen('vault', 'V2')).toBe(false);
    expect(p.isOpen('vault', 'V3')).toBe(true);
    expect(p.stats()).toMatchObject({ open: 2, evictions: 1 });
    // an evicted vault simply re-opens on its next use, with its data
    p.get('vault', 'V2').run(`INSERT INTO owner_setting (key, value_json, updated_at) VALUES ('k', '1', 1)`);
    expect(p.get('vault', 'V2').get<{ value_json: string }>(`SELECT value_json FROM owner_setting WHERE key = 'k'`)!.value_json).toBe('1');
  });

  it('a leased connection (a request or job is using it) or one inside a transaction is never evicted', () => {
    const p = makePool({ maxOpen: 1 });
    for (const id of ['L1', 'L2', 'L3']) newVault(p, id);
    const release = p.acquire('vault', 'L1');
    p.get('vault', 'L2'); // over the size for a moment: L1 is leased, L2 is the newest
    expect(p.isOpen('vault', 'L1')).toBe(true);
    const l2 = p.get('vault', 'L2');
    l2.tx(() => {
      p.get('vault', 'L3'); // L2 is inside a transaction, L1 is leased: neither may close
      expect(p.isOpen('vault', 'L1')).toBe(true);
      expect(p.isOpen('vault', 'L2')).toBe(true);
    });
    expect(p.close('vault', 'L1')).toBe(false); // explicit close refused while leased
    release();
    release(); // idempotent
    expect(p.isOpen('vault', 'L1')).toBe(false); // released → evicted down to the size
    expect(p.stats().open).toBe(1);
  });

  it('a missing file is an error — never a fresh empty database — and an unregistered id is refused', () => {
    const p = makePool();
    newVault(p, 'GONE');
    rmSync(join(dir, 'vaults', 'GONE.sqlite'));
    expect(() => p.get('vault', 'GONE')).toThrow(/missing/);
    expect(existsSync(join(dir, 'vaults', 'GONE.sqlite'))).toBe(false);
    expect(() => p.get('vault', 'NOPE')).toThrow(/not registered/);
    registry.set('vault:EVIL', '../system.sqlite');
    expect(() => p.get('vault', 'EVIL')).toThrow(/invalid db_file/);
    expect(() => p.createFile('vault', '../x')).toThrow();
  });

  it('a new vault is a copy of the migrated template with its OWN sync epoch; an existing file is never overwritten', () => {
    const p = makePool();
    newVault(p, 'T1');
    newVault(p, 'T2');
    const e1 = p.get('vault', 'T1').get<{ id: string }>('SELECT id FROM data_server_epoch WHERE is_current = 1')!.id;
    const e2 = p.get('vault', 'T2').get<{ id: string }>('SELECT id FROM data_server_epoch WHERE is_current = 1')!.id;
    expect(e1).toMatch(/^[0-9a-f]{32}$/);
    expect(e1).not.toBe(e2);
    expect(() => p.createFile('vault', 'T1')).toThrow(/already exists/);
    // no temp files left beside the vaults
    expect(readdirSync(join(dir, 'vaults')).filter((f) => f.endsWith('.sqlite')).sort()).toEqual(['T1.sqlite', 'T2.sqlite']);
    expect(readdirSync(join(dir, 'vaults')).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('the pool size is lowered to fit the open-file limit (and says so); unknown limit keeps the configured size', () => {
    expect(effectivePoolSize(500, null)).toBe(500);
    expect(effectivePoolSize(500, 1024)).toBe(Math.floor((1024 - FD_RESERVE) / FDS_PER_DATABASE));
    expect(effectivePoolSize(500, 100)).toBe(4); // never below a working minimum
    expect(effectivePoolSize(10, 1_000_000)).toBe(10);
    const warnings: string[] = [];
    const p = makePool({ maxOpen: 500, openFileLimit: 1024, warn: (m) => warnings.push(m) });
    expect(p.stats()).toMatchObject({ max: 192, fdLimit: 1024 });
    expect(warnings.join(' ')).toContain('open-file limit');
    // this process: the real limit is read from /proc on Linux
    const real = readOpenFileLimit();
    if (process.platform === 'linux') expect(real === null || real > 0).toBe(true);
  });

  it('open hooks run once per database per process (not again after an eviction); a failing hook never blocks the open', () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const p = makePool({ maxOpen: 1, warn: (_m, d) => warnings.push(d) });
    const seen: string[] = [];
    p.onOpen('vault', 'test.count', (_k, id) => seen.push(id));
    p.onOpen('vault', 'test.boom', () => {
      throw new Error('hook failed');
    });
    expect(() => p.onOpen('vault', 'test.count', () => undefined)).toThrow(/already registered/);
    newVault(p, 'H1');
    newVault(p, 'H2');
    p.get('vault', 'H1');
    p.get('vault', 'H2'); // evicts H1
    p.get('vault', 'H1'); // re-open: hooks do not run again
    expect(seen).toEqual(['H1', 'H2']);
    expect(warnings.filter((w) => w?.hook === 'test.boom')).toHaveLength(2);
  });

  it('closeAll closes every connection and refuses further opens', () => {
    const p = makePool();
    newVault(p, 'C1');
    const db = p.get('vault', 'C1');
    p.closeAll();
    expect(db.isOpen).toBe(false);
    expect(() => p.get('vault', 'C1')).toThrow(/closed/);
  });
});
