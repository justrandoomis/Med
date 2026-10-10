// G2 / AC-05 — Source Lock: a question whose answer is NOT in the lecture but IS in a reference outside the lock.
// The system abstains inside «Lecture Only» and never serves a cached result produced under a wider scope.
// Real pipeline on the Golden Set (appendicitis lecture; the cholecystitis reference — the only place that
// mentions Murphy's sign — linked to the lecture as `reference_for`). AI = the TEST-ONLY scripted provider
// (no key exists here): the generator is scripted to misbehave (answer from memory), the verifier to be honest.
// Adversarial angles beyond the module tests: the realistic rail path (a thread / explanation ANCHORED on a lecture
// page — retrieval always returns the page, so the model IS called), a request that smuggles the reference in
// through `reference_source_ids` / `version_pins` / unknown keys, an Arabic question, and the cache after an
// explicit widening (explain + chat + Study Book).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatPostResponse, ChatThreadResponse, ExplainResponse, ScopeResolveResponse, StudyArtifactView, StudyBookView } from '@medlevo/shared';
import { linkReference, regionWith } from '../evidence/helpers';
import { aliasFor, content, evidenceIn, lectureOnly, regionsIn, S, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
const Q = "What is Murphy's sign and how is it elicited?";
const REF_ONLY = /Murphy|costal margin|gallstones|Cholecystitis/i;

beforeAll(async () => {
  lib = await studyLibrary(ai);
  linkReference(lib.t, lib.lecture.sourceId, lib.reference.sourceId);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  ai.verdict = () => 'supported';
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

const post = async <T>(url: string, payload: unknown): Promise<{ status: number; body: T & { error?: { code: string; message: string } } }> => {
  const res = await lib.t.app.inject({ method: 'POST', url, headers: lib.h, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
};
const widerScope = () => ({ mode: 'lecture_plus_references' as const, lecture_source_id: lib.lecture.sourceId, reference_source_ids: [lib.reference.sourceId] });
const lecturePage = (i: number) => lib.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = ?', [lib.lecture.versionId, i])!.id;
/** the anchor the rail's chat uses when nothing is selected: the current page */
const pageAnchor = (i = 0) => ({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: lecturePage(i), region_ids: [] as string[] });
const thread = async (scope: object, anchor: object | null = pageAnchor()) => {
  const r = await post<ChatThreadResponse>('/api/studybook/threads', { scope, anchor, style: 'detailed' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.thread;
};
const ask = async (threadId: string, text = Q) => post<ChatPostResponse>(`/api/studybook/threads/${threadId}/messages`, { text });
const citationsOf = (a: StudyArtifactView) => Object.values(a.claims).flatMap((c) => c.citations.map((x) => x.evidence));
const textOf = (a: StudyArtifactView) => a.blocks.map((b) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n')).join('\n');

describe('G2 AC-05 — the lock itself', () => {
  it('«Lecture Only» resolves to the lecture alone, whatever else the request carries (reference ids, pins, smuggled keys)', async () => {
    const r = await post<ScopeResolveResponse>('/api/evidence/scope/resolve', {
      mode: 'lecture_only',
      lecture_source_id: lib.lecture.sourceId,
      reference_source_ids: [lib.reference.sourceId],
      version_pins: { [lib.reference.sourceId]: lib.reference.versionId },
      include_my_notes: false,
      // keys a client (or a document-driven agent) might try; stripped by the schema
      versionIds: [lib.reference.versionId],
      sourceIds: [lib.reference.sourceId],
      allow_external: true,
      allowExternal: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.scope.versionIds).toEqual([lib.lecture.versionId]);
    expect(r.body.sources.map((s) => s.source_id)).toEqual([lib.lecture.sourceId]);
    // the explicit wider scope does include the linked reference (so the difference is real)
    const wide = await post<ScopeResolveResponse>('/api/evidence/scope/resolve', { mode: 'lecture_plus_references', lecture_source_id: lib.lecture.sourceId });
    expect(wide.body.sources.map((s) => s.source_id).sort()).toEqual([lib.lecture.sourceId, lib.reference.sourceId].sort());
    // pinning the LECTURE to the reference's version is refused, never silently honoured
    const pin = await post('/api/evidence/scope/resolve', { mode: 'lecture_only', lecture_source_id: lib.lecture.sourceId, version_pins: { [lib.lecture.sourceId]: lib.reference.versionId } });
    expect(pin.status).toBe(400);
    // external evidence is not enabled → refused with a reason (never a silent fallback to «everything»)
    const ext = await post('/api/evidence/scope/resolve', { mode: 'external', lecture_source_id: lib.lecture.sourceId });
    expect(ext.status).toBe(409);
    expect(ext.body.error!.code).toBe('FEATURE_DISABLED');
  });
});

describe('G2 AC-05 — asked from a lecture page (anchored: the model IS called with the lecture page)', () => {
  it('chat: the reference never reaches the model; an answer «from memory» is rejected; the abstention offers the explicit wider scope', async () => {
    const th = await thread(lectureOnly(lib));
    let promptSeen = '';
    ai.once('chat', (req) => {
      promptSeen = req.prompt;
      const ev = evidenceIn(req.prompt);
      expect(ev.length).toBeGreaterThan(0); // the anchored page is evidence…
      expect(ev.some((e) => REF_ONLY.test(e.text))).toBe(false); // …the reference is not
      // a generator that ignores the lock and answers from its own knowledge, citing a lecture excerpt
      return content([{ kind: 'paragraph', sentences: [S.c("Murphy's sign is inspiratory arrest on palpation under the right costal margin.", [ev[0]!.alias], 'derived')] }]);
    });
    ai.verdict = (text) => (/Murphy/.test(text) ? 'not_supported' : 'supported');
    const r = await ask(th.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(promptSeen).not.toMatch(/costal margin during inspiration|gallstones/);
    expect(r.body.answer.status).toBe('abstained');
    expect(r.body.answer.abstain?.reason).toBe('insufficient_evidence');
    const a = r.body.answer.artifact!;
    expect(a.scope.version_ids).toEqual([lib.lecture.versionId]);
    expect(textOf(a)).not.toMatch(/Murphy/);
    expect(citationsOf(a)).toHaveLength(0);
    // §08: «say so and suggest widening the scope through a clear action of mine»
    expect(r.body.answer.abstain?.suggest_scope).toMatchObject({ mode: 'lecture_plus_references', lecture_source_id: lib.lecture.sourceId, reference_source_ids: [lib.reference.sourceId] });
  });

  it('chat: the generator itself says «not in the lecture» → abstained, with the explicit wider-scope action', async () => {
    const th = await thread(lectureOnly(lib));
    ai.once('chat', () => ({ blocks: [], abstain: { reason: 'not_found_in_scope', detail: 'The lecture excerpts do not describe this sign.' } }));
    const r = await ask(th.id);
    expect(r.body.answer.status).toBe('abstained');
    expect(r.body.answer.abstain).toMatchObject({ reason: 'not_found_in_scope' });
    expect(r.body.answer.abstain?.suggest_scope).toMatchObject({ mode: 'lecture_plus_references', reference_source_ids: [lib.reference.sourceId] });
  });

  it('explain on the page with the question as instruction: same abstention + wider-scope action; nothing from the reference in the prompt', async () => {
    ai.once('explain', (req) => {
      expect(evidenceIn(req.prompt).some((e) => REF_ONLY.test(e.text))).toBe(false);
      return content([{ kind: 'paragraph', sentences: [S.c("Murphy's sign is elicited under the right costal margin.", [evidenceIn(req.prompt)[0]!.alias])] }]);
    });
    ai.verdict = (text) => (/Murphy/.test(text) ? 'not_supported' : 'supported');
    const r = await post<ExplainResponse>('/api/studybook/explain', { action: 'explain', style: 'detailed', anchor: pageAnchor(0), scope: lectureOnly(lib), instruction: Q });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.artifact.abstain?.reason).toBe('insufficient_evidence');
    expect(r.body.artifact.abstain?.suggest_scope).toMatchObject({ mode: 'lecture_plus_references', reference_source_ids: [lib.reference.sourceId] });
    expect(citationsOf(r.body.artifact)).toHaveLength(0);
  });

  it('Arabic question (لا توجد في المحاضرة): compare finds it only outside the lock → abstains WITHOUT a model call + wider-scope action', async () => {
    const before = ai.calls.length;
    const r = await post<ExplainResponse>('/api/studybook/compare', { items: ['علامة مورفي (Murphy)', 'costal margin'], scope: lectureOnly(lib), style: 'detailed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.artifact.abstain).toMatchObject({ reason: 'not_found_in_scope' });
    expect(r.body.artifact.abstain!.detail).toMatch(/بُحث في/);
    expect(r.body.artifact.abstain!.suggest_scope).toMatchObject({ mode: 'lecture_plus_references' });
    expect(ai.calls.length).toBe(before);
  });
});

describe('G2 AC-05 — no cache from an earlier, wider mode', () => {
  it('chat: after an explicit widening answered from the reference, a new Lecture Only conversation abstains and never sees that answer', async () => {
    const wide = await thread(widerScope());
    ai.once('chat', (req) => content([{ kind: 'paragraph', sentences: [S.c("Murphy's sign is elicited by palpation under the right costal margin during inspiration.", [aliasFor(req, 'Murphy')], 'directly_stated')] }]));
    const rw = await ask(wide.id);
    expect(rw.body.answer.status, JSON.stringify(rw.body.answer)).toBe('final');
    expect(citationsOf(rw.body.answer.artifact!).map((e) => e.source_id)).toContain(lib.reference.sourceId);

    const narrow = await thread(lectureOnly(lib));
    ai.once('chat', (req) => {
      // neither the reference nor the wider conversation's answer is in the narrow request
      expect(req.prompt).not.toMatch(/costal margin|gallstones/);
      return { blocks: [], abstain: { reason: 'not_found_in_scope', detail: 'not in the lecture' } };
    });
    const rn = await ask(narrow.id);
    expect(rn.body.answer.status).toBe('abstained');
    expect(rn.body.answer.artifact!.scope.version_ids).toEqual([lib.lecture.versionId]);
    // a lecture-only thread cannot be pointed at the wider thread's lock afterwards either
    const drift = await post(`/api/studybook/threads/${narrow.id}/messages`, { text: Q, scope: widerScope() });
    expect(drift.status).toBe(400); // unknown key `scope` → the message body cannot change a thread's lock
  });

  it('explain: the same request first under «Lecture + References», then «Lecture Only» → not served from the cache', async () => {
    const us = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
    const anchor = { source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] };
    ai.once('explain', (req) =>
      content([
        { kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children and in pregnant women.', [aliasFor(req, 'Ultrasound is the first-line imaging')], 'directly_stated')] },
      ]),
    );
    const wide = await post<ExplainResponse>('/api/studybook/explain', { action: 'explain', style: 'short', anchor, scope: widerScope(), instruction: 'compare with gallstones' });
    expect(wide.status, JSON.stringify(wide.body)).toBe(200);
    expect(wide.body.artifact.scope.mode).toBe('lecture_plus_references');
    const again = await post<ExplainResponse>('/api/studybook/explain', { action: 'explain', style: 'short', anchor, scope: widerScope(), instruction: 'compare with gallstones' });
    expect(again.body.cached).toBe(true); // the cache works for the SAME lock…
    let narrowPrompt = '';
    ai.once('explain', (req) => {
      narrowPrompt = req.prompt;
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children and in pregnant women.', [aliasFor(req, 'Ultrasound is the first-line imaging')], 'directly_stated')] }]);
    });
    const narrow = await post<ExplainResponse>('/api/studybook/explain', { action: 'explain', style: 'short', anchor, scope: lectureOnly(lib), instruction: 'compare with gallstones' });
    expect(narrow.body.cached).toBe(false); // …never across locks
    expect(narrow.body.artifact.id).not.toBe(wide.body.artifact.id);
    expect(narrow.body.artifact.scope.version_ids).toEqual([lib.lecture.versionId]);
    // the owner's own words («gallstones») are in the request; no excerpt of the reference is
    expect(evidenceIn(narrowPrompt).some((e) => REF_ONLY.test(e.text))).toBe(false);
    expect(narrowPrompt).not.toMatch(/suspected gallstones|costal margin/);
    expect(citationsOf(narrow.body.artifact).every((e) => e.source_id === lib.lecture.sourceId)).toBe(true);
    // Explain Until Understood cannot feed the wider explanation back into a lecture-only request
    const retry = await post('/api/studybook/explain', { action: 'explain', style: 'short', anchor, scope: lectureOnly(lib), retry_of: { artifact_id: wide.body.artifact.id, strategy: 'smaller_steps' } });
    expect(retry.status).toBe(409);
    expect(retry.body.error!.code).toBe('OUT_OF_SCOPE');
  });

  it('Study Book: a book generated with the references is never served to a Lecture Only request; its job never sees the reference', async () => {
    const prompts: string[] = [];
    ai.always('study_book', (req) => {
      prompts.push(req.prompt);
      const r = regionsIn(req.prompt).find((x) => x.alias);
      if (!r) return { blocks: [], abstain: { reason: 'insufficient_evidence', detail: 'no evidence' } };
      const first = r.text.replace(/^\[E\d+\] \[R\d+\]\n/, '').split(/(?<=[.!?؟])\s+/)[0]!.trim().slice(0, 200);
      return content([{ kind: 'paragraph', sentences: [S.c(first, [r.alias!], 'directly_stated')], explains_regions: [r.region] }]);
    });
    const wideRes = await post<{ book: StudyBookView; cached: boolean }>('/api/studybook/books', { source_id: lib.lecture.sourceId, scope: widerScope() });
    expect(wideRes.status, JSON.stringify(wideRes.body)).toBe(200);
    await lib.t.ctx.jobs.drain();
    const wideId = wideRes.body.book.artifact.id;
    prompts.length = 0;
    const narrowRes = await post<{ book: StudyBookView; cached: boolean }>('/api/studybook/books', { source_id: lib.lecture.sourceId, scope: lectureOnly(lib) });
    expect(narrowRes.status, JSON.stringify(narrowRes.body)).toBe(200);
    expect(narrowRes.body.cached).toBe(false);
    expect(narrowRes.body.book.artifact.id).not.toBe(wideId);
    expect(narrowRes.body.book.artifact.scope.mode).toBe('lecture_only');
    await lib.t.ctx.jobs.drain();
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).not.toMatch(/costal margin|gallstones/);
    // a repeated lecture-only request reuses the lecture-only book (same lock), never the wider one
    const again = await post<{ book: StudyBookView; cached: boolean }>('/api/studybook/books', { source_id: lib.lecture.sourceId, scope: lectureOnly(lib) });
    if (again.body.cached) expect(again.body.book.artifact.id).toBe(narrowRes.body.book.artifact.id);
    expect(again.body.book.artifact.id).not.toBe(wideId);
  });
});
