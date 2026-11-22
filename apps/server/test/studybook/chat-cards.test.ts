// Smart chat skills (wp/smart-rail, migration 0471): a skill result is appended to the conversation as a card — the
// owner's request + an assistant message carrying a typed attachment that only REFERENCES objects of other modules by
// id. The card survives a reload (it is part of the history), every referenced id must exist (nothing is written
// otherwise), compare cards show the evidence-checked artifact itself, and cards never reach the model as history.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatPostResponse, ChatThreadResponse, ChatThreadView, StudyArtifactView } from '@medlevo/shared';
import { regionWith } from '../evidence/helpers';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
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

const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  lib.t.app.inject({ method, url: `/api/studybook${url}`, headers: lib.h, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function newThread(): Promise<ChatThreadView> {
  const res = await inject('POST', '/threads', { scope: lectureOnly(lib), anchor: null });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as ChatThreadResponse).thread;
}

function usPage() {
  const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  const p = lib.t.ctx.db.get<{ page_index: number }>('SELECT page_index FROM source_page WHERE id = ?', [us.page_id])!;
  return { pageId: us.page_id as string, pageIndex: p.page_index };
}

const countMessages = (threadId: string) => lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM message WHERE thread_id = ?', [threadId])!.n;

describe('skill cards in the conversation history', () => {
  it('a «sources» card is stored with its page and comes back on reload with its attachment; the thread is named after it', async () => {
    const th = await newThread();
    const pg = usPage();
    const res = await inject('POST', `/threads/${th.id}/cards`, { text: 'المصادر', skill: 'sources', attachment: { type: 'sources', page_id: pg.pageId }, context: { page_id: pg.pageId } });
    expect(res.statusCode, res.body).toBe(200);
    const post = res.json() as ChatPostResponse;
    expect(post.owner_message).toMatchObject({ role: 'owner', status: 'final', page_indexes: [pg.pageIndex] });
    expect(post.answer).toMatchObject({ role: 'assistant', status: 'final', reply_to_id: post.owner_message.id, attachment: { type: 'sources', page_id: pg.pageId }, artifact: null });

    const again = (await inject('GET', `/threads/${th.id}`)).json() as ChatThreadResponse;
    expect(again.thread.title).toBe('المصادر');
    expect(again.messages.map((m) => [m.role, m.attachment?.type ?? null])).toEqual([
      ['owner', null],
      ['assistant', 'sources'],
    ]);
  });

  it('every referenced id must exist: an unknown question / case / run is refused and nothing is written', async () => {
    const th = await newThread();
    for (const attachment of [
      { type: 'questions', ids: ['NOPE_QUESTION'], page_id: null },
      { type: 'case', case_id: 'NOPE_CASE' },
      { type: 'mcq', run_id: 'NOPE_RUN', question_ids: [] },
      { type: 'cards', card_ids: ['NOPE_CARD'], version_id: lib.lecture.versionId },
    ]) {
      const res = await inject('POST', `/threads/${th.id}/cards`, { text: 'x', skill: 'lecture_questions', attachment });
      expect(res.statusCode, `${attachment.type}: ${res.body}`).toBe(404);
    }
    // a malformed attachment is a validation error
    const bad = await inject('POST', `/threads/${th.id}/cards`, { text: 'x', skill: 'mcq', attachment: { type: 'mcq', run_id: 'R', question_ids: [], answer: 'B' } });
    expect(bad.statusCode).toBe(400);
    // a page of another lecture can never be attached (the Source Lock holds for cards too)
    const ref = lib.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? LIMIT 1', [lib.reference.versionId])!;
    const outside = await inject('POST', `/threads/${th.id}/cards`, { text: 'x', skill: 'sources', attachment: { type: 'sources', page_id: null }, context: { page_id: ref.id } });
    expect(outside.statusCode).toBe(409);
    expect(countMessages(th.id)).toBe(0);
  });

  it('a compare card shows the checked comparison artifact; the card is never sent to the model as history', async () => {
    ai.once('compare', (req) =>
      content([
        {
          kind: 'comparison_table',
          sentences: [],
          table: {
            header: ['الجانب', 'Ultrasound', 'CT abdomen'],
            rows: [[S.n('متى يُستخدم'), S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated'), S.n('غير مذكور في المصادر المسموحة')]],
          },
        },
      ]),
    );
    const cmp = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/compare', headers: lib.h, payload: { items: ['Ultrasound', 'CT abdomen'], scope: lectureOnly(lib) } });
    expect(cmp.statusCode, cmp.body).toBe(200);
    const artifact = cmp.json().artifact as StudyArtifactView;

    const th = await newThread();
    // the artifact is required, and must be a comparison
    const missing = await inject('POST', `/threads/${th.id}/cards`, { text: 'قارن', skill: 'compare', attachment: { type: 'compare', items: ['Ultrasound', 'CT abdomen'] } });
    expect(missing.statusCode).toBe(400);
    const res = await inject('POST', `/threads/${th.id}/cards`, { text: 'قارن: Ultrasound / CT abdomen', skill: 'compare', attachment: { type: 'compare', items: ['Ultrasound', 'CT abdomen'] }, artifact_id: artifact.id });
    expect(res.statusCode, res.body).toBe(200);
    const post = res.json() as ChatPostResponse;
    expect(post.answer.artifact?.id).toBe(artifact.id);
    expect(post.answer.attachment).toEqual({ type: 'compare', items: ['Ultrasound', 'CT abdomen'] });

    // a chat question after the card: the model's history holds no card turn
    ai.once('chat', (req) => {
      expect(req.prompt).not.toContain('قارن: Ultrasound / CT abdomen');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const ask = await inject('POST', `/threads/${th.id}/messages`, { text: 'ما الفحص الأول عند الأطفال؟', context: { page_id: usPage().pageId } });
    expect(ask.statusCode, ask.body).toBe(200);
    const all = (await inject('GET', `/threads/${th.id}`)).json() as ChatThreadResponse;
    expect(all.messages.filter((m) => m.role === 'assistant').map((m) => m.attachment?.type ?? null)).toEqual(['compare', null]);
  });
});
