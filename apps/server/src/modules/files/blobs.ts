// Blob lifecycle (ADR-0003 §3.3, ARCHITECTURE_DELTA §4.1 `2250_ops`; P1-T1 step 0 seam, step 2 body).
//
// Every vault (and later every subject space) has its own `stored_file` rows, and all of them point into ONE
// content-addressed store (DATA_DIR/files/aa/bb/<sha256>): two users who upload the same bytes share one blob. The
// system DB keeps a REGISTRY of the blobs (`blob`) with per-database reference HINTS (`blob_ref`); the hints live in
// another file than the rows they count and drift with per-file restores, so they are never the reason bytes go.
//
// Bytes are deleted ONLY here (BlobService) and only in two cases:
//   * the mark-and-sweep GC (./gc.ts) found a blob unreferenced by EVERY registered database in two sweeps at least
//     7 days apart, moved it to quarantine, and a fresh mark 30 days later still missed it;
//   * a deployment with exactly ONE database (today's single owner): when that database drops its last row for a
//     blob, inside the transaction that proved no table references it, nothing else can — exact, as in R1-a.
// Every other path — a purge, an upload clean-up, an annotation image prune — deletes its own row and clears its own
// hint (`removeStoredFileIfUnreferenced`), and the bytes wait for the sweep.
//
// With MEDLEVO_BLOB_STORE=r2 the registry also tracks the encrypted copy in the object store (./r2.ts): new blobs are
// replicated in the background, and a blob whose local copy is missing is fetched back before it is read.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../../context';
import type { Binding, TenantBinding } from '../../system/binding';
import type { BlobMeta, BlobRegistry, BlobRow } from '../../system/ops';
import type { ObjectBlobStore } from './r2';
import { localSize } from './r2';

/** Child columns of every foreign key into stored_file (asked from the schema, never hard-coded). */
function storedFileReferences(ctx: AppContext): Array<{ tbl: string; col: string }> {
  return ctx.db.all<{ tbl: string; col: string }>(
    `SELECT m.name AS tbl, p."from" AS col
     FROM sqlite_master m, pragma_foreign_key_list(m.name) p
     WHERE m.type = 'table' AND p."table" = 'stored_file'`,
  );
}

/**
 * Delete a stored_file row when NO table of the bound database references it any more, and clear that database's hint
 * for the blob. Runs outside the caller's transaction (after its commit). Returns true when the row was removed; false
 * when it is still referenced or already gone. The bytes are deleted only through the registry (see the header).
 */
export function removeStoredFileIfUnreferenced(ctx: AppContext, fileId: string): boolean {
  const refs = storedFileReferences(ctx);
  let sha: string | null = null;
  const removed = ctx.db.tx(() => {
    for (const fk of refs) {
      if (ctx.db.get(`SELECT 1 AS x FROM "${fk.tbl}" WHERE "${fk.col}" = ? LIMIT 1`, [fileId])) return false;
    }
    const file = ctx.files.stat(fileId);
    if (!file) return false;
    sha = file.sha256;
    ctx.db.run('DELETE FROM stored_file WHERE id = ?', [fileId]);
    return true;
  });
  if (removed && sha) ctx.blobs.dropped(sha);
  return removed;
}

/** Where a blob lives on disk (validated content address). */
export function blobPathFor(filesDir: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid blob address');
  return join(filesDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function storageKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export interface BlobServiceOptions {
  registry: BlobRegistry;
  binding: TenantBinding;
  filesDir: string;
  quarantineDir: string;
  tmpDir: string;
  log: FastifyBaseLogger;
  /** registered databases sharing the store (vaults not deleted + spaces) */
  databaseCount: () => number;
  /** open upload sessions for this content (their bytes may complete into it) */
  inFlight: (sha256: string) => boolean;
  objectStore: ObjectBlobStore | null;
}

export interface ReplicationResult {
  copied: number;
  failed: number;
  skipped: number;
}

function dbIdOf(b: Binding | null): string | null {
  if (!b || b.kind === 'root') return null;
  return b.kind === 'vault' ? b.vaultId : b.spaceId;
}

export class BlobService {
  /** set by the GC: references made while a sweep runs are marked in it (never swept by that sweep) */
  onReference: ((sha256: string, dbId: string) => void) | null = null;
  private readonly fetching = new Map<string, Promise<boolean>>();
  private readonly pending = new Set<Promise<void>>();
  private replicating: Promise<ReplicationResult> | null = null;
  /** where the next replication pass continues (content-address order; wraps around) */
  private replicationCursor = '';

  constructor(private readonly o: BlobServiceOptions) {
    mkdirSync(o.quarantineDir, { recursive: true, mode: 0o700 });
  }

  get registry(): BlobRegistry {
    return this.o.registry;
  }

  get objectStore(): ObjectBlobStore | null {
    return this.o.objectStore;
  }

  /** The id of the database the current binding writes into (vault / space), or null. */
  currentDbId(): string | null {
    return dbIdOf(this.o.binding.current() ?? this.o.binding.harnessDefault());
  }

  localPath(sha256: string): string {
    return blobPathFor(this.o.filesDir, sha256);
  }

  quarantinePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid blob address');
    return join(this.o.quarantineDir, sha256);
  }

  // ───────── FileStore hooks ─────────

  /** A stored_file row for this blob exists in the bound database (new, or found by content). */
  referenced(meta: BlobMeta): void {
    const dbId = this.currentDbId();
    if (!dbId) return;
    this.o.registry.recordReferenceInternal(meta, dbId);
    this.onReference?.(meta.sha256, dbId);
  }

  /**
   * The bound database dropped its row for this blob: clear its hint. In a single-database deployment, delete the
   * bytes now (exact — see the header); otherwise they wait for the sweep.
   */
  dropped(sha256: string): void {
    const dbId = this.currentDbId();
    if (dbId) this.o.registry.dropReferenceInternal(sha256, dbId);
    if (this.o.databaseCount() > 1) {
      this.o.log.info({ sha256: sha256.slice(0, 12) }, 'stored file row removed; the blob waits for the mark-and-sweep GC');
      return;
    }
    if (this.o.inFlight(sha256)) return; // an upload of these very bytes is in progress
    const p = this.deleteNow(sha256, 'single database: no row references it')
      .catch((e: unknown) => this.o.log.warn({ err: e }, 'could not delete blob'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves when every background deletion started so far has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  // ───────── deletion (the only paths that remove bytes) ─────────

  /** Remove every copy of a blob (disk, quarantine, object store) and its registry row. */
  async deleteNow(sha256: string, why: string): Promise<void> {
    const row = this.o.registry.getInternal(sha256);
    for (const p of [this.localPath(sha256), this.quarantinePath(sha256)]) {
      try {
        rmSync(p, { force: true });
      } catch (e) {
        this.o.log.warn({ err: e, sha256: sha256.slice(0, 12) }, 'could not remove blob file');
      }
    }
    this.o.registry.forgetInternal(sha256);
    if (row?.storage === 'r2' && this.o.objectStore) {
      try {
        await this.o.objectStore.delete(sha256);
      } catch (e) {
        // a remote copy nobody references any more costs storage, never data: logged
        this.o.log.warn({ err: e, sha256: sha256.slice(0, 12) }, 'could not delete the object-store copy of a deleted blob');
      }
    }
    this.o.log.info({ sha256: sha256.slice(0, 12), why }, 'blob deleted');
  }

  /** GC: move an orphaned blob out of the store (kept for 30 days; a reference found again brings it back). */
  quarantine(b: BlobRow, at: number): void {
    const from = this.localPath(b.sha256);
    if (existsSync(from)) {
      const to = this.quarantinePath(b.sha256);
      rmSync(to, { force: true });
      renameSync(from, to);
    }
    this.o.registry.setQuarantinedInternal(b.sha256, at);
  }

  /** GC: a quarantined blob is referenced again — put the bytes back (or drop the spare copy). */
  unquarantine(b: BlobRow): void {
    const q = this.quarantinePath(b.sha256);
    const to = this.localPath(b.sha256);
    if (existsSync(q)) {
      if (existsSync(to)) rmSync(q, { force: true });
      else {
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        renameSync(q, to);
      }
    }
    this.o.registry.setQuarantinedInternal(b.sha256, null);
    this.o.registry.setOrphanedInternal(b.sha256, null);
  }

  /**
   * GC: the quarantine period is over and a fresh mark still misses the blob. The remote copy goes first (while the
   * row still says «quarantined», so the replicator never re-uploads it), then — unless a reference appeared during
   * that wait (`stillUnreferenced`) — the local copy and the row.
   */
  async deleteQuarantined(b: BlobRow, stillUnreferenced: () => boolean): Promise<boolean> {
    if (b.storage === 'r2' && this.o.objectStore) {
      await this.o.objectStore.delete(b.sha256);
      this.o.registry.setStorageInternal(b.sha256, 'local');
    }
    if (!stillUnreferenced()) return false;
    rmSync(this.quarantinePath(b.sha256), { force: true });
    if (!existsSync(this.localPath(b.sha256))) this.o.registry.forgetInternal(b.sha256);
    else {
      // bytes came back through an upload of the same content while the remote copy was deleted: keep them
      this.o.registry.setQuarantinedInternal(b.sha256, null);
      this.o.registry.setOrphanedInternal(b.sha256, null);
      return false;
    }
    return true;
  }

  // ───────── object store (MEDLEVO_BLOB_STORE=r2) ─────────

  /** Is a confirmed copy of this blob in the object store? */
  isRemote(sha256: string): boolean {
    return this.o.objectStore !== null && this.o.registry.getInternal(sha256)?.storage === 'r2';
  }

  /**
   * Make sure the blob is on the local disk: fetch, decrypt and verify it from the object store when the local copy
   * is missing. Concurrent callers share one download. Returns false when it cannot be had.
   */
  async ensureLocal(sha256: string, size: number): Promise<boolean> {
    const path = this.localPath(sha256);
    if (localSize(path) === size) return true;
    if (!this.isRemote(sha256)) return existsSync(path);
    const running = this.fetching.get(sha256);
    if (running) return running;
    const p = (async () => {
      mkdirSync(this.o.tmpDir, { recursive: true, mode: 0o700 });
      const tmp = join(this.o.tmpDir, `blob-${randomBytes(8).toString('hex')}`);
      try {
        await this.o.objectStore!.get(sha256, size, tmp);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        renameSync(tmp, path);
        this.o.log.info({ sha256: sha256.slice(0, 12) }, 'blob restored from the object store');
        return true;
      } catch (e) {
        this.o.log.warn({ err: e, sha256: sha256.slice(0, 12) }, 'could not fetch a blob from the object store');
        return false;
      } finally {
        rmSync(tmp, { force: true });
        this.fetching.delete(sha256);
      }
    })();
    this.fetching.set(sha256, p);
    return p;
  }

  /**
   * Copy registered blobs that are only on the disk to the object store. Quarantined or orphaned blobs are not copied.
   * One pass at a time; a failure leaves the blob for a later pass. P1-T1 step 2 review: each pass continues where the
   * previous one stopped (content-address order, wrapping around), so blobs that cannot be copied (a lost local copy)
   * never starve the others; a blob quarantined or deleted while its copy uploads has that copy removed again (nothing
   * else would ever delete it).
   */
  replicatePending(limit = 200, signal?: AbortSignal): Promise<ReplicationResult> {
    if (!this.o.objectStore) return Promise.resolve({ copied: 0, failed: 0, skipped: 0 });
    if (this.replicating) return this.replicating;
    const store = this.o.objectStore;
    this.replicating = (async () => {
      const out: ReplicationResult = { copied: 0, failed: 0, skipped: 0 };
      const reg = this.o.registry;
      const from = this.replicationCursor;
      const first = reg.pendingReplicationInternal(limit, from);
      const rows = first.length < limit && from !== '' ? [...first, ...reg.pendingReplicationInternal(limit - first.length, '').filter((r) => r.sha256 <= from)] : first;
      let last = '';
      for (const b of rows) {
        if (signal?.aborted) break;
        last = b.sha256;
        const path = this.localPath(b.sha256);
        if (localSize(path) !== b.size) {
          out.skipped++;
          continue;
        }
        try {
          await store.put(b.sha256, path, b.size, signal);
          // still registered and not quarantined meanwhile: the remote copy is confirmed
          const now = reg.getInternal(b.sha256);
          if (now && now.quarantined_at === null) {
            reg.setStorageInternal(b.sha256, 'r2');
            out.copied++;
          } else {
            await store.delete(b.sha256).catch((e: unknown) => this.o.log.warn({ err: e, sha256: b.sha256.slice(0, 12) }, 'could not remove the copy of a blob quarantined during its upload'));
            out.skipped++;
          }
        } catch (e) {
          out.failed++;
          this.o.log.warn({ err: e, sha256: b.sha256.slice(0, 12) }, 'could not copy a blob to the object store');
        }
      }
      // a full pass (or an interrupted one) continues after the last blob it looked at; a short pass starts over
      this.replicationCursor = rows.length === limit || signal?.aborted ? last : '';
      return out;
    })().finally(() => {
      this.replicating = null;
    });
    return this.replicating;
  }
}
