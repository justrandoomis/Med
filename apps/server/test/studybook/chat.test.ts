// Contextual chat (§30) + Save AI answer as note (§28) + AC-05 through chat (abstain without a model call,
// explicit wider scope, no reuse across scopes) + not-configured / budget paths.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessageView, ChatPostResponse, ChatThreadResponse, NoteDTO } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { linkReference, regionWith } from '../evidence/helpers';
import { aliasFor, content, createStudyApp, evidenceIn, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;

beforeAll(async () => {
  lib = await studyLibrary(ai);
  linkReference(lib.t, lib.lecture.sourceId, lib.reference.sourceId);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  if (ai.errors.length) {
    const e = ai.errors.splice(0);
    throw new Error(`scripted generator failed: ${e.map(String).join(' | ')}`);
  }
});

/** an anchored thread on the «Ultrasound is the first-line» region (anchor regions are always searched) */
function usAnchor() {
  const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  return { source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] };
}

async function thread(body: Record<string, unknown>): Promise<ChatThreadResponse> {
  const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: lib.h, payload: { scope: lectureOnly(lib), anchor: null, style: 'detailed', ...body } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function ask(threadId: string, text: string, extra: Record<string, unknown> = {}) {
  const res = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/threads/${threadId}/messages`, headers: lib.h, payload: { text, ...extra } });
  return { status: res.statusCode, json: res.json() as ChatPostResponse & { error?: { code: string; message: string } } };
}
const plain = (m: ChatMessageView) => m.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

describe('contextual chat', () => {
  it('a thread is bound to its anchor, version and pinned scope; answers go through the evidence pipeline', async () => {
    const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
    const th = await thread({ anchor: { source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id], quote: { exact: 'Ultrasound is the first-line imaging test in children' } } });
    expect(th.thread).toMatchObject({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, socratic: false, message_count: 0 });
    expect(th.thread.scope.version_ids).toEqual([lib.lecture.versionId]);
    ai.once('chat', (req) => {
      expect(req.prompt).toMatch(/label="SELECTION/);
      expect(req.prompt).toContain('OWNER REQUEST / QUESTION');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const r = await ask(th.thread.id, 'لماذا نبدأ بالأمواج فوق الصوتية عند الأطفال؟');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.owner_message).toMatchObject({ role: 'owner', status: 'final' });
    expect(r.json.answer).toMatchObject({ role: 'assistant', status: 'final', reply_to_id: r.json.owner_message.id });
    expect(r.json.answer.artifact).toMatchObject({ kind: 'chat_answer', status: 'published' });
    const claimRun = r.json.answer.content.paragraphs[0]!.runs.find((x) => x.claim)!;
    expect(r.json.answer.artifact!.claims[claimRun.claim!]!.verification_status).toBe('linked');

    // history: a follow-up sees this thread's turns as generated (non-evidence) context only
    ai.once('chat', (req) => {
      expect(req.prompt).toMatch(/label="CONVERSATION SO FAR \(this thread only; answers are generated, NOT evidence\)"/);
      expect(req.prompt).toContain('لماذا نبدأ بالأمواج');
      return content([{ kind: 'paragraph', sentences: [S.c('CT abdomen is preferred in adults when the diagnosis is uncertain.', [aliasFor(req, 'CT abdomen')], 'directly_stated')] }]);
    });
    const r2 = await ask(th.thread.id, 'ومتى نلجأ إلى CT؟', { style: 'short' });
    expect(r2.json.answer.style).toBe('short');
    const full = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/threads/${th.thread.id}`, headers: lib.h })).json() as ChatThreadResponse;
    expect(full.messages.map((m) => `${m.role}:${m.status}`)).toEqual(['owner:final', 'assistant:final', 'owner:final', 'assistant:final']);
    expect(full.thread.message_count).toBe(4);
    const list = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/threads?source_id=${lib.lecture.sourceId}&page_id=${us.page_id}`, headers: lib.h })).json();
    expect(list.threads.map((x: { id: string }) => x.id)).toContain(th.thread.id);
    // generated answers are searchable as generated content (never evidence)
    expect(lib.t.ctx.db.get<{ origin: string }>(`SELECT origin FROM owner_content_fts WHERE entity_type = 'message' AND entity_id = ?`, [r.json.answer.id])?.origin).toBe('generated');
  });

  it('Socratic mode asks for a hint + guiding question; LITERAL answers are verbatim quotes only', async () => {
    const th = await thread({ socratic: true, anchor: usAnchor() });
    ai.once('chat', (req) => {
      expect(req.prompt).toContain('SOCRATIC MODE');
      return content([
        { kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] },
        { kind: 'mini_question', sentences: [S.n('فكّر: لماذا نتجنب الإشعاع عند الأطفال؟')] },
      ]);
    });
    const r = await ask(th.thread.id, 'ما الفحص الأول عند الأطفال؟');
    expect(r.json.answer.artifact!.blocks.map((b) => b.kind)).toEqual(['paragraph', 'mini_question']);
    expect(plain(r.json.answer)).toContain('سؤال تحقق مولد');

    const lit = await thread({ style: 'literal', anchor: usAnchor() });
    ai.once('chat', (req) => {
      const e = aliasFor(req, 'Ultrasound is the first-line');
      const quote = evidenceIn(req.prompt).find((x) => x.alias === e)!.text.slice(0, 50).trim();
      return content([{ kind: 'paragraph', sentences: [S.c('صياغة حرة ليست اقتباسًا.', [e]), S.c(quote, [e], 'directly_stated', { original_quote: true })] }]);
    });
    const rl = await ask(lit.thread.id, 'ما الفحص الأول عند الأطفال؟');
    expect(rl.json.answer.artifact!.blocks.every((b) => b.kind === 'original_quote')).toBe(true);
    expect(plain(rl.json.answer)).not.toContain('صياغة حرة');
  });

  it('AC-05: lecture_only abstains WITHOUT a model call and suggests the explicit wider scope; no reuse across scopes', async () => {
    const th = await thread({});
    const before = ai.calls.length;
    const r = await ask(th.thread.id, "What is Murphy's sign in acute cholecystitis?");
    expect(r.status).toBe(200);
    expect(r.json.answer.status).toBe('abstained');
    expect(r.json.answer.abstain).toMatchObject({ reason: 'not_found_in_scope' });
    expect(r.json.answer.abstain!.detail).toContain('بُحث في');
    expect(r.json.answer.abstain!.suggest_scope).toMatchObject({ mode: 'lecture_plus_references', reference_source_ids: [lib.reference.sourceId] });
    expect(ai.calls.length).toBe(before); // no model call at all

    // the owner explicitly widens (a new thread in the suggested scope) → the reference is searched
    const wide = await thread({ scope: r.json.answer.abstain!.suggest_scope });
    ai.once('chat', (req) => content([{ kind: 'paragraph', sentences: [S.c("Murphy's sign is elicited under the right costal margin.", [aliasFor(req, 'Murphy')])] }]));
    const rw = await ask(wide.thread.id, "What is Murphy's sign in acute cholecystitis?");
    expect(rw.json.answer.status).toBe('final');
    const cited = Object.values(rw.json.answer.artifact!.claims).flatMap((c) => c.citations.map((x) => x.evidence.source_id));
    expect(cited).toContain(lib.reference.sourceId);

    // back in lecture_only: still abstains, never served the wider answer
    const again = await thread({});
    const n = ai.calls.length;
    const ra = await ask(again.thread.id, "What is Murphy's sign in acute cholecystitis?");
    expect(ra.json.answer.status).toBe('abstained');
    expect(ai.calls.length).toBe(n);
  });

  it('a real-patient question abstains with the educational notice', async () => {
    const th = await thread({});
    const before = ai.calls.length;
    const r = await ask(th.thread.id, 'My mother has right lower quadrant pain since yesterday, what dose should I give her?');
    expect(r.json.answer).toMatchObject({ status: 'abstained', abstain: { reason: 'real_patient_request' } });
    expect(ai.calls.length).toBe(before);
  });

  it('a failed generation leaves the answer rejected with its reason and no content (never shown as final)', async () => {
    const th = await thread({ anchor: usAnchor() });
    ai.once('chat', () => new Error('upstream down'));
    const r = await ask(th.thread.id, 'ما العلامات السريرية؟');
    expect(r.status).toBe(502);
    const full = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/threads/${th.thread.id}`, headers: lib.h })).json() as ChatThreadResponse;
    const ans = full.messages.find((m) => m.role === 'assistant')!;
    expect(ans.status).toBe('rejected');
    expect(ans.content.paragraphs).toHaveLength(0);
    expect(ans.artifact).toBeNull();
  });

  it('the pinned scope never drifts: a thread whose source left the scope refuses to continue', async () => {
    const th = await thread({ scope: { mode: 'lecture_plus_references', lecture_source_id: lib.lecture.sourceId, reference_source_ids: [lib.reference.sourceId] } });
    lib.t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [lib.t.clock.now(), lib.reference.sourceId]);
    try {
      const r = await ask(th.thread.id, 'سؤال بعد حذف المرجع');
      expect(r.status).toBe(409);
      expect(r.json.error!.code).toBe('OUT_OF_SCOPE');
      expect(r.json.error!.message).toContain('افتح محادثة جديدة');
    } finally {
      lib.t.ctx.db.run('UPDATE source SET deleted_at = NULL WHERE id = ?', [lib.reference.sourceId]);
    }
  });
});

describe('save AI answer as note (§28)', () => {
  it('creates an ai_answer note with its question, context, evidence, model, date and source versions; stays generated', async () => {
    const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
    const th = await thread({ anchor: { source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] } });
    ai.once('chat', (req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const r = await ask(th.thread.id, 'ما الفحص التصويري الأول عند الأطفال؟');
    const noteId = newId();
    const res = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${r.json.answer.id}/save-note`, headers: lib.h, payload: { note_id: noteId } });
    expect(res.statusCode, res.body).toBe(200);
    const note = res.json().note as NoteDTO;
    expect(note).toMatchObject({ id: noteId, origin: 'ai_answer' });
    expect(note.anchor).toMatchObject({ type: 'page', page_id: us.page_id, version_id: lib.lecture.versionId });
    const body = note.body.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(body).toContain('إجابة مولَّدة');
    expect(body).toContain('ليست مصدرًا مستقلًا');
    expect(body).toContain('السؤال: ما الفحص التصويري الأول');
    expect(body).toContain('الأدلة: محاضرة ص12');
    const rec = note.ai_record as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rec).toMatchObject({ kind: 'ai_answer', question: 'ما الفحص التصويري الأول عند الأطفال؟', model: 'fake-model-1' });
    expect(rec.evidence_ids.length).toBeGreaterThan(0);
    expect(rec.source_versions).toEqual([{ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, version_no: 1 }]);
    expect(rec.context).toMatchObject({ thread_id: th.thread.id, message_id: r.json.answer.id, page_id: us.page_id });
    expect(typeof rec.generated_at).toBe('number');
    // the note arrives on other devices through the normal sync feed and is searchable as generated
    const pull = (await lib.t.app.inject({ method: 'GET', url: '/api/sync/pull?since=0&limit=1000', headers: lib.h })).json();
    expect(pull.changes.some((c: { entity_type: string; entity_id: string }) => c.entity_type === 'note' && c.entity_id === noteId)).toBe(true);
    expect(lib.t.ctx.db.get<{ origin: string }>(`SELECT origin FROM owner_content_fts WHERE entity_type = 'note' AND entity_id = ?`, [noteId])?.origin).toBe('ai_answer');
    // idempotent: the same save again does not create a second note
    const again = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${r.json.answer.id}/save-note`, headers: lib.h, payload: { note_id: noteId } });
    expect(again.json().result).toBe('duplicate');
    expect(lib.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM note WHERE origin = 'ai_answer'`)!.n).toBe(1);
    // an abstention cannot be saved as an answer
    const th2 = await thread({});
    const ab = await ask(th2.thread.id, "What is Murphy's sign?");
    const bad = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${ab.json.answer.id}/save-note`, headers: lib.h, payload: { note_id: newId() } });
    expect(bad.statusCode).toBe(409);
  });
});

describe('not configured / budget', () => {
  it('without a provider every AI feature reports requires_configuration and the API says why', async () => {
    const t = await createStudyApp(null);
    try {
      const h = await t.login();
      const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json();
      for (const k of ['ai.explain', 'ai.chat', 'ai.study_book', 'ai.summaries', 'ai.figure_explain']) {
        expect(caps.features[k], k).toMatchObject({ state: 'requires_configuration', reason_ar: expect.stringContaining('ANTHROPIC_API_KEY') });
      }
      const th = await t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: h, payload: { scope: { mode: 'lecture_only', lecture_source_id: 'NOPE' }, anchor: null, style: 'detailed' } });
      expect(th.statusCode).toBe(409); // the lecture does not exist — scope first
    } finally {
      await t.close();
    }
  });

  it('a zero budget blocks the call with the budget reason (nothing generated)', async () => {
    const tight = new ScriptedAi();
    const other = await studyLibrary(tight, { env: { MEDLEVO_AI_MONTHLY_BUDGET_USD: '0' } });
    try {
      const th = (await other.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: other.h, payload: { scope: lectureOnly(other), anchor: null, style: 'detailed' } })).json() as ChatThreadResponse;
      const r = await other.t.app.inject({ method: 'POST', url: `/api/studybook/threads/${th.thread.id}/messages`, headers: other.h, payload: { text: 'ما الفحص الأول؟' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('AI_BUDGET_EXCEEDED');
      expect(r.json().error.message).toContain('الميزانية');
      expect(tight.calls).toHaveLength(0);
    } finally {
      await other.t.close();
    }
  });
});
