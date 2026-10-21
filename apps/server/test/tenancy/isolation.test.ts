// P1-T1 step 1 acceptance (BUILD_PLAN §3.3 step 1, ADR-0003 §3.2, ARCHITECTURE_DELTA §1.1 / §5.5 gate 2):
//   * two users interleaved — every request reaches ONLY its own vault: zero cross reads over 200 requests;
//   * the vault comes from the session, never from the request;
//   * there is NO default database: unbound access throws NO_TENANT_BOUND, also from timers and inside the root
//     context of background work; a production binding refuses a harness default;
//   * a job runs in the database it was enqueued in — never in the context of whoever pokes or starts the worker;
//   * the per-statement cost of the bound proxy and the pool-miss latency (NFR-P6 ≤ 50 ms p95) are measured.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type ModuleEntry, MODULES } from '../../src/modules';
import { TenantBinding, type Binding } from '../../src/system/binding';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { addUser, type ExtraUser } from '../helpers/tenancy';

interface JobSeen {
  tag: string;
  path: string;
  kind: string | undefined;
  viewer: string | null;
}
const jobRuns: JobSeen[] = [];

/** A test module: where am I bound, a request-scoped timer, and a job that writes into «its» database. */
const probe: ModuleEntry = {
  name: 'tprobe',
  prefix: '/api/tprobe',
  plugin: async (app, { ctx }) => {
    ctx.jobs.register<{ tag: string }, { ok: true }>('tprobe_write', {
      version: 'tprobe-1',
      inputSchema: z.object({ tag: z.string().max(40) }),
      handler: async (run) => {
        await new Promise((r) => setTimeout(r, 1));
        const b = ctx.binding.current();
        jobRuns.push({ tag: run.input.tag, path: ctx.db.path, kind: b?.kind, viewer: b?.viewer?.userId ?? null });
        ctx.db.run('INSERT INTO owner_setting (key, value_json, updated_at) VALUES (?, ?, ?)', [`probe.${run.input.tag}`, JSON.stringify(run.input.tag), 1]);
        return { ok: true };
      },
    });
    app.get('/where', async (req) => {
      const b = ctx.binding.current();
      return { kind: b?.kind ?? null, vault_id: b?.kind === 'vault' ? b.vaultId : null, path: ctx.db.path, user_id: req.viewer?.userId ?? null };
    });
    app.get('/later', async () => new Promise((resolve) => setTimeout(() => resolve({ path: ctx.db.path }), 3)));
    app.post('/job', async (req) => ctx.jobs.enqueue('tprobe_write', { tag: (req.body as { tag: string }).tag }));
  },
};

let t: TestApp;
let hA: AuthHeaders;
let hB: AuthHeaders;
let b: ExtraUser;
let pathA: string;
let pathB: string;
let vaultA: string;
let folderA: string;
let folderB: string;

beforeAll(async () => {
  t = await createTestApp({ modules: [...MODULES, probe] });
  hA = await t.login();
  b = await addUser(t, 'student-b');
  hB = await b.login();
  const ownA = t.ownerBinding() as Extract<Binding, { kind: 'vault' }>;
  vaultA = ownA.vaultId;
  pathA = t.ctx.pool.pathOf('vault', vaultA);
  pathB = t.ctx.pool.pathOf('vault', b.vault.id);
  const mk = async (h: AuthHeaders, title: string) => {
    const r = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { parent_id: null, kind: 'folder', title } });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json() as { node: { id: string } }).node.id;
  };
  folderA = await mk(hA, 'مجلد المستخدم أ');
  folderB = await mk(hB, 'مجلد المستخدم ب');
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('two users interleaved', () => {
  it('200 interleaved requests: every response comes from the requester’s own vault — zero cross reads', async () => {
    type Who = 'A' | 'B';
    const own = { A: { h: hA, folder: folderA, other: folderB, path: pathA, title: 'مجلد المستخدم أ', otherTitle: 'مجلد المستخدم ب' }, B: { h: hB, folder: folderB, other: folderA, path: pathB, title: 'مجلد المستخدم ب', otherTitle: 'مجلد المستخدم أ' } };
    const kinds = ['tree', 'where', 'own-node', 'other-node', 'later'] as const;
    const plan: Array<{ who: Who; kind: (typeof kinds)[number] }> = [];
    for (let i = 0; i < 200; i++) plan.push({ who: i % 2 === 0 ? 'A' : 'B', kind: kinds[Math.floor(i / 2) % kinds.length]! });
    let crossReads = 0;
    const results = await Promise.all(
      plan.map(async ({ who, kind }) => {
        const me = own[who];
        const url =
          kind === 'tree' ? '/api/library/tree' : kind === 'where' ? '/api/tprobe/where' : kind === 'later' ? '/api/tprobe/later' : `/api/library/nodes/${kind === 'own-node' ? me.folder : me.other}`;
        const res = await t.app.inject({ method: 'GET', url, headers: me.h });
        const body = res.body;
        if (body.includes(me.otherTitle) || body.includes(own[who === 'A' ? 'B' : 'A'].path)) crossReads++;
        return { who, kind, status: res.statusCode, json: res.json() as Record<string, unknown> };
      }),
    );
    expect(results).toHaveLength(200);
    expect(crossReads).toBe(0);
    for (const r of results) {
      const me = own[r.who];
      if (r.kind === 'other-node') {
        expect(r.status).toBe(404); // another user's id is simply not there
        continue;
      }
      expect(r.status).toBe(200);
      if (r.kind === 'tree') expect((r.json.nodes as Array<{ title: string }>).map((n) => n.title)).toEqual([me.title]);
      if (r.kind === 'own-node') expect((r.json.node as { title: string }).title).toBe(me.title);
      if (r.kind === 'where' || r.kind === 'later') expect(r.json.path).toBe(me.path);
      if (r.kind === 'where') expect(r.json).toMatchObject({ kind: 'vault', user_id: r.who === 'A' ? t.ctx.system.users.findForAuth('owner')!.id : b.user.id });
    }
  });

  it('the vault comes from the session, never from the request (ids in the query, headers or body are ignored)', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/tprobe/where?vault_id=${vaultA}&vaultId=${vaultA}`, headers: { ...hB, 'x-medlevo-vault': vaultA } });
    expect(res.json()).toMatchObject({ path: pathB, vault_id: b.vault.id });
    // a write by B lands in B's vault only
    const w = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: hB, payload: { parent_id: folderA, kind: 'folder', title: 'محاولة' } });
    expect(w.statusCode).toBe(404); // A's folder does not exist for B
  });

  it('public / unauthenticated requests are bound to the root context (no database at all)', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/status' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/tprobe/where' })).statusCode).toBe(401);
  });
});

describe('no default database', () => {
  const code = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  it('unbound access throws NO_TENANT_BOUND — directly and from a timer — once the harness default is off', async () => {
    t.ctx.binding.setHarnessDefault(null);
    try {
      expect(code(() => t.ctx.db.get('SELECT 1 AS x'))).toBe('NO_TENANT_BOUND');
      expect(code(() => t.ctx.settings.get())).toBe('NO_TENANT_BOUND');
      const fromTimer = await new Promise<string | null>((resolve) => setTimeout(() => resolve(code(() => t.ctx.db.get('SELECT 1 AS x'))), 1));
      expect(fromTimer).toBe('NO_TENANT_BOUND');
      const fromImmediate = await new Promise<string | null>((resolve) => setImmediate(() => resolve(code(() => t.ctx.db.all('SELECT 1')))));
      expect(fromImmediate).toBe('NO_TENANT_BOUND');
    } finally {
      t.ctx.binding.setHarnessDefault(() => t.ownerBinding());
    }
  });

  it('the root context of background work is strict even while a test harness default exists; its timers too', async () => {
    expect(t.ctx.binding.harnessDefault()).not.toBeNull();
    expect(code(() => t.ctx.binding.runRoot(() => t.ctx.db.get('SELECT 1')))).toBe('NO_TENANT_BOUND');
    const fromRootTimer = await new Promise<string | null>((resolve) => t.ctx.binding.runRoot(() => setTimeout(() => resolve(code(() => t.ctx.db.get('SELECT 1'))), 1)));
    expect(fromRootTimer).toBe('NO_TENANT_BOUND');
    // bindRoot: a callback that always runs in the root context, whoever calls it
    const cb = t.ctx.binding.bindRoot(() => code(() => t.ctx.db.get('SELECT 1')));
    expect(t.ctx.binding.run(t.ownerBinding(), cb)).toBe('NO_TENANT_BOUND');
  });

  it('a request-scoped timer keeps the request’s own vault', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/tprobe/later', headers: hB })).json()).toEqual({ path: pathB });
  });

  it('outside tests a harness default is refused (the production binding has no way to get a default database)', () => {
    const strict = new TenantBinding({ resolve: () => t.ctx.db, allowHarnessDefault: false });
    expect(() => strict.setHarnessDefault(t.ownerBinding())).toThrow(/only allowed in tests/);
    expect(strict.harnessDefault()).toBeNull();
    expect(code(() => strict.db())).toBe('NO_TENANT_BOUND');
  });
});

describe('jobs', () => {
  it('a job runs in the database it was enqueued in — never in the context of the request that pokes or starts the worker', async () => {
    jobRuns.length = 0;
    // A enqueues while the worker is stopped (no poke)
    const a1 = await t.app.inject({ method: 'POST', url: '/api/tprobe/job', headers: hA, payload: { tag: 'A1' } });
    expect(a1.statusCode, a1.body).toBe(200);
    // the worker is started from INSIDE B's vault binding: A1 must still run in A's vault
    const bBinding: Binding = { kind: 'vault', vaultId: b.vault.id, viewer: null };
    t.ctx.binding.run(bBinding, () => t.ctx.jobs.start());
    try {
      await vi.waitFor(() => expect(jobRuns.map((r) => r.tag)).toContain('A1'), { timeout: 5_000 });
      // B's request enqueues and pokes; then A's; then B's again — each runs in its own vault
      for (const [h, tag] of [
        [hB, 'B1'],
        [hA, 'A2'],
        [hB, 'B2'],
      ] as const) {
        const r = await t.app.inject({ method: 'POST', url: '/api/tprobe/job', headers: h, payload: { tag } });
        expect(r.statusCode, r.body).toBe(200);
      }
      await vi.waitFor(() => expect(jobRuns.map((r) => r.tag).sort()).toEqual(['A1', 'A2', 'B1', 'B2']), { timeout: 5_000 });
    } finally {
      await t.ctx.jobs.stop();
    }
    for (const r of jobRuns) {
      expect(r.path, r.tag).toBe(r.tag.startsWith('A') ? pathA : pathB);
      expect(r.kind).toBe('vault');
      expect(r.viewer).toBeNull(); // background work: no viewer
    }
    const tags = (vaultId: string) =>
      t.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () =>
        t.ctx.db.all<{ key: string }>(`SELECT key FROM owner_setting WHERE key LIKE 'probe.%' ORDER BY key`).map((x) => x.key),
      );
    expect(tags(vaultA)).toEqual(['probe.A1', 'probe.A2']);
    expect(tags(b.vault.id)).toEqual(['probe.B1', 'probe.B2']);
    // the system job index names the right database and the enqueuing user
    const idx = t.ctx.system.db.all<{ db_id: string; actor_user_id: string | null; status: string }>(`SELECT db_id, actor_user_id, status FROM job_index WHERE kind = 'tprobe_write'`);
    expect(idx).toHaveLength(4);
    for (const row of idx) {
      expect(row.status).toBe('completed');
      expect(row.actor_user_id).toBe(row.db_id === vaultA ? t.ctx.system.users.findForAuth('owner')!.id : b.user.id);
    }
  });
});

describe('measurements', () => {
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  };

  it('per-statement binding overhead of the bound proxy vs a direct connection (reported; sanity bound 20 µs)', () => {
    const direct = t.ctx.pool.get('vault', vaultA);
    const sql = 'SELECT value_json FROM owner_setting WHERE key = ?';
    const N = 5_000;
    const rounds = 15;
    const directNs: number[] = [];
    const proxyNs: number[] = [];
    t.ctx.binding.run({ kind: 'vault', vaultId: vaultA, viewer: null }, () => {
      for (let i = 0; i < 2_000; i++) t.ctx.db.get(sql, ['probe.A1']); // warm-up (statement cache, JIT)
      for (let r = 0; r < rounds; r++) {
        let s = performance.now();
        for (let i = 0; i < N; i++) direct.get(sql, ['probe.A1']);
        directNs.push(((performance.now() - s) * 1e6) / N);
        s = performance.now();
        for (let i = 0; i < N; i++) t.ctx.db.get(sql, ['probe.A1']);
        proxyNs.push(((performance.now() - s) * 1e6) / N);
      }
    });
    const overheadNs = proxyNs.map((p, i) => p - directNs[i]!);
    const result = {
      statement: sql,
      statements_per_round: N,
      rounds,
      direct_p50_ns: Math.round(pct(directNs, 50)),
      proxy_p50_ns: Math.round(pct(proxyNs, 50)),
      overhead_p50_ns: Math.round(pct(overheadNs, 50)),
      overhead_p95_ns: Math.round(pct(overheadNs, 95)),
    };
    console.info(`[P1-T1 binding overhead] ${JSON.stringify(result)}`);
    if (process.env.MEDLEVO_MEASURE_OUT) writeFileSync(`${process.env.MEDLEVO_MEASURE_OUT}.binding.json`, JSON.stringify(result, null, 2));
    expect(result.overhead_p50_ns).toBeLessThan(20_000);
  });

  it('pool miss latency (NFR-P6: ≤ 50 ms p95): re-opening an evicted vault; the first open of the process reported apart', async () => {
    const small = await createTestApp({ dbPoolSize: 4 });
    try {
      const users: ExtraUser[] = [];
      for (let i = 0; i < 12; i++) users.push(await addUser(small, `pool-user-${i}`));
      const firstOpenMs: number[] = [];
      const missMs: number[] = [];
      for (const u of users) {
        const s = performance.now();
        small.ctx.pool.get('vault', u.vault.id);
        firstOpenMs.push(performance.now() - s);
      }
      for (let round = 0; round < 3; round++) {
        for (const u of users) {
          expect(small.ctx.pool.isOpen('vault', u.vault.id)).toBe(false); // 12 vaults, 4 slots: every access misses
          const s = performance.now();
          small.ctx.pool.get('vault', u.vault.id).get('SELECT 1');
          missMs.push(performance.now() - s);
        }
      }
      const stats = small.ctx.pool.stats();
      const result = {
        vaults: users.length,
        pool_max: stats.max,
        first_open_p50_ms: +pct(firstOpenMs, 50).toFixed(2),
        first_open_p95_ms: +pct(firstOpenMs, 95).toFixed(2),
        miss_p50_ms: +pct(missMs, 50).toFixed(2),
        miss_p95_ms: +pct(missMs, 95).toFixed(2),
        evictions: stats.evictions,
      };
      console.info(`[P1-T1 pool] ${JSON.stringify(result)}`);
      if (process.env.MEDLEVO_MEASURE_OUT) writeFileSync(`${process.env.MEDLEVO_MEASURE_OUT}.pool.json`, JSON.stringify(result, null, 2));
      expect(stats.max).toBe(4);
      expect(stats.open).toBeLessThanOrEqual(4);
      expect(result.miss_p95_ms).toBeLessThanOrEqual(50);
    } finally {
      await small.close();
    }
  }, 120_000);
});

describe('one blob store for every vault', () => {
  it('a user removing a file never deletes bytes another vault still uses (same content, same blob)', async () => {
    const bytes = Buffer.from(`%PDF-1.4 shared lecture ${Date.now()}`);
    const inVault = <T>(vaultId: string, fn: () => T): T => t.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
    const fa = await inVault(vaultA, () => t.ctx.files.put(bytes, { mime: 'application/pdf', originalName: 'shared.pdf' }));
    const fb = await inVault(b.vault.id, () => t.ctx.files.put(bytes, { mime: 'application/pdf', originalName: 'shared.pdf' }));
    const pathA = inVault(vaultA, () => t.ctx.files.path(fa.id));
    const pathB = inVault(b.vault.id, () => t.ctx.files.path(fb.id));
    expect(pathA).toBe(pathB); // content-addressed: one blob
    const { removeStoredFileIfUnreferenced } = await import('../../src/modules/files/blobs');
    expect(inVault(vaultA, () => removeStoredFileIfUnreferenced(t.ctx, fa.id))).toBe(true); // A's row is gone…
    expect(inVault(vaultA, () => t.ctx.files.stat(fa.id))).toBeNull();
    // …but B's file still opens with its bytes
    const res = await t.app.inject({ method: 'GET', url: `/api/files/${fb.id}`, headers: hB });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });
});

describe('per-database memory', () => {
  it('`ctx.db` is ONE proxy object in every binding; `ctx.db.raw` is each database’s own connection (cache keys)', () => {
    const inVault = <T>(vaultId: string, fn: () => T): T => t.ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, fn);
    const [proxyA, rawA] = inVault(vaultA, () => [t.ctx.db, t.ctx.db.raw] as const);
    const [proxyB, rawB] = inVault(b.vault.id, () => [t.ctx.db, t.ctx.db.raw] as const);
    expect(proxyA).toBe(proxyB); // a WeakMap keyed by ctx.db would share one entry between users
    expect(rawA).not.toBe(rawB);
    expect(inVault(vaultA, () => t.ctx.db.raw)).toBe(rawA); // stable while the connection is open
  });
});
