// JSON response compression (AOS-21.12 / NFR-P3, ADR-0004 §2.5): packed ink points travel as base64 inside JSON (+33 %),
// so a 5,000-stroke page is over the 8 MB on-the-wire budget unless JSON responses are compressed. A JSON answer of
// 1 KiB or more is sent br- or gzip-encoded when the request accepts it (br first: it is the smaller of the two);
// everything else (files, Range answers, streams, server-sent events, small answers, a client that accepts neither) is
// sent exactly as before. `Vary: Accept-Encoding` tells caches the body depends on the header.
import { promisify } from 'node:util';
import { brotliCompress, constants as zc, gzip } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const COMPRESS_MIN_BYTES = 1024;
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** The encoding to use for this Accept-Encoding header (q-values honoured; q=0 refuses), or null. */
export function pickEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const v = qp ? Number(qp.slice(2)) : 1;
    q.set(name.trim(), Number.isFinite(v) ? v : 0);
  }
  const ok = (name: 'br' | 'gzip') => (q.has(name) ? q.get(name)! > 0 : q.has('*') && q.get('*')! > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

function addVary(reply: FastifyReply): void {
  const vary = String(reply.getHeader('vary') ?? '');
  if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
}

export function registerJsonCompression(app: FastifyInstance): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (req.method === 'HEAD' || reply.hasHeader('content-encoding') || reply.statusCode === 206 || reply.statusCode === 204) return payload;
    if (!String(reply.getHeader('content-type') ?? '').toLowerCase().startsWith('application/json')) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload; // a stream: sent as it is
    const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
    if (size < COMPRESS_MIN_BYTES) return payload;
    addVary(reply);
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return payload;
    const body =
      enc === 'br'
        ? await brotli(payload, { params: { [zc.BROTLI_PARAM_QUALITY]: 4, [zc.BROTLI_PARAM_SIZE_HINT]: size, [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT } })
        : await gz(payload, { level: 6 });
    reply.header('content-encoding', enc);
    reply.removeHeader('content-length');
    return body;
  });
}
