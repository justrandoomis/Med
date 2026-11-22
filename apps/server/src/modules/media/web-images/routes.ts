// Routes of the web reference images, mounted by the media module under /api/media:
//   GET    /web-images/status                    WebImageStatusResponse (server switch, each provider, how to enable)
//   POST   /web-images/search {query, providers?, limit?}   WebImageSearchResponse (409 FEATURE_DISABLED when off)
//   GET    /web-images/thumb?u=&s=               the proxied, cached picture (server-signed URL only)
//   GET    /web-images/refs?source_id=           the owner's reference cards
//   POST   /web-images/refs {result, query?, source_id?, version_id?, page_id?, note?}   pin a signed result
//   DELETE /web-images/refs/:id
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../../context';
import { parseParams, parseQuery } from '../../../lib/http';
import { deriveKey, loadOrCreateServerSecret } from '../../../lib/secret';
import { WebImageService } from './service';

const services = new WeakMap<AppContext, WebImageService>();

/** the process-wide service of this app (tests swap its HTTP layer with useTransport) */
export function webImagesOf(ctx: AppContext): WebImageService {
  let s = services.get(ctx);
  if (!s) {
    s = new WebImageService(ctx, deriveKey(loadOrCreateServerSecret(ctx.config.dataDir), 'web-image-proxy'));
    services.set(ctx, s);
  }
  return s;
}

export function registerWebImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const svc = webImagesOf(ctx);
  const s = svc.status();
  ctx.capabilities.set('external.images', s.state, s.reason_ar);

  app.get('/web-images/status', async () => svc.status());
  app.post('/web-images/search', { config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req) => svc.search(req.body ?? {}));
  app.get('/web-images/thumb', { config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (req, reply) => {
    const q = parseQuery(z.object({ u: z.string().min(8).max(2000), s: z.string().min(8).max(64) }).strict(), req);
    const img = await svc.thumb(q.u, q.s);
    const etag = `"${img.sha}"`;
    reply
      .header('content-type', img.mime)
      .header('cache-control', 'private, max-age=2592000, immutable')
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('referrer-policy', 'no-referrer');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(img.body);
  });
  app.get('/web-images/refs', async (req) => {
    const q = parseQuery(z.object({ source_id: z.string().trim().min(1).max(64).optional() }).strict(), req);
    return { items: svc.listRefs(q) };
  });
  app.post('/web-images/refs', async (req, reply) => {
    reply.code(201);
    return { item: svc.pin(req.body ?? {}) };
  });
  app.delete('/web-images/refs/:id', async (req) => {
    svc.deleteRef(parseParams(z.object({ id: z.string().trim().min(1).max(64) }), req).id);
    return { ok: true };
  });
}
