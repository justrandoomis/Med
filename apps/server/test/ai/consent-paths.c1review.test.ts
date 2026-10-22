// AOS-21.42 — review of track C1 (2026-10-22): the ai_processing consent on EVERY AI path, not only at the orchestrator.
// The builder's tests called ctx.ai.generateStructured directly. Here a provider whose data leaves the deployment
// (dataLeavesDeployment: true) is configured and every user-facing AI route is driven WITHOUT the user's consent:
// explain, explain as a stream, compare, the Study Book, summaries, chat and chat as a stream, question generation.
// Each must refuse before anything reaches the provider (provider.calls stays empty), and say so HONESTLY: the code is
// CONSENT_REQUIRED with details.kind 'ai_processing' — before this review the Study Book routes answered
// AI_BUDGET_EXCEEDED («بلغت الميزانية حدّها» on the explain panel) for a user who had spent nothing.
// Also: a call made outside any user's database (the root context of background work) never sends user content —
// the gate failed OPEN there (no content owner → no check) while the budget fell back to the deployment ceiling.
// Positive control: once the consent naming the provider is recorded, the same routes reach the provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AI_CONSENT_TEXT_VERSION, type ChatThreadResponse, type ResolvedScope } from '@medlevo/shared';
import { regionWith } from '../evidence/helpers';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';

class LeavingAi extends ScriptedAi {
  /** stands for a hosted API: what it is sent leaves the deployment */
  readonly dataLeavesDeployment = true;
}

const ai = new LeavingAi();
let lib: StudyLib;
let region: { id: string; page_id: string };
let ownerId: string;

beforeAll(async () => {
  lib = await studyLibrary(ai);
  const r = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  region = { id: r.id, page_id: r.page_id };
  ownerId = lib.t.ctx.system.users.findForAuth('owner')!.id;
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});

const anchor = () => ({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: region.page_id, region_ids: [region.id] });
const post = (url: string, payload: unknown) => lib.t.app.inject({ method: 'POST', url, headers: lib.h, payload: payload as object });

function expectConsentRefusal(res: { statusCode: number; body: string; json: () => unknown }, what: string): void {
  expect(res.statusCode, `${what}: ${res.body}`).toBe(409);
  const err = (res.json() as { error: { code: string; message: string; details?: { kind?: string } } }).error;
  expect(err.code, `${what}: ${res.body}`).toBe('CONSENT_REQUIRED');
  expect(err.details?.kind, what).toBe('ai_processing');
  expect(err.message, what).toContain('موافقتك');
}

describe('AOS-21.42 (review) — no AI route sends a user\'s content without their consent', () => {
  it('every Study Book route (explain, stream, compare, book, summary, chat, chat stream) refuses with CONSENT_REQUIRED; nothing is sent', async () => {
    expectConsentRefusal(await post('/api/studybook/explain', { action: 'explain', style: 'detailed', anchor: anchor(), scope: lectureOnly(lib) }), 'explain');
    expectConsentRefusal(await post('/api/studybook/explain/stream', { action: 'explain', style: 'detailed', anchor: anchor(), scope: lectureOnly(lib) }), 'explain/stream');
    expectConsentRefusal(await post('/api/studybook/compare', { items: ['Ultrasound', 'CT abdomen'], scope: lectureOnly(lib) }), 'compare');
    expectConsentRefusal(await post('/api/studybook/books', { source_id: lib.lecture.sourceId, scope: lectureOnly(lib) }), 'books');
    expectConsentRefusal(await post('/api/studybook/summaries', { type: 'detailed', source_id: lib.lecture.sourceId, scope: lectureOnly(lib) }), 'summaries');
    const th = await post('/api/studybook/threads', { scope: lectureOnly(lib), anchor: null, style: 'detailed' });
    expect(th.statusCode, th.body).toBe(200);
    const threadId = (th.json() as ChatThreadResponse).thread.id;
    expectConsentRefusal(await post(`/api/studybook/threads/${threadId}/messages`, { text: 'ما الفحص الأول؟' }), 'chat');
    expectConsentRefusal(await post(`/api/studybook/threads/${threadId}/messages/stream`, { text: 'ما الفحص الأول؟' }), 'chat/stream');
    expect(ai.calls).toHaveLength(0);
  });

  it('question generation (a background job of the vault) is refused at the provider gate: the run fails, nothing is sent', async () => {
    const res = await post('/api/exams/generate', { source_id: lib.lecture.sourceId, scope: lectureOnly(lib), count: 2 });
    // either refused at the route, or the job runs and fails at the gate — never a provider call
    if (res.statusCode === 200 || res.statusCode === 202) await lib.t.ctx.jobs.drain();
    expect(ai.calls).toHaveLength(0);
  });

  it('outside any database (the root context of background work) nothing is sent either', async () => {
    const scope: ResolvedScope = { mode: 'lecture_only', sourceIds: ['S1'], versionIds: ['V1'], versionBySource: { S1: 'V1' }, allowExternal: false, includeMyNotes: false, hash: 'h', describeAr: 'المحاضرة فقط' };
    // the consent of user #1 exists, but a call in the root context carries nobody's consent
    lib.t.ctx.system.consents.grantAiProcessing({ userId: ownerId, deviceId: null, isPlatformAdmin: true }, ['fake'], AI_CONSENT_TEXT_VERSION);
    try {
      await expect(
        lib.t.ctx.binding.runRoot(() =>
          lib.t.ctx.ai.generateStructured({ task: 'summarize', schema: z.object({ s: z.string() }), system: 's', input: [{ label: 'x', text: 'PRIVATE 4471' }], scope, sourceVersionIds: ['V1'] }),
        ),
      ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(ai.calls).toHaveLength(0);
    } finally {
      lib.t.ctx.system.consents.revokeAiProcessing({ userId: ownerId, deviceId: null, isPlatformAdmin: true });
    }
  });

  it('positive control: with the consent naming the provider the same route reaches it', async () => {
    lib.t.ctx.system.consents.grantAiProcessing({ userId: ownerId, deviceId: null, isPlatformAdmin: true }, ['fake'], AI_CONSENT_TEXT_VERSION);
    ai.once('explain', (req) => {
      const e = aliasFor(req, 'Ultrasound is the first-line');
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [e], 'directly_stated')] }]);
    });
    const res = await post('/api/studybook/explain', { action: 'explain', style: 'detailed', anchor: anchor(), scope: lectureOnly(lib) });
    expect(res.statusCode, res.body).toBe(200);
    expect(ai.calls.length).toBeGreaterThan(0);
  });
});

describe('AOS-21.42 (review) — a consent covers the text it was given to', () => {
  it('a consent recorded for an EARLIER consent text does not cover sending now; the view says it is not granted', async () => {
    // the row as an earlier release recorded it (the PUT route accepts only the current text version)
    lib.t.ctx.system.consents.grantAiProcessing({ userId: ownerId, deviceId: null, isPlatformAdmin: true }, ['fake'], 'ai-processing-2026-01-01');
    try {
      const before = ai.calls.length;
      const res = await post('/api/studybook/compare', { items: ['Ultrasound', 'CT abdomen'], scope: lectureOnly(lib) });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('CONSENT_REQUIRED');
      expect(ai.calls.length).toBe(before);
      const view = await lib.t.app.inject({ method: 'GET', url: '/api/accounts/me/ai-consent', headers: lib.h });
      expect(view.json()).toMatchObject({ granted: false, text_version: 'ai-processing-2026-01-01', current_text_version: AI_CONSENT_TEXT_VERSION });
    } finally {
      lib.t.ctx.system.consents.revokeAiProcessing({ userId: ownerId, deviceId: null, isPlatformAdmin: true });
    }
  });
});
