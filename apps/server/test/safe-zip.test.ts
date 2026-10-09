import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractZipSafe, normalizeEntryName, readZipEntryCount } from '../src/lib/safe-zip';

const LIMITS = { maxEntries: 50, maxTotalBytes: 50 * 1024 * 1024, maxRatio: 100 };

async function zipOf(entries: Array<[string, string | Buffer, { unixPermissions?: number; compress?: boolean }?]>): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, data, opts] of entries) {
    z.file(name, data, {
      unixPermissions: opts?.unixPermissions,
      compression: opts?.compress === false ? 'STORE' : 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  }
  return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

describe('safe ZIP extraction', () => {
  it('extracts normal entries (folders, Arabic names, office documents)', async () => {
    const docx = await zipOf([['word/document.xml', '<w:document/>']]);
    const buf = await zipOf([
      ['lectures/محاضرة 1.pdf', Buffer.from('%PDF-1.7 TEST FIXTURE')],
      ['notes.txt', 'hello'],
      ['slides/deck.docx', docx],
    ]);
    const res = await extractZipSafe(buf, LIMITS);
    expect(res.aborted).toBe(false);
    expect(res.rejected).toEqual([]);
    expect(res.accepted.map((e) => e.path).sort()).toEqual(['lectures/محاضرة 1.pdf', 'notes.txt', 'slides/deck.docx']);
    expect(res.accepted.find((e) => e.path === 'notes.txt')!.data!.toString()).toBe('hello');
  });

  it('rejects path traversal and absolute paths (never re-roots them)', async () => {
    const buf = await zipOf([
      ['../evil.txt', 'x'],
      ['a/../../evil2.txt', 'x'],
      ['/etc/passwd', 'x'],
      ['C:\\Windows\\win.ini', 'x'],
      ['ok.txt', 'fine'],
    ]);
    const res = await extractZipSafe(buf, LIMITS);
    const byName = Object.fromEntries(res.rejected.map((r) => [r.originalName, r.code]));
    expect(byName['../evil.txt']).toBe('PATH_TRAVERSAL');
    expect(byName['a/../../evil2.txt']).toBe('PATH_TRAVERSAL');
    expect(byName['/etc/passwd']).toBe('ABSOLUTE_PATH');
    expect(byName['C:\\Windows\\win.ini']).toBe('ABSOLUTE_PATH');
    expect(res.accepted.map((e) => e.path)).toEqual(['ok.txt']);
    for (const r of res.rejected) expect(r.reason_ar).toMatch(/[\u0600-\u06FF]/);
  });

  it('ignores symlinks, system files and nested archives; keeps the first of duplicate names', async () => {
    const inner = await zipOf([['x.txt', 'x']]);
    const buf = await zipOf([
      ['link-to-etc', '/etc/passwd', { unixPermissions: 0o120777 }],
      ['__MACOSX/._a.pdf', 'meta'],
      ['.DS_Store', 'meta'],
      ['archive.zip', inner],
      ['disguised.bin', inner],
      ['Doc.txt', 'one'],
      ['doc.TXT', 'two'],
    ]);
    const res = await extractZipSafe(buf, LIMITS);
    const byName = Object.fromEntries(res.rejected.map((r) => [r.originalName, r.code]));
    expect(byName['link-to-etc']).toBe('SYMLINK');
    expect(byName['__MACOSX/._a.pdf']).toBe('SYSTEM_FILE');
    expect(byName['.DS_Store']).toBe('SYSTEM_FILE');
    expect(byName['archive.zip']).toBe('NESTED_ARCHIVE');
    expect(byName['disguised.bin']).toBe('NESTED_ARCHIVE');
    expect(byName['doc.TXT']).toBe('DUPLICATE_NAME');
    expect(res.accepted.map((e) => e.path)).toEqual(['Doc.txt']);
  });

  it('refuses archives with too many entries before parsing them', async () => {
    const buf = await zipOf(Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, `${i}`] as [string, string]));
    expect(readZipEntryCount(buf)).toBe(12);
    const res = await extractZipSafe(buf, { ...LIMITS, maxEntries: 10 });
    expect(res.aborted).toBe(true);
    expect(res.abortCode).toBe('TOO_MANY_ENTRIES');
    expect(res.accepted).toEqual([]);
  });

  it('stops a zip bomb by measured compression ratio', async () => {
    const bomb = Buffer.alloc(20 * 1024 * 1024, 0); // compresses ~1000:1
    const buf = await zipOf([['bomb.txt', bomb], ['small.txt', 'ok']]);
    expect(buf.length).toBeLessThan(200 * 1024);
    const res = await extractZipSafe(buf, LIMITS);
    expect(res.rejected.find((r) => r.originalName === 'bomb.txt')?.code).toBe('RATIO_EXCEEDED');
    expect(res.accepted.map((e) => e.path)).toEqual(['small.txt']);
    expect(res.totalUncompressed).toBeLessThan(1024);
  });

  it('stops when the measured total uncompressed size exceeds the limit', async () => {
    const chunk = () => randomBytes(3 * 1024 * 1024); // incompressible → ratio check does not trigger
    const buf = await zipOf([['a.bin', chunk()], ['b.bin', chunk()], ['c.bin', chunk()]]);
    const res = await extractZipSafe(buf, { ...LIMITS, maxTotalBytes: 5 * 1024 * 1024 });
    expect(res.aborted).toBe(true);
    expect(res.abortCode).toBe('TOTAL_LIMIT');
    expect(res.accepted.map((e) => e.path)).toEqual(['a.bin']);
    expect(res.rejected.map((r) => [r.originalName, r.code])).toEqual([
      ['b.bin', 'TOTAL_LIMIT'],
      ['c.bin', 'NOT_EXTRACTED'],
    ]);
    expect(res.totalUncompressed).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('does not trust size headers: lying headers are still caught while inflating', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    const buf = await zipOf([['liar.bin', payload]]);
    // patch the declared uncompressed size (local header @22 and central directory @24) to 10 bytes
    const lfh = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    buf.writeUInt32LE(10, lfh + 22);
    const cdh = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(10, cdh + 24);
    const res = await extractZipSafe(buf, { ...LIMITS, maxRatio: 100_000, maxEntryBytes: 1024 * 1024 });
    expect(res.rejected[0]).toMatchObject({ originalName: 'liar.bin', code: 'ENTRY_TOO_LARGE' });
    expect(res.accepted).toEqual([]);
  });

  it('reports invalid archives instead of throwing', async () => {
    const res = await extractZipSafe(Buffer.from('this is not a zip file at all'), LIMITS);
    expect(res).toMatchObject({ aborted: true, abortCode: 'ZIP_INVALID' });
    expect(res.abortReasonAr).toMatch(/[\u0600-\u06FF]/);
  });

  it('extracts into a directory without escaping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'medlevo-zip-'));
    try {
      const buf = await zipOf([['sub/a.txt', 'A'], ['../escape.txt', 'X']]);
      const res = await extractZipSafe(buf, LIMITS, { mode: 'dir', dir });
      expect(res.accepted).toHaveLength(1);
      const file = res.accepted[0]!.filePath!;
      expect(file.startsWith(dir)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('A');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes names', () => {
    expect(normalizeEntryName('./a//b/./c.txt')).toEqual({ path: 'a/b/c.txt' });
    expect(normalizeEntryName('dir\\file.txt')).toEqual({ path: 'dir/file.txt' });
    expect(normalizeEntryName('CON.txt')).toEqual({ path: '_CON.txt' });
    expect(normalizeEntryName('bad\u0000name')).toEqual({ code: 'INVALID_NAME' });
    expect(normalizeEntryName('..')).toEqual({ code: 'PATH_TRAVERSAL' });
    expect(normalizeEntryName('//server/share')).toEqual({ code: 'ABSOLUTE_PATH' });
  });
});
