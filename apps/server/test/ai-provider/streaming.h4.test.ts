// Round 7 H4 item 10 (§30) — streaming below the HTTP routes:
//   * the Anthropic adapter forwards the stream's visible text deltas (stream.on('text')) in order, against a MOCKED
//     HTTP layer (SSE: message_start, content_block_delta text_delta, message_delta, message_stop) — no network, no
//     key; the result is still built from finalMessage() only; a throwing listener never breaks the call; an abort
//     mid-stream ends the call;
//   * the orchestrator numbers the attempts and announces the single repair attempt (`restart`) so a draft of an
//     answer that failed the structure is voided; nothing streams when no listener is given;
//   * draftFromPartialJson reads sentence texts out of partial JSON (escapes, a \u escape cut in half, figure output,
//     table cells), never the abstain detail, never evidence aliases, and strips model-typed «citations».
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ResolvedScope } from '@medlevo/shared';
import type { AiTextEvent } from '../../src/modules/ai';
import { AnthropicProvider } from '../../src/modules/ai/providers';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { draftFromPartialJson } from '../../src/modules/studybook/draft';
import { createTestApp, type TestApp } from '../helpers/app';
import { FakeAiProvider } from '../helpers/fake-ai';

const FAKE_KEY = 'sk-ant-test-not-a-real-key-000';

function sseBody(text: string, chunk = 9): string {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const parts = [
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ];
  for (let i = 0; i < text.length; i += chunk) parts.push(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } }));
  parts.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
  parts.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }));
  parts.push(ev('message_stop', { type: 'message_stop' }));
  return parts.join('');
}

/** a mocked HTTP layer that answers with an SSE body, optionally dribbled out chunk by chunk (to abort mid-stream) */
function mockFetch(body: string, opts: { slow?: boolean } = {}) {
  const fn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!opts.slow) return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream_1' } });
    const enc = new TextEncoder();
    const events = body.split('\n\n').filter(Boolean);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (init?.signal?.aborted) {
          ctrl.error(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
          return;
        }
        if (i >= events.length) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(enc.encode(`${events[i++]}\n\n`));
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream_2' } });
  };
  return fn as typeof fetch;
}

const schema = z.object({ title: z.string(), items: z.array(z.string()) });
const VALID = { title: 'شرح «تجريبي»', items: ['a', 'b\nc'] };
function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return { task: 'explain', model: 'claude-opus-5-5', system: 'S', prompt: 'P', jsonSchema: z.toJSONSchema(schema) as Record<string, unknown>, maxOutputTokens: 1000, signal: new AbortController().signal, ...over };
}

describe('Anthropic adapter: text deltas', () => {
  it('forwards every visible delta in order; the result is the final message', async () => {
    const text = JSON.stringify(VALID);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: mockFetch(sseBody(text)), maxRetries: 0 });
    expect(p.streamsText).toBe(true);
    const deltas: string[] = [];
    const res = await p.generateStructured(request({ onTextDelta: (d) => deltas.push(d) }));
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join('')).toBe(text);
    expect(res.json).toEqual(VALID);
    expect(res.usage.outputTokens).toBe(42);
  });

  it('a listener that throws never breaks the call; without a listener nothing is forwarded', async () => {
    const text = JSON.stringify(VALID);
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: mockFetch(sseBody(text)), maxRetries: 0 });
    const res = await p.generateStructured(
      request({
        onTextDelta: () => {
          throw new Error('listener gone');
        },
      }),
    );
    expect(res.json).toEqual(VALID);
    const p2 = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: mockFetch(sseBody(text)), maxRetries: 0 });
    expect((await p2.generateStructured(request())).json).toEqual(VALID);
  });

  it('aborting mid-stream ends the call (the caller’s abort propagates, nothing returned)', async () => {
    const text = JSON.stringify({ title: 'x'.repeat(200), items: ['y'.repeat(200)] });
    const p = new AnthropicProvider({ apiKey: FAKE_KEY, fetch: mockFetch(sseBody(text, 5), { slow: true }), maxRetries: 0 });
    const ac = new AbortController();
    const deltas: string[] = [];
    const call = p.generateStructured(
      request({
        signal: ac.signal,
        onTextDelta: (d) => {
          deltas.push(d);
          if (deltas.length === 3) ac.abort(new DOMException('owner stopped', 'AbortError'));
        },
      }),
    );
    await expect(call).rejects.toBeTruthy();
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas.join('').length).toBeLessThan(text.length);
  });
});

describe('orchestrator: attempts and restart', () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });
  const scope: ResolvedScope = { mode: 'lecture_only', sourceIds: ['S1'], versionIds: ['V1'], versionBySource: { S1: 'V1' }, allowExternal: false, includeMyNotes: false, hash: 'h', describeAr: 'المحاضرة فقط' };
  const base = { task: 'summarize' as const, schema, system: 'S', input: [{ label: 'L', text: 'T' }], scope, sourceVersionIds: ['V1'] };

  it('deltas carry attempt 1; a schema failure announces restart, then attempt 2 deltas', async () => {
    const fake = new FakeAiProvider({ steps: [{ json: { title: 'missing items' } }, { json: VALID }] });
    t = await createTestApp({ ai: fake });
    const events: AiTextEvent[] = [];
    const out = await t.ctx.ai.generateStructured({ ...base, onText: (e) => events.push(e) });
    expect(out.output).toEqual(VALID);
    const iRestart = events.findIndex((e) => e.type === 'restart');
    expect(iRestart).toBeGreaterThan(0);
    expect(events.slice(0, iRestart).every((e) => e.type === 'delta' && e.attempt === 1)).toBe(true);
    expect(events.slice(iRestart + 1).every((e) => e.type === 'delta' && e.attempt === 2)).toBe(true);
    const text = (a: 1 | 2) => events.filter((e): e is Extract<AiTextEvent, { type: 'delta' }> => e.type === 'delta' && e.attempt === a).map((e) => e.text).join('');
    expect(text(1)).toBe(JSON.stringify({ title: 'missing items' }));
    expect(text(2)).toBe(JSON.stringify(VALID));
  });

  it('no listener → the provider is never asked to stream', async () => {
    const fake = new FakeAiProvider({ steps: [{ json: VALID }] });
    t = await createTestApp({ ai: fake });
    await t.ctx.ai.generateStructured(base);
    expect(fake.calls[0]!.onTextDelta).toBeUndefined();
  });
});

describe('draftFromPartialJson', () => {
  const full = JSON.stringify({
    blocks: [
      { kind: 'heading', sentences: [{ text: 'التصوير الأولي', claim: null }] },
      { kind: 'paragraph', sentences: [{ text: 'Ultrasound is "first-line" in children (ص 12).', claim: { support_type: 'directly_stated', evidence: ['E1'] } }, { text: 'سطر\nثانٍ', claim: null }] },
      { kind: 'comparison_table', sentences: [], table: { header: ['A', 'B'], rows: [[{ text: 'cell one', claim: null }]] } },
    ],
    abstain: { reason: 'insufficient_evidence', detail: 'ABSTAIN DETAIL MUST NOT SHOW' },
    coverage_note: 'COVERAGE NOTE',
  });

  it('the complete text: sentences per block, escapes decoded, citations stripped, aliases / abstain / notes never shown', () => {
    const d = draftFromPartialJson(full);
    expect(d).toEqual([
      { kind: 'heading', sentences: ['التصوير الأولي'] },
      { kind: 'paragraph', sentences: ['Ultrasound is "first-line" in children.', 'سطر ثانٍ'] },
      { kind: 'comparison_table', sentences: ['cell one'] },
    ]);
    const all = JSON.stringify(d);
    expect(all).not.toContain('E1');
    expect(all).not.toContain('ABSTAIN DETAIL');
    expect(all).not.toContain('COVERAGE NOTE');
  });

  it('every prefix parses without throwing and only ever grows (a sentence in progress shows its beginning)', () => {
    let prevChars = 0;
    for (let n = 0; n <= full.length; n++) {
      const d = draftFromPartialJson(full.slice(0, n));
      const chars = d.flatMap((b) => b.sentences).join('').length;
      // pseudo-citation stripping may shorten the in-progress sentence once «(ص 12)» completes
      expect(chars).toBeGreaterThanOrEqual(prevChars - 8);
      prevChars = chars;
    }
    const cut = full.indexOf('first-line') + 5;
    expect(draftFromPartialJson(full.slice(0, cut)).at(-1)!.sentences.at(-1)).toBe('Ultrasound is "first');
  });

  it('a \\u escape cut in half is dropped, not garbled; figure output ({content:{blocks}}) is read too', () => {
    expect(draftFromPartialJson('{"blocks":[{"kind":"paragraph","sentences":[{"text":"abc\\u06')).toEqual([{ kind: 'paragraph', sentences: ['abc'] }]);
    const fig = JSON.stringify({ figure_kind: 'flowchart', content: { blocks: [{ kind: 'paragraph', sentences: [{ text: 'Figure sentence', claim: null }] }], abstain: null }, visual_items: [{ description: 'VISUAL ITEM' }] });
    expect(draftFromPartialJson(fig)).toEqual([{ kind: 'paragraph', sentences: ['Figure sentence'] }]);
  });
});
