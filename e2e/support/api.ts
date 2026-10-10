// API helpers for E2E tests: an authenticated client bound to a Playwright APIRequestContext (the page's
// `page.request` shares the browser's session cookie), plus fixture upload and processing waits.
// Types only come from @medlevo/shared (erased at runtime — the harness never imports app code).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type {
  JobView,
  LibraryNodeView,
  ProcessingStatusResponse,
  SourceDetail,
  SourceType,
  UploadFileResult,
  UploadResponse,
} from '@medlevo/shared';
import { GOLDEN_DIR } from './paths';

/** every mutating /api request must carry this header (ARCHITECTURE §3.1 CSRF) */
export const CSRF_HEADERS = { 'x-medlevo-csrf': '1' } as const;

export const TERMINAL_JOB_STATES: ReadonlyArray<JobView['status']> = ['completed', 'partial', 'failed', 'cancelled', 'waiting_for_input'];

export class ApiCallError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} → ${status}: ${body.slice(0, 600)}`);
    this.name = 'ApiCallError';
  }
}

export interface UploadedFixture extends UploadFileResult {
  status: 'accepted';
  source_id: string;
  version_id: string;
}

export interface UploadOptions {
  sourceType?: SourceType;
  title?: string;
  /** 'create' stores identical bytes again as a separate source (default: the server answers `duplicate`) */
  onDuplicate?: 'create';
}

export interface WaitForProcessingOptions {
  timeoutMs?: number;
  /** also wait for the question-extraction job of a question source / previous exam (when one is queued) */
  questions?: boolean;
}

export interface ProcessingResult extends ProcessingStatusResponse {
  extraction: { job: JobView | null; summary: unknown } | null;
}

export interface NotebookAndCourse {
  notebook: LibraryNodeView;
  course: LibraryNodeView;
}

export interface E2eApi {
  readonly request: APIRequestContext;
  /** raw call (never throws on HTTP status) */
  call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<APIResponse>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, data?: unknown): Promise<T>;
  patch<T = unknown>(path: string, data?: unknown): Promise<T>;
  put<T = unknown>(path: string, data?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  /** upload one Golden Set fixture (fixtures/golden/<fileName>) into a library node; must be accepted */
  uploadFixture(nodeId: string, fileName: string, opts?: UploadOptions): Promise<UploadedFixture>;
  /** poll until the processing job of this version is in a terminal state (and, optionally, question extraction) */
  waitForProcessing(versionId: string, opts?: WaitForProcessingOptions): Promise<ProcessingResult>;
  /** a notebook with a course inside it (unique titles unless given) */
  createNotebookAndCourse(opts?: { notebookTitle?: string; courseTitle?: string }): Promise<NotebookAndCourse>;
  source(sourceId: string): Promise<SourceDetail>;
}

async function parse<T>(method: string, path: string, res: APIResponse): Promise<T> {
  const text = await res.text();
  if (!res.ok()) throw new ApiCallError(method, path, res.status(), text);
  return (text ? JSON.parse(text) : null) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An API client acting as the signed-in owner of `request`'s cookie jar, with the CSRF header on every call. */
export function apiAs(request: APIRequestContext): E2eApi {
  const call: E2eApi['call'] = (method, path, data) =>
    request.fetch(path, {
      method,
      headers: { ...CSRF_HEADERS },
      ...(data === undefined ? {} : { data }),
    });
  const json =
    (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE') =>
    async <T>(path: string, data?: unknown): Promise<T> =>
      parse<T>(method, path, await call(method, path, data));

  const api: E2eApi = {
    request,
    call,
    get: (path) => json('GET')(path),
    post: (path, data) => json('POST')(path, data ?? {}),
    patch: (path, data) => json('PATCH')(path, data ?? {}),
    put: (path, data) => json('PUT')(path, data ?? {}),
    del: (path) => json('DELETE')(path),

    async uploadFixture(nodeId, fileName, opts = {}) {
      const buffer = readFileSync(join(GOLDEN_DIR, fileName));
      const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = { node_id: nodeId };
      if (opts.sourceType) multipart.source_type = opts.sourceType;
      if (opts.title) multipart.title = opts.title;
      if (opts.onDuplicate) multipart.on_duplicate = opts.onDuplicate;
      multipart.files = { name: fileName, mimeType: 'application/octet-stream', buffer };
      const res = await request.post('/api/sources/upload', { headers: { ...CSRF_HEADERS }, multipart });
      const body = await parse<UploadResponse>('POST', '/api/sources/upload', res);
      const result = body.results[0];
      if (!result || result.status !== 'accepted' || !result.source_id || !result.version_id) {
        throw new Error(`upload of ${fileName} was not accepted: ${JSON.stringify(result)}`);
      }
      return result as UploadedFixture;
    },

    async waitForProcessing(versionId, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
      let status: ProcessingStatusResponse | null = null;
      for (;;) {
        status = await api.get<ProcessingStatusResponse>(`/api/sources/versions/${versionId}/processing`);
        if (status.job && TERMINAL_JOB_STATES.includes(status.job.status)) break;
        if (Date.now() > deadline) throw new Error(`processing of version ${versionId} did not finish in time: ${JSON.stringify(status)}`);
        await sleep(500);
      }
      let extraction: ProcessingResult['extraction'] = null;
      if (opts.questions) {
        for (;;) {
          const ex = await api.get<{ job: JobView | null; summary: unknown }>(`/api/questions/extractions/${versionId}`);
          extraction = ex;
          if (ex.job && TERMINAL_JOB_STATES.includes(ex.job.status)) break;
          if (Date.now() > deadline) throw new Error(`question extraction of version ${versionId} did not finish in time: ${JSON.stringify(ex)}`);
          await sleep(500);
        }
      }
      return { ...status, extraction };
    },

    async createNotebookAndCourse(opts = {}) {
      const stamp = Date.now().toString(36);
      const { node: notebook } = await api.post<{ node: LibraryNodeView }>('/api/library/nodes', {
        parent_id: null,
        kind: 'notebook',
        title: opts.notebookTitle ?? `الجراحة ${stamp}`,
        cover: { style: 'linen', color: 'rose', symbol: 'book' },
      });
      const { node: course } = await api.post<{ node: LibraryNodeView }>('/api/library/nodes', {
        parent_id: notebook.id,
        kind: 'course',
        title: opts.courseTitle ?? `Course 1 — البطن الحاد ${stamp}`,
      });
      return { notebook, course };
    },

    source: (sourceId) => api.get<SourceDetail>(`/api/sources/${sourceId}`),
  };
  return api;
}
