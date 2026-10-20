// Round 7 H4 item 10 (§30 «عند streaming، ميّز المسودة التي لم تجتز الفحص عن النتيجة المنشورة. لا تجعل ادعاءً طبيًا
// غير متحقق يظهر أولًا بثقة ثم تختفي مشكلته بصمت.»). Before H4 there was no streaming: the owner waited for the whole
// pipeline. Now POST /api/studybook/explain/stream and /threads/:id/messages/stream answer with Server-Sent Events:
//   * phase retrieving → generating → (draft…) → verifying → final, in that order;
//   * every draft event is labelled «مسودة لم تُتحقق بعد» and carries the model's sentences AS WRITTEN (unverified);
//   * the final event = the non-streaming response; a sentence verification removed is LISTED as removed (never
//     silently dropped after having been on screen); nothing of the draft is stored;
//   * a schema failure voids the draft (restart event) before the single repair attempt;
//   * failures before the stream opens stay JSON errors (404 / 400 / CSRF); closing the connection cancels the
//     provider call and the answer is recorded as stopped by the owner, never published.
// TEST-ONLY scripted provider (no API key in this environment); the real adapter's deltas are tested with a
// mocked HTTP layer in test/ai-provider/anthropic.test.ts.
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STREAM_DRAFT_LABEL_AR, type ChatPostResponse, type ChatThreadResponse, type ExplainResponse, type StudyStreamEvent } from '@medlevo/shared';
import { regionWith } from '../evidence/helpers';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
let us: { id: string; page_id: string };

beforeAll(async () => {
  lib = await studyLibrary(ai);
  const r = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  us = { id: r.id, page_id: r.page_id };
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  ai.verdict = () => 'supported';
  ai.streamPause = null;
  if (ai.errors.length) {
    const e = ai.errors.splice(0);
    throw new Error(`scripted generator failed: ${e.map(String).join(' | ')}`);
  }
});

type Ev<T> = StudyStreamEvent<T>;
function parseSse<T>(body: string): Array<Ev<T>> {
  return body
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as Ev<T>);
}
const anchorUs = () => ({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] });
const SUPPORTED = 'Ultrasound is the first-line imaging test in children.';
const UNSUPPORTED = 'Ultrasound replaces every other test in adults (TEST-UNSUPPORTED).';

describe('explain as a stream', () => {
  it('phases in order, labelled unverified drafts with every sentence as written, then the verified result with the removed sentence listed', async () => {
    ai.verdict = (t) => (t.includes('TEST-UNSUPPORTED') ? 'not_supported' : 'supported');
    ai.streamChunk = 11;
    ai.once('explain', (req) => {
      const e = aliasFor(req, 'Ultrasound is the first-line');
      return content([{ kind: 'paragraph', sentences: [S.c(SUPPORTED, [e], 'directly_stated'), S.c(UNSUPPORTED, [e], 'derived')] }]);
    });
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: { action: 'explain', style: 'detailed', anchor: anchorUs(), scope: lectureOnly(lib) } });
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
    const evs = parseSse<ExplainResponse>(res.body);
    const types = evs.map((e) => (e.type === 'phase' ? `phase:${e.phase}` : e.type));
    // order: retrieving → generating → drafts → verifying → final
    expect(types[0]).toBe('phase:retrieving');
    expect(types[1]).toBe('phase:generating');
    const iVerify = types.indexOf('phase:verifying');
    const drafts = evs.filter((e): e is Extract<Ev<ExplainResponse>, { type: 'draft' }> => e.type === 'draft');
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(types.lastIndexOf('draft')).toBeLessThan(iVerify);
    expect(types.at(-1)).toBe('final');
    expect(types).not.toContain('error');
    for (const d of drafts) {
      expect(d.label_ar).toBe(STREAM_DRAFT_LABEL_AR);
      expect(d.attempt).toBe(1);
    }
    // the last draft shows BOTH sentences as the model wrote them (the unsupported one too — it is unverified)
    expect(drafts.at(-1)!.blocks).toEqual([{ kind: 'paragraph', sentences: [SUPPORTED, UNSUPPORTED] }]);
    // an earlier draft showed a sentence in progress (the stream really is incremental)
    expect(drafts.length === 1 || drafts[0]!.blocks.flatMap((b) => b.sentences).join(' ').length < `${SUPPORTED} ${UNSUPPORTED}`.length).toBe(true);
    const final = evs.at(-1) as Extract<Ev<ExplainResponse>, { type: 'final' }>;
    expect(final.had_draft).toBe(true);
    expect(final.result.artifact.status).toBe('published');
    const published = final.result.artifact.blocks.map((b) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('')).join(' ');
    expect(published).toContain('Ultrasound is the first-line');
    expect(published).not.toContain('TEST-UNSUPPORTED');
    // removed — shown as removed, with the reason
    expect(final.removed).toEqual([expect.objectContaining({ text: expect.stringContaining('TEST-UNSUPPORTED'), reason_ar: expect.any(String) })]);
    // nothing of the draft was stored: the artifact's blocks hold only the verified sentence
    const stored = lib.t.ctx.db.all<{ content_json: string }>('SELECT content_json FROM content_block WHERE artifact_id = ?', [final.result.artifact.id]).map((r) => r.content_json).join(' ');
    expect(stored).not.toContain('TEST-UNSUPPORTED');
  });

  it('a cached answer comes as a final event without any draft', async () => {
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c(SUPPORTED, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const body = { action: 'simplify', style: 'short', anchor: anchorUs(), scope: lectureOnly(lib) };
    const first = parseSse<ExplainResponse>((await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: body })).body);
    expect((first.at(-1) as { type: string }).type).toBe('final');
    const calls = ai.calls.length;
    const again = parseSse<ExplainResponse>((await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: body })).body);
    expect(ai.calls.length).toBe(calls);
    expect(again.some((e) => e.type === 'draft')).toBe(false);
    const fin = again.at(-1) as Extract<Ev<ExplainResponse>, { type: 'final' }>;
    expect(fin.result.cached).toBe(true);
    expect(fin.had_draft).toBe(false);
  });

  it('an answer that fails the required structure: its draft is voided (restart) before the single repair attempt', async () => {
    // attempt 1: sentences but no `abstain` field → schema rejected; attempt 2: valid
    ai.once('explain', () => ({ blocks: [{ kind: 'paragraph', sentences: [{ text: 'Draft sentence of the first attempt (TEST).', claim: null }] }] }));
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c(SUPPORTED, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: { action: 'translate', style: 'detailed', anchor: anchorUs(), scope: lectureOnly(lib) } });
    const evs = parseSse<ExplainResponse>(res.body);
    const iRestart = evs.findIndex((e) => e.type === 'restart');
    expect(iRestart).toBeGreaterThan(0);
    const before = evs.slice(0, iRestart).filter((e) => e.type === 'draft') as Array<Extract<Ev<ExplainResponse>, { type: 'draft' }>>;
    const after = evs.slice(iRestart).filter((e) => e.type === 'draft') as Array<Extract<Ev<ExplainResponse>, { type: 'draft' }>>;
    expect(before.at(-1)!.blocks[0]!.sentences).toEqual(['Draft sentence of the first attempt (TEST).']);
    expect(before.every((d) => d.attempt === 1)).toBe(true);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((d) => d.attempt === 2)).toBe(true);
    expect(after.flatMap((d) => d.blocks.flatMap((b) => b.sentences)).join(' ')).not.toContain('first attempt');
    expect((evs[iRestart] as { reason_ar: string }).reason_ar).toContain('أُلغيت');
    expect((evs.at(-1) as { type: string }).type).toBe('final');
  });

  it('a model «citation» typed into the text never appears in the draft', async () => {
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c(`${SUPPORTED} (ص 11)`, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const evs = parseSse<ExplainResponse>((await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: { action: 'explain', style: 'short', anchor: anchorUs(), scope: lectureOnly(lib), instruction: 'TEST pseudo citation' } })).body);
    const last = evs.filter((e) => e.type === 'draft').at(-1) as Extract<Ev<ExplainResponse>, { type: 'draft' }>;
    expect(last.blocks[0]!.sentences[0]).not.toMatch(/ص\s*11/);
  });

  it('failures before the stream opens are ordinary JSON errors (validation, CSRF, no session)', async () => {
    const bad = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: lib.h, payload: { action: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.headers['content-type'])).toContain('application/json');
    const noCsrf = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: { cookie: lib.h.cookie }, payload: { action: 'explain', style: 'short', anchor: anchorUs(), scope: lectureOnly(lib) } });
    expect(noCsrf.statusCode).toBe(403);
    const anon = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain/stream', headers: { 'x-medlevo-csrf': '1' }, payload: {} });
    expect(anon.statusCode).toBe(401);
  });
});

describe('chat as a stream', () => {
  async function thread(): Promise<ChatThreadResponse> {
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: lib.h, payload: { scope: lectureOnly(lib), anchor: anchorUs(), style: 'detailed' } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  it('drafts, then the stored verified answer; the message never holds draft text; removed sentences reported', async () => {
    const th = await thread();
    ai.verdict = (t) => (t.includes('TEST-UNSUPPORTED') ? 'not_supported' : 'supported');
    ai.once('chat', (req) => {
      const e = aliasFor(req, 'Ultrasound is the first-line');
      return content([{ kind: 'paragraph', sentences: [S.c(SUPPORTED, [e], 'directly_stated'), S.c(UNSUPPORTED, [e], 'derived')] }]);
    });
    const res = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/threads/${th.thread.id}/messages/stream`, headers: lib.h, payload: { text: 'لماذا نبدأ بالأمواج فوق الصوتية؟' } });
    expect(res.statusCode, res.body).toBe(200);
    const evs = parseSse<ChatPostResponse>(res.body);
    expect(evs.some((e) => e.type === 'draft' && e.blocks.some((b) => b.sentences.some((s) => s.includes('TEST-UNSUPPORTED'))))).toBe(true);
    const fin = evs.at(-1) as Extract<Ev<ChatPostResponse>, { type: 'final' }>;
    expect(fin.type).toBe('final');
    expect(fin.result.answer).toMatchObject({ role: 'assistant', status: 'final' });
    expect(fin.removed.map((r) => r.text).join(' ')).toContain('TEST-UNSUPPORTED');
    const row = lib.t.ctx.db.get<{ content_json: string; status: string }>('SELECT content_json, status FROM message WHERE id = ?', [fin.result.answer.id])!;
    expect(row.status).toBe('final');
    expect(row.content_json).toContain('Ultrasound is the first-line');
    expect(row.content_json).not.toContain('TEST-UNSUPPORTED');
  });

  it('unknown thread → 404 JSON before any stream', async () => {
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads/NOPE_TEST/messages/stream', headers: lib.h, payload: { text: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });

  it('closing the connection mid-draft cancels the model call; the answer is recorded as stopped and never published', async () => {
    const th = await thread();
    let release!: () => void;
    ai.streamChunk = 7;
    // hold the stream once the sentence has begun («{"blocks":[{"kind":"paragraph","sentences":[{"text":"Ultra…»)
    ai.streamPause = { afterChunks: 12, until: new Promise<void>((r) => (release = r)) };
    let seenSignal: AbortSignal | null = null;
    ai.once('chat', (req) => {
      seenSignal = req.signal;
      return content([{ kind: 'paragraph', sentences: [S.c(SUPPORTED, [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const address = new URL(await lib.t.app.listen({ port: 0, host: '127.0.0.1' }));
    // a plain HTTP request without a shared agent: closing it closes the connection, as a browser tab would
    const req = http.request({
      host: address.hostname,
      port: Number(address.port),
      path: `/api/studybook/threads/${th.thread.id}/messages/stream`,
      method: 'POST',
      agent: false,
      headers: { ...lib.h, 'content-type': 'application/json' },
    });
    const text = await new Promise<string>((resolve, reject) => {
      let got = '';
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          got += d;
          if (got.includes('event: draft')) resolve(got);
        });
        res.on('end', () => resolve(got));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: 'سؤال سيُوقف (TEST)' }));
    });
    expect(text).toContain('event: draft');
    req.destroy(); // the owner pressed «أوقف» / closed the tab
    // the server notices the closed connection and aborts the provider call
    const deadline = Date.now() + 5000;
    while (!(seenSignal as AbortSignal | null)?.aborted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    release();
    let row: { status: string; detail_json: string | null; artifact_id: string | null } | undefined;
    while (Date.now() < deadline) {
      row = lib.t.ctx.db.get<{ status: string; detail_json: string | null; artifact_id: string | null }>(
        `SELECT status, detail_json, artifact_id FROM message WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [th.thread.id],
      );
      if (row?.status === 'rejected') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(row?.status).toBe('rejected');
    expect(row?.artifact_id).toBeNull();
    expect(JSON.parse(row!.detail_json!).error).toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('أوقفتَ الإجابة') });
  });
});
