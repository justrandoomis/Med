// Regression tests for the independent review of track L1 (see docs/modules/learning.md §14): provenance on cards made
// from a mistake, bounded planner horizon, opaque occlusion mask ids, owner weakness status kept, owner-day starts on
// DST-gap days, schedule cache keyed by the library version, sync payload checks, Anki export details.
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stableStringify, type CardCreateResponse, type CardReviewPayload, type FlashcardView, type SrsConfigView, type WeaknessListResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { encodePng } from '../../src/modules/processing/png';
import { createQuestion } from '../../src/modules/questions/service';
import { srsParams } from '../../src/modules/learning/srs';
import { addDays, dayEndMs, dayOf, dayStartMs } from '../../src/modules/learning/time';
import { api, createLearningApp, DAY, MIN, ok, push, rt, type LApp } from './helpers';

const T0 = Date.UTC(2026, 9, 9, 9, 0, 0);
/** Anki text-import file → headers + tab-separated rows (same reading as cards.test.ts). */
function parseAnkiTsv(body: string): { headers: Record<string, string>; rows: string[][] } {
  const headers: Record<string, string> = {};
  const rows: string[][] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) headers[line.slice(1, line.indexOf(':'))] = line.slice(line.indexOf(':') + 1);
    else rows.push(line.split('\t'));
  }
  return { headers, rows };
}
const text = (r: { paragraphs: Array<{ runs: Array<{ t: string }> }> }) => r.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');

describe('L1 review fixes', () => {
  let t: LApp;
  beforeEach(async () => {
    t = await createLearningApp({ now: T0 });
  });
  afterEach(async () => t.close());

  async function wrongAttempt(qid: string, at: number): Promise<string> {
    const v = t.ctx.db.get<{ id: string; correct_option_ids_json: string }>('SELECT v.id, v.correct_option_ids_json FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?', [qid])!;
    const opts = t.ctx.db.all<{ id: string }>('SELECT id FROM question_option WHERE question_version_id = ? ORDER BY ord', [v.id]).map((o) => o.id);
    const correct = JSON.parse(v.correct_option_ids_json) as string[];
    const id = newId();
    const [r] = await push(t, [
      { entity_type: 'question_attempt', entity_id: id, op: 'append', payload: { question_id: qid, question_version_id: v.id, selected_option_ids: [opts.find((o) => !correct.includes(o))], confidence: 'confident', answered_at: at } },
    ]);
    expect(r!.result).toBe('applied');
    return id;
  }

  it('a card from a mistake says when the question is generated and when its key is AI-derived (§0.3)', async () => {
    const gen = createQuestion(t.ctx, {
      origin: 'generated',
      qtype: 'sba',
      stem: 'Which sign is classic for acute appendicitis?',
      options: [{ text: 'Rovsing sign' }, { text: 'Murphy sign' }],
      correctOptionIndexes: [0],
      answerStatus: 'ai_derived',
      explanation: 'Rovsing sign is RIF pain on LIF pressure.',
    });
    const card = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards/from-mistake', { attempt_id: await wrongAttempt(gen.questionId, T0 - DAY) }))).cards[0]!;
    expect(text(card.front)).toMatch(/مولد بواسطة MedLevo — ليس من ملفاتك/);
    const back = text(card.back);
    expect(back).toMatch(/^الإجابة: A\. Rovsing sign/);
    expect(back).toMatch(/مصدر الإجابة: حل مولد من الأدلة \(AI-derived\) — ليست مفتاحًا من ملفاتك/);
    expect(card.origin_ref).toMatchObject({ question_origin: 'generated', answer_status: 'ai_derived' });
    // the export carries the same labels (the card leaves the app with its provenance)
    const tsv = (await t.app.inject({ method: 'GET', url: '/api/learning/export/anki', headers: t.h })).body;
    expect(tsv).toContain('AI-derived');
    // an owner question: no «generated» label, the key is the owner's
    const own = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which sign suggests acute cholecystitis?',
      options: [{ text: 'Murphy sign' }, { text: 'Cullen sign' }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
    });
    const c2 = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards/from-mistake', { attempt_id: await wrongAttempt(own.questionId, T0 - DAY) }))).cards[0]!;
    expect(text(c2.front)).not.toMatch(/مولد/);
    expect(text(c2.back)).toMatch(/مصدر الإجابة: مفتاح حددته بنفسي\./);
  });

  it('planner: an exam date beyond the planning horizon is refused (no unbounded day-by-day schedule)', async () => {
    const lecture = newId();
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'Lecture', 'lecture', ?, ?)`, [lecture, T0, T0]);
    const cfg = (exam_date: string) => ({
      title: 'x',
      exam_date,
      source_ids: [lecture],
      available_weekdays: [0, 1, 2, 3, 4, 5, 6],
      daily_minutes: 60,
      blocked_dates: [],
      include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true },
    });
    for (const route of ['/api/learning/plans/preview', '/api/learning/plans']) {
      const far = await api(t).post(route, cfg('2206-10-09'));
      expect(far.statusCode).toBe(400);
      expect(far.body).toMatch(/بعيد جدًا/);
    }
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plan_task')!.n).toBe(0);
    // a long but real horizon still works
    expect((await api(t).post('/api/learning/plans/preview', cfg(addDays('2026-10-09', 1000)))).statusCode).toBe(200);
  });

  it('occlusion review payload: mask ids are positional, never the stored (client-named) ids', async () => {
    const file = await t.ctx.files.put(encodePng({ width: 20, height: 20, data: new Uint8Array(1600).fill(255) }), { mime: 'image/png', originalName: 'a.png' });
    const imageId = newId();
    t.ctx.db.run(`INSERT INTO image_asset (id, file_id, origin, image_kind, created_at) VALUES (?, ?, 'source', 'diagram', ?)`, [imageId, file.id, T0]);
    const r = await ok<CardCreateResponse>(
      api(t).post('/api/learning/cards/occlusion', {
        image_asset_id: imageId,
        masks: [
          { id: 'Caecum', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Caecum' },
          { id: 'Ileum', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, label: 'Ileum' },
        ],
      }),
    );
    const ileum = r.cards.find((c) => text(c.back) === 'Ileum')!;
    const p = await ok<CardReviewPayload>(api(t).get(`/api/learning/cards/${ileum.id}/review`));
    expect(p.image!.masks.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(p.image!.masks.map((m) => m.active)).toEqual([false, true]);
    expect(JSON.stringify(p.image)).not.toMatch(/Caecum|Ileum/);
  });

  it('a weakness the owner dismissed stays dismissed when its signals disappear', async () => {
    const q = createQuestion(t.ctx, {
      origin: 'owner',
      qtype: 'sba',
      stem: 'Which sign is classic for acute appendicitis?',
      options: [{ text: 'Rovsing sign' }, { text: 'Murphy sign' }],
      correctOptionIndexes: [0],
      answerStatus: 'owner_key',
    });
    await wrongAttempt(q.questionId, T0 - 2 * DAY);
    await wrongAttempt(q.questionId, T0 - DAY);
    const w = (await ok<WeaknessListResponse>(api(t).get('/api/learning/weakness'))).items.find((x) => x.key === `question:${q.questionId}`)!;
    expect(w.status).toBe('active');
    await ok(api(t).patch(`/api/learning/weakness/${w.id}`, { status: 'dismissed' }));
    t.clock.advance(MIN);
    await ok(api(t).post('/api/learning/profile/reset', { part: 'mcq_attempts' }));
    const after = (await ok<WeaknessListResponse>(api(t).get('/api/learning/weakness?status=all'))).items.find((x) => x.id === w.id)!;
    expect(after.status).toBe('dismissed');
    expect(after.status_origin).toBe('owner');
  });

  it('a schedule cached with another library version is recomputed (params_key covers the ts-fsrs version)', async () => {
    const c = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A' }))).cards[0]!;
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 3, reviewed_at: T0 }));
    const cfg = await ok<SrsConfigView>(api(t).get('/api/learning/srs-config'));
    const paramsOnly = createHash('sha256').update(stableStringify(srsParams(0.9))).digest('hex');
    expect(cfg.params_key).not.toBe(paramsOnly);
    const good = ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state.due_at;
    t.ctx.db.run('UPDATE review_state SET params_key = ?, due_at = 0 WHERE card_id = ?', [paramsOnly, c.id]);
    expect(((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView).review_state.due_at).toBe(good);
  });

  it('sync: a review event whose payload id differs from the op id is refused; a negative bury time is refused', async () => {
    const c = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A' }))).cards[0]!;
    const [bad] = await push(t, [{ entity_type: 'review_event', entity_id: 'EVT1', op: 'append', payload: { id: 'OTHER', cardId: c.id, rating: 3, reviewedAt: T0 } }]);
    expect(bad!.result).toBe('rejected');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event')!.n).toBe(0);
    const [good] = await push(t, [{ entity_type: 'review_event', entity_id: 'EVT2', op: 'append', payload: { id: 'EVT2', cardId: c.id, rating: 3, reviewedAt: T0 } }]);
    expect(good!.result).toBe('applied');
    const [neg] = await push(t, [{ entity_type: 'flashcard', entity_id: c.id, op: 'upsert', base_rev: c.rev, payload: { kind: 'basic', front: rt('Q'), back: rt('A'), buriedUntil: -5 } }]);
    expect(neg!.result).toBe('rejected');
  });

  it('Anki export: escaped Source column, safe tags, cloze markers only for the exported cards of a note', async () => {
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES ('S1', 'Shock <b>"lecture"</b> 2:1', 'lecture', ?, ?)`, [T0, T0]);
    await ok(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A', source_id: 'S1' }));
    const basic = parseAnkiTsv((await t.app.inject({ method: 'GET', url: '/api/learning/export/anki', headers: t.h })).body);
    const row = basic.rows[0]!;
    expect(row[3]).toBe('Shock &lt;b&gt;&quot;lecture&quot;&lt;/b&gt; 2:1');
    expect(row[4]!.split(' ')).toEqual(['medlevo', 'medlevo::basic', 'medlevo::source::Shock_b_lecture_b_2_1']);
    // a cloze note with c1 (kept), c2 (deleted) and c3 (suspended)
    const cl = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'cloze', front: 'A {{c1::one}} B {{c2::two::hint}} C {{c3::three}}.' }));
    await ok(api(t).del(`/api/learning/cards/${cl.cards[1]!.id}`));
    await ok(api(t).post(`/api/learning/cards/${cl.cards[2]!.id}/suspend`, { suspended: true }));
    const clozeText = async (q: string) => {
      const res = await t.app.inject({ method: 'GET', url: `/api/learning/export/anki${q}`, headers: t.h });
      const zip = await JSZip.loadAsync(res.rawPayload);
      return parseAnkiTsv(await zip.file('medlevo-cloze.txt')!.async('string')).rows.map((r) => r[1]);
    };
    expect(await clozeText('')).toEqual(['<div dir=ltr>A {{c1::one}} B two C three.</div>']);
    expect(await clozeText('?include_suspended=true')).toEqual(['<div dir=ltr>A {{c1::one}} B two C {{c3::three}}.</div>']);
  });

  it('AC-26: a source trashed AGAIN after the owner kept the card flags it again; restoring a deleted card does not', async () => {
    t.ctx.db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES ('S2', 'Lecture two', 'lecture', ?, ?)`, [T0, T0]);
    const c = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A', source_id: 'S2' }))).cards[0]!;
    const view = async () => ((await ok(api(t).get(`/api/learning/cards/${c.id}`))).card as FlashcardView);
    const trash = (at: number | null) => t.ctx.db.run('UPDATE source SET deleted_at = ? WHERE id = ?', [at, 'S2']);
    t.clock.advance(MIN);
    trash(t.ctx.clock.now());
    expect((await view()).needs_review).toBe(true);
    t.clock.advance(MIN);
    expect((await ok(api(t).post(`/api/learning/cards/${c.id}/impact/resolve`, { resolution: 'keep' }))).card.needs_review).toBe(false);
    // deleting and restoring the card is not a new cause
    await ok(api(t).del(`/api/learning/cards/${c.id}`));
    await view();
    await ok(api(t).post(`/api/learning/cards/${c.id}/restore`, {}));
    expect((await view()).needs_review).toBe(false);
    // the source comes back, then goes to the trash again → a new cause
    t.clock.advance(MIN);
    trash(null);
    expect((await view()).needs_review).toBe(false);
    t.clock.advance(MIN);
    trash(t.ctx.clock.now());
    const again = await view();
    expect(again.needs_review).toBe(true);
    expect(again.impacts.find((i) => i.kind === 'source_trashed')!.resolution).toBeNull();
  });

  it('a new cloze index added to a generated note stays «generated» (never relabelled as written by the owner)', async () => {
    const id = newId();
    t.ctx.db.run(
      `INSERT INTO flashcard (id, kind, front_json, back_json, evidence_ids_json, origin, rev, created_at, updated_at, note_id, cloze_index) VALUES (?, 'cloze', ?, ?, '[]', 'generated', 1, ?, ?, ?, 1)`,
      [id, JSON.stringify(rt('Pain starts {{c1::periumbilical}}.')), JSON.stringify({ v: 1, paragraphs: [] }), T0, T0, id],
    );
    await ok(api(t).patch(`/api/learning/cards/${id}`, { base_rev: 1, front: 'Pain starts {{c1::periumbilical}} then moves to the {{c2::RIF}}.' }));
    const added = t.ctx.db.get<{ origin: string; cloze_index: number }>('SELECT origin, cloze_index FROM flashcard WHERE note_id = ? AND id <> ?', [id, id])!;
    expect(added).toEqual({ origin: 'generated', cloze_index: 2 });
  });
});

describe('owner day starts on DST-gap days (midnight skipped)', () => {
  it('the day starts at the first instant whose local date is that day', () => {
    // America/Santiago 2026-09-06: 00:00 → 01:00 (-04 → -03): the day starts at 04:00Z, not 03:00Z (23:00 of the 5th)
    expect(dayStartMs('2026-09-06', 'America/Santiago')).toBe(Date.UTC(2026, 8, 6, 4, 0, 0));
    expect(dayEndMs('2026-09-05', 'America/Santiago')).toBe(Date.UTC(2026, 8, 6, 4, 0, 0));
    // America/Havana 2026-03-08: 00:00 → 01:00 (-05 → -04)
    expect(dayStartMs('2026-03-08', 'America/Havana')).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    // ordinary zones are unchanged
    expect(dayStartMs('2026-10-10', 'Asia/Baghdad')).toBe(Date.UTC(2026, 9, 9, 21, 0, 0));
    expect(dayStartMs('2026-03-29', 'Asia/Beirut')).toBe(Date.UTC(2026, 2, 28, 22, 0, 0));
    for (const tz of ['America/Santiago', 'America/Havana', 'Asia/Beirut', 'America/Asuncion', 'Australia/Lord_Howe', 'Asia/Baghdad']) {
      for (let d = '2026-01-01'; d < '2027-01-01'; d = addDays(d, 7)) {
        const s = dayStartMs(d, tz);
        expect(dayOf(s, tz), `${tz} ${d}`).toBe(d);
        expect(dayOf(s - 1, tz) < d, `${tz} ${d}`).toBe(true);
      }
    }
  });
});

// Regression (L1 review blocker, fixed in the sources purge): flashcard_impact / review_reset rows of purged cards are
// deleted with them, so a permanent delete of a source whose cards were flagged is no longer refused.
describe('purge × learning rows', () => {
  it('a trashed lecture whose card was flagged can be purged permanently', async () => {
    const { api: sapi, createNode, golden, makeHarness, uploadOk } = await import('../sources/helpers');
    const h = await makeHarness();
    try {
      const root = await createNode(h, { title: 'Lectures' });
      const up = await uploadOk(h, root.id, [{ name: 'lecture_appendicitis.pdf', data: golden('lecture_appendicitis.pdf') }]);
      const sid = up.results[0]!.source_id!;
      const card = ((await sapi(h).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A', source_id: sid })).json() as CardCreateResponse).cards[0]!;
      await sapi(h).post(`/api/library/nodes/${root.id}/trash`);
      expect(((await sapi(h).get(`/api/learning/cards/${card.id}`)).json() as { card: FlashcardView }).card.needs_review).toBe(true);
      const impact = (await sapi(h).get(`/api/library/nodes/${root.id}/impact?mode=purge`)).json() as { confirm_token: string };
      const res = await sapi(h).del(`/api/library/nodes/${root.id}?confirm_token=${encodeURIComponent(impact.confirm_token)}`);
      expect(res.statusCode, res.body).toBe(200);
    } finally {
      await h.close();
    }
  }, 60_000);
});
