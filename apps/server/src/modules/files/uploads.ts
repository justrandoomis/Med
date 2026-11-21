// Chunked, resumable uploads (P1-T1 step 2; ARCHITECTURE_DELTA §7.12). A phone on a weak connection announces the
// whole file first (size + sha256), then sends fixed-size chunks — each verified by its own sha256 — in any order and
// as often as it needs; an interrupted upload asks for its session again and sends only what is missing.
//
//   POST   /api/files/uploads                   {size, sha256, mime?, name?, target:'vault'} → UploadSessionView
//          (an open session for the same bytes is resumed; bytes the vault already holds complete at once)
//   GET    /api/files/uploads/:id                → UploadSessionView (the viewer's own sessions only)
//   PUT    /api/files/uploads/:id/chunks/:n      raw body + x-content-sha256 → UploadSessionView
//   POST   /api/files/uploads/:id/complete       → UploadCompleteResponse (whole sha256 verified, then ctx.files.put)
//   DELETE /api/files/uploads/:id                → abandons the session and its chunks
//
// Sessions live in the system DB (upload_session, one user's rows per viewer); chunks in DATA_DIR/tmp/uploads/<id>/
// (never in the content-addressed store until the whole file is verified). The storage quota is checked when the
// session starts (open sessions count) and again when the file is stored; the per-file limit is MEDLEVO_MAX_UPLOAD_MB.
// While a session is open its announced content is protected from the blob GC (it may complete into an orphaned blob).
//
// AOS-2.3 / 18.3 (subject spaces): the SAME service serves the subject's own routes `/api/spaces/:s/uploads…`, mounted by
// the lectures plugin and declared in authz/spaceRoutes.ts. There the request is bound to the subject's space, so a
// session's `target_db` is `s:<spaceId>`, the file is stored in the space database, the subject's storage quota is the
// one checked (open sessions into the subject count), and only the uploader's own sessions INTO THIS SPACE are found —
// a session of another subject or of the vault answers 404 like a missing id. Who may start one is the route's
// business (contributors and moderators of the subject; gate 2 already answered «not found» to strangers). The
// completed file reaches an official lecture through `POST /api/spaces/:s/lectures/:id/upload {upload_id}`.
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createUploadSchema, UPLOAD_CHUNK_SHA_HEADER, UPLOAD_LABELS_AR, type UploadCompleteResponse, type UploadSessionView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import { UploadSessionRepo, type UploadSessionRow } from '../../system/ops';
import { toFileView } from './store';

const idParams = z.object({ id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const chunkParams = idParams.extend({ n: z.coerce.number().int().min(0).max(1_000_000) });

/** Per-client limits of the upload routes (the subject's own routes use the same, AOS-2.3). */
export const UPLOAD_LIMITS = {
  create: { max: 60, timeWindow: 60_000 },
  chunk: { max: 1200, timeWindow: 60_000 },
  complete: { max: 30, timeWindow: 60_000 },
  read: { max: 600, timeWindow: 60_000 },
} as const;

export function chunkCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

function expectedChunkBytes(row: Pick<UploadSessionRow, 'expected_size' | 'chunk_size'>, n: number): number {
  const count = chunkCount(row.expected_size, row.chunk_size);
  return n === count - 1 ? row.expected_size - row.chunk_size * (count - 1) : row.chunk_size;
}

export function uploadView(row: UploadSessionRow): UploadSessionView {
  return {
    upload_id: row.id,
    status: row.status,
    size: row.expected_size,
    sha256: row.expected_sha256,
    chunk_size: row.chunk_size,
    chunks: chunkCount(row.expected_size, row.chunk_size),
    received: UploadSessionRepo.received(row),
    expires_at: row.expires_at,
    file_id: row.file_id,
  };
}

/** Chunk folders under DATA_DIR/tmp/uploads (one per session). */
export class UploadChunkStore {
  constructor(private readonly root: string) {}

  dirOf(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid upload id');
    return join(this.root, id);
  }

  chunkPath(id: string, n: number): string {
    return join(this.dirOf(id), String(n));
  }

  write(id: string, n: number, body: Buffer): void {
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${n}.${randomBytes(4).toString('hex')}`);
    writeFileSync(tmp, body, { mode: 0o600 });
    const fd = openSync(tmp, 'r+'); // fsync needs a writable handle on Windows (EPERM with 'r'); the same on Linux
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.chunkPath(id, n));
  }

  size(id: string, n: number): number | null {
    try {
      return statSync(this.chunkPath(id, n)).size;
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    rmSync(this.dirOf(id), { recursive: true, force: true });
  }

  /** Folders whose session is not open any more (expired, completed, failed, unknown). */
  sweep(isOpen: (id: string) => boolean): number {
    if (!existsSync(this.root)) return 0;
    let n = 0;
    for (const id of readdirSync(this.root)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || isOpen(id)) continue;
      rmSync(join(this.root, id), { recursive: true, force: true });
      n++;
    }
    return n;
  }
}

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

const notFound = () => new AppError('NOT_FOUND', UPLOAD_LABELS_AR.not_found, 404);

/** `upload_session.target_db` of a session into a subject space (a vault's is its vault id). */
export const spaceUploadTarget = (spaceId: string): string => `s:${spaceId}`;

/** Where the bound request writes: the viewer's own vault, or the subject space a space route bound. */
type UploadTarget = { kind: 'vault'; db: string } | { kind: 'space'; db: string; spaceId: string };

export class UploadService {
  readonly chunks: UploadChunkStore;
  /** completions in progress (a phone that times out on a big file retries «complete» while the first still runs) */
  private readonly completing = new Map<string, Promise<UploadCompleteResponse>>();

  constructor(private readonly ctx: AppContext) {
    this.chunks = new UploadChunkStore(join(ctx.config.tmpDir, 'uploads'));
  }

  private bound(): UploadTarget {
    const b = this.ctx.binding.current();
    if (b?.kind === 'vault') return { kind: 'vault', db: b.vaultId };
    if (b?.kind === 'space' && b.viewer) return { kind: 'space', db: spaceUploadTarget(b.spaceId), spaceId: b.spaceId };
    throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  }

  private own(viewer: Viewer, id: string): UploadSessionRow {
    const row = this.ctx.system.uploads.get(viewer, id);
    if (!row || row.target_db !== this.bound().db) throw notFound();
    return row;
  }

  /**
   * (AOS-2.3) The stored file of the viewer's own COMPLETED session into the bound database — what an official upload
   * `{upload_id}` turns into a version. Another user's, another subject's or a vault session: 404; still open: 409.
   */
  completedFile(viewer: Viewer, id: string): { fileId: string; name: string | null; size: number } {
    const row = this.own(viewer, id);
    if (row.status === 'open') throw new AppError('CONFLICT', UPLOAD_LABELS_AR.not_completed, 409, { status: row.status, received: UploadSessionRepo.received(row).length, chunks: chunkCount(row.expected_size, row.chunk_size) });
    if (row.status !== 'completed' || !row.file_id || !this.ctx.files.stat(row.file_id)) throw notFound();
    return { fileId: row.file_id, name: row.original_name, size: row.expected_size };
  }

  private open(viewer: Viewer, id: string): UploadSessionRow {
    const row = this.own(viewer, id);
    if (row.status === 'open' && row.expires_at <= this.ctx.clock.now()) {
      this.ctx.system.uploads.fail(viewer, id);
      this.chunks.remove(id);
      throw new AppError('CONFLICT', UPLOAD_LABELS_AR.expired, 409, { status: 'expired' });
    }
    if (row.status !== 'open') throw new AppError('CONFLICT', UPLOAD_LABELS_AR.closed, 409, { status: row.status });
    return row;
  }

  start(viewer: Viewer, body: z.infer<typeof createUploadSchema>): UploadSessionView {
    const target = this.bound();
    if (target.kind === 'vault' && body.target !== 'vault') throw new AppError('BAD_REQUEST', UPLOAD_LABELS_AR.space_target, 400);
    if (target.kind === 'space' && (body.target === 'vault' || body.target.space_id !== target.spaceId)) throw new AppError('BAD_REQUEST', UPLOAD_LABELS_AR.space_target_mismatch, 400);
    if (body.size > this.ctx.config.limits.maxUploadBytes) throw new AppError('PAYLOAD_TOO_LARGE', UPLOAD_LABELS_AR.too_large, 413);
    // bytes this database already holds: done at once, nothing is sent again
    const have = this.ctx.db.get<{ id: string }>('SELECT id FROM stored_file WHERE sha256 = ? AND size = ?', [body.sha256, body.size]);
    const resumed = this.ctx.system.uploads.findOpen(viewer, target.db, body.sha256, body.size);
    if (resumed && !have) return uploadView(resumed);
    if (!have) {
      if (target.kind === 'vault') this.ctx.quota.checkStorageForUpload(viewer, target.db, body.size);
      else this.ctx.quota.checkSpaceStorageForUpload(body.size, this.ctx.system.uploads.openBytesToInternal(target.db));
    }
    const row = this.ctx.system.uploads.create(viewer, {
      targetDb: target.db,
      sha256: body.sha256,
      size: body.size,
      chunkSize: this.ctx.config.uploads.chunkBytes,
      mime: body.mime ?? null,
      name: body.name ?? null,
      ttlMs: this.ctx.config.uploads.ttlMs,
    });
    if (have) {
      this.ctx.system.uploads.complete(viewer, row.id, have.id);
      if (resumed) {
        this.ctx.system.uploads.complete(viewer, resumed.id, have.id);
        this.chunks.remove(resumed.id);
      }
      return uploadView(this.ctx.system.uploads.get(viewer, row.id)!);
    }
    return uploadView(row);
  }

  get(viewer: Viewer, id: string): UploadSessionView {
    return uploadView(this.own(viewer, id));
  }

  putChunk(viewer: Viewer, id: string, n: number, body: Buffer, claimedSha: string | undefined): UploadSessionView {
    const row = this.open(viewer, id);
    const count = chunkCount(row.expected_size, row.chunk_size);
    if (n >= count) throw new AppError('VALIDATION_FAILED', UPLOAD_LABELS_AR.chunk_index, 400, { chunks: count });
    if (body.length !== expectedChunkBytes(row, n)) throw new AppError('VALIDATION_FAILED', UPLOAD_LABELS_AR.chunk_size, 400, { expected: expectedChunkBytes(row, n), got: body.length });
    const sha = createHash('sha256').update(body).digest('hex');
    if (!claimedSha || claimedSha.trim().toLowerCase() !== sha) throw new AppError('VALIDATION_FAILED', UPLOAD_LABELS_AR.chunk_hash, 400);
    this.chunks.write(id, n, body);
    return uploadView(this.ctx.system.uploads.addChunk(viewer, id, n, this.ctx.config.uploads.ttlMs));
  }

  /**
   * Assemble and store a session's file. P1-T1 step 2 review: a second «complete» while the first is still assembling
   * (the client timed out on a large recording and retried) waits for that one and gets the same answer, instead of
   * assembling the whole file a second time and failing half-way when the first removes the chunks.
   */
  complete(viewer: Viewer, id: string): Promise<UploadCompleteResponse> {
    this.own(viewer, id); // the viewer's own session (another user's id is simply not found)
    const running = this.completing.get(id);
    if (running) return running;
    const p = this.completeOnce(viewer, id).finally(() => this.completing.delete(id));
    this.completing.set(id, p);
    return p;
  }

  private async completeOnce(viewer: Viewer, id: string): Promise<UploadCompleteResponse> {
    const existing = this.own(viewer, id);
    if (existing.status === 'completed' && existing.file_id) {
      // a repeated «complete» (the answer was lost) answers the same file
      const f = this.ctx.files.stat(existing.file_id);
      if (f) return { file: toFileView(f), deduplicated: true, session: uploadView(existing) };
    }
    const row = this.open(viewer, id);
    const count = chunkCount(row.expected_size, row.chunk_size);
    const missing: number[] = [];
    for (let n = 0; n < count; n++) if (this.chunks.size(id, n) !== expectedChunkBytes(row, n)) missing.push(n);
    if (missing.length) throw new AppError('CONFLICT', UPLOAD_LABELS_AR.missing_chunks(missing.length), 409, { missing: missing.slice(0, 1000) });

    // assemble while hashing; nothing reaches the store unless the WHOLE file is what was announced
    mkdirSync(this.ctx.config.tmpDir, { recursive: true, mode: 0o700 });
    const assembled = join(this.ctx.config.tmpDir, `upload-${id}-${randomBytes(4).toString('hex')}`);
    try {
      const hash = createHash('sha256');
      const out = createWriteStream(assembled, { flags: 'wx', mode: 0o600 });
      for (let n = 0; n < count; n++) {
        const part = readFileSync(this.chunks.chunkPath(id, n)); // one chunk (≤ MEDLEVO_UPLOAD_CHUNK_MB) at a time
        hash.update(part);
        if (!out.write(part)) await once(out, 'drain');
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
      if (hash.digest('hex') !== row.expected_sha256 || statSync(assembled).size !== row.expected_size) {
        this.ctx.system.uploads.fail(viewer, id);
        this.chunks.remove(id);
        throw new AppError('VALIDATION_FAILED', UPLOAD_LABELS_AR.whole_hash, 400);
      }
      const stored = await this.ctx.files.put(createReadStream(assembled), {
        mime: row.mime ?? 'application/octet-stream',
        originalName: row.original_name,
        maxBytes: this.ctx.config.limits.maxUploadBytes,
      });
      this.ctx.system.uploads.complete(viewer, id, stored.id);
      this.chunks.remove(id);
      return { file: toFileView(stored), deduplicated: stored.deduplicated, session: uploadView(this.ctx.system.uploads.get(viewer, id)!) };
    } finally {
      rmSync(assembled, { force: true });
    }
  }

  abandon(viewer: Viewer, id: string): void {
    this.own(viewer, id);
    this.ctx.system.uploads.fail(viewer, id);
    this.chunks.remove(id);
  }

  /** Maintenance: expire sessions past their time and remove chunk folders of closed sessions. */
  cleanup(): { expired: number; folders: number } {
    const expired = this.ctx.system.uploads.expireInternal();
    const open = new Set(this.ctx.system.uploads.openIdsInternal());
    return { expired: expired.length, folders: this.chunks.sweep((id) => open.has(id)) };
  }
}

/** The raw chunk body (application/octet-stream) and its claimed sha256 header of `PUT …/chunks/:n`. */
export function chunkOf(req: FastifyRequest): { body: Buffer; claimed: string | undefined } {
  const body = req.body;
  if (!Buffer.isBuffer(body)) throw new AppError('UNSUPPORTED_FORMAT', 'أرسل الجزء بصيغة application/octet-stream.', 415);
  const claimed = req.headers[UPLOAD_CHUNK_SHA_HEADER];
  return { body, claimed: typeof claimed === 'string' ? claimed : undefined };
}

/** The bytes a chunk request may carry: one chunk plus room for nothing else. */
export const chunkBodyLimit = (ctx: AppContext): number => ctx.config.uploads.chunkBytes + 64 * 1024;

export function registerUploadRoutes(app: FastifyInstance, ctx: AppContext, service: UploadService): void {
  const chunkLimit = chunkBodyLimit(ctx);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: chunkLimit }, (_req, body, done) => done(null, body));

  app.post('/uploads', { config: { rateLimit: UPLOAD_LIMITS.create } }, async (req): Promise<UploadSessionView> => service.start(viewerOf(req), parseBody(createUploadSchema, req)));

  app.get('/uploads/:id', { config: { rateLimit: UPLOAD_LIMITS.read } }, async (req): Promise<UploadSessionView> => service.get(viewerOf(req), parseParams(idParams, req).id));

  app.put('/uploads/:id/chunks/:n', { bodyLimit: chunkLimit, config: { rateLimit: UPLOAD_LIMITS.chunk } }, async (req): Promise<UploadSessionView> => {
    const { id, n } = parseParams(chunkParams, req);
    const { body, claimed } = chunkOf(req);
    return service.putChunk(viewerOf(req), id, n, body, claimed);
  });

  app.post('/uploads/:id/complete', { config: { rateLimit: UPLOAD_LIMITS.complete } }, async (req): Promise<UploadCompleteResponse> => service.complete(viewerOf(req), parseParams(idParams, req).id));

  app.delete('/uploads/:id', { config: { rateLimit: UPLOAD_LIMITS.read } }, async (req) => {
    service.abandon(viewerOf(req), parseParams(idParams, req).id);
    return { ok: true };
  });
}
