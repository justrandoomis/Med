// Independent review of track C2 — regression tests for the issues it confirmed (see docs/modules/studybook.md
// «Independent review»). Golden Set sources through the real pipeline; the TEST-ONLY ScriptedAi as the model.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatThreadResponse, ExplainResponse, StudyArtifactView, StudyBookView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { ProviderError } from '../../src/modules/ai/types';
import { regionWith } from '../evidence/helpers';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
let us: { id: string; page_id: string; text: string };

beforeAll(async () => {
  lib = await studyLibrary(ai);
  const r = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
  us = { id: r.id, page_id: r.page_id, text: r.text };
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

const anchorUs = () => ({ source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: us.page_id, region_ids: [us.id] });
const runsText = (a: StudyArtifactView) => a.blocks.map((b) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n')).join('\n');
const tableText = (a: StudyArtifactView) =>
  a.blocks
    .flatMap((b) => (b.table ? [...b.table.header, ...b.table.rows.flat()] : []))
    .map((rt) => rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(''))
    .join('\n');

async function explain(body: Record<string, unknown>): Promise<{ status: number; json: ExplainResponse & { error?: { code: string; message: string } } }> {
  const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/explain', headers: lib.h, payload: { action: 'explain', style: 'detailed', anchor: anchorUs(), scope: lectureOnly(lib), ...body } });
  return { status: res.statusCode, json: res.json() };
}

describe('claim-less sentences inside medical content (§0.1, AC-29)', () => {
  it('a medical statement the generator marked claim:null is not published uncited; short connective text and questions stay', async () => {
    ai.once('explain', (req) => {
      const e = aliasFor(req, 'Ultrasound is the first-line');
      return content([
        { kind: 'heading', sentences: [S.n('Investigations')] },
        {
          kind: 'paragraph',
          sentences: [
            S.c('Ultrasound is the first-line imaging test in children.', [e], 'directly_stated'),
            S.n('Appendicitis is always treated with antibiotics alone and never needs surgery.'),
            S.n('تُعالج الزائدة الملتهبة بالمضادات الحيوية وحدها دون جراحة في كل الحالات.'),
            S.n('لنرَ لماذا.'),
            S.n('ما الفحص الذي تختاره أولًا عند طفل؟'),
          ],
        },
        { kind: 'exam_pearl', sentences: [S.n('CT is never needed in pregnant women with suspected appendicitis.')] },
        { kind: 'mini_question', sentences: [S.n('فكّر: لماذا نتجنب الإشعاع عند الأطفال؟')] },
      ]);
    });
    const r = await explain({ instruction: 'مراجعة: جمل بلا دليل' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const a = r.json.artifact;
    const text = runsText(a);
    expect(text).toContain('Ultrasound is the first-line');
    expect(text).not.toContain('antibiotics alone');
    expect(text).not.toContain('بالمضادات الحيوية وحدها');
    expect(text).not.toContain('pregnant women');
    // connective text and questions to the learner are kept
    expect(text).toContain('لنرَ لماذا.');
    expect(text).toContain('ما الفحص الذي تختاره أولًا عند طفل؟');
    expect(text).toContain('Investigations');
    expect(a.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'mini_question']);
    // the dropped sentences are reported (shown on demand, never as supported)
    const removed = a.removed.map((x) => x.text);
    expect(removed).toEqual(expect.arrayContaining(['Appendicitis is always treated with antibiotics alone and never needs surgery.', 'CT is never needed in pregnant women with suspected appendicitis.']));
    expect(a.removed.find((x) => x.text.includes('antibiotics alone'))!.reason_ar).toContain('بلا دليل');
  });

  it('comparison cells: an uncited statement in an item column becomes the honest placeholder; aspect labels stay', async () => {
    ai.once('compare', (req) => {
      const usA = aliasFor(req, 'Ultrasound is the first-line');
      return content([
        {
          kind: 'comparison_table',
          sentences: [],
          table: {
            header: ['الجانب', 'Ultrasound', 'CT abdomen'],
            rows: [
              [S.n('متى يُستخدم'), S.c('Ultrasound is the first-line imaging test in children.', [usA], 'directly_stated'), S.n('CT abdomen is the gold standard for every adult patient.')],
              [S.n('Radiation'), S.n('غير مذكور في المصادر المسموحة'), S.n('غير مذكور في المصادر المسموحة')],
            ],
          },
        },
      ]);
    });
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/compare', headers: lib.h, payload: { items: ['Ultrasound', 'CT abdomen'], scope: lectureOnly(lib), instruction: 'مراجعة الخلايا' } });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().artifact as StudyArtifactView;
    const t = tableText(a);
    expect(t).not.toContain('gold standard');
    expect(t).toContain('غير مثبت في المصادر المسموحة');
    expect(t).toContain('Radiation'); // an aspect label (first column) is not a claim
    expect(a.removed.some((x) => x.text.includes('gold standard'))).toBe(true);
  });
});

describe('Explain Until Understood stays in its lineage', () => {
  it('retry_of must be an explanation of the same source', async () => {
    const other = lib.t.ctx.db.run(
      `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, is_frozen, created_at, updated_at)
       VALUES ('review_other_art', 'review_other_art', 1, 'explanation', 'شرح من مصدر آخر', ?, '{}', '{}', 'k-review', 'r', 'g', 'v', 'published', 0, 1, 1)`,
      [lib.reference.sourceId],
    );
    expect(other.changes).toBe(1);
    const before = ai.calls.length;
    const r = await explain({ retry_of: { artifact_id: 'review_other_art', strategy: 'analogy' } });
    expect(r.status).toBe(400);
    expect(r.json.error!.code).toBe('BAD_REQUEST');
    expect(ai.calls.length).toBe(before);
  });
});

describe('cache key includes the owner terminology injected into the prompt (§21, ARCHITECTURE §3.7)', () => {
  it('a new preferred rendering for a term in the selection is a new key (the old explanation is not reused)', async () => {
    ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const first = await explain({ instruction: 'مفتاح المصطلحات' });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect((await explain({ instruction: 'مفتاح المصطلحات' })).json.cached).toBe(true);
    const add = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/terms', headers: lib.h, payload: { term_en: 'Ultrasound', owner_preferred_ar: 'السونار' } });
    expect(add.statusCode, add.body).toBe(200);
    let prompt = '';
    ai.once('explain', (req) => {
      prompt = req.prompt;
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const after = await explain({ instruction: 'مفتاح المصطلحات' });
    expect(after.json.cached).toBe(false);
    expect(prompt).toContain('Ultrasound → السونار');
    const id = add.json().term.id as string;
    await lib.t.app.inject({ method: 'DELETE', url: `/api/studybook/terms/${id}`, headers: lib.h });
  });
});

describe('figures without vision: nothing verified → an abstention, not an empty «explained» result', () => {
  it('a caption-only explanation whose sentences all fail verification abstains (the warning alone is not an explanation)', async () => {
    const noVision = new ScriptedAi({ unsupported: ['vision_figure'] });
    const other = await studyLibrary(noVision);
    try {
      const fig = other.t.ctx.db.get<{ id: string; page_id: string }>(`SELECT id, page_id FROM source_region WHERE version_id = ? AND kind = 'figure' LIMIT 1`, [other.lecture.versionId])!;
      noVision.once('explain', () => content([{ kind: 'paragraph', sentences: [S.c('The figure shows a perforated appendix in 90% of children.', ['E99'])] }]));
      const res = await other.t.app.inject({
        method: 'POST',
        url: '/api/studybook/explain',
        headers: other.h,
        payload: { action: 'explain_image', style: 'detailed', anchor: { source_id: other.lecture.sourceId, version_id: other.lecture.versionId, page_id: fig.page_id, region_ids: [fig.id] }, scope: lectureOnly(other) },
      });
      expect(res.statusCode, res.body).toBe(200);
      const a = res.json().artifact as StudyArtifactView;
      expect(a.abstain).toMatchObject({ reason: 'insufficient_evidence' });
      expect(a.blocks).toHaveLength(0);
      expect(a.removed.some((x) => x.text.includes('perforated appendix'))).toBe(true);
    } finally {
      await other.t.close();
    }
  });
});

describe('contextual chat hardening', () => {
  it('a thread anchor with regions of another version is refused (never bound to a foreign region)', async () => {
    const ref = regionWith(lib.t, lib.reference.versionId, 'Murphy');
    const res = await lib.t.app.inject({
      method: 'POST',
      url: '/api/studybook/threads',
      headers: lib.h,
      payload: { scope: lectureOnly(lib), style: 'detailed', anchor: { ...anchorUs(), region_ids: [us.id, ref.id] } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OUT_OF_SCOPE');
  });

  it('an answer whose generation was interrupted long ago is shown as not completed, never as still being written', async () => {
    const th = (await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: lib.h, payload: { scope: lectureOnly(lib), style: 'detailed', anchor: anchorUs() } })).json() as ChatThreadResponse;
    const old = lib.t.ctx.clock.now() - 60 * 60 * 1000;
    const msgId = newId();
    lib.t.ctx.db.run(
      `INSERT INTO message (id, thread_id, role, content_json, status, abstain_reason, artifact_id, created_at, style, reply_to_id, detail_json, updated_at)
       VALUES (?, ?, 'assistant', '{"v":1,"paragraphs":[]}', 'verifying', NULL, NULL, ?, 'detailed', NULL, NULL, ?)`,
      [msgId, th.thread.id, old, old],
    );
    const full = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/threads/${th.thread.id}`, headers: lib.h })).json() as ChatThreadResponse;
    const m = full.messages.find((x) => x.id === msgId)!;
    expect(m.status).toBe('rejected');
    expect(m.content.paragraphs).toHaveLength(0);
  });

  it('save-as-note never targets another existing note (no overwrite, no resurrection of a deleted note)', async () => {
    const th = (await lib.t.app.inject({ method: 'POST', url: '/api/studybook/threads', headers: lib.h, payload: { scope: lectureOnly(lib), style: 'detailed', anchor: anchorUs() } })).json() as ChatThreadResponse;
    ai.once('chat', (req) => content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]));
    const ans = (await lib.t.app.inject({ method: 'POST', url: `/api/studybook/threads/${th.thread.id}/messages`, headers: lib.h, payload: { text: 'ما الفحص الأول؟' } })).json();
    expect(ans.answer.status).toBe('final');
    // the owner's own note, later deleted (in the trash)
    const ownId = newId();
    const push = await lib.t.app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: lib.h,
      payload: { ops: [{ op_id: newId(), device_id: 'dev-review', entity_type: 'note', entity_id: ownId, op: 'upsert', payload: { body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'كتابتي الخاصة' }] }] }, title: 'ملاحظتي' } }] },
    });
    expect(push.json().results[0].result).toBe('applied');
    lib.t.ctx.db.run('UPDATE note SET deleted_at = ? WHERE id = ?', [lib.t.ctx.clock.now(), ownId]);
    const before = lib.t.ctx.db.get<{ body_json: string; origin: string; deleted_at: number | null }>('SELECT body_json, origin, deleted_at FROM note WHERE id = ?', [ownId])!;
    const res = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${ans.answer.id}/save-note`, headers: lib.h, payload: { note_id: ownId } });
    expect(res.statusCode).toBe(409);
    expect(lib.t.ctx.db.get('SELECT body_json, origin, deleted_at FROM note WHERE id = ?', [ownId])).toEqual(before);
    // a fresh id still works, and saving the same answer again with that id is idempotent
    const fresh = newId();
    const ok = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${ans.answer.id}/save-note`, headers: lib.h, payload: { note_id: fresh } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().note.id).toBe(fresh);
    const again = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/messages/${ans.answer.id}/save-note`, headers: lib.h, payload: { note_id: fresh } });
    expect(again.statusCode).toBe(200);
    expect(again.json().result).toBe('duplicate');
  });
});

describe('Study Book job: a non-retryable provider failure fails that section once (no blind paid retries)', () => {
  it('a refusal on one section → that section failed with the reason, the others published, the model asked once for it', async () => {
    let n = 0;
    ai.always('study_book', (req) => {
      n++;
      if (n === 1) return new ProviderError('refusal', { model: 'fake-model-1' });
      const ev = /\n\[(E\d+)\](?: \[R\d+\])?\n([^\n]+)/.exec(req.prompt);
      if (!ev) return content([], { abstain: { reason: 'insufficient_evidence', detail: 'لا نص' } });
      const first = (ev[2]!.split(/(?<=[.!?؟])\s+/)[0] ?? '').trim().slice(0, 200);
      return content([{ kind: 'paragraph', sentences: [S.c(first, [ev[1]!], 'directly_stated')] }]);
    });
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/books', headers: lib.h, payload: { source_id: lib.lecture.sourceId, scope: lectureOnly(lib) } });
    expect(res.statusCode, res.body).toBe(200);
    const created = res.json().book as StudyBookView;
    await lib.t.ctx.jobs.drain();
    const v = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books/${created.artifact.id}`, headers: lib.h })).json() as StudyBookView;
    const total = v.sections.length;
    expect(total).toBeGreaterThan(1);
    expect(n).toBe(total); // the refused section was asked once, not once per job attempt
    expect(v.job?.attempts).toBe(1);
    const failed = v.sections.filter((s) => s.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail_ar).toContain('امتنع');
    expect(v.artifact.status).toBe('partial');
  });
});
