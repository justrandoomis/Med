// G5 — AC-19 «عدم كشف الحل»: during an exam the key never shows through a source peek, an image, a label or a caption;
// after finishing the evidence opens in full. REAL pipeline (upload → processing → questions hook → extraction →
// lecture matching) on the Golden Set question source + lecture and the G5 marked bank (a tick «✓» printed next to the
// keyed option, a lone «*» next to another, an «Answer: A» on the last option's line, and a picture question whose
// caption names the answer). No AI is involved anywhere here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttemptFeedbackView, ExamSessionView, QuickAddResponse, SyncChange, SyncPullResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { KEY_UNDER_REVIEW_AR, withoutAnswerMarks } from '../../src/modules/exams/delivery';
import { refreshQuestion } from '../../src/modules/questions/lifecycle';
import { api, createNode, detail, golden, questionAt, uploadAndProcess, type QApp } from '../questions/helpers';
import { acceptanceFixture, appWith, exam, feedback, finishExam, plain } from './g5-helpers';

let t: QApp;
let course: string;
let qs: { sourceId: string; versionId: string };
let lecture: { sourceId: string; versionId: string };
let marked: { sourceId: string; versionId: string };

beforeAll(async () => {
  t = await appWith(null);
  course = (await createNode(t, 'Surgery Course 1')).id;
  qs = await uploadAndProcess(t, course, 'questions_surgery_course1.pdf', golden('questions_surgery_course1.pdf'), 'question_source', 'Surgery Course 1 Questions');
  lecture = await uploadAndProcess(t, course, 'lecture_appendicitis.pdf', golden('lecture_appendicitis.pdf'), 'lecture', 'Acute Appendicitis lecture');
  marked = await uploadAndProcess(t, course, 'g5_marked_bank.pdf', acceptanceFixture('g5_marked_bank.pdf'), 'question_source', 'G5 marked bank');
}, 300_000);

afterAll(async () => {
  await t?.close();
});

const optionTexts = (s: ExamSessionView) => s.items.flatMap((i) => i.options.map((o) => plain(o.text)));
const itemOf = (s: ExamSessionView, qid: string) => s.items.find((i) => i.question_id === qid)!;

describe('AC-19: a mark printed next to the answer is never delivered', () => {
  it('the vault keeps the original («McBurney\'s point ✓», «Ultrasound *») and records the tick as an unofficial mark', async () => {
    const q1 = await detail(t, questionAt(t, marked.sourceId, '', '1'));
    const q2 = await detail(t, questionAt(t, marked.sourceId, '', '2'));
    expect(q1.question.current.options.map((o) => plain(o.text))).toContain("McBurney's point ✓");
    expect(q2.question.current.options.map((o) => plain(o.text))).toContain('Ultrasound *');
    expect(q1.key_entries.some((e) => e.mark_kind === 'handwritten' && !e.origin_known)).toBe(true);
    // the printed key at the end binds both: scorable source keys → they enter assessed exams
    for (const d of [q1, q2]) {
      expect(d.question.current.answer_status).toBe('source_key');
      expect(d.scorable).toBe(true);
    }
  });

  it('an assessed exam delivers the options WITHOUT the tick / asterisk; after finishing the key is shown', async () => {
    const s = await exam(t, { mode: 'exam', count: 10, source_ids: [marked.sourceId], seed: 'g5-ac19-marks' });
    expect(s.items).toHaveLength(4);
    const texts = optionTexts(s);
    for (const txt of texts) {
      expect(txt).not.toMatch(/[✓✔☑✗✘*]/);
      expect(txt).not.toMatch(/answer\s*:/i);
      expect(txt).toBe(txt.trim());
    }
    expect(texts).toContain("McBurney's point");
    expect(texts).toContain('Ultrasound');
    expect(JSON.stringify(s)).not.toMatch(/✓|\*"/);
    // the same in practice (before checking an answer)
    const p = await exam(t, { mode: 'practice', count: 10, source_ids: [marked.sourceId], seed: 'g5-ac19-practice' });
    for (const txt of optionTexts(p)) expect(txt).not.toMatch(/[✓*]/);

    const q1 = questionAt(t, marked.sourceId, '', '1');
    await finishExam(t, s, (it) => (it.question_id === q1 ? "McBurney's point" : null));
    const fb = await feedback(t, s.attempt.id, itemOf(s, q1).index);
    expect(fb.status).toBe(200);
    expect(fb.body.is_correct).toBe(true);
    const key = fb.body.options.find((o) => fb.body.correct_option_ids?.includes(o.id))!;
    expect(plain(key.text)).toContain("McBurney's point");
    expect(fb.body.occurrences[0]!.origin_label_ar).toBe('سؤال من مصدر الأسئلة — G5 marked bank — ص 1 — رقم السؤال 1');
  });

  it('an «Answer: A» printed on the last option\'s line is read as the key, never as option text', async () => {
    const d = await detail(t, questionAt(t, marked.sourceId, '', '3'));
    expect(plain(d.question.current.stem)).toBe('Which clinical sign is associated with acute cholecystitis?');
    expect(d.question.current.options.map((o) => plain(o.text))).toEqual(["Murphy's sign", 'Psoas sign', 'Obturator sign', "Rovsing's sign"]);
    expect(d.question.current.answer_status).toBe('source_key');
    const key = d.question.current.options.find((o) => d.question.current.correct_option_ids?.includes(o.id))!;
    expect(plain(key.text)).toBe("Murphy's sign");
  });

  it('a pasted question whose last option swallowed «Answer: B» (owner key set afterwards) is delivered without it', async () => {
    const text = ['1. Which point is classically tender in suspected appendicitis (pasted)?', "A. Murphy's point", "B. McBurney's point", "C. Kehr's point", "D. Castell's point Answer: B"].join('\n');
    const res = await api(t).post('/api/questions/quick-add', { text, course_node_id: course });
    expect(res.statusCode).toBe(200);
    const qid = (res.json() as QuickAddResponse).question_id!;
    await t.ctx.jobs.drain();
    const before = await detail(t, qid);
    const optD = before.question.current.options.find((o) => plain(o.text).startsWith("Castell's point"))!;
    // the original text is kept as typed — the owner decides what the key is
    expect(plain(optD.text)).toBe("Castell's point Answer: B");
    const keyB = before.question.current.options.find((o) => plain(o.text) === "McBurney's point")!;
    if (before.question.current.answer_status !== 'owner_key') {
      expect((await api(t).post(`/api/questions/${qid}/key`, { option_keys: [keyB.option_key] })).statusCode).toBe(200);
    }
    const s = await exam(t, { mode: 'exam', count: 1, question_ids: [qid] });
    expect(s.items).toHaveLength(1);
    expect(optionTexts(s)).toContain("Castell's point");
    for (const txt of optionTexts(s)) expect(txt).not.toMatch(/answer/i);
  });

  it('withoutAnswerMarks: marks go, real content stays', () => {
    const rt = (t: string) => ({ v: 1 as const, paragraphs: [{ dir: 'ltr' as const, runs: [{ t }] }] });
    const out = (t: string) => plain(withoutAnswerMarks(rt(t)));
    expect(out("McBurney's point ✓")).toBe("McBurney's point");
    expect(out('✔ Ultrasound')).toBe('Ultrasound');
    expect(out('Ultrasound *')).toBe('Ultrasound');
    expect(out('*Ultrasound')).toBe('Ultrasound');
    expect(out('CT abdomen (correct)')).toBe('CT abdomen');
    expect(out("Castell's point Answer: B")).toBe("Castell's point");
    expect(out('التصوير بالأمواج فوق الصوتية الإجابة: أ')).toBe('التصوير بالأمواج فوق الصوتية');
    // content that only looks similar is untouched
    expect(out('p < 0.05*')).toBe('p < 0.05');
    expect(out('Answer the call within 5 min')).toBe('Answer the call within 5 min');
    expect(out('K+ 6.5 mmol/L')).toBe('K+ 6.5 mmol/L');
    expect(out('Vitamin B')).toBe('Vitamin B');
  });
});

describe('AC-19: the picture question — image without name, caption kept out', () => {
  it('the caption that names the answer is not in the delivered item; the image is the figure crop, served without a file name', async () => {
    const qid = questionAt(t, marked.sourceId, '', '4');
    const s = await exam(t, { mode: 'exam', count: 1, question_ids: [qid] });
    const item = s.items[0]!;
    expect(plain(item.stem)).toBe('What does the image below show?');
    const json = JSON.stringify(item);
    expect(json).not.toMatch(/Figure 1|Ultrasound of an inflamed|synthetic|g5_marked|\.png|\.pdf/i);
    expect(item.media).toHaveLength(1);
    expect(item.media[0]!.alt_ar).toBe('الصورة 1 المرفقة بالسؤال');
    expect(item.media[0]!.token_url).not.toMatch(/inflamed|appendix|figure|caption/i);

    const res = await t.app.inject({ method: 'GET', url: item.media[0]!.token_url, headers: t.h });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^image\//);
    expect(String(res.headers['content-disposition'] ?? '')).not.toMatch(/filename/i);
    for (const [k, v] of Object.entries(res.headers)) expect(`${k}: ${String(v)}`, k).not.toMatch(/inflamed|appendix|figure|\.png/i);

    // the delivered picture is the FIGURE region's crop; the caption is its own region, outside the crop
    const regions = t.ctx.db.all<{ id: string; kind: string; bbox_json: string; text: string | null; file_id: string | null }>(
      `SELECT r.id, r.kind, r.bbox_json, r.text, a.file_id FROM source_region r JOIN source_page p ON p.id = r.page_id
         LEFT JOIN image_asset a ON a.region_id = r.id
        WHERE r.version_id = ? AND p.page_index = 1 AND r.kind IN ('figure', 'caption')`,
      [marked.versionId],
    );
    const fig = regions.find((r) => r.kind === 'figure' && r.file_id)!;
    const cap = regions.find((r) => r.kind === 'caption')!;
    expect(fig, 'figure region with an image asset').toBeTruthy();
    expect(cap?.text).toMatch(/inflamed appendix/);
    const served = t.ctx.files.read(fig.file_id!);
    expect(Buffer.compare(res.rawPayload, await served)).toBe(0);
    const fb = JSON.parse(fig.bbox_json) as { y: number; h: number };
    const cb = JSON.parse(cap.bbox_json) as { y: number; h: number };
    expect(cb.y >= fb.y + fb.h - 0.002 || cb.y + cb.h <= fb.y + 0.002, 'caption outside the figure crop').toBe(true);
  });
});

describe('AC-19: nothing else in an assessed attempt points at the answer', () => {
  it('payload: no key, explanation, link reason, section / topic title, source name or page label; build report key-free', async () => {
    const s = await exam(t, { mode: 'exam', count: 10, source_ids: [qs.sourceId], seed: 'g5-ac19-golden' });
    expect(s.items.length).toBe(6); // B3 has no key → excluded from an assessed exam (AC-14)
    for (const it of s.items) {
      expect(Object.keys(it).sort()).toEqual(['has_negation', 'index', 'media', 'negation_terms', 'options', 'origin_label_ar', 'origin_type', 'qtype', 'question_id', 'question_version_id', 'scored', 'stem'].sort());
      for (const o of it.options) expect(Object.keys(o).sort()).toEqual(['display_label', 'id', 'text']);
      expect(it.origin_label_ar).toBe('سؤال من مصادر أسئلتك');
    }
    const json = JSON.stringify(s);
    for (const leak of ['correct', 'explanation', 'Surgery Course 1 Questions', 'Abdominal pain', 'Biliary disease', 'Section A', 'Acute Appendicitis lecture', 'مذكورة في المحاضرة', 'lecture_pages', 'McBurney\'s point (', 'ص 1', 'ص 11', 'الإجابة']) {
      expect(json, leak).not.toContain(leak);
    }
    expect(JSON.stringify(s.exam.build)).not.toMatch(/McBurney|Serum amylase|Pregnancy test/);
    // practice of the same items would carry no reason either: they are all scorable
    expect(s.unscored_reasons).toEqual({});
  });

  it('during the attempt: feedback, solution, hints and results are refused, the sync pull carries no graded attempt', async () => {
    const s = await exam(t, { mode: 'exam', count: 3, source_ids: [qs.sourceId], seed: 'g5-ac19-during' });
    const a = s.attempt.id;
    expect((await feedback(t, a, 0)).status).toBe(409);
    expect((await api(t).post(`/api/exams/attempts/${a}/items/0/solution`, {})).statusCode).toBe(409);
    expect((await api(t).post(`/api/exams/attempts/${a}/items/0/hint`, { level: 1 })).statusCode).toBe(409);
    expect((await api(t).get(`/api/exams/attempts/${a}/result`)).statusCode).toBe(409);
    const answer = { id: newId(), selected_option_ids: [s.items[0]!.options[0]!.id], answered_at: t.ctx.clock.now() };
    expect((await api(t).post(`/api/exams/attempts/${a}/items/0/answer`, answer)).statusCode).toBe(409);
    const changes: SyncChange[] = [];
    for (let since = 0, more = true; more; ) {
      const pull = await api(t).get(`/api/sync/pull?since=${since}&limit=200`);
      expect(pull.statusCode).toBe(200);
      const body = pull.json() as SyncPullResponse;
      changes.push(...body.changes);
      since = body.next_since;
      more = body.has_more;
    }
    expect(changes.filter((c) => c.entity_type === 'question_attempt' && JSON.stringify(c.entity).includes(a))).toHaveLength(0);
    const mine = changes.find((c) => c.entity_type === 'exam_attempt' && c.entity_id === a);
    if (mine) expect(JSON.stringify(mine.entity)).not.toMatch(/correct|is_correct|key/);
  });

  it('after finishing: every item opens its full evidence — key and who stands behind it, every occurrence, the lecture pages that cover it', async () => {
    const s = await exam(t, { mode: 'exam', count: 10, source_ids: [qs.sourceId], seed: 'g5-ac19-after' });
    await finishExam(t, s);
    const lecturePages = new Set(t.ctx.db.all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ?', [lecture.versionId]).map((p) => p.id));
    let withLecture = 0;
    for (const it of s.items) {
      const fb = await feedback(t, s.attempt.id, it.index);
      expect(fb.status).toBe(200);
      const body: AttemptFeedbackView = fb.body;
      expect(body.correct_option_ids?.length).toBe(1);
      expect(body.answer_status).toBe('source_key');
      expect(body.answer_status_label_ar).toBeTruthy();
      expect(body.occurrences.some((o) => o.source_id === qs.sourceId)).toBe(true);
      for (const o of body.occurrences) {
        expect(o.origin_label_ar).toMatch(/^سؤال من مصدر الأسئلة — .+ — ص \d/);
        expect(o.pages.length).toBeGreaterThan(0);
      }
      for (const l of body.lecture_links) {
        if (l.lecture_source_id !== lecture.sourceId) continue;
        withLecture++;
        expect(l.pages.length).toBeGreaterThan(0);
        for (const p of l.pages) {
          expect(lecturePages.has(p.page_id)).toBe(true);
          expect(p.label_ar).toMatch(/^ص 1[1-4]$/);
        }
      }
    }
    expect(withLecture).toBeGreaterThanOrEqual(4); // A1–A4 are covered by the appendicitis lecture
    const result = await api(t).get(`/api/exams/attempts/${s.attempt.id}/result`);
    expect(result.statusCode).toBe(200);
  });
});

describe('AC-19 (practice): an unscorable item never names its key before the answer', () => {
  it('a source key read with doubt («مفتاح المصدر («B» …) بثقة منخفضة») is delivered with a key-free reason; the full reason after answering', async () => {
    const a1 = questionAt(t, qs.sourceId, 'A', '1');
    // the key line of Section A flagged for review by processing (as an uncertain OCR reading would be)
    const keyRegion = t.ctx.db.get<{ region_id: string }>(
      `SELECT e.region_id FROM answer_key_entry e WHERE e.source_version_id = ? AND e.section_key = 'A' AND e.printed_number = '1' AND e.region_id IS NOT NULL`,
      [qs.versionId],
    )!;
    const before = t.ctx.db.get<{ status: string }>('SELECT status FROM source_region WHERE id = ?', [keyRegion.region_id])!.status;
    t.ctx.db.run(`UPDATE source_region SET status = 'needs_review' WHERE id = ?`, [keyRegion.region_id]);
    refreshQuestion(t.ctx, a1);
    const d = await detail(t, a1);
    expect(d.scorable).toBe(false);
    expect(d.unscorable_reason_ar).toContain('«B»'); // the vault may name it — the owner is reviewing the key there

    const s = await exam(t, { mode: 'practice', count: 1, question_ids: [a1] });
    const reason = s.unscored_reasons['0']!;
    expect(reason).toBe(KEY_UNDER_REVIEW_AR);
    expect(JSON.stringify(s)).not.toContain('«B»');
    const chosen = s.items[0]!.options.find((o) => plain(o.text) === "Kehr's point")!;
    const res = await api(t).post(`/api/exams/attempts/${s.attempt.id}/items/0/answer`, { id: newId(), selected_option_ids: [chosen.id], answered_at: t.ctx.clock.now() });
    expect(res.statusCode).toBe(200);
    const fb = res.json() as AttemptFeedbackView;
    expect(fb.scored).toBe(false);
    expect(fb.unscored_reason_ar).toContain('«B»');
    t.ctx.db.run('UPDATE source_region SET status = ? WHERE id = ?', [before, keyRegion.region_id]);
    refreshQuestion(t.ctx, a1);
  });
});
