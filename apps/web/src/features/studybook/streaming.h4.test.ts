// Round 7 H4 item 10 (web): the SSE client of the streaming explain / chat endpoints — events split anywhere across
// network chunks are reassembled; the CSRF header and same-origin credentials are sent; an `error` event and a non-OK
// answer become ApiErrors with the server's Arabic message; a stream cut before `final` is an error (never a result).
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImpl, isApiError } from '../../lib/api';
import { EMPTY_STREAM, postStudyStream, reduceStream } from './streaming';

afterEach(() => setFetchImpl(null));

function chunked(text: string, size: number): Response {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= text.length) return c.close();
        c.enqueue(enc.encode(text.slice(i, i + size)));
        i += size;
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
const ev = (e: Record<string, unknown>) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;

describe('postStudyStream', () => {
  it('reassembles events split at any byte; sends CSRF + same-origin; resolves with the final result', async () => {
    const body =
      ': keep-alive\n\n' +
      ev({ type: 'phase', phase: 'retrieving', label_ar: 'يُبحث…' }) +
      ev({ type: 'draft', attempt: 1, blocks: [{ kind: 'paragraph', sentences: ['جملة «أولى» — first'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'x' }) +
      ev({ type: 'final', result: { ok: 1 }, removed: [{ text: 'r', reason_ar: 'سبب' }], had_draft: true });
    for (const size of [1, 3, 7, 64]) {
      let init: RequestInit | null = null;
      setFetchImpl(async (_url, i) => {
        init = i;
        return chunked(body, size);
      });
      const seen: string[] = [];
      let view = EMPTY_STREAM;
      const out = await postStudyStream<{ ok: number }>('/studybook/explain/stream', { a: 1 }, { onEvent: (e) => ((view = reduceStream(view, e)), seen.push(e.type)) });
      expect(out).toEqual({ result: { ok: 1 }, removed: [{ text: 'r', reason_ar: 'سبب' }], hadDraft: true });
      expect(seen).toEqual(['phase', 'draft', 'final']);
      expect(view.blocks[0]!.sentences[0]).toBe('جملة «أولى» — first');
      const h = (init as unknown as RequestInit).headers as Record<string, string>;
      expect(h['x-medlevo-csrf']).toBe('1');
      expect((init as unknown as RequestInit).credentials).toBe('same-origin');
    }
  });

  it('an error event → ApiError with the server code and Arabic message', async () => {
    setFetchImpl(async () => chunked(ev({ type: 'error', error: { code: 'AI_PROVIDER_ERROR', message: 'تعذر الحصول على رد من مزود الذكاء الاصطناعي.' } }), 5));
    const e = await postStudyStream('/studybook/explain/stream', {}, {}).catch((x: unknown) => x);
    expect(isApiError(e)).toBe(true);
    expect(e).toMatchObject({ code: 'AI_PROVIDER_ERROR', message: 'تعذر الحصول على رد من مزود الذكاء الاصطناعي.' });
  });

  it('a non-OK answer (before any stream) → ApiError with the server message', async () => {
    setFetchImpl(async () => new Response(JSON.stringify({ error: { code: 'AI_NOT_CONFIGURED', message: 'ميزات الذكاء الاصطناعي غير مفعّلة.' } }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const e = await postStudyStream('/studybook/explain/stream', {}, {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'AI_NOT_CONFIGURED', status: 409, message: 'ميزات الذكاء الاصطناعي غير مفعّلة.' });
  });

  it('a stream cut before `final` is an error, never a result', async () => {
    setFetchImpl(async () => chunked(ev({ type: 'draft', attempt: 1, blocks: [{ kind: null, sentences: ['partial'] }], label_ar: 'مسودة لم تُتحقق بعد', note_ar: 'x' }), 4));
    const e = await postStudyStream('/studybook/explain/stream', {}, {}).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'BAD_RESPONSE' });
    expect((e as Error).message).toContain('لم يُعتمد شيء من المسودة');
  });
});
