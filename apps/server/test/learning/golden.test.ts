// Learning on the Golden Set through the REAL pipeline (upload → processing → question extraction → lecture matching):
// cards from a selection and from a mistake, AC-26 (source replacement / key correction flag cards without losing the
// review history), the Weakness Center with AC-27 weights and transparent reasons, Mistake Genome edits, Reasoning
// Replay content sources, progress separation, Exam DNA denominators & warnings, Exam Relevance (not a probability),
// one-tap revision within the minutes, planner sized by the real lecture and Home.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MASTERY_WEIGHTS,
  type CardCreateResponse,
  type ExamDnaDetail,
  type ExamRelevanceView,
  type FlashcardView,
  type HomeDetail,
  type MistakeGenomeView,
  type ReasoningReplayView,
  type RevisionSessionDetail,
  type SourceProgressDetail,
  type StudyPlanView,
  type WeaknessListResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { fromRegion } from '../../src/modules/evidence/services';
import { createQuestion } from '../../src/modules/questions/service';
import { createExamApp, questionAt, type ExamApp } from '../exams/helpers';
import { golden } from '../questions/helpers';
import { multipart } from '../sources/helpers';
import { api, DAY, MIN, ok, push } from './helpers';

let t: ExamApp;
let qA1: string;
let qA2: string;
let qA3: string;
let qA4: string;
let qB3: string;
const attempts: Record<string, string> = {};

function versionOf(qid: string): { id: string; options: string[]; correct: string[] } {
  const v = t.ctx.db.get<{ id: string; correct_option_ids_json: string | null }>('SELECT v.id, v.correct_option_ids_json FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?', [qid])!;
  const options = t.ctx.db.all<{ id: string }>('SELECT id FROM question_option WHERE question_version_id = ? ORDER BY ord', [v.id]).map((o) => o.id);
  return { id: v.id, options, correct: JSON.parse(v.correct_option_ids_json ?? '[]') as string[] };
}

async function answer(name: string, qid: string, opts: { correct: boolean; confidence?: 'guess' | 'unsure' | 'confident' | null; hints?: number; at: number }) {
  const v = versionOf(qid);
  const pick = opts.correct ? v.correct : [v.options.find((o) => !v.correct.includes(o))!];
  const id = newId();
  attempts[name] = id;
  const [r] = await push(t as never, [
    {
      entity_type: 'question_attempt',
      entity_id: id,
      op: 'append',
      payload: { question_id: qid, question_version_id: v.id, selected_option_ids: pick, confidence: opts.confidence ?? null, hints_used: opts.hints ?? 0, answered_at: opts.at },
    },
  ]);
  expect(r!.result).toBe('applied');
}

beforeAll(async () => {
  t = await createExamApp();
  qA1 = questionAt(t, t.qs.sourceId, 'A', '1');
  qA2 = questionAt(t, t.qs.sourceId, 'A', '2');
  qA3 = questionAt(t, t.qs.sourceId, 'A', '3');
  qA4 = questionAt(t, t.qs.sourceId, 'A', '4');
  qB3 = questionAt(t, t.qs.sourceId, 'B', '3');
  const now = t.ctx.clock.now();
  await answer('a1_wrong_1', qA1, { correct: false, confidence: 'confident', at: now - 3 * DAY });
  await answer('a1_wrong_2', qA1, { correct: false, confidence: 'unsure', at: now - 2 * DAY });
  await answer('a2_confident', qA2, { correct: true, confidence: 'confident', at: now - 2 * DAY });
  await answer('a4_guess', qA4, { correct: true, confidence: 'guess', at: now - DAY });
  await answer('a3_hint', qA3, { correct: true, confidence: 'confident', hints: 1, at: now - DAY });
}, 120_000);

afterAll(async () => t?.close());

describe('learning on the Golden Set', () => {
  it('Weakness Center: grouped by lecture / concept / repeated question, AC-27 weights and transparent reasons', async () => {
    const w = await ok<WeaknessListResponse>(api(t).get('/api/learning/weakness'));
    expect(w.sources_note_ar.join(' ')).toMatch(/OSCE/);
    const lecture = w.items.find((x) => x.key === `lecture:${t.lecture.sourceId}`)!;
    expect(lecture).toBeDefined();
    expect(lecture.kind).toBe('lecture');
    expect(lecture.counts.wrong).toBe(2);
    expect(lecture.counts.correct_independent).toBe(1); // A2 confident
    expect(lecture.counts.correct_assisted).toBe(2); // A4 guess, A3 after a hint
    // AC-27: guessed / hint-assisted correct answers weigh less than a confident independent one
    const weightOf = (ref: string) => lecture.signal_views.find((s) => s.ref === `mcq:${attempts[ref]}`)!.weight;
    expect(weightOf('a4_guess')).toBe(MASTERY_WEIGHTS.correct_guess);
    expect(weightOf('a3_hint')).toBe(MASTERY_WEIGHTS.correct_after_hint);
    expect(weightOf('a2_confident')).toBe(MASTERY_WEIGHTS.correct_confident_independent);
    expect(weightOf('a4_guess')!).toBeLessThan(weightOf('a2_confident')!);
    const wrongW = 2 * 0.6;
    const expected = Math.round((wrongW / (wrongW + 1 + 0.2 + 0.35)) * 100) / 100;
    expect(lecture.score).toBe(expected);
    expect(lecture.score_formula_ar).toMatch(/بالتخمين 0\.2/);
    expect(lecture.reasons_ar.join(' ')).toMatch(/بالتخمين أو بعد تلميح/);
    expect(lecture.reasons_ar.join(' ')).toMatch(/متكررة/);
    expect(lecture.repeated.question_ids).toEqual([qA1]);
    expect(lecture.dedicated_revision_available).toBe(true);
    // suggested actions: pages to re-read from the lecture link, retry questions, cards from mistakes, AI-gated explanation
    const kinds = lecture.suggested_actions.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['review_pages', 'practice_questions', 'flashcards', 'simplified_explanation']));
    const simplified = lecture.suggested_actions.find((a) => a.kind === 'simplified_explanation')!;
    expect(simplified.ref.available).toBe(false);
    expect(simplified.label_ar).toMatch(/غير متاح/);
    // the concept groups of A1's link
    expect(w.items.some((x) => x.kind === 'concept' && x.repeated.question_ids.includes(qA1))).toBe(true);
    // a question with repeated mistakes is its own weakness; a single wrong answer elsewhere would not be
    expect(w.items.some((x) => x.key === `question:${qA1}`)).toBe(true);
  });

  it('owner edits: dismiss stays until new mistakes; excluded signals leave the score; dedicated revision', async () => {
    const w = await ok<WeaknessListResponse>(api(t).get('/api/learning/weakness'));
    const lecture = w.items.find((x) => x.key === `lecture:${t.lecture.sourceId}`)!;
    const patched = await ok(api(t).patch(`/api/learning/weakness/${lecture.id}`, { label: 'التهاب الزائدة', excluded_refs: [`mcq:${attempts.a4_guess}`] }));
    expect(patched.label).toBe('التهاب الزائدة');
    expect(patched.label_origin).toBe('owner');
    expect(patched.counts.excluded).toBe(1);
    expect(patched.counts.correct_assisted).toBe(1);
    // the attempt itself is untouched
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_attempt WHERE id = ?', [attempts.a4_guess!])!.n).toBe(1);
    const rev = await ok<RevisionSessionDetail>(api(t).post(`/api/learning/weakness/${lecture.id}/revision`, { minutes: 15 }));
    expect(rev.weakness_id).toBe(lecture.id);
    expect(rev.total_est_minutes).toBeLessThanOrEqual(15);
    expect(rev.items.some((i) => i.kind === 'question' && i.question_id === qA1)).toBe(true);
    expect(rev.items.some((i) => i.kind === 'pages')).toBe(true);
    const dismissed = await ok(api(t).patch(`/api/learning/weakness/${lecture.id}`, { status: 'dismissed' }));
    expect(dismissed.status).toBe('dismissed');
    expect((await ok<WeaknessListResponse>(api(t).get('/api/learning/weakness'))).items.some((x) => x.id === lecture.id)).toBe(false);
    t.clock.advance(MIN);
    await answer('a1_wrong_3', qA1, { correct: false, confidence: 'confident', at: t.ctx.clock.now() });
    const back = await ok(api(t).get(`/api/learning/weakness/${lecture.id}`));
    expect(back.status).toBe('active');
    expect(back.status_reason_ar).toMatch(/أخطاء جديدة/);
  });

  it('Mistake Genome: estimated distribution with its denominator; owner edits go through the exams service', async () => {
    const g = await ok<MistakeGenomeView>(api(t).get('/api/learning/mistakes/genome'));
    expect(g.denominator).toBe(3);
    expect(g.estimate_note_ar).toMatch(/ليس تشخيصًا نفسيًا/);
    expect(g.distribution.reduce((a, d) => a + d.count, 0) + g.unclassified).toBe(3);
    const target = g.recent.find((r) => r.attempt_id === attempts.a1_wrong_1)!;
    expect(target.auto_mistake_type).not.toBeNull();
    const r = await ok(api(t).patch(`/api/learning/mistakes/${attempts.a1_wrong_1}`, { mistake_type: 'concept_confusion' }));
    expect(r.attempt.mistake_type).toBe('concept_confusion');
    expect(r.attempt.mistake_origin).toBe('owner');
    expect(r.attempt.auto_mistake_type).toBe(target.auto_mistake_type);
    expect(r.attempt.is_correct).toBe(false);
    const g2 = await ok<MistakeGenomeView>(api(t).get('/api/learning/mistakes/genome'));
    expect(g2.distribution.find((d) => d.type === 'concept_confusion')!.by_owner).toBe(1);
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM change_log WHERE entity_type = 'question_attempt' AND action = 'mistake_type'`)!.n).toBe(1);
    // a correct answer cannot be classified as a mistake
    expect((await api(t).patch(`/api/learning/mistakes/${attempts.a2_confident}`, { mistake_type: 'misread' })).statusCode).toBe(409);
  });

  it('Reasoning Replay: built from the question explanation when present, says what is missing otherwise (AI-gated)', async () => {
    const src = await ok<ReasoningReplayView>(api(t).get(`/api/learning/reasoning/${qA1}?attempt_id=${attempts.a1_wrong_1}`));
    expect(src.key_known).toBe(true);
    expect(src.label_ar).toMatch(/ليس سجلًا لتفكير داخلي/);
    expect(src.content_source).toBe('none');
    expect(src.missing_ar.length).toBeGreaterThan(0);
    expect(src.ai.needed).toBe(true);
    expect(src.ai.available).toBe(false);
    expect(src.ai.reason_ar).toMatch(/الذكاء الاصطناعي/);
    expect(src.options.filter((o) => o.is_best)).toHaveLength(1);
    expect(src.options.some((o) => o.chosen_by_you && !o.is_best)).toBe(true);
    // an owner question that carries its explanation and distractor explanations
    const { questionId } = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which sign suggests appendicitis?',
      options: [{ text: 'Rovsing sign' }, { text: 'Murphy sign' }, { text: 'Cullen sign' }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
      explanation: 'Rovsing sign: RIF pain on LIF pressure.',
      distractorExplanations: { 1: { v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'Murphy sign points to cholecystitis.' }] }] }, 2: { v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: 'Cullen sign suggests retroperitoneal bleeding.' }] }] } },
    });
    const own = await ok<ReasoningReplayView>(api(t).get(`/api/learning/reasoning/${questionId}`));
    expect(own.content_source).toBe('question_explanation');
    expect(own.missing_ar).toEqual([]);
    expect(own.ai.needed).toBe(false);
    const best = own.options.find((o) => o.is_best)!;
    expect(best.why!.paragraphs[0]!.runs.map((r) => r.t).join('')).toMatch(/Rovsing/);
    expect(own.options.filter((o) => !o.is_best).every((o) => o.why !== null)).toBe(true);
    // unresolved key: nothing is presented as the better answer
    const unresolved = await ok<ReasoningReplayView>(api(t).get(`/api/learning/reasoning/${qB3}`));
    expect(unresolved.key_known).toBe(false);
    expect(unresolved.options.every((o) => !o.is_best)).toBe(true);
    expect(unresolved.missing_ar[0]).toMatch(/غير محسوم/);
  });

  it('card from a mistake: front/back from the question, idempotent; unresolved keys refused; AC-26 on key correction', async () => {
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards/from-mistake', { attempt_id: attempts.a1_wrong_1 }));
    const card = r.cards[0]!;
    expect(card.kind).toBe('mistake');
    expect(card.origin).toBe('from_mistake');
    expect(card.source_id).toBe(t.qs.sourceId);
    const back = card.back.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(back).toMatch(/^الإجابة: /);
    expect(back).toMatch(/اخترتَ/);
    const again = await ok<CardCreateResponse>(api(t).post('/api/learning/cards/from-mistake', { attempt_id: attempts.a1_wrong_1 }));
    expect(again.created).toBe(false);
    expect(again.cards[0]!.id).toBe(card.id);
    // a wrong answer to an unresolved key cannot become a card with an uncertain answer
    const vB3 = versionOf(qB3);
    const bad = newId();
    await push(t as never, [{ entity_type: 'question_attempt', entity_id: bad, op: 'append', payload: { question_id: qB3, question_version_id: vB3.id, selected_option_ids: [vB3.options[0]], answered_at: t.ctx.clock.now() } }]);
    expect((await api(t).post('/api/learning/cards/from-mistake', { attempt_id: bad })).statusCode).toBe(409);

    // review it, then the owner corrects the key → new question version → the card is flagged, history kept
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: card.id, rating: 1, reviewed_at: t.ctx.clock.now() }));
    const opts = t.ctx.db.all<{ option_key: string; id: string }>('SELECT option_key, id FROM question_option WHERE question_version_id = ? ORDER BY ord', [versionOf(qA1).id]);
    const correct = versionOf(qA1).correct;
    const otherKey = opts.find((o) => !correct.includes(o.id))!.option_key;
    await ok(api(t).post(`/api/questions/${qA1}/key`, { option_keys: [otherKey], reason: 'test correction' }));
    const list = await ok(api(t).get('/api/learning/cards?status=needs_review'));
    const flagged = (list.items as FlashcardView[]).find((c) => c.id === card.id)!;
    expect(flagged.needs_review).toBe(true);
    expect(flagged.impacts.find((i) => i.kind === 'question_changed')!.reason_ar).toMatch(/مفتاح/);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [card.id])!.n).toBe(1);
    const kept = await ok(api(t).post(`/api/learning/cards/${card.id}/impact/resolve`, { resolution: 'keep' }));
    expect(kept.card.needs_review).toBe(false);
    expect(kept.card.impacts[0].resolution).toBe('keep');
  });

  it('progress separation: viewing pages is reading progress, never mastery; mastery needs scored answers', async () => {
    const pages = t.ctx.db.all<{ page_index: number }>('SELECT page_index FROM source_page WHERE version_id = ? ORDER BY page_index', [t.qs.versionId]);
    await ok(api(t).post('/api/annotations/progress', { source_id: t.qs.sourceId, version_id: t.qs.versionId, page_indexes: pages.map((p) => p.page_index) }));
    const qsProgress = await ok<SourceProgressDetail>(api(t).get(`/api/learning/progress/${t.qs.sourceId}`));
    expect(qsProgress.reading_progress).toBe(1);
    expect(qsProgress.notes_ar[0]).toMatch(/لا يُعد إتمامًا/);
    expect(qsProgress.notes_ar[0]).toMatch(/ولا إتقانًا/);
    expect(qsProgress.explanation_coverage).toBe(0);
    // the questions file has scored answers: mastery is the mean AC-27 weight, independent of reading
    expect(qsProgress.practice.scored_attempts).toBeGreaterThanOrEqual(3);
    expect(qsProgress.mastery_estimate).not.toBeNull();
    expect(qsProgress.mastery_estimate!).toBeLessThan(qsProgress.reading_progress);
    // the previous-exam file holds A1 (three wrong answers): its estimate is 0, whatever was read
    const prev = await ok<SourceProgressDetail>(api(t).get(`/api/learning/progress/${t.prev.sourceId}`));
    expect(prev.mastery_estimate).toBe(0);
    // a lecture without answers has no mastery estimate at all (never a guess)
    const now = t.ctx.clock.now();
    const bare = newId();
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'Unread lecture', 'lecture', ?, ?)`, [bare, now, now]);
    const empty = await ok<SourceProgressDetail>(api(t).get(`/api/learning/progress/${bare}`));
    expect(empty.mastery_estimate).toBeNull();
    expect(empty.reading_progress).toBe(0);
    expect(empty.mastery.basis_ar).toMatch(/3/);
  });

  it('Exam DNA: unique vs occurrences with explicit denominators, sample + warnings; relevance is not a probability', async () => {
    const dna = await ok<ExamDnaDetail>(api(t).get('/api/learning/exam-dna'));
    expect(dna.sample.files).toBe(2);
    expect(dna.sample.unique_questions).toBe(9); // A1 appears in both files (exact duplicate) → one unique question
    expect(dna.sample.occurrences).toBe(10);
    expect(dna.sample.date_range).toBeNull();
    for (const c of dna.by_concept) expect(c.denominator_unique).toBe(9);
    for (const c of dna.by_item_type) expect(c.denominator).toBe(9);
    expect(dna.by_item_type.reduce((a, x) => a + x.count, 0)).toBe(9);
    const appendicitis = dna.by_concept.find((c) => c.label === 'Acute Appendicitis')!;
    expect(appendicitis.unique).toBe(1);
    expect(appendicitis.occurrences).toBe(2);
    expect(dna.warnings_ar.join(' ')).toMatch(/العينة صغيرة/);
    expect(dna.warnings_ar.join(' ')).toMatch(/تاريخ الأسئلة غير معروف/);
    expect(dna.warnings_ar.join(' ')).toMatch(/مدرّس أو قسم/);
    expect(dna.relevance_note_ar).toMatch(/وليس احتمال/);
    expect(dna.counting_note_ar).toMatch(/فريد/);
    const rel = await ok<ExamRelevanceView>(api(t).get(`/api/learning/exam-dna/relevance?question_id=${qA1}`));
    expect(rel.counts.files_with_question).toBe(2);
    expect(rel.level).toBe('medium'); // would be high, capped: the sample is small
    expect(rel.reasons_ar.join(' ')).toMatch(/ملفات|ملف/);
    expect(rel.reasons_ar.join(' ')).toMatch(/صغيرة/);
    expect(rel.note_ar).toMatch(/وليس احتمال/);
    expect(JSON.stringify(rel)).not.toMatch(/probability|احتمال ظهور السؤال: \d/);
    // an owner question outside the sample
    const { questionId } = createQuestion(t.ctx, { origin: 'owner', qtype: 'sba', stem: 'Owner question', options: [{ text: 'a' }, { text: 'b' }], correctOptionIndexes: [0], answerStatus: 'owner_key' });
    expect((await ok<ExamRelevanceView>(api(t).get(`/api/learning/exam-dna/relevance?question_id=${questionId}`))).level).toBe('not_in_sample');
  });

  it('one-tap revision fits the minutes, with reasons and estimate basis; planner sized by the real lecture; Home', async () => {
    for (let i = 0; i < 30; i++) {
      const c = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: `Card ${i} about appendicitis`, back: `Answer ${i}`, source_id: t.lecture.sourceId }))).cards[0]!;
      await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 1, reviewed_at: t.ctx.clock.now() }));
    }
    t.clock.advance(30 * MIN);
    t.h = await t.login();
    for (const minutes of [5, 12, 45]) {
      const s = await ok<RevisionSessionDetail>(api(t).post('/api/learning/revision', { minutes }));
      expect(s.total_est_minutes).toBeLessThanOrEqual(minutes);
      expect(s.items.length).toBeGreaterThan(0);
      expect(s.items.every((i) => i.reason_ar.length > 0 && i.est_minutes > 0)).toBe(true);
      expect(s.explanation_ar).toMatch(/تقديرية/);
      expect(s.estimate_basis_ar.join(' ')).toMatch(/افتراضي|متوسط/);
      const sum = s.items.reduce((a, i) => a + i.est_minutes, 0);
      expect(sum).toBeLessThanOrEqual(minutes + 1e-9);
      const again = await ok<RevisionSessionDetail>(api(t).get(`/api/learning/revision/${s.id}`));
      expect(again.items).toEqual(s.items);
    }
    const mixed = await ok<RevisionSessionDetail>(api(t).post('/api/learning/revision', { minutes: 45 }));
    expect(new Set(mixed.items.map((i) => i.kind))).toEqual(new Set(['flashcard', 'question', 'pages']));
    expect(mixed.items.some((i) => i.kind === 'question' && i.question_id === qA1)).toBe(true);
    // same data → same selection (deterministic)
    const again = await ok<RevisionSessionDetail>(api(t).post('/api/learning/revision', { minutes: 45 }));
    expect(again.items).toEqual(mixed.items);

    const exam = '2026-10-25';
    const plan = await ok<StudyPlanView>(
      api(t).post('/api/learning/plans', {
        title: 'Surgery final',
        exam_date: exam,
        source_ids: [t.lecture.sourceId],
        available_weekdays: [0, 1, 2, 3, 4, 5, 6],
        daily_minutes: 60,
        blocked_dates: [],
        include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true },
      }),
    );
    const pages = t.ctx.db.get<{ page_count: number }>('SELECT page_count FROM source_version WHERE id = (SELECT current_version_id FROM source WHERE id = ?)', [t.lecture.sourceId])!.page_count;
    const learn = plan.tasks.filter((x) => x.kind === 'learn');
    expect(learn.reduce((a, x) => a + x.minutes, 0)).toBe(pages * 4);
    expect(plan.tasks.some((x) => x.kind === 'mcq')).toBe(true);
    expect(plan.tasks.some((x) => x.kind === 'weakness')).toBe(true);
    expect(plan.tasks.at(-1)!.kind).toBe('exam');
    const perDay = new Map<string, number>();
    for (const x of plan.tasks) perDay.set(x.day, (perDay.get(x.day) ?? 0) + x.minutes);
    for (const m of perDay.values()) expect(m).toBeLessThanOrEqual(60);

    // Home: continue studying first, today's tasks, due cards, exam countdown, top weakness, important questions with reasons
    await push(t as never, [{ entity_type: 'study_session', entity_id: newId(), op: 'upsert', payload: { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, mode: 'learn', view: 'original', location: { page_index: 1 } } }]);
    const home = await ok<HomeDetail>(api(t).get('/api/learning/home'));
    expect(home.continue[0]!.source_id).toBe(t.lecture.sourceId);
    expect(home.continue[0]!.page_label_ar).toMatch(/ص/);
    expect(home.today.length).toBeGreaterThan(0);
    expect(home.today.every((x) => x.day === home.day)).toBe(true);
    expect(home.due_cards).toBeGreaterThanOrEqual(30);
    expect(home.exam).toEqual({ title: 'Surgery final', date: exam, days_left: 16 });
    expect(home.top_weakness).not.toBeNull();
    expect(home.important_questions.length).toBeGreaterThan(0);
    expect(home.important_questions.every((q) => q.reason_ar.length > 0)).toBe(true);
    expect(home.important_questions.find((q) => q.question_id === qA1)!.reason_ar).toMatch(/وليس احتمال|أخطأت/);
  });
  it('card from a selection: exact evidence from the region, dependency recorded; AC-26 on source replacement', async () => {
    const region = t.ctx.db.get<{ id: string; text: string }>(
      `SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id WHERE r.version_id = ? AND r.kind = 'paragraph' AND r.text LIKE 'Pain usually begins%' ORDER BY p.page_index, r.reading_order LIMIT 1`,
      [t.lecture.versionId],
    )!;
    const r = await ok<CardCreateResponse>(
      api(t).post('/api/learning/cards/from-selection', { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, quote: region.text.slice(0, 30), region_id: region.id, start: 0, end: 30, front: 'ما الذي تقوله المحاضرة هنا؟' }),
    );
    const card = r.cards[0]!;
    expect(card.origin).toBe('from_selection');
    expect(card.evidence).toHaveLength(1);
    expect(card.evidence[0]!.quote).toBe(region.text.slice(0, 30));
    expect(card.evidence[0]!.available).toBe(true);
    expect(card.back.paragraphs[0]!.runs[0]!.kind).toBe('original_quote');
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM artifact_dependency WHERE dependent_type = 'flashcard' AND dependent_id = ?`, [card.id])!.n).toBeGreaterThan(0);
    // a selection from another version is refused
    expect((await api(t).post('/api/learning/cards/from-selection', { source_id: t.lecture.sourceId, version_id: t.qs.versionId, quote: 'x', region_id: region.id, front: 'q' })).statusCode).toBe(400);
    // history, then the owner uploads a replacement version of the lecture
    const now = t.ctx.clock.now();
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: card.id, rating: 3, reviewed_at: now }));
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: card.id, rating: 3, reviewed_at: now + MIN }));
    t.clock.advance(20 * MIN);
    const body = multipart({ note: 'new edition' }, [{ name: 'lecture_appendicitis_v2.pdf', data: golden('lecture_cholecystitis.pdf') }]);
    const up = await t.app.inject({ method: 'POST', url: `/api/sources/${t.lecture.sourceId}/versions`, headers: { ...t.h, 'content-type': body.contentType }, payload: body.payload });
    expect(up.statusCode).toBe(200);
    await t.ctx.jobs.drain();
    await ok(api(t).get('/api/evidence/alerts?status=all'));
    const v = (await ok(api(t).get(`/api/learning/cards/${card.id}`))).card as FlashcardView;
    expect(v.needs_review).toBe(true);
    const impact = v.impacts.find((i) => i.kind === 'source_changed')!;
    expect(impact.alert_id).toBeTruthy();
    expect(impact.reason_ar).toMatch(/سجل مراجعاتك محفوظ/);
    expect(v.review_state.reps).toBe(2);
    const q = await ok(api(t).get('/api/learning/review/queue'));
    expect(q.counts.needs_review).toBeGreaterThanOrEqual(1);
    // relearn: the schedule restarts, every earlier event is kept
    const relearn = await ok(api(t).post(`/api/learning/cards/${card.id}/impact/resolve`, { resolution: 'relearn' }));
    expect(relearn.card.needs_review).toBe(false);
    expect(relearn.card.review_state.state).toBe('new');
    expect(relearn.card.schedule_resets).toHaveLength(1);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [card.id])!.n).toBe(2);
    // the card can be moved to the current version explicitly
    const moved = await ok(api(t).post(`/api/learning/cards/${card.id}/impact/resolve`, { resolution: 'move_to_current_version' }));
    expect(moved.card.source_version_id).not.toBe(t.lecture.versionId);
  });


  it('AC-26: a card whose cited evidence becomes unavailable (source trashed) is flagged, history and citation text kept', async () => {
    const region = t.ctx.db.get<{ id: string; text: string }>(
      `SELECT r.id, r.text FROM source_region r WHERE r.version_id = ? AND r.kind IN ('paragraph','question','text_block') AND length(r.text) > 20 ORDER BY r.reading_order LIMIT 1`,
      [t.prev.versionId],
    )!;
    const ev = fromRegion(t.ctx, region.id);
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'From the 2024 exam', back: 'Answer', source_id: t.qs.sourceId, evidence_ids: [ev.id] }));
    const card = r.cards[0]!;
    expect(card.evidence[0]!.available).toBe(true);
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: card.id, rating: 3, reviewed_at: t.ctx.clock.now() }));
    await ok(api(t).post(`/api/sources/${t.prev.sourceId}/trash`, {}));
    const v = (await ok(api(t).get(`/api/learning/cards/${card.id}`))).card as FlashcardView;
    expect(v.needs_review).toBe(true);
    const imp = v.impacts.find((i) => i.kind === 'evidence_unavailable')!;
    expect(imp.reason_ar).toMatch(/سلة المحذوفات/);
    expect(imp.reason_ar).toContain(region.text.slice(0, 20));
    expect(v.evidence[0]!.available).toBe(false);
    expect(v.evidence[0]!.quote).toBe(ev.quote);
    expect(v.review_state.reps).toBe(1);
    // restoring the source clears the cause (the row stays, inactive)
    await ok(api(t).post(`/api/sources/${t.prev.sourceId}/restore`, {}));
    const back = (await ok(api(t).get(`/api/learning/cards/${card.id}`))).card as FlashcardView;
    expect(back.needs_review).toBe(false);
    expect(back.impacts.find((i) => i.kind === 'evidence_unavailable')!.active).toBe(false);
  });
});
