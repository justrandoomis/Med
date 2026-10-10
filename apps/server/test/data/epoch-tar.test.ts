// Server data epoch (sync after a restore) and the backup archive format (streaming tar.gz writer + SAFE reader).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SyncPullResponse, SyncPushResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { currentEpoch, startRestoreEpoch } from '../../src/modules/data/epoch';
import { ArchiveError, extractTarGz, TarGzWriter, tarHeader } from '../../src/modules/data/tar';
import { createTestApp, type AuthHeaders, type TestApp } from '../helpers/app';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'medlevo-tar-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const limits = { maxEntries: 100, maxTotalBytes: 64 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024, maxRatio: 100, ratioMinBytes: 1024 * 1024 };

function rawEntry(name: string, data: Buffer, type = '0'): Buffer {
  const h = tarHeader('x', data.length, 0);
  h.fill(0, 0, 100);
  h.write(name, 0, 100, 'utf8');
  h[156] = type.charCodeAt(0);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}

describe('archive format', () => {
  it('round-trips files and buffers (long names via the ustar prefix), hashes match, readable by tar', async () => {
    const src = join(dir, 'blob.bin');
    const blob = randomBytes(300_000);
    writeFileSync(src, blob);
    const out = join(dir, 'a.tar.gz');
    const w = new TarGzWriter(out);
    const long = `medlevo-backup/files/${'ab'}/${'cd'}/${'e'.repeat(64)}/${'f'.repeat(40)}`;
    const e1 = await w.addFile(long, src);
    const e2 = await w.addBuffer('medlevo-backup/manifest.json', Buffer.from('{"a":1}'));
    const fin = await w.finish();
    expect(fin.sha256).toBe(createHash('sha256').update(readFileSync(out)).digest('hex'));
    expect(e1.sha256).toBe(createHash('sha256').update(blob).digest('hex'));
    const r = await extractTarGz(out, join(dir, 'x1'), limits);
    expect(r.entries.map((e) => e.path)).toEqual([long, 'medlevo-backup/manifest.json']);
    expect(r.entries[0]!.sha256).toBe(e1.sha256);
    expect(r.entries[1]!.sha256).toBe(e2.sha256);
    expect(readFileSync(join(dir, 'x1', ...long.split('/')))).toEqual(blob);
  });

  it('sizes ≥ 8 GiB use GNU base-256 in the header (round-trip of the size field)', () => {
    const big = 9 * 1024 ** 3 + 7;
    const h = tarHeader('medlevo-backup/big', big, 0);
    expect(h[124]! & 0x80).toBe(0x80);
    let v = 0n;
    for (let i = 125; i < 136; i++) v = (v << 8n) | BigInt(h[i]!);
    expect(Number(v)).toBe(big);
  });

  it('refuses unsafe names at creation (traversal, absolute) and duplicates', async () => {
    const w = new TarGzWriter(join(dir, 'b.tar.gz'));
    await expect(w.addBuffer('../evil', Buffer.from('x'))).rejects.toBeInstanceOf(ArchiveError);
    await expect(w.addBuffer('/etc/passwd', Buffer.from('x'))).rejects.toBeInstanceOf(ArchiveError);
    await w.addBuffer('ok/a', Buffer.from('x'));
    await expect(w.addBuffer('OK/A', Buffer.from('y'))).rejects.toBeInstanceOf(ArchiveError);
    await w.abort();
    expect(existsSync(join(dir, 'b.tar.gz'))).toBe(false);
  });

  const cases: Array<[string, Buffer, string]> = [
    ['traversal', Buffer.concat([rawEntry('../../outside.txt', Buffer.from('pwned')), Buffer.alloc(1024)]), 'INVALID_NAME'],
    ['absolute', Buffer.concat([rawEntry('/tmp/abs.txt', Buffer.from('pwned')), Buffer.alloc(1024)]), 'INVALID_NAME'],
    ['symlink', Buffer.concat([rawEntry('link', Buffer.alloc(0), '2'), Buffer.alloc(1024)]), 'UNSUPPORTED_ENTRY'],
    ['hard link', Buffer.concat([rawEntry('hard', Buffer.alloc(0), '1'), Buffer.alloc(1024)]), 'UNSUPPORTED_ENTRY'],
    ['pax header', Buffer.concat([rawEntry('pax', Buffer.from('20 path=../../x\n'), 'x'), Buffer.alloc(1024)]), 'UNSUPPORTED_ENTRY'],
    ['duplicate', Buffer.concat([rawEntry('a/b', Buffer.from('1')), rawEntry('A/B', Buffer.from('2')), Buffer.alloc(1024)]), 'DUPLICATE_NAME'],
    ['no end blocks', rawEntry('a', Buffer.from('1')), 'TRUNCATED'],
  ];
  for (const [label, tar, code] of cases) {
    it(`refuses an archive with ${label} (${code}) and writes nothing outside`, async () => {
      const p = join(dir, `${label.replace(/\s/g, '_')}.tar.gz`);
      writeFileSync(p, gzipSync(tar));
      const target = join(dir, `t-${label.replace(/\s/g, '_')}`);
      await expect(extractTarGz(p, target, limits)).rejects.toMatchObject({ code });
      expect(existsSync(join(dir, 'outside.txt'))).toBe(false);
      expect(existsSync('/tmp/abs.txt')).toBe(false);
    });
  }

  it('refuses a corrupted header checksum', async () => {
    const t = Buffer.concat([rawEntry('a', Buffer.from('1')), Buffer.alloc(1024)]);
    t[0] = 'b'.charCodeAt(0);
    const p = join(dir, 'chk.tar.gz');
    writeFileSync(p, gzipSync(t));
    await expect(extractTarGz(p, join(dir, 't-chk'), limits)).rejects.toMatchObject({ code: 'BAD_HEADER' });
  });

  it('limits are measured while inflating: ratio bomb, total size, entry count', async () => {
    const bomb = Buffer.concat([rawEntry('zeros', Buffer.alloc(40 * 1024 * 1024)), Buffer.alloc(1024)]);
    const p = join(dir, 'bomb.tar.gz');
    writeFileSync(p, gzipSync(bomb, { level: 9 }));
    await expect(extractTarGz(p, join(dir, 't-bomb'), limits)).rejects.toMatchObject({ code: 'RATIO_EXCEEDED' });
    const total = Buffer.concat([rawEntry('big', randomBytes(3 * 1024 * 1024)), Buffer.alloc(1024)]);
    const p2 = join(dir, 'total.tar.gz');
    writeFileSync(p2, gzipSync(total));
    await expect(extractTarGz(p2, join(dir, 't-total'), { ...limits, maxTotalBytes: 1024 * 1024, maxEntryBytes: 10 * 1024 * 1024 })).rejects.toMatchObject({ code: 'TOTAL_LIMIT' });
    const many = Buffer.concat([...Array.from({ length: 5 }, (_, i) => rawEntry(`f${i}`, Buffer.from('x'))), Buffer.alloc(1024)]);
    const p3 = join(dir, 'many.tar.gz');
    writeFileSync(p3, gzipSync(many));
    await expect(extractTarGz(p3, join(dir, 't-many'), { ...limits, maxEntries: 3 })).rejects.toMatchObject({ code: 'TOO_MANY_ENTRIES' });
  });

  it('a non-gzip file is refused', async () => {
    const p = join(dir, 'plain.tar.gz');
    writeFileSync(p, Buffer.from('not gzip at all'));
    await expect(extractTarGz(p, join(dir, 't-plain'), limits)).rejects.toBeInstanceOf(ArchiveError);
  });
});

describe('server data epoch (sync after restore)', () => {
  let t: TestApp;
  let h: AuthHeaders;
  beforeAll(async () => {
    t = await createTestApp();
    h = await t.login();
  });
  afterAll(async () => {
    await t.close();
  });

  it('pull carries server_epoch / epoch_base_seq / head_seq; push results carry server_seq', async () => {
    const pull = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: h })).json() as SyncPullResponse;
    expect(pull.server_epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(pull.epoch_base_seq).toBe(0);
    expect(pull.head_seq).toBe(0);
    const push = (
      await t.app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: h,
        payload: { ops: [{ op_id: newId(), device_id: 'D1', entity_type: 'note', entity_id: newId(), op: 'upsert', payload: { title: null, body: { v: 1, paragraphs: [] }, anchor: null, origin: 'owner' } }] },
      })
    ).json() as SyncPushResponse;
    expect(push.results[0]!.result).toBe('applied');
    expect(push.results[0]!.server_seq).toBe(push.server_seq);
    expect(push.server_seq).toBeGreaterThan(0);
  });

  it('a restore epoch has a new id and starts at the change-feed head; exactly one current epoch', async () => {
    const before = currentEpoch(t.ctx.db)!;
    const head = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: h })).json().head_seq as number;
    const next = startRestoreEpoch(t.ctx.db, { now: t.ctx.clock.now(), backupId: 'B1', backupCreatedAt: 1 });
    expect(next.id).not.toBe(before.id);
    expect(next.base_seq).toBe(head);
    expect(next.reason).toBe('restore');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM data_server_epoch WHERE is_current = 1')!.n).toBe(1);
    const pull = (await t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0', headers: h })).json() as SyncPullResponse;
    expect(pull.server_epoch).toBe(next.id);
    expect(pull.epoch_base_seq).toBe(head);
    expect((await t.app.inject({ method: 'GET', url: '/api/data/epoch', headers: h })).json().epoch).toMatchObject({ id: next.id, reason: 'restore' });
  });

  it('a push naming an older epoch is refused untouched (409 server_epoch_changed); the current epoch or none is accepted', async () => {
    const old = currentEpoch(t.ctx.db)!;
    startRestoreEpoch(t.ctx.db, { now: t.ctx.clock.now(), backupId: 'B2', backupCreatedAt: 2 });
    const cur = currentEpoch(t.ctx.db)!;
    const noteOp = () => ({ op_id: newId(), device_id: 'D1', entity_type: 'note', entity_id: newId(), op: 'upsert' as const, payload: { title: null, body: { v: 1, paragraphs: [] }, anchor: null, origin: 'owner' } });
    const headBefore = t.ctx.sync.headSeq();
    const notesBefore = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n;
    const stale = noteOp();
    const refused = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { server_epoch: old.id, ops: [stale] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toEqual({ server_epoch_changed: true, server_epoch: cur.id });
    // nothing applied, nothing recorded: the same op id is not a "duplicate" later
    expect(t.ctx.sync.headSeq()).toBe(headBefore);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note')!.n).toBe(notesBefore);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_operation WHERE op_id = ?', [stale.op_id])!.n).toBe(0);
    const ok = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { server_epoch: cur.id, ops: [stale] } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as SyncPushResponse).results[0]!.result).toBe('applied');
    // older clients send no epoch: unchanged behaviour
    const legacy = await t.app.inject({ method: 'POST', url: '/api/sync/push', headers: h, payload: { ops: [noteOp()] } });
    expect((legacy.json() as SyncPushResponse).results[0]!.result).toBe('applied');
  });
});
