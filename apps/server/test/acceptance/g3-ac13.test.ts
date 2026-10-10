// G3 / AC-13 — «an option circled by hand, without a known key, is never classified as the official source answer just
// because of the mark». Golden Set `question_photo_circled.png` (Q7, circle around «A», no key) and the derived photos
// of `fixtures/acceptance/make_g3_fixtures.mjs` go through the REAL routes (quick add «صورة سؤال واحد», sources upload)
// and the REAL pipeline (OCR → extraction → keys → validation). No AI anywhere.
//
// Adversarial angles: the single-photo quick add (the path the spec names), the same photo twice (two marks never add
// up to a key), assessed exam / practice / export with solutions / flashcard, the owner correcting the OCR'd text
// (the mark must stay a mark), re-running extraction, a photo whose printed «Answer: C» must win over a circle on «B»,
// pasted text carrying a circled glyph «Ⓐ» or a tick «✓», an Arabic photo with a circle around «ب».
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttemptFeedbackView, QuestionDetailResponse, QuickAddResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createNode, createQuestionsApp, golden, listAll, uploadAndProcess, type QApp } from '../questions/helpers';
import { multipart } from '../sources/helpers';

const ACCEPTANCE = join(__dirname, '..', '..', '..', '..', 'fixtures', 'acceptance');
let t: QApp;
let course: string;
let photo: { sourceId: string; versionId: string; questionId: string };

const api = {
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: t.h }),
  post: (url: string, payload: unknown = {}) => t.app.inject({ method: 'POST', url, headers: t.h, payload: payload as never }),
  patch: (url: string, payload: unknown) => t.app.inject({ method: 'PATCH', url, headers: t.h, payload: payload as never }),
};
async function detail(id: string): Promise<QuestionDetailResponse> {
  const r = await api.get(`/api/questions/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as QuestionDetailResponse;
}
const optText = (o: QuestionDetailResponse['question']['current']['options'][number]) => o.text.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join(' ');
/** the AC-13 invariant: no official key, nothing correct, never scored */
function expectNoOfficialKey(d: QuestionDetailResponse) {
  expect(['missing_key', 'unresolved']).toContain(d.question.current.answer_status);
  expect(d.question.current.correct_option_ids).toBeNull();
  expect(d.key_entries.filter((k) => k.origin_known && k.binding === 'bound')).toEqual([]);
  expect(d.scorable).toBe(false);
}

beforeAll(async () => {
  t = await createQuestionsApp();
  course = (await createNode(t, 'Surgery Course 1 (G3)')).id;
  // «إذا رفع المستخدم صورة لسؤال واحد»: the quick-add photo path, through the real multipart route
  const body = multipart({ node_id: course, title: 'سؤال مصوّر (TEST FIXTURE)' }, [{ name: 'question_photo_circled.png', data: golden('question_photo_circled.png'), contentType: 'image/png', field: 'file' }]);
  const res = await t.app.inject({ method: 'POST', url: '/api/questions/quick-add', headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
  expect(res.statusCode, res.body).toBe(200);
  const qa = res.json() as QuickAddResponse;
  expect(qa.mode).toBe('image');
  await t.ctx.jobs.drain();
  const items = await listAll(t, `source_id=${qa.source_id}`);
  expect(items).toHaveLength(1);
  photo = { sourceId: qa.source_id!, versionId: qa.version_id!, questionId: items[0]!.id };
}, 180_000);

afterAll(async () => {
  await t?.close();
});

describe('G3 AC-13 — the circled option on a single question photo (quick add)', () => {
  it('extracted as Q7 with 4 options; the circle is an UNOFFICIAL mark of unknown origin, never a key; a review item says why', async () => {
    const d = await detail(photo.questionId);
    expect(d.question.occurrences[0]!.printed_number).toBe('7');
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(['A', 'B', 'C', 'D']);
    expectNoOfficialKey(d);
    expect(d.question.current.answer_status).toBe('missing_key');
    expect(d.key_entries).toHaveLength(1);
    expect(d.key_entries[0]).toMatchObject({ mark_kind: 'circled_option', origin_known: false, binding: 'unofficial', key_label: 'A' });
    const item = d.review_items.find((i) => i.kind === 'unofficial_mark')!;
    expect(item.status).toBe('open');
    expect(item.reason).toMatch(/قد تكون إجابة طالب سابق/);
    expect(d.unscorable_reason_ar).toMatch(/مفتاح/);
  });

  it('assessed exam: refused (unscorable); practice: shown, answering the circled «A» is recorded but never graded', async () => {
    const assessed = await api.post('/api/exams', { title: '', mode: 'exam', count: 5, question_ids: [photo.questionId] });
    expect(assessed.statusCode).toBe(409);
    expect(assessed.json().error.details.report.exclusions[0].code).toBe('unscorable');
    const practice = (await api.post('/api/exams', { title: '', mode: 'practice', count: 1, question_ids: [photo.questionId] })).json();
    const item = practice.session.items[0];
    expect(item.scored).toBe(false);
    const d = await detail(photo.questionId);
    const circled = d.question.current.options.find((o) => o.source_label === 'A')!;
    const delivered = item.options.find((o: { id: string }) => o.id === circled.id) ?? item.options[0];
    const fb = (await api.post(`/api/exams/attempts/${practice.session.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [delivered.id], confidence: 'confident', answered_at: t.ctx.clock.now() })).json() as AttemptFeedbackView;
    expect(fb.scored).toBe(false);
    expect(fb.is_correct).toBeNull();
    expect(fb.correct_option_ids).toBeNull();
    expect(fb.answer_status).toBe('missing_key');
    expect(fb.unscored_reason_ar).toBeTruthy();
  });

  it('export WITH solutions: the answer line says there is no key; no option is marked as the answer', async () => {
    const r = await api.get(`/api/data/export/questions?source_id=${photo.sourceId}&format=md&include_solutions=1`);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    const md = r.body;
    expect(md).toMatch(/\*\*الإجابة:\*\* .*(بلا مفتاح|لا يوجد مفتاح|مفتاح مفقود)/);
    for (const line of md.split('\n').filter((l) => /^- [A-D]\)/.test(l))) expect(line).not.toContain('✓');
  });

  it('the same photo again (another copy): one question with two occurrences — two circles never add up to a key', async () => {
    const again = await uploadAndProcess(t, course, 'question_photo_circled.png', golden('question_photo_circled.png'), 'question_source', 'نسخة ثانية من الصورة');
    await t.ctx.jobs.drain();
    const row = t.ctx.db.get<{ question_id: string }>('SELECT question_id FROM question_occurrence WHERE source_id = ?', [again.sourceId])!;
    expect(row.question_id).toBe(photo.questionId); // exact duplicate (AC-17)
    const d = await detail(photo.questionId);
    expect(d.question.occurrences).toHaveLength(2);
    expectNoOfficialKey(d);
    expect(d.key_entries.every((k) => k.binding === 'unofficial' && !k.origin_known)).toBe(true);
  });

  it('re-running extraction keeps the mark a mark', async () => {
    const r = await api.post('/api/questions/extract', { version_id: photo.versionId });
    expect(r.statusCode, r.body).toBe(200);
    await t.ctx.jobs.drain();
    expectNoOfficialKey(await detail(photo.questionId));
  });

  it('the owner corrects the OCR text: still no key; only the owner\'s explicit choice sets one — labelled as the owner\'s, never as the source\'s', async () => {
    const before = await detail(photo.questionId);
    const opts = before.question.current.options.map((o) => ({ option_key: o.option_key, source_label: o.source_label, text: o.source_label === 'A' ? 'Ultrasound' : optText(o) }));
    const fixed = await api.patch(`/api/questions/${photo.questionId}`, { options: opts, reviewed_fields: ['options'], note: 'صححت نص الخيار A من الصورة' });
    expect(fixed.statusCode, fixed.body).toBe(200);
    const after = await detail(photo.questionId);
    expect(after.question.current.id).not.toBe(before.question.current.id);
    expectNoOfficialKey(after);
    expect(after.review_items.find((i) => i.kind === 'unofficial_mark')?.status).toBe('open');
    // the owner decides — a different kind of answer, said so everywhere
    const a = after.question.current.options.find((o) => o.source_label === 'A')!;
    const keyed = await api.post(`/api/questions/${photo.questionId}/key`, { option_keys: [a.option_key], reason: 'راجعت المحاضرة' });
    expect(keyed.statusCode, keyed.body).toBe(200);
    const owned = await detail(photo.questionId);
    expect(owned.question.current.answer_status).toBe('owner_key');
    expect(owned.question.current.key_details?.notes_ar).toBeTruthy();
    expect(owned.key_entries.find((k) => k.mark_kind === 'circled_option')).toMatchObject({ binding: 'unofficial', origin_known: false });
    expect(owned.key_entries.filter((k) => k.origin_known)).toEqual([]); // still no SOURCE key anywhere
  });
});

describe('G3 AC-13 — variants', () => {
  it('a printed «Answer: C» on the photo is the key; the circle on «B» never votes and never conflicts', async () => {
    const s = await uploadAndProcess(t, course, 'g3_photo_circled_with_key.png', readFileSync(join(ACCEPTANCE, 'g3_photo_circled_with_key.png')), 'question_source', 'صورة سؤال بمفتاح مطبوع');
    const [q] = await listAll(t, `source_id=${s.sourceId}`);
    const d = await detail(q!.id);
    expect(d.question.current.answer_status).toBe('source_key');
    const correct = d.question.current.options.filter((o) => (d.question.current.correct_option_ids ?? []).includes(o.id));
    expect(correct.map((o) => o.source_label)).toEqual(['C']);
    expect(d.key_entries.filter((k) => k.origin_known).map((k) => [k.mark_kind, k.key_label])).toEqual([['printed_key', 'C']]);
    expect(d.key_entries.some((k) => k.key_label === 'B' && k.origin_known)).toBe(false);
    // the circled line was not read cleanly by OCR: the question is held for review, not silently scored
    expect(d.question.current.extraction_status).toBe('needs_review');
    expect(d.scorable).toBe(false);
  });

  it('pasted text with a circled glyph «Ⓐ» or a tick «✓»: the mark is not the owner\'s key either', async () => {
    for (const text of [
      '7. Which investigation is first-line for suspected gallstones?\nⒶ Ultrasound\nB. CT abdomen\nC. MRCP\nD. ERCP',
      '7. Which investigation is first-line for suspected gallstones?\nA. Ultrasound ✓\nB. CT abdomen\nC. MRCP\nD. ERCP',
    ]) {
      const r = await api.post('/api/questions/quick-add', { text, course_node_id: course });
      expect(r.statusCode, r.body).toBe(200);
      const d = await detail((r.json() as QuickAddResponse).question_id!);
      expect(d.question.current.options).toHaveLength(4);
      expect(d.question.current.answer_status).toBe('missing_key');
      expect(d.question.current.correct_option_ids).toBeNull();
      expect(d.scorable).toBe(false);
    }
  });

  it('an Arabic photo with a circle around «ب»: all four options read, the circle kept as an unofficial mark, never a key', async () => {
    // regression (G3): the automatic OCR segmentation read only the stem and silently dropped «أ … ب … ج … د …» —
    // the question was stored with NO options and «checks passed». The page is now re-read where writing was left
    // unread, and the circle read as «(ب.» is recorded as a mark like its Latin twin «(A …».
    const s = await uploadAndProcess(t, course, 'g3_photo_circled_ar.png', readFileSync(join(ACCEPTANCE, 'g3_photo_circled_ar.png')), 'question_source', 'صورة سؤال عربي');
    const items = await listAll(t, `source_id=${s.sourceId}`);
    expect(items).toHaveLength(1);
    const d = await detail(items[0]!.id);
    expect(d.question.occurrences[0]!.printed_number).toBe('5');
    expect(d.question.current.options.map((o) => o.source_label)).toEqual(['أ', 'ب', 'ج', 'د']);
    expect(d.question.current.options.map(optText)).toEqual(['التصوير المقطعي', 'الأمواج فوق الصوتية', 'الرنين المغناطيسي', 'التنظير']);
    expectNoOfficialKey(d);
    expect(d.key_entries.map((k) => [k.mark_kind, k.binding, k.origin_known, k.key_label])).toEqual([['circled_option', 'unofficial', false, 'ب']]);
    expect(d.review_items.some((i) => i.kind === 'unofficial_mark' && i.status === 'open')).toBe(true);
    // the circled line itself is a weak OCR reading: held for review, never silently accepted
    expect(d.question.current.extraction_status).toBe('needs_review');
  });
});
