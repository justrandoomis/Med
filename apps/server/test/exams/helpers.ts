// Exams test helpers: the Golden Set question sources + lecture processed by the REAL pipeline (upload → processing
// → questions hook → extraction → matching), an optional TEST-ONLY scripted AI provider whose answers are computed
// from the request (the evidence aliases differ per retrieval), and small API / sync helpers.
import type { AiTask, ExamCreateRequest, ExamCreateResponse, SyncOpResult } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import type { AiProvider, ProviderRequest, ProviderResponse } from '../../src/modules/ai/types';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { createTestApp } from '../helpers/app';
import { createNode, golden, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';

export { questionAt };

// ───────── scripted AI (test-only; never registered in production) ─────────
export type Responder = (req: ProviderRequest) => unknown;

export class ScriptedAi implements AiProvider {
  readonly name = 'scripted-test';
  readonly calls: ProviderRequest[] = [];
  private readonly handlers = new Map<AiTask, Responder>();

  constructor(private readonly supported: AiTask[] | 'all' = 'all') {}

  on(task: AiTask, fn: Responder): this {
    this.handlers.set(task, fn);
    return this;
  }

  off(task: AiTask): this {
    this.handlers.delete(task);
    return this;
  }

  callsFor(task: AiTask): ProviderRequest[] {
    return this.calls.filter((c) => c.task === task);
  }

  supports(task: AiTask): boolean {
    return this.supported === 'all' || this.supported.includes(task);
  }

  modelFor(): string {
    return 'scripted-model-1';
  }

  estimateCostUsd(): number {
    return 0.001;
  }

  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const h = this.handlers.get(req.task);
    if (!h) throw new Error(`ScriptedAi: no handler for ${req.task}`);
    return { json: h(req), model: 'scripted-model-1', usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

/** alias → quote of the evidence blocks in a prompt (`[E1]\n<quote>` inside untrusted blocks). */
export function evidenceIn(prompt: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\[(E\d+)\]\n([\s\S]*?)\n<\/untrusted_content/g;
  for (const m of prompt.matchAll(re)) out.set(m[1]!, m[2]!);
  return out;
}

export function aliasWith(prompt: string, needle: string): string {
  for (const [alias, quote] of evidenceIn(prompt)) if (quote.toLowerCase().includes(needle.toLowerCase())) return alias;
  throw new Error(`no evidence alias containing «${needle}» in the prompt: ${[...evidenceIn(prompt).values()].map((q) => q.slice(0, 60)).join(' | ')}`);
}

/** verify_support: every claim index in the prompt «supported». */
export function allSupported(req: ProviderRequest): unknown {
  const idx = [...req.prompt.matchAll(/CLAIM \[(\d+)\]/g)].map((m) => Number(m[1]));
  return { results: [...new Set(idx)].map((index) => ({ index, verdict: 'supported', reason: 'مدعومة' })) };
}

// ───────── app ─────────
export interface ExamApp extends QApp {
  course: string;
  qs: { sourceId: string; versionId: string };
  prev: { sourceId: string; versionId: string };
  lecture: { sourceId: string; versionId: string };
}

export async function createExamApp(opts: { ai?: AiProvider | null; lecture?: boolean } = {}): Promise<ExamApp> {
  const t = await createTestApp({
    ai: opts.ai ?? null,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
  const h = await t.login();
  const q = Object.assign(t, { h }) as QApp;
  const course = (await createNode(q, 'Surgery Course 1')).id;
  const qs = await uploadAndProcess(q, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  const prev = await uploadAndProcess(q, course, 'questions_previous_exam_2024.pdf', golden('questions_previous_exam_2024.pdf'), 'previous_exam', 'Previous exam 2024');
  const lecture =
    opts.lecture === false
      ? { sourceId: '', versionId: '' }
      : await uploadAndProcess(q, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis (TEST FIXTURE)');
  await t.ctx.jobs.drain();
  return Object.assign(q, { course, qs, prev, lecture });
}

export function api(t: QApp) {
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => t.app.inject({ method, url, headers: t.h, payload: payload as never });
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload: unknown = {}) => call('POST', url, payload),
    patch: (url: string, payload: unknown) => call('PATCH', url, payload),
  };
}

export async function createExam(t: QApp, req: Partial<ExamCreateRequest> & Pick<ExamCreateRequest, 'mode' | 'count'>): Promise<ExamCreateResponse> {
  const res = await api(t).post('/api/exams', { title: '', ...req });
  if (res.statusCode !== 200) throw new Error(`create exam failed: ${res.statusCode} ${res.body}`);
  return res.json() as ExamCreateResponse;
}

export const DEVICE = 'device-test-1';

export async function push(t: QApp, ops: Array<{ entity_type: string; entity_id: string; op: 'upsert' | 'append' | 'delete'; payload: unknown; op_id?: string }>): Promise<SyncOpResult[]> {
  const res = await api(t).post('/api/sync/push', { ops: ops.map((o) => ({ op_id: o.op_id ?? newId(), device_id: DEVICE, client_ts: t.ctx.clock.now(), ...o })) });
  if (res.statusCode !== 200) throw new Error(`push failed: ${res.statusCode} ${res.body}`);
  return (res.json() as { results: SyncOpResult[] }).results;
}

/** A page of a version by 0-based index. */
export function pageId(t: QApp, versionId: string, index: number): string {
  const r = t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = ?', [versionId, index]);
  if (!r) throw new Error(`no page ${index}`);
  return r.id;
}
