// Claude-style study chat (wp/chat-ux, migration 0470): saved conversations (create / list per lecture / search /
// rename / delete / continue), per-message model + effort (allow-list, default = the task's configuration, priced by the
// orchestrator's budget guard), page context + page tags for the reader ↔ chat sync, edit-last / regenerate, remembered
// preferences, isolation between users (each user's own vault), and the streaming endpoint persisting ONLY the
// evidence-checked answer (a sentence the verifier rejects is removed, never softened).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessageView, ChatPostResponse, ChatPrefsResponse, ChatThreadResponse, ChatThreadView } from '@medlevo/shared';
import { regionWith } from '../evidence/helpers';
import { addUser } from '../helpers/tenancy';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

/** a provider whose owner-selectable models are Opus + Sonnet (Haiku deliberately not offered) */
class PickAi extends ScriptedAi {
  readonly selectableModels = ['claude-opus-5-5', 'claude-sonnet-5-5'];
}

const ai = new PickAi();
let lib: StudyLib;

beforeAll(async () => {
  lib = await studyLibrary(ai);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  ai.verdict = () => 'supported';
  if (ai.errors.length) {
    const e = ai.errors.splice(0);
    throw new Error(`scripted generator failed: ${e.map(String).join(' | ')}`);
  }
});

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, headers = lib.h) =>
  lib.t.app.inject({ method, url: `/api/studybook${url}`, headers, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function newThread(body: Record<string, unknown> = {}): Promise<ChatThreadView> {
  const res = await inject('POST', '/threads', { scope: lectureOnly(lib), anchor: null, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ChatThreadResponse).thread;
}

function usPage() {
  const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  const p = lib.t.ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [us.page_id])!;
  return { regionId: us.id, pageId: us.page_id as string, pageIndex: p.page_index };
}

function answerOnce() {
  ai.once('chat', (req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
}

/** questions carry the page being read (as the chat surface does), so retrieval always reaches it */
async function ask(threadId: string, body: Record<string, unknown>) {
  if (body.context === undefined) body = { ...body, context: { page_id: usPage().pageId } };
  const res = await inject('POST', `/threads/${threadId}/messages`, body);
  return { status: res.statusCode, json: res.json() as ChatPostResponse & { error?: { code: string; message: string } } };
}

describe('saved conversations', () => {
  it('create → named after the first question → listed per lecture with kind + title → search → rename → delete', async () => {
    const th = await newThread({ kind: 'explain' });
    expect(th).toMatchObject({ kind: 'explain', title: null, source_id: lib.lecture.sourceId, source_title: 'Acute Appendicitis (TEST FIXTURE)' });
    answerOnce();
    const r = await ask(th.id, { text: 'ما الفحص الأول عند الأطفال؟' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const list = (await inject('GET', `/threads?source_id=${lib.lecture.sourceId}`)).json() as { threads: ChatThreadView[] };
    const mine = list.threads.find((x) => x.id === th.id)!;
    expect(mine).toMatchObject({ kind: 'explain', title: 'ما الفحص الأول عند الأطفال؟', message_count: 2 });

    // search by the owner's question text, and nothing for an unrelated needle
    const found = (await inject('GET', `/threads?q=${encodeURIComponent('الفحص الأول')}`)).json() as { threads: ChatThreadView[] };
    expect(found.threads.map((x) => x.id)).toContain(th.id);
    const none = (await inject('GET', `/threads?q=${encodeURIComponent('لا_يوجد%')}`)).json() as { threads: ChatThreadView[] };
    expect(none.threads).toEqual([]);

    const renamed = await inject('PATCH', `/threads/${th.id}`, { title: '  الأشعة عند الأطفال ' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().thread.title).toBe('الأشعة عند الأطفال');
    expect((await inject('PATCH', `/threads/${th.id}`, { title: '' })).statusCode).toBe(400);

    // continue: a second question in the same saved conversation sees its history
    ai.once('chat', (req) => {
      expect(req.prompt).toContain('CONVERSATION SO FAR');
      return content([{ kind: 'paragraph', sentences: [S.c('CT abdomen is preferred in adults when the diagnosis is uncertain.', [aliasFor(req, 'CT abdomen')], 'directly_stated')] }]);
    });
    expect((await ask(th.id, { text: 'ومتى CT؟' })).status).toBe(200);

    const del = await inject('DELETE', `/threads/${th.id}`);
    expect(del.statusCode, del.body).toBe(200);
    expect((await inject('GET', `/threads/${th.id}`)).statusCode).toBe(404);
    expect((await inject('POST', `/threads/${th.id}/messages`, { text: 'هل ما زلت هنا؟' })).statusCode).toBe(404);
    const after = (await inject('GET', `/threads?source_id=${lib.lecture.sourceId}`)).json() as { threads: ChatThreadView[] };
    expect(after.threads.map((x) => x.id)).not.toContain(th.id);
    expect(lib.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'message' AND entity_id IN (SELECT id FROM message WHERE thread_id = ?)`, [th.id])!.n).toBe(0);
  });

  it('a conversation of one user is invisible to another (each user’s own vault); preferences are per user too', async () => {
    const th = await newThread();
    const other = await addUser(lib.t, 'second-student');
    const h2 = await other.login();
    expect((await inject('GET', `/threads/${th.id}`, undefined, h2)).statusCode).toBe(404);
    expect(((await inject('GET', '/threads', undefined, h2)).json() as { threads: unknown[] }).threads).toEqual([]);
    expect((await inject('PATCH', `/threads/${th.id}`, { title: 'x' }, h2)).statusCode).toBe(404);
    expect((await inject('DELETE', `/threads/${th.id}`, undefined, h2)).statusCode).toBe(404);
    expect((await inject('GET', `/threads/${th.id}`)).statusCode).toBe(200);

    expect((await inject('PUT', '/chat/prefs', { model: 'claude-sonnet-5-5', effort: 'low', sync_pages: false })).statusCode).toBe(200);
    const p2 = (await inject('GET', '/chat/prefs', undefined, h2)).json() as ChatPrefsResponse;
    expect(p2.prefs).toEqual({ model: null, effort: null, auto_explain: false, sync_pages: true });
  });
});

describe('model + effort per message', () => {
  it('remembered preferences: defaults, allow-list, saved choice', async () => {
    await inject('PUT', '/chat/prefs', { model: null, effort: null, sync_pages: true, auto_explain: false });
    const d = (await inject('GET', '/chat/prefs')).json() as ChatPrefsResponse;
    expect(d.available_models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(d.defaults).toEqual({ model: 'fake-model-1', effort: 'high' });
    const s = (await inject('PUT', '/chat/prefs', { model: 'claude-sonnet-5-5', effort: 'max', auto_explain: true })).json() as ChatPrefsResponse;
    expect(s.prefs).toEqual({ model: 'claude-sonnet-5-5', effort: 'max', auto_explain: true, sync_pages: true });
    expect((await inject('PUT', '/chat/prefs', { model: 'gpt-4o' })).statusCode).toBe(400);
    expect((await inject('PUT', '/chat/prefs', { effort: 'ultra' })).statusCode).toBe(400);
  });

  it('the chosen model + effort reach the generation call only; verification keeps its model; usage is recorded', async () => {
    const th = await newThread();
    const before = ai.calls.length;
    ai.once('chat', (req) => {
      expect(req.model).toBe('claude-sonnet-5-5');
      expect(req.effort).toBe('low');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'derived')] }]);
    });
    const r = await ask(th.id, { text: 'ما الفحص الأول عند الأطفال؟', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const verify = ai.calls.slice(before).filter((c) => c.task === 'verify_support');
    expect(verify.length).toBeGreaterThan(0);
    expect(verify.every((c) => c.model === 'fake-model-1' && c.effort === undefined)).toBe(true);
    expect(r.json.owner_message).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
    expect(r.json.answer).toMatchObject({ status: 'final', model: 'claude-sonnet-5-5', effort: 'low' });
    // generation + verification, estimated
    expect(r.json.answer.usage!.input_tokens).toBeGreaterThanOrEqual(2000);
    expect(r.json.answer.usage!.cost_usd).toBeGreaterThan(0);
    const usage = lib.t.ctx.db.get<{ model: string }>(`SELECT model FROM usage_record WHERE task = 'chat' ORDER BY id DESC LIMIT 1`)!;
    expect(usage.model).toBe('claude-sonnet-5-5');

    // without a choice: the task's configured model and effort
    ai.once('chat', (req) => {
      expect(req.model).toBe('fake-model-1');
      expect(req.effort).toBeUndefined();
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    expect((await ask(th.id, { text: 'أعد بإيجاز' })).status).toBe(200);
  });

  it('refuses a model outside the allow-list (400) or one this provider does not offer (409), before any model call', async () => {
    const th = await newThread();
    const before = ai.calls.length;
    const bad = await ask(th.id, { text: 'سؤال', model: 'gpt-4o' });
    expect(bad.status).toBe(400);
    const badEffort = await ask(th.id, { text: 'سؤال', effort: 'turbo' });
    expect(badEffort.status).toBe(400);
    const notOffered = await ask(th.id, { text: 'ما الفحص الأول عند الأطفال؟', model: 'claude-haiku-5-5' });
    expect(notOffered.status).toBe(409);
    expect(notOffered.json.error).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    const streamed = await inject('POST', `/threads/${th.id}/messages/stream`, { text: 'ما الفحص الأول؟', model: 'claude-haiku-5-5' });
    expect(streamed.statusCode).toBe(409);
    expect(String(streamed.headers['content-type'])).toContain('application/json');
    expect(ai.calls.length).toBe(before);
  });
});

describe('page context, page tags, edit / regenerate', () => {
  it('the attached page steers retrieval and tags the turn; a page from another version is refused', async () => {
    const th = await newThread({ kind: 'explain' });
    const us = usPage();
    ai.once('chat', (req) => {
      expect(req.prompt).toContain('Ultrasound is the first-line');
      expect(req.system + req.prompt).toContain('ATTACHED PAGE');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const r = await ask(th.id, { text: 'اشرح هذه الصفحة', context: { page_id: us.pageId } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.owner_message.page_indexes).toEqual([us.pageIndex]);
    expect(r.json.owner_message.context).toMatchObject({ page_id: us.pageId });
    expect(r.json.answer.page_indexes).toContain(us.pageIndex);

    const refPage = lib.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? LIMIT 1', [lib.reference.versionId])!;
    const out = await ask(th.id, { text: 'اشرح هذه الصفحة', context: { page_id: refPage.id } });
    expect(out.status).toBe(409);
    expect(out.json.error).toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('replace_from regenerates / edits ONLY the last question; the thread keeps one turn', async () => {
    const th = await newThread();
    answerOnce();
    const first = await ask(th.id, { text: 'ما الفحص الأول؟' });
    answerOnce();
    const second = await ask(th.id, { text: 'ما الفحص الأول عند الأطفال؟' });
    // editing the FIRST (not last) question is refused
    const notLast = await ask(th.id, { text: 'تعديل', replace_from: first.json.owner_message.id });
    expect(notLast.status).toBe(409);
    // regenerate the last answer (same text) / edit it (new text)
    ai.once('chat', (req) => {
      // the replaced turn is not part of the history the new answer sees
      expect(req.prompt).not.toContain('ما الفحص الأول عند الأطفال؟\n');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const edited = await ask(th.id, { text: 'وعند البالغين؟', replace_from: second.json.owner_message.id });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    const full = (await inject('GET', `/threads/${th.id}`)).json() as ChatThreadResponse;
    const texts = full.messages.filter((m) => m.role === 'owner').map((m) => m.content.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join(''));
    expect(texts).toEqual(['ما الفحص الأول؟', 'وعند البالغين؟']);
    expect(full.messages).toHaveLength(4);
    expect(full.messages.some((m) => m.id === second.json.answer.id)).toBe(false);
  });
});

describe('streaming persists the evidence-checked answer only', () => {
  it('the stream ends with the verified answer; the stored message has no removed sentence, with pages and usage', async () => {
    const th = await newThread();
    const us = usPage();
    ai.verdict = (text) => (text.includes('always') ? 'not_supported' : 'supported');
    ai.once('chat', (req) =>
      content([
        {
          kind: 'paragraph',
          sentences: [
            S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated'),
            S.c('Ultrasound is always diagnostic in every child.', [aliasFor(req, 'Ultrasound is the first-line')], 'derived'),
          ],
        },
      ]),
    );
    const res = await inject('POST', `/threads/${th.id}/messages/stream`, { text: 'اشرح', context: { page_id: us.pageId }, effort: 'medium' });
    expect(res.statusCode).toBe(200);
    const evs = res.body
      .split('\n\n')
      .map((c) => c.split('\n').find((l) => l.startsWith('data: ')))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(6)) as { type: string; result?: ChatPostResponse; removed?: Array<{ text: string }> });
    const fin = evs.at(-1)!;
    expect(fin.type).toBe('final');
    expect(fin.removed!.map((x) => x.text)).toContain('Ultrasound is always diagnostic in every child.');
    // drafts showed it (unverified), the stored message does not
    expect(evs.some((e) => e.type === 'draft' && JSON.stringify(e).includes('always diagnostic'))).toBe(true);
    const full = (await inject('GET', `/threads/${th.id}`)).json() as ChatThreadResponse;
    const answer = full.messages.find((m) => m.role === 'assistant') as ChatMessageView;
    expect(answer.status).toBe('final');
    const text = answer.content.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(text).toContain('Ultrasound is the first-line');
    expect(text).not.toContain('always diagnostic');
    expect(answer).toMatchObject({ effort: 'medium' });
    expect(answer.page_indexes).toContain(us.pageIndex);
    expect(answer.usage!.cost_usd).toBeGreaterThan(0);
  });
});
