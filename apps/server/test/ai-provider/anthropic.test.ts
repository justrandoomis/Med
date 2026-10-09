// Anthropic adapter (ADR-0002) against a MOCKED HTTP layer: no network, no real key. Covers request shaping
// (model per task, structured output schema, vision blocks, effort, server-side fallback, no tools/sampling),
// SSE parsing, usage → estimated cost, provider request ids, error mapping, refusal/truncation, bounded retries,
// abort/timeout, and the orchestrator integration (usage_record rows, Arabic reasons, budget ceiling).
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ResolvedScope } from '@medlevo/shared';
import { loadConfig } from '../../src/config';
import { AnthropicProvider, createProviderFromConfig, priceFor, toStructuredOutputSchema } from '../../src/modules/ai/providers';
import { ProviderError, type ProviderRequest } from '../../src/modules/ai/types';
import { createTestApp, type TestApp } from '../helpers/app';

const FAKE_KEY = 'sk-ant-test-not-a-real-key-000';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply =
  | { kind: 'sse'; text: string; model?: string; stop?: string; usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; requestId?: string }
  | { kind: 'error'; status: number; type: string; requestId?: string; headers?: Record<string, string> }
  | { kind: 'throw'; error: Error };

function sse(r: Extract<Reply, { kind: 'sse' }>): string {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const u = r.usage ?? { input: 1200, output: 300 };
  const parts = [
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: r.model ?? 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: u.input, output_tokens: 1, cache_creation_input_tokens: u.cacheWrite ?? 0, cache_read_input_tokens: u.cacheRead ?? 0 },
      },
    }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  // split the text into a few deltas (the stream accumulates them)
  const chunks = r.text.match(/[\s\S]{1,17}/g) ?? [''];
  for (const c of chunks) parts.push(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }));
  parts.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
  parts.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: r.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output } }));
  parts.push(ev('message_stop', { type: 'message_stop' }));
  return parts.join('');
}

function mockFetch(replies: Reply[]) {
  const calls: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) });
    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    const r = replies.shift();
    if (!r) throw new Error('mockFetch: no reply left');
    if (r.kind === 'throw') throw r.error;
    if (r.kind === 'error') {
      return new Response(JSON.stringify({ type: 'error', error: { type: r.type, message: 'upstream detail that must never reach the owner' }, request_id: r.requestId }), {
        status: r.status,
        headers: { 'content-type': 'application/json', ...(r.requestId ? { 'request-id': r.requestId } : {}), 'retry-after-ms': '1', ...(r.headers ?? {}) },
      });
    }
    return new Response(sse(r), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': r.requestId ?? 'req_test_1' } });
  };
  return { fn: fn as typeof fetch, calls };
}

const outSchema = z.object({
  title: z.string().min(1).max(200),
  level: z.enum(['simple', 'detailed']),
  items: z.array(z.object({ text: z.string(), n: z.number().int().min(0) })).min(2),
  note: z.string().nullable(),
});

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    task: 'explain',
    model: 'claude-opus-5-5',
    system: 'SYSTEM PROMPT',
    prompt: 'USER PROMPT with <untrusted_content>…</untrusted_content>',
    jsonSchema: z.toJSONSchema(outSchema) as Record<string, unknown>,
    maxOutputTokens: 4000,
    signal: new AbortController().signal,
    ...over,
  };
}

const VALID = { title: 'شرح', level: 'simple', items: [{ text: 'a', n: 1 }, { text: 'b', n: 2 }], note: null };

describe('Anthropic adapter — request shaping', () => {
  it('builds a streaming Messages request with structured output, effort, fallback, no tools or sampling params', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID) }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
    const res = await p.generateStructured(request());
    expect(res.json).toEqual(VALID);
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(c.url).toMatch(/\/v1\/messages(\?beta=true)?$/);
    expect(c.headers['x-api-key']).toBe(FAKE_KEY);
    expect(c.headers['authorization']).toBeUndefined();
    expect(c.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    const b = c.body;
    expect(b).toMatchObject({ model: 'claude-opus-5-5', stream: true, system: 'SYSTEM PROMPT', fallbacks: 'default', max_tokens: 4000 + 16_000 });
    expect(b).not.toHaveProperty('tools');
    expect(b).not.toHaveProperty('temperature');
    expect(b).not.toHaveProperty('top_p');
    expect(b).not.toHaveProperty('thinking'); // adaptive by default on Opus 5.5; never "disabled"/budget_tokens
    expect(b).not.toHaveProperty('betas'); // sent as a header, not in the body
    const oc = b.output_config as { effort: string; format: { type: string; schema: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(oc.effort).toBe('high');
    expect(oc.format.type).toBe('json_schema');
    const s = oc.format.schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.$schema).toBeUndefined();
    expect(s.properties.level.enum).toEqual(['simple', 'detailed']); // enums are kept
    expect(s.properties.title.minLength).toBeUndefined(); // unsupported constraints move to the description
    expect(s.properties.title.description).toContain('minLength: 1');
    expect(s.properties.items.items.additionalProperties).toBe(false);
    expect(s.properties.items.minItems).toBeUndefined();
    expect(s.properties.items.description).toContain('minItems: 2');
    const msgs = b.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toEqual([{ type: 'text', text: 'USER PROMPT with <untrusted_content>…</untrusted_content>' }]);
  });

  it('sends vision crops as base64 image blocks before the text and uses the vision model', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID), model: 'claude-sonnet-5-5' }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0, models: { vision: 'claude-sonnet-5-5' } });
    expect(p.modelFor('vision_figure')).toBe('claude-sonnet-5-5');
    expect(p.modelFor('explain')).toBe('claude-opus-5-5');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const res = await p.generateStructured(request({ task: 'vision_figure', model: p.modelFor('vision_figure'), images: [{ mime: 'image/png', data: png }] }));
    expect(res.model).toBe('claude-sonnet-5-5');
    const content = (m.calls[0]!.body.messages as Array<{ content: Array<Record<string, any>> }>)[0]!.content; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } });
    expect(content[1]!.type).toBe('text');
    // a non-image payload is refused before any HTTP call
    await expect(p.generateStructured(request({ task: 'vision_figure', images: [{ mime: 'application/pdf', data: png }] }))).rejects.toMatchObject({ kind: 'bad_request' });
    expect(m.calls).toHaveLength(1);
  });

  it('per-task models from overrides; verification is a separate role; effort/fallback only where the model accepts them', async () => {
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, models: { generation: 'claude-opus-5-5', verification: 'claude-haiku-5-5', vision: null } });
    expect(p.modelFor('verify_support')).toBe('claude-haiku-5-5');
    expect(p.modelFor('validate_question')).toBe('claude-haiku-5-5');
    expect(p.modelFor('vision_figure')).toBe('claude-opus-5-5');
    const haiku = p.buildParams(request({ task: 'verify_support', model: 'claude-haiku-5-5' }));
    expect(haiku.fallbacks).toBeUndefined(); // Haiku 5.5 has no server-side fallback
    expect(haiku.output_config?.effort).toBe('high');
    const old = p.buildParams(request({ model: 'claude-haiku-4-5' }));
    expect(old.output_config?.effort).toBeUndefined(); // effort is a 400 on Haiku 4.5
    expect(old.fallbacks).toBeUndefined();
    expect(p.buildParams(request({ task: 'classify' })).output_config?.effort).toBe('low');
    // no embeddings / transcription in the Messages API → honestly unsupported
    expect(p.supports('embed')).toBe(false);
    expect(p.supports('transcribe')).toBe(false);
    expect(p.supports('vision_figure')).toBe(true);
    // a schema with a record (additionalProperties ≠ false) cannot be expressed → prompt-only JSON
    const rec = p.buildParams(request({ jsonSchema: z.toJSONSchema(z.object({ m: z.record(z.string(), z.number()) })) as Record<string, unknown> }));
    expect(rec.output_config?.format).toBeUndefined();
    expect(() => toStructuredOutputSchema(z.toJSONSchema(z.object({ m: z.record(z.string(), z.string()) })) as Record<string, unknown>)).toThrow();
  });
});

describe('Anthropic adapter — responses, usage and cost', () => {
  it('returns parsed JSON, the served model, the request id and usage incl. cache tokens', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID), usage: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 100 }, requestId: 'req_abc123' }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
    const res = await p.generateStructured(request());
    expect(res).toMatchObject({ model: 'claude-opus-5-5', requestRef: 'req_abc123', usage: { inputTokens: 1600, outputTokens: 2000, cacheReadInputTokens: 500, cacheCreationInputTokens: 100 } });
    // $4 / $20 per 1M (Opus 5.5), cache read $0.20, cache write 1.25 × input — an ESTIMATE
    const expected = (1000 * 4 + 100 * 4 * 1.25 + 500 * 0.2 + 2000 * 20) / 1e6;
    expect(p.estimateCostUsd('claude-opus-5-5', res.usage)).toBeCloseTo(expected, 8);
  });

  it('non-JSON text is handed to the orchestrator as text (its single repair attempt decides)', async () => {
    const m = mockFetch([{ kind: 'sse', text: 'Sure! ```json\n{"x":1}\n```' }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
    const res = await p.generateStructured(request());
    expect(res.json).toBeUndefined();
    expect(res.text).toContain('{"x":1}');
  });

  it('prices: exact, dated id prefix, Haiku 5.5 long-prompt rates, unknown model at the highest rate', () => {
    expect(priceFor('claude-sonnet-5-5')).toMatchObject({ known: true, price: { input: 2, output: 10 } });
    expect(priceFor('claude-opus-5-5-20270101')).toMatchObject({ known: true, price: { input: 4 } });
    expect(priceFor('claude-opus-5')).toMatchObject({ price: { input: 5 } }); // not confused with opus-5-5
    expect(priceFor('some-future-model')).toMatchObject({ known: false, price: { input: 10, output: 50 } });
    const p = new AnthropicProvider({ apiKey: FAKE_KEY });
    expect(p.estimateCostUsd('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo((1000 * 0.1 + 1000 * 0.5) / 1e6, 10);
    expect(p.estimateCostUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1000 })).toBeCloseTo((200_000 * 0.5 + 1000 * 2.5) / 1e6, 10);
    expect(p.outputTokenCeiling('explain', 4000)).toBe(20_000);
    expect(p.outputTokenCeiling('classify', 500)).toBe(4_500);
    expect(p.outputTokenCeiling('study_book', 127_000)).toBe(128_000);
  });

  it('refusal and truncation are errors (partial output is never returned) and carry the billed usage', async () => {
    const m = mockFetch([
      { kind: 'sse', text: '{"title":"par', stop: 'refusal', requestId: 'req_refused' },
      { kind: 'sse', text: '{"title":"cut', stop: 'max_tokens', requestId: 'req_cut', usage: { input: 10, output: 20_000 } },
    ]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
    const e1 = await p.generateStructured(request()).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ProviderError);
    expect(e1).toMatchObject({ kind: 'refusal', requestRef: 'req_refused', retryable: false });
    const e2 = (await p.generateStructured(request()).catch((e: unknown) => e)) as ProviderError;
    expect(e2).toMatchObject({ kind: 'truncated', requestRef: 'req_cut', usage: { outputTokens: 20_000 } });
  });
});

describe('Anthropic adapter — error mapping, retries, abort', () => {
  it('maps HTTP failures to classified ProviderErrors with the request id (no upstream text)', async () => {
    const cases: Array<[number, string, string, boolean]> = [
      [401, 'authentication_error', 'auth', false],
      [403, 'permission_error', 'permission', false],
      [404, 'not_found_error', 'not_found', false],
      [400, 'invalid_request_error', 'bad_request', false],
      [413, 'request_too_large', 'too_large', false],
      [429, 'rate_limit_error', 'rate_limited', true],
      [529, 'overloaded_error', 'overloaded', true],
      [500, 'api_error', 'overloaded', true],
    ];
    for (const [status, type, kind, retryable] of cases) {
      const m = mockFetch([{ kind: 'error', status, type, requestId: `req_${status}` }]);
      const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
      const e = (await p.generateStructured(request()).catch((x: unknown) => x)) as ProviderError;
      expect(e, `status ${status}`).toBeInstanceOf(ProviderError);
      expect(e).toMatchObject({ kind, retryable, status, requestRef: `req_${status}` });
      expect(e.message).not.toContain('upstream detail');
    }
    const net = mockFetch([{ kind: 'throw', error: new TypeError('fetch failed') }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: net.fn, maxRetries: 0 });
    await expect(p.generateStructured(request())).rejects.toMatchObject({ kind: 'connection', retryable: true });
  });

  it('retries 429 / 529 a bounded number of times (SDK retries), then succeeds or gives up', async () => {
    const ok = mockFetch([
      { kind: 'error', status: 429, type: 'rate_limit_error' },
      { kind: 'error', status: 529, type: 'overloaded_error' },
      { kind: 'sse', text: JSON.stringify(VALID) },
    ]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: ok.fn, maxRetries: 2 });
    await expect(p.generateStructured(request())).resolves.toMatchObject({ json: VALID });
    expect(ok.calls).toHaveLength(3);
    const fail = mockFetch([
      { kind: 'error', status: 529, type: 'overloaded_error' },
      { kind: 'error', status: 529, type: 'overloaded_error' },
      { kind: 'sse', text: JSON.stringify(VALID) },
    ]);
    const p1 = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: fail.fn, maxRetries: 1 });
    await expect(p1.generateStructured(request())).rejects.toMatchObject({ kind: 'overloaded' });
    expect(fail.calls).toHaveLength(2); // 1 + maxRetries, never unbounded
  });

  it('a caller abort propagates unchanged; a timeout abort is classified as timeout', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID) }, { kind: 'sse', text: JSON.stringify(VALID) }]);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 });
    const ac = new AbortController();
    ac.abort(new Error('job cancelled'));
    const e = await p.generateStructured(request({ signal: ac.signal })).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(ProviderError);
    const tc = new AbortController();
    tc.abort(new DOMException('timed out', 'TimeoutError'));
    await expect(p.generateStructured(request({ signal: tc.signal }))).rejects.toMatchObject({ kind: 'timeout', retryable: true });
  });
});

describe('factory and secrets', () => {
  it('returns null without ANTHROPIC_API_KEY and an Anthropic provider with it; the key never serializes', () => {
    const none = loadConfig({ NODE_ENV: 'test', MEDLEVO_DATA_DIR: '/tmp/medlevo-x', MEDLEVO_ORIGIN: 'http://localhost:5173' });
    expect(createProviderFromConfig(none)).toBeNull();
    const cfg = loadConfig({
      NODE_ENV: 'test',
      MEDLEVO_DATA_DIR: '/tmp/medlevo-x',
      MEDLEVO_ORIGIN: 'http://localhost:5173',
      ANTHROPIC_API_KEY: FAKE_KEY,
      MEDLEVO_MODEL_VERIFICATION: 'claude-sonnet-5-5',
    });
    const p = createProviderFromConfig(cfg)!;
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.name).toBe('anthropic');
    expect(p.modelFor('explain')).toBe('claude-opus-5-5');
    expect(p.modelFor('verify_support')).toBe('claude-sonnet-5-5');
    expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(cfg)).not.toContain(FAKE_KEY);
    expect(Object.values(p as unknown as Record<string, unknown>).some((v) => typeof v === 'string' && v.includes(FAKE_KEY))).toBe(false);
  });
});

describe('orchestrator + Anthropic adapter (mocked HTTP)', () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });
  const scope: ResolvedScope = {
    mode: 'lecture_only',
    sourceIds: ['S1'],
    versionIds: ['V1'],
    versionBySource: { S1: 'V1' },
    allowExternal: false,
    includeMyNotes: false,
    hash: 'h',
    describeAr: 'المحاضرة فقط',
  };
  const gen = (tApp: TestApp) =>
    tApp.ctx.ai.generateStructured({
      task: 'explain',
      schema: outSchema,
      system: 'Explain using only the evidence.',
      input: [{ label: 'E1', text: 'UNTRUSTED-LECTURE-TEXT-77' }],
      scope,
      sourceVersionIds: ['V1'],
      maxOutputTokens: 2000,
    });

  it('records usage with provider, served model, request id and an estimated cost; no prompt text stored', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID), requestId: 'req_orch_1', usage: { input: 3000, output: 900 } }]);
    t = await createTestApp({ ai: new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 }) });
    const res = await gen(t);
    expect(res.output).toEqual(VALID);
    const row = t.ctx.db.get<Record<string, unknown>>('SELECT * FROM usage_record WHERE id = ?', [res.usageId])!;
    expect(row).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', status: 'ok', request_ref: 'req_orch_1', input_tokens: 3000, output_tokens: 900, task: 'explain' });
    expect(row.estimated_cost_usd as number).toBeCloseTo((3000 * 4 + 900 * 20) / 1e6, 8);
    expect(JSON.stringify(t.ctx.db.all('SELECT * FROM usage_record'))).not.toContain('UNTRUSTED-LECTURE-TEXT-77');
    // the delimited untrusted content and the security policy reach the provider
    const body = m.calls[0]!.body as { system: string; messages: Array<{ content: Array<{ text?: string }> }> };
    expect(body.system).toContain('SECURITY POLICY');
    expect(body.messages[0]!.content[0]!.text).toMatch(/<untrusted_content id="1" boundary="untrusted_content_[0-9a-f]{16}"/);
    // status lists the real model per task
    expect(t.ctx.ai.status()).toMatchObject({ configured: true, provider: 'anthropic', tasks: { explain: { available: true, model: 'claude-opus-5-5' }, embed: { available: false } } });
  });

  it('a refused / truncated answer is AI_PROVIDER_ERROR with a specific Arabic reason; its billed usage and request id are recorded', async () => {
    const m = mockFetch([
      { kind: 'sse', text: '{"tit', stop: 'max_tokens', requestId: 'req_trunc', usage: { input: 100, output: 18_000 } },
      { kind: 'error', status: 401, type: 'authentication_error', requestId: 'req_401' },
    ]);
    t = await createTestApp({ ai: new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 }) });
    const e1 = (await gen(t).catch((x: unknown) => x)) as { code: string; messageAr: string; details: { provider_error: string } };
    expect(e1).toMatchObject({ code: 'AI_PROVIDER_ERROR', details: { provider_error: 'truncated', retryable: false } });
    expect(e1.messageAr).toContain('انقطع');
    const e2 = (await gen(t).catch((x: unknown) => x)) as { code: string; messageAr: string };
    expect(e2.code).toBe('AI_PROVIDER_ERROR');
    expect(e2.messageAr).toContain('ANTHROPIC_API_KEY');
    expect(e2.messageAr).not.toContain(FAKE_KEY);
    const rows = t.ctx.db.all<{ status: string; request_ref: string | null; output_tokens: number | null; estimated_cost_usd: number }>('SELECT status, request_ref, output_tokens, estimated_cost_usd FROM usage_record ORDER BY id');
    expect(rows).toEqual([
      { status: 'error', request_ref: 'req_trunc', output_tokens: 18_000, estimated_cost_usd: expect.any(Number) },
      { status: 'error', request_ref: 'req_401', output_tokens: null, estimated_cost_usd: 0 },
    ]);
    expect(rows[0]!.estimated_cost_usd).toBeGreaterThan(0.3); // billed truncation counts toward the budget
  });

  it('the budget pre-check includes the reasoning headroom (worst case), so a tight budget blocks before any HTTP call', async () => {
    const m = mockFetch([{ kind: 'sse', text: JSON.stringify(VALID) }]);
    // 2000 visible + 16000 reasoning headroom at $20/1M ≈ $0.36 worst case > $0.30 budget
    t = await createTestApp({ ai: new AnthropicProvider({ apiKey: FAKE_KEY, fetch: m.fn, maxRetries: 0 }), env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '0.30' } });
    await expect(gen(t)).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(m.calls).toHaveLength(0);
    expect(t.ctx.db.get<{ status: string }>('SELECT status FROM usage_record')!.status).toBe('budget_blocked');
  });
});
