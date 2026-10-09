// Helpers for library + sources tests: an app with a STUB processing handler (so enqueue works and
// jobs stay queued — this track never runs the real pipeline), multipart building, fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { PROCESS_JOB_KIND, type LibraryNodeView, type UploadResponse } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import type { ModuleEntry } from '../../src/modules';
import { MODULES } from '../../src/modules';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';

export const GOLDEN = join(REPO_ROOT, 'fixtures', 'golden');
export const LOCAL_FIXTURES = join(REPO_ROOT, 'apps', 'server', 'test', 'sources', 'fixtures');
export const golden = (name: string) => readFileSync(join(GOLDEN, name));
export const localFixture = (name: string) => readFileSync(join(LOCAL_FIXTURES, name));

/** Test-only stand-in for the processing module: registers the job kind, never processes. */
const stubProcessing: ModuleEntry = {
  name: 'processing',
  prefix: '/api/processing',
  plugin: async (_app, { ctx }) => {
    ctx.jobs.register(PROCESS_JOB_KIND, { version: 'test-stub', handler: async () => ({ ok: true }) });
  },
};
const noProcessing: ModuleEntry = { name: 'processing', prefix: '/api/processing', plugin: async () => undefined };

export interface Harness extends TestApp {
  h: AuthHeaders;
}

export async function makeHarness(opts: { processing?: 'stub' | 'none'; env?: Record<string, string> } = {}): Promise<Harness> {
  const modules = MODULES.map((m) => (m.name === 'processing' ? (opts.processing === 'none' ? noProcessing : stubProcessing) : m));
  const t = await createTestApp({ modules, env: opts.env });
  const h = await t.login();
  return Object.assign(t, { h });
}

export interface FilePart {
  name: string;
  data: Buffer;
  contentType?: string;
  field?: string;
}

/** Build a multipart/form-data body (fields first, then files). */
export function multipart(fields: Record<string, string>, files: FilePart[]): { payload: Buffer; contentType: string } {
  const boundary = `----medlevo${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.name}"\r\nContent-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(t: Harness, nodeId: string, files: FilePart[], fields: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  const body = multipart({ node_id: nodeId, ...fields }, files);
  return t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
}

export async function uploadOk(t: Harness, nodeId: string, files: FilePart[], fields: Record<string, string> = {}): Promise<UploadResponse> {
  const res = await upload(t, nodeId, files, fields);
  if (res.statusCode !== 200) throw new Error(`upload failed: ${res.statusCode} ${res.body}`);
  return res.json() as UploadResponse;
}

export async function createNode(t: Harness, body: Record<string, unknown>): Promise<LibraryNodeView> {
  const res = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: t.h, payload: { parent_id: null, kind: 'folder', ...body } });
  if (res.statusCode !== 200) throw new Error(`create node failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { node: LibraryNodeView }).node;
}

export function api(t: Harness) {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    t.app.inject({ method, url, headers: t.h, payload: payload as never });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
    del: (url: string) => call('DELETE', url),
  };
}
