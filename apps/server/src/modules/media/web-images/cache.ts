// Content-addressed, size-capped cache of web image thumbnails (DATA_DIR/cache/web-images; NOT in backups — every
// entry can be fetched again). Layout:
//   blobs/<sha256 of the bytes>      the picture (one copy whatever the number of URLs pointing to it)
//   index/<sha256 of the URL>.json   { sha, mime, size, at } — which picture a remote URL gave
// Total bytes are capped: the least recently used blobs go first. Pictures are public (from allow-listed services),
// so the cache is shared by the accounts of the deployment; nothing user-specific is stored here.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../../lib/hash';

export interface CachedImage {
  sha: string;
  mime: string;
  body: Buffer;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export class ThumbCache {
  private readonly blobs: string;
  private readonly index: string;
  private total: number | null = null;

  constructor(
    dir: string,
    private readonly maxBytes: number,
  ) {
    this.blobs = join(dir, 'blobs');
    this.index = join(dir, 'index');
  }

  private ensure(): void {
    mkdirSync(this.blobs, { recursive: true });
    mkdirSync(this.index, { recursive: true });
  }

  get(url: string): CachedImage | null {
    const key = sha256(url);
    let meta: { sha?: string; mime?: string };
    try {
      meta = JSON.parse(readFileSync(join(this.index, `${key}.json`), 'utf8')) as { sha?: string; mime?: string };
    } catch {
      return null;
    }
    if (!meta.sha || !HEX64.test(meta.sha) || !meta.mime || !MIMES.has(meta.mime)) return null;
    const path = join(this.blobs, meta.sha);
    try {
      const body = readFileSync(path);
      if (sha256(body) !== meta.sha) {
        rmSync(path, { force: true });
        return null;
      }
      const now = new Date();
      utimesSync(path, now, now); // LRU: «used now»
      return { sha: meta.sha, mime: meta.mime, body };
    } catch {
      return null;
    }
  }

  put(url: string, body: Buffer, mime: string): CachedImage {
    if (!MIMES.has(mime)) throw new Error(`cache: unsupported type ${mime}`);
    this.ensure();
    const sha = sha256(body);
    const path = join(this.blobs, sha);
    let existed = true;
    try {
      statSync(path);
    } catch {
      existed = false;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, path);
    }
    writeFileSync(join(this.index, `${sha256(url)}.json`), JSON.stringify({ sha, mime, size: body.length, at: Date.now() }));
    if (!existed) {
      this.total = (this.total ?? this.scanTotal()) + (this.total === null ? 0 : body.length);
      if (this.total > this.maxBytes) this.evict(sha);
    }
    return { sha, mime, body };
  }

  /** bytes of pictures currently kept */
  size(): number {
    return (this.total = this.scanTotal());
  }

  private scanTotal(): number {
    let t = 0;
    try {
      for (const n of readdirSync(this.blobs)) if (HEX64.test(n)) t += statSync(join(this.blobs, n)).size;
    } catch {
      return 0;
    }
    return t;
  }

  /** least recently used first (never the picture just stored), down to 80 % of the cap; index entries of removed
   *  blobs just miss next time */
  private evict(keep: string): void {
    const files = readdirSync(this.blobs)
      .filter((n) => HEX64.test(n) && n !== keep)
      .map((n) => {
        const s = statSync(join(this.blobs, n));
        return { n, size: s.size, at: s.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = this.scanTotal();
    const target = Math.floor(this.maxBytes * 0.8);
    for (const f of files) {
      if (total <= target) break;
      rmSync(join(this.blobs, f.n), { force: true });
      total -= f.size;
    }
    this.total = total;
  }
}
