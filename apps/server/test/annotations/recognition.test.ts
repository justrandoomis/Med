// Track F4 — handwriting recognition (§28, §41, §46) with the TEST-ONLY FakeAiProvider: derived storage (the ink is
// never touched), uncertain words, corrections that keep the machine reading, search in handwriting with its origin,
// honest abstentions, «اسأل عن المحدد» context, and handwritten written answers confirmed before grading.
import { deflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId, type AskContextResponse, type InkRecognitionView, type SearchResponse, type WrittenAttemptResponse } from '@medlevo/shared';
import { createQuestion } from '../../src/modules/questions/service';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { FakeAiProvider } from '../helpers/fake-ai';
import { createSourceFixture, inkPayload, op, type SourceFixture } from './helpers';

/** A real (tiny) PNG: IHDR + IDAT + IEND. */
function png(w = 64, h = 32): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h, 0xff);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_B64 = png().toString('base64');

const reading = (lines: Array<Array<[string, boolean?]>>, language: 'ar' | 'en' | 'mixed' = 'mixed') => ({
  json: { status: 'recognized', language, lines: lines.map((l) => ({ words: l.map(([text, uncertain]) => ({ text, uncertain: !!uncertain })) })), reason: null },
});

let t: TestApp;
let h: AuthHeaders;
let f: SourceFixture;
let ai: FakeAiProvider;

const get = (url: string) => t.app.inject({ method: 'GET', url, headers: h });
const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers: h, payload: payload as never });
const patch = (url: string, payload: unknown) => t.app.inject({ method: 'PATCH', url, headers: h, payload: payload as never });
const count = (sql: string, params: unknown[] = []) => t.ctx.db.get<{ n: number }>(sql, params)!.n;

async function stroke(x = 0.6): Promise<string> {
  const id = newId();
  const res = await post('/api/sync/push', { ops: [op({ entity_type: 'annotation', entity_id: id, op: 'append', payload: inkPayload(f, { x }) })] });
  expect(res.json().results[0].result).toBe('applied');
  return id;
}

function pageReq(annotationIds: string[], extra: Record<string, unknown> = {}) {
  return {
    id: newId(),
    purpose: 'page_ink',
    lang: 'mixed',
    annotation_ids: annotationIds,
    anchor: { type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[0], page_index: 0 },
    bbox: { x: 0.6, y: 0.29, w: 0.12, h: 0.04 },
    image_png_base64: PNG_B64,
    ...extra,
  };
}

async function recognize(annotationIds: string[], extra: Record<string, unknown> = {}): Promise<InkRecognitionView> {
  const res = await post('/api/annotations/recognitions', pageReq(annotationIds, extra));
  expect(res.statusCode).toBe(202);
  await t.ctx.jobs.drain();
  return (await get(`/api/annotations/recognitions/${res.json().recognition.id}`)).json().recognition as InkRecognitionView;
}

async function search(q: string): Promise<SearchResponse> {
  return (await get(`/api/search?q=${encodeURIComponent(q)}&types=handwriting`)).json() as SearchResponse;
}

describe('capability without a vision provider', () => {
  beforeEach(async () => {
    t = await createTestApp();
    h = await t.login();
    f = createSourceFixture(t);
  });
  afterEach(async () => t.close());

  it('is requires_configuration with an Arabic reason; a request is refused and nothing is stored', async () => {
    const caps = (await get('/api/capabilities')).json();
    expect(caps.features['workspace.handwriting_recognition'].state).toBe('requires_configuration');
    expect(caps.features['workspace.handwriting_recognition'].reason_ar).toMatch(/vision/);
    const id = await stroke();
    const res = await post('/api/annotations/recognitions', pageReq([id]));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('AI_NOT_CONFIGURED');
    expect(res.json().error.message).toMatch(/[؀-ۿ]/);
    expect(count('SELECT COUNT(*) AS n FROM ink_recognition')).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM processing_job WHERE kind = 'ink.recognize'`)).toBe(0);
  });

  it('a configured provider that cannot read pictures still leaves it requires_configuration (with the reason)', async () => {
    await t.close();
    t = await createTestApp({ ai: new FakeAiProvider({ supports: ['explain', 'chat'] }) });
    h = await t.login();
    const cap = (await get('/api/capabilities')).json().features['workspace.handwriting_recognition'];
    expect(cap.state).toBe('requires_configuration');
    expect(cap.reason_ar).toMatch(/لا يدعمها/);
  });
});

describe('with the test-only FakeAiProvider', () => {
  beforeEach(async () => {
    ai = new FakeAiProvider();
    t = await createTestApp({ ai, jobs: { backoffBaseMs: 0, backoffMaxMs: 0 } });
    h = await t.login();
    f = createSourceFixture(t);
  });
  afterEach(async () => t.close());

  it('stores a DERIVED reading: the strokes stay untouched, uncertain words are marked, the sent picture is kept', async () => {
    const ids = [await stroke(0.6), await stroke(0.65)];
    const before = t.ctx.db.all('SELECT id, data_json, rev, deleted_at FROM annotation ORDER BY id');
    ai.push(reading([[['ليش؟'], ['Rebound', true]]]));
    const v = await recognize(ids);
    expect(v.status).toBe('recognized');
    expect(v.recognized_text).toBe('ليش؟ Rebound');
    expect(v.effective_text).toBe('ليش؟ Rebound');
    expect(v.uncertain_count).toBe(1);
    expect(v.lines[0]!.words).toEqual([{ text: 'ليش؟', uncertain: false }, { text: 'Rebound', uncertain: true }]);
    expect(v.origin).toBe('recognized');
    expect(v.origin_label_ar).toMatch(/مقروء آليًا/);
    expect(v.annotation_ids.sort()).toEqual([...ids].sort());
    expect(v.anchor).toMatchObject({ source_id: f.sourceId, page_id: f.pageIds[0], page_label_ar: 'ص 11 (الصفحة 1 في الملف)' });
    expect(v.engine).toBe('fake-model-1');
    // the ink is exactly as written
    expect(t.ctx.db.all('SELECT id, data_json, rev, deleted_at FROM annotation ORDER BY id')).toEqual(before);
    // the vision call: one picture, the recognition task, transcription-only rules; usage recorded
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.task).toBe('ink_recognize');
    expect(ai.calls[0]!.images).toHaveLength(1);
    expect(ai.calls[0]!.images![0]!.mime).toBe('image/png');
    expect(Buffer.from(ai.calls[0]!.images![0]!.data).equals(png())).toBe(true);
    expect(ai.calls[0]!.system).toMatch(/Never correct, complete, translate/);
    expect(ai.calls[0]!.prompt).toMatch(/mix Arabic/);
    expect(count(`SELECT COUNT(*) AS n FROM usage_record WHERE task = 'ink_recognize' AND status = 'ok'`)).toBe(1);
    const img = await get(v.image_url!);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(png())).toBe(true);
    // listed for its page
    const list = (await get(`/api/annotations/recognitions?page_id=${f.pageIds[0]}`)).json().recognitions as InkRecognitionView[];
    expect(list.map((r) => r.id)).toEqual([v.id]);
  });

  it('is idempotent by the client id (a lost response never reads twice)', async () => {
    const id = await stroke();
    const req = pageReq([id]);
    expect((await post('/api/annotations/recognitions', req)).statusCode).toBe(202);
    const again = await post('/api/annotations/recognitions', req);
    expect(again.statusCode).toBe(200);
    expect(again.json().recognition.id).toBe(req.id);
    expect(count(`SELECT COUNT(*) AS n FROM processing_job WHERE kind = 'ink.recognize'`)).toBe(1);
  });

  it('search in handwriting shows its origin; a correction keeps the machine reading and becomes the owner text', async () => {
    const id = await stroke();
    ai.push(reading([[['hepatocyte'], ['zonation', true]]], 'en'));
    const v = await recognize([id]);
    let s = await search('hepatocyte');
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({ type: 'handwriting', id: v.id, origin: 'recognized', is_evidence: false });
    expect(s.results[0]!.location).toMatchObject({ source_id: f.sourceId, page_id: f.pageIds[0], page_index: 0 });
    expect(s.results[0]!.snippet.highlights.length).toBeGreaterThan(0);
    expect(t.ctx.db.get(`SELECT origin FROM owner_content_fts WHERE entity_type = 'ink_recognition' AND entity_id = ?`, [v.id])).toEqual({ origin: 'recognized' });

    const c = (await patch(`/api/annotations/recognitions/${v.id}`, { corrected_text: 'hepatocytes zonation' })).json().recognition as InkRecognitionView;
    expect(c.recognized_text).toBe('hepatocyte zonation'); // the machine reading is kept as returned
    expect(c.corrected_text).toBe('hepatocytes zonation');
    expect(c.effective_text).toBe('hepatocytes zonation');
    expect(c.origin).toBe('owner_corrected');
    expect(t.ctx.db.get(`SELECT origin FROM owner_content_fts WHERE entity_type = 'ink_recognition' AND entity_id = ?`, [v.id])).toEqual({ origin: 'owner' });
    s = await search('hepatocytes');
    expect(s.results.map((r) => [r.id, r.origin])).toEqual([[v.id, 'owner_typed']]);
    expect((await search('hepatocyte')).results).toHaveLength(0);
    expect(count(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'ink_recognition' AND action = 'corrected'`)).toBe(1);
    // back to the machine reading
    const back = (await patch(`/api/annotations/recognitions/${v.id}`, { corrected_text: null })).json().recognition as InkRecognitionView;
    expect(back.origin).toBe('recognized');
    expect((await search('hepatocyte')).results).toHaveLength(1);

    // the strokes it read are erased → no longer a hit (the reading stands for writing that exists)
    const del = await post('/api/sync/push', { ops: [op({ entity_type: 'annotation', entity_id: id, op: 'delete', base_rev: 1, payload: {} })] });
    expect(del.json().results[0].result).toBe('applied');
    expect((await search('hepatocyte')).results).toHaveLength(0);
  });

  it('deleting a reading removes only the derived text (and its search entry); the ink stays', async () => {
    const id = await stroke();
    ai.push(reading([[['bilirubin']]]));
    const v = await recognize([id]);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/annotations/recognitions/${v.id}`, headers: h })).statusCode).toBe(200);
    expect((await get(`/api/annotations/recognitions/${v.id}`)).statusCode).toBe(404);
    expect(count(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'ink_recognition'`)).toBe(0);
    expect(t.ctx.db.get('SELECT deleted_at FROM annotation WHERE id = ?', [id])).toEqual({ deleted_at: null });
  });

  it('the full JSON export carries the reading and the owner correction (not the picture, which the strokes re-make)', async () => {
    const id = await stroke();
    ai.push(reading([[['portal'], ['triad', true]]], 'en'));
    const v = await recognize([id]);
    await patch(`/api/annotations/recognitions/${v.id}`, { corrected_text: 'portal triads' });
    const res = await get('/api/data/export/all');
    expect(res.statusCode).toBe(200);
    const rows = (JSON.parse(res.body) as { data: Record<string, Array<Record<string, unknown>>> }).data.ink_recognition!;
    const row = rows.find((r) => r.id === v.id)!;
    expect(row).toMatchObject({ text: 'portal triad', corrected_text: 'portal triads', purpose: 'page_ink', status: 'recognized', uncertain_count: 1 });
    expect(JSON.parse(String(row.annotation_ids_json))).toEqual([id]);
    expect(row).not.toHaveProperty('image_png');
  });

  it('abstains honestly: unreadable / empty readings are not «recognized», failures say why, retry works', async () => {
    const id = await stroke();
    ai.push({ json: { status: 'unreadable', language: null, lines: [], reason: 'الخطوط متداخلة' } });
    const u = await recognize([id]);
    expect(u.status).toBe('unreadable');
    expect(u.error_ar).toMatch(/تعذّرت قراءة الكتابة: الخطوط متداخلة/);
    expect(u.recognized_text).toBe('');
    expect(count(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'ink_recognition'`)).toBe(0);
    // the owner can still type what it says (a correction of an abstention)
    const typed = (await patch(`/api/annotations/recognitions/${u.id}`, { corrected_text: 'ليش؟' })).json().recognition as InkRecognitionView;
    expect(typed.origin).toBe('owner_corrected');
    expect(count(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'ink_recognition'`)).toBe(1);

    ai.push({ json: { status: 'recognized', language: 'ar', lines: [{ words: [] }], reason: null } });
    const empty = await recognize([id]);
    expect(empty.status).toBe('unreadable');
    expect(empty.error_ar).toMatch(/لم يجد القارئ كلمات/);

    ai.push({ json: { nope: 1 } }, { json: { still: 'bad' } });
    const bad = await recognize([id]);
    expect(bad.status).toBe('failed');
    expect(bad.error_ar).toMatch(/رُفضت نتيجة الذكاء الاصطناعي/);

    ai.push(reading([[['appendix']]]));
    const retried = (await post(`/api/annotations/recognitions/${bad.id}/retry`, {})).json().recognition as InkRecognitionView;
    expect(retried.status).toBe('queued');
    await t.ctx.jobs.drain();
    expect(((await get(`/api/annotations/recognitions/${bad.id}`)).json().recognition as InkRecognitionView).effective_text).toBe('appendix');
    // a reading that is not complete cannot be «corrected»
    const q = await post('/api/annotations/recognitions', pageReq([id]));
    expect((await patch(`/api/annotations/recognitions/${q.json().recognition.id}`, { corrected_text: 'x' })).statusCode).toBe(409);
  });

  it('refuses pictures that are not a sensible PNG and requests without their context', async () => {
    const id = await stroke();
    const notPng = await post('/api/annotations/recognitions', pageReq([id], { image_png_base64: Buffer.from('GIF89a-not-a-png-at-all-really').toString('base64') }));
    expect(notPng.statusCode).toBe(415);
    const huge = await post('/api/annotations/recognitions', pageReq([id], { image_png_base64: png(4000, 20).toString('base64') }));
    expect(huge.statusCode).toBe(400);
    expect(huge.json().error.message).toMatch(/أبعاد/);
    const noAnchor = await post('/api/annotations/recognitions', pageReq([id], { anchor: null }));
    expect(noAnchor.statusCode).toBe(400);
    const otherPage = await post('/api/annotations/recognitions', pageReq([id], { anchor: { type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.v2PageIds[0], page_index: 0 } }));
    expect(otherPage.statusCode).toBe(404);
    const notePage = await post('/api/annotations/recognitions', pageReq([id], { anchor: { type: 'note_page', note_page_id: newId() } }));
    expect(notePage.statusCode).toBe(409);
    expect(notePage.json().error.message).toMatch(/لم تصل إلى الخادم/);
    expect(count('SELECT COUNT(*) AS n FROM ink_recognition')).toBe(0);
  });

  describe('«اسأل عن المحدد»: the handwriting + the paragraph next to it', () => {
    let near: string;
    function region(text: string, box: { x: number; y: number; w: number; h: number }, kind = 'paragraph'): string {
      const id = newId();
      const now = t.clock.now();
      t.ctx.db.run(
        `INSERT INTO source_region (id, version_id, page_id, kind, reading_order, bbox_json, text, text_origin, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, 'digital', 'extracted', ?, ?)`,
        [id, f.versionId, f.pageIds[0], kind, JSON.stringify(box), text, now, now],
      );
      return id;
    }
    beforeEach(() => {
      near = region('Rebound tenderness indicates peritoneal irritation.', { x: 0.08, y: 0.2, w: 0.7, h: 0.08 });
      region('Synthetic fixture footer paragraph far below.', { x: 0.08, y: 0.85, w: 0.7, h: 0.05 });
      region('Heading of the page', { x: 0.08, y: 0.05, w: 0.6, h: 0.04 }, 'heading');
    });
    const anchor = () => ({ type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[0], page_index: 0 });

    it('composes a clear request from the recognized «ليش؟» and the paragraph beside it (nothing is sent)', async () => {
      const id = await stroke(0.85);
      ai.push(reading([[['ليش؟']]], 'ar'));
      const v = await recognize([id]);
      const r = (await post('/api/annotations/ask-context', { anchor: anchor(), bbox: { x: 0.84, y: 0.21, w: 0.08, h: 0.04 }, recognition_id: v.id })).json() as AskContextResponse;
      expect(r.handwriting).toEqual({ text: 'ليش؟', origin: 'recognized', uncertain_count: 0 });
      expect(r.paragraph).toMatchObject({ region_id: near, relation: 'beside' });
      expect(r.anchor).toMatchObject({ source_id: f.sourceId, page_id: f.pageIds[0], region_ids: [near] });
      expect(r.anchor.quote!.exact).toContain('Rebound tenderness');
      expect(r.question_ar).toContain('«ليش؟»');
      expect(r.question_ar).toContain('Rebound tenderness indicates peritoneal irritation.');
      expect(r.notes_ar.join(' ')).toMatch(/لا يُرسل شيء تلقائيًا/);
      expect(ai.calls).toHaveLength(1); // only the recognition: building the request calls no model
      // a corrected reading is used as the owner's text
      await patch(`/api/annotations/recognitions/${v.id}`, { corrected_text: 'لماذا؟' });
      const c = (await post('/api/annotations/ask-context', { anchor: anchor(), bbox: { x: 0.84, y: 0.21, w: 0.08, h: 0.04 }, recognition_id: v.id })).json() as AskContextResponse;
      expect(c.handwriting).toMatchObject({ text: 'لماذا؟', origin: 'owner_corrected' });
    });

    it('overlapping writing picks that paragraph; typed text is used when nothing was read; far writing → the page', async () => {
      const over = (await post('/api/annotations/ask-context', { anchor: anchor(), bbox: { x: 0.3, y: 0.22, w: 0.1, h: 0.03 }, typed_text: 'why?' })).json() as AskContextResponse;
      expect(over.paragraph).toMatchObject({ region_id: near, relation: 'overlaps' });
      expect(over.handwriting).toEqual({ text: 'why?', origin: 'owner_typed', uncertain_count: 0 });
      const far = (await post('/api/annotations/ask-context', { anchor: anchor(), bbox: { x: 0.3, y: 0.55, w: 0.1, h: 0.03 } })).json() as AskContextResponse;
      expect(far.paragraph).toBeNull();
      expect(far.anchor.region_ids).toEqual([]);
      expect(far.handwriting).toBeNull();
      expect(far.question_ar).toContain('«…»');
      expect(far.notes_ar.join(' ')).toMatch(/اكتب ما كتبته بخط يدك/);
      expect(far.notes_ar.join(' ')).toMatch(/لا توجد فقرة نصية/);
    });

    it('refuses a reading of another page', async () => {
      const id = await stroke();
      ai.push(reading([[['x']]]));
      const v = await recognize([id]);
      const other = { type: 'page', source_id: f.sourceId, version_id: f.versionId, page_id: f.pageIds[1], page_index: 1 };
      expect((await post('/api/annotations/ask-context', { anchor: other, bbox: { x: 0.3, y: 0.2, w: 0.1, h: 0.1 }, recognition_id: v.id })).statusCode).toBe(400);
    });
  });

  describe('handwritten written answers (§41)', () => {
    let qid: string;
    let vid: string;
    beforeEach(() => {
      const c = createQuestion(t.ctx, { origin: 'owner', qtype: 'short_answer', stem: 'First-line imaging for suspected appendicitis in children?', options: [], answerStatus: 'not_applicable' });
      qid = c.questionId;
      vid = c.versionId;
      t.ctx.db.run('UPDATE question_version SET rubric_json = ? WHERE id = ?', [JSON.stringify([{ text: 'Ultrasound first in children', weight: 2 }, { text: 'Avoids radiation', weight: 1 }]), vid]);
    });
    const padReq = (extra: Record<string, unknown> = {}) => ({
      id: newId(),
      purpose: 'written_answer',
      lang: 'en',
      question_id: qid,
      strokes: [[[0.1, 0.2, 0], [0.2, 0.25, 16]], [[0.3, 0.2, 40], [0.35, 0.3, 60]]],
      image_png_base64: PNG_B64,
      ...extra,
    });
    const save = (body: Record<string, unknown>) => post('/api/exams/written/attempts', { id: newId(), question_id: qid, question_version_id: vid, answered_at: t.clock.now(), ...body });

    it('the read text is confirmed (and edited) before saving; grading sees only the confirmed text, never penalising the reading', async () => {
      ai.push(reading([[['Ultrasound'], ['first'], ['in'], ['childern', true]]], 'en'));
      const res = await post('/api/annotations/recognitions', padReq());
      expect(res.statusCode).toBe(202);
      await t.ctx.jobs.drain();
      const rec = (await get(`/api/annotations/recognitions/${res.json().recognition.id}`)).json().recognition as InkRecognitionView;
      expect(rec).toMatchObject({ purpose: 'written_answer', status: 'recognized', question_id: qid, uncertain_count: 1 });
      // the pad strokes are kept with the reading (the owner's handwriting is never lost)
      expect(JSON.parse(t.ctx.db.get<{ s: string }>('SELECT strokes_json AS s FROM ink_recognition WHERE id = ?', [rec.id])!.s)).toHaveLength(2);
      // written-answer readings are not part of universal search
      expect(count(`SELECT COUNT(*) AS n FROM owner_content_fts WHERE entity_type = 'ink_recognition'`)).toBe(0);

      // not confirmed → refused (nothing is graded from an unconfirmed reading)
      const unconfirmed = await save({ answer_text: rec.effective_text, recognition_id: rec.id, recognized_confirmed: false });
      expect(unconfirmed.statusCode).toBe(400);
      expect(unconfirmed.json().error.message).toMatch(/أكّده/);
      // confirmed with the owner's fix of the uncertain word; the machine reading comes from the server, not the client
      const ok = await save({ answer_text: 'Ultrasound first in children', recognition_id: rec.id, recognized_confirmed: true, recognized_text: 'forged by the client' });
      expect(ok.statusCode).toBe(200);
      const a = (ok.json() as WrittenAttemptResponse).attempt;
      expect(a).toMatchObject({ answer_text: 'Ultrasound first in children', recognized_text: 'Ultrasound first in childern', recognized_confirmed: true, recognition_id: rec.id });

      ai.push({
        json: {
          rubric: [],
          points: [
            { rubric_index: 0, status: 'correct', note: 'صحيح' },
            { rubric_index: 1, status: 'missing', note: 'ناقصة' },
          ],
          wrong_statements: [],
          improved_answer: [],
          qualitative_feedback: ['مختصرة'],
        },
      });
      const graded = ((await post(`/api/exams/written/attempts/${a.id}/grade`, {})).json() as WrittenAttemptResponse).attempt;
      expect(graded.status).toBe('graded');
      const call = ai.calls.find((c) => c.task === 'grade_written')!;
      expect(call.prompt).toContain('Ultrasound first in children');
      expect(call.prompt).not.toContain('childern');
      expect(call.prompt).toMatch(/Never deduct for spelling/);
      expect(graded.assessment!.notes_ar.join(' ')).toMatch(/لا يُخصم منه شيء/);
      expect(graded.assessment!.estimated_score).toEqual({ got: 2, max: 3 });
    });

    it('(review) a long handwritten answer (Arabic writing is many short strokes) is accepted', async () => {
      const strokes = Array.from({ length: 1500 }, (_, i) => [[(i % 100) / 100, 0.1, 0], [(i % 100) / 100 + 0.004, 0.11, 12]]);
      const res = await post('/api/annotations/recognitions', padReq({ strokes }));
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(t.ctx.db.get<{ s: string }>('SELECT strokes_json AS s FROM ink_recognition WHERE id = ?', [res.json().recognition.id])!.s)).toHaveLength(1500);
    });

    it('a reading of another question, or one not finished, cannot back an answer', async () => {
      const other = createQuestion(t.ctx, { origin: 'owner', qtype: 'short_answer', stem: 'Other?', options: [], answerStatus: 'not_applicable' });
      ai.push(reading([[['text']]]));
      const res = await post('/api/annotations/recognitions', padReq({ question_id: other.questionId }));
      await t.ctx.jobs.drain();
      const wrong = await save({ answer_text: 'text', recognition_id: res.json().recognition.id, recognized_confirmed: true });
      expect(wrong.statusCode).toBe(400);
      const pending = await post('/api/annotations/recognitions', padReq());
      const early = await save({ answer_text: 'x', recognition_id: pending.json().recognition.id, recognized_confirmed: true });
      expect(early.statusCode).toBe(409);
      // a pad without strokes is refused
      expect((await post('/api/annotations/recognitions', padReq({ strokes: [] }))).statusCode).toBe(400);
    });
  });
});
