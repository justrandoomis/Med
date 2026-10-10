// Shared setup of the G8 acceptance tests (AC-26, AC-27, security sweep): a test app with the REAL processing pipeline
// whose module plugins record every route they register (so «every /api route» is the real, complete list — not a
// hand-written one), a local HTTP trap that records any request the server makes to it, and small API helpers.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { UploadResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { MODULES, type ModuleEntry } from '../../src/modules';
import type { AiProvider } from '../../src/modules/ai/types';
import { createProcessingModule } from '../../src/modules/processing';
import { createTestApp } from '../helpers/app';
import type { QApp } from '../questions/helpers';
import { multipart } from '../sources/helpers';

export const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
export const GOLDEN = join(REPO_ROOT, 'fixtures', 'golden');
export const acc = (name: string) => readFileSync(join(ACC, name));
export const gold = (name: string) => readFileSync(join(GOLDEN, name));

export interface RouteDef {
  method: string;
  url: string;
}

export interface G8App extends QApp {
  routes: RouteDef[];
}

/** Every module plugin is wrapped so that an onRoute hook (inside its own context) records the routes it adds. */
export async function g8App(opts: { env?: Record<string, string>; ai?: AiProvider | null } = {}): Promise<G8App> {
  const routes: RouteDef[] = [{ method: 'GET', url: '/api/health' }, { method: 'HEAD', url: '/api/health' }];
  const modules: ModuleEntry[] = MODULES.map((m) => {
    const plugin = m.name === 'processing' ? createProcessingModule({}) : m.plugin;
    const wrapped = (async (app: FastifyInstance, o: never) => {
      app.addHook('onRoute', (r) => {
        for (const method of Array.isArray(r.method) ? r.method : [r.method]) routes.push({ method: String(method), url: r.url });
      });
      await (plugin as (a: FastifyInstance, o: never) => Promise<void>)(app, o);
    }) as unknown as ModuleEntry['plugin'];
    return { ...m, plugin: wrapped };
  });
  const t = await createTestApp({ modules, env: opts.env, ai: opts.ai, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
  const h = await t.login();
  return Object.assign(t, { h, routes });
}

/** A URL for a route pattern: every :param gets a well-formed but unknown id. */
export function concreteUrl(pattern: string): string {
  return pattern
    .replace(/:token\b/g, 'x'.repeat(48))
    .replace(/:[A-Za-z_]+/g, '01JZZZZZZZZZZZZZZZZZZZZZZZ')
    .replace(/\*/g, 'x');
}

export interface Trap {
  port: number;
  hits: string[];
  close(): Promise<void>;
}

/** A local HTTP server that records every request made to it (and answers 404). */
export async function startTrap(): Promise<Trap> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { port, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Upload through the real sources API (content sniffing, limits, processing job). Does not run the jobs. */
export async function uploadRaw(t: QApp, nodeId: string, name: string, data: Buffer, sourceType?: string): Promise<{ status: number; body: UploadResponse & { error?: { code: string; message: string } } }> {
  const fields: Record<string, string> = { node_id: nodeId, on_duplicate: 'create' };
  if (sourceType) fields.source_type = sourceType;
  const body = multipart(fields, [{ name, data }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  return { status: res.statusCode, body: res.json() };
}
