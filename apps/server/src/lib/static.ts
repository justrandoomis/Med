// Minimal, safe static file serving for the built SPA (production). Only used for non-/api paths.
// Paths are resolved inside the dist directory (no traversal); unknown paths fall back to index.html.
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.traineddata': 'application/octet-stream',
};

export interface StaticSite {
  root: string;
  serve(req: FastifyRequest, reply: FastifyReply): FastifyReply | null;
}

export function createStaticSite(distDir: string): StaticSite | null {
  if (!existsSync(distDir) || !existsSync(resolve(distDir, 'index.html'))) return null;
  const root = realpathSync(distDir);
  const indexPath = resolve(root, 'index.html');

  function send(reply: FastifyReply, file: string, immutable: boolean): FastifyReply {
    const ext = extname(file).toLowerCase();
    reply.header('content-type', MIME[ext] ?? 'application/octet-stream');
    reply.header('x-content-type-options', 'nosniff');
    // index.html & service worker must revalidate so updates are picked up; hashed assets are immutable
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    return reply.send(createReadStream(file));
  }

  return {
    root,
    serve(req, reply) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/');
      } catch {
        return null;
      }
      if (urlPath.includes('\0') || urlPath.startsWith('/api/') || urlPath === '/api') return null;
      const candidate = resolve(root, '.' + urlPath);
      if (candidate.startsWith(root + sep) && existsSync(candidate)) {
        const st = statSync(candidate);
        if (st.isFile()) {
          const real = realpathSync(candidate);
          if (real.startsWith(root + sep)) return send(reply, real, /\/assets\//.test(urlPath));
        }
      }
      // SPA fallback only for navigations (no file extension), so missing assets 404 honestly.
      if (extname(urlPath) === '' || urlPath.endsWith('.html')) return send(reply, indexPath, false);
      return null;
    },
  };
}
