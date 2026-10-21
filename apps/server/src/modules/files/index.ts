// Private file routes.
//   GET  /api/files/:id          — owner session required; Range support; inline; nosniff; private cache
//   POST /api/files/:id/token    — owner session; returns a short-lived signed URL
//   GET  /api/files/t/:token     — no session; the HMAC-signed, short-lived token is the credential. It names the database
//                                  it was issued in (and the user); the route binds exactly that database (P1-T1)
//   /api/files/uploads…          — chunked, resumable uploads (P1-T1 step 2, ./uploads.ts)
// Background (P1-T1 step 2; only in a server that listens): a mark pass at boot (rebuilds the blob hints — after any
// restore), the daily mark-and-sweep GC (MEDLEVO_BLOB_GC_SCHEDULE), expiry of upload sessions, and — with
// MEDLEVO_BLOB_STORE=r2 — the copy of new blobs to the object store.
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FileTokenResponse, StoredFileView } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams } from '../../lib/http';
import { lastSlotAt } from '../data/offsite-schedule';
import { type FileStore, type StoredFile, toFileView } from './store';
import { registerUploadRoutes, UploadService } from './uploads';

export { FileStore, type StoredFile, type PutOptions, type PutResult, normalizeMime, toFileView } from './store';

/** Types a browser could execute as active content when opened directly → force download. */
const ACTIVE_CONTENT = new Set(['text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript']);

export interface ByteRange {
  start: number;
  end: number;
}

/** Parse a single `bytes=` range. Returns null (serve full), 'unsatisfiable', or the range. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed → ignore (RFC 9110 allows serving the full body)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function contentDisposition(kind: 'inline' | 'attachment', name: string | null): string {
  if (!name) return kind;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * HEAD: keep the real Content-Length. Fastify's automatic HEAD handler rewrites Content-Length to 0
 * for an empty payload but leaves it alone for a stream, so send an empty stream (no file I/O).
 */
function sendHead(reply: FastifyReply): FastifyReply {
  return reply.send(Readable.from([]));
}

export function sendStoredFile(store: FileStore, file: StoredFile, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const etag = `"${file.sha256}"`;
  const active = ACTIVE_CONTENT.has(file.mime);
  reply.header('content-type', active ? 'application/octet-stream' : file.mime);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-disposition', contentDisposition(active ? 'attachment' : 'inline', file.original_name));
  // content-addressed → immutable; private: never stored by shared caches
  reply.header('cache-control', 'private, max-age=31536000, immutable');
  reply.header('etag', etag);
  reply.header('accept-ranges', 'bytes');

  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) return reply.code(304).send();

  // If-Range: only honor Range when the validator matches
  const ifRange = req.headers['if-range'];
  const rangeHeader = ifRange && ifRange !== etag ? undefined : req.headers.range;
  const range = parseRange(rangeHeader, file.size);
  if (range === 'unsatisfiable') {
    reply.header('content-range', `bytes */${file.size}`);
    return reply.code(416).send();
  }
  if (range) {
    reply.code(206);
    reply.header('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
    reply.header('content-length', String(range.end - range.start + 1));
    if (req.method === 'HEAD') return sendHead(reply);
    return reply.send(store.createReadStream(file.id, range));
  }
  reply.header('content-length', String(file.size));
  if (req.method === 'HEAD') return sendHead(reply);
  if (file.size === 0) return reply.send('');
  return reply.send(store.createReadStream(file.id));
}

const idParams = z.object({ id: z.string().min(1).max(64) });
const tokenParams = z.object({ token: z.string().min(10).max(512) });
const tokenBody = z.object({ ttl_seconds: z.number().int().min(10).max(3600).optional() }).optional();

/** Background upkeep of the blob store (root context; one tick a minute). */
export class FileMaintenance {
  private first: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly ctx: ModuleOptions['ctx'],
    private readonly uploads: UploadService,
    private readonly o: { firstTickMs?: number; tickMs?: number } = {},
  ) {}

  /** One maintenance step (tests call it directly). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.uploads.cleanup();
      if (this.ctx.blobs.objectStore) await this.ctx.blobs.replicatePending();
      const schedule = this.ctx.config.blobGc.schedule;
      if (schedule && !this.ctx.gc.isRunning) {
        const slot = lastSlotAt(this.ctx.clock.now(), schedule, this.ctx.config.timezone);
        const last = this.ctx.system.blobs.lastSweepsInternal(20).find((s) => s.kind === 'sweep');
        if (!last || last.started_at < slot) await this.ctx.gc.run('sweep');
      }
    } catch (e) {
      this.ctx.log.warn({ err: e }, 'file maintenance tick failed');
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.first || this.timer) return;
    this.ctx.binding.runRoot(() => {
      this.first = setTimeout(() => {
        this.first = null;
        // a mark pass first: rebuilds every hint (the data directory may come from a restore)
        void this.ctx.gc.run('mark').then(() => this.tick());
        this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 60_000);
        this.timer.unref();
      }, this.o.firstTickMs ?? 30_000);
      this.first.unref();
    });
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }
}

export default async function filesModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;
  const uploads = new UploadService(ctx);
  registerUploadRoutes(app, ctx, uploads);
  const maintenance = new FileMaintenance(ctx, uploads);
  app.addHook('onListen', async () => maintenance.start());
  app.addHook('onClose', async () => {
    maintenance.stop();
    await ctx.blobs.settled();
  });

  const notFound = () => new AppError('NOT_FOUND', 'الملف غير موجود أو لم يعد متاحًا.', 404);

  app.get('/t/:token', async (req, reply) => {
    const { token } = parseParams(tokenParams, req);
    const v = ctx.files.verifyToken(token);
    const invalid = () => new AppError('FORBIDDEN', 'رابط الملف منتهي الصلاحية أو غير صالح. افتح الملف من التطبيق مرة أخرى.', 403);
    if (!v) throw invalid();
    const binding = ctx.tenancy.bindingForFileToken(v.db, v.userId);
    if (!binding) throw invalid();
    return ctx.binding.run(binding, () => {
      const file = ctx.files.stat(v.fileId);
      if (!file) throw notFound();
      return sendStoredFile(ctx.files, file, req, reply);
    });
  });

  app.get('/:id/meta', async (req): Promise<StoredFileView> => {
    const { id } = parseParams(idParams, req);
    const file = ctx.files.stat(id);
    if (!file) throw notFound();
    return toFileView(file);
  });

  app.get('/:id', async (req, reply) => {
    const { id } = parseParams(idParams, req);
    const file = ctx.files.stat(id);
    if (!file) throw notFound();
    return sendStoredFile(ctx.files, file, req, reply);
  });

  app.post('/:id/token', async (req): Promise<FileTokenResponse> => {
    const { id } = parseParams(idParams, req);
    const body = parseBody(tokenBody, req) ?? {};
    const file = ctx.files.stat(id);
    if (!file) throw notFound();
    const { token, expiresAt } = ctx.files.createToken(id, (body.ttl_seconds ?? 300) * 1000);
    return { token, url: `/api/files/t/${token}`, expires_at: expiresAt };
  });
}
