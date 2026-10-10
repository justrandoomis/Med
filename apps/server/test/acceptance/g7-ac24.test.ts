// G7 — AC-24 «مزامنة وتعارض»: edits from two devices, or a review / an answer sent twice, never delete the owner's
// notes and never count an attempt twice; a conflict that cannot be merged keeps BOTH versions.
// REAL pipeline (Golden Set question source + previous exam + lecture uploaded, processed, extracted, matched) and the
// REAL sync engine: two devices = two owner sessions (two cookies) with two device ids pushing through
// POST /api/sync/push. Every verdict is checked through the read APIs the web app uses (notes, annotations, cards,
// exam results, the pull feed), not only through table rows. No AI is involved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotationDTO, CardDetailResponse, ExamResultDetail, ExamSessionView, NoteDTO, SourceAnnotationsResponse, SyncOpResult, SyncPullResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { createExam, createExamApp, pageId, type ExamApp } from '../exams/helpers';
import type { AuthHeaders } from '../helpers/app';
import { stateOf } from './g4-helpers';

let t: ExamApp;
let A: AuthHeaders; // device A (e.g. the iPad)
let B: AuthHeaders; // device B (e.g. the laptop)
const DEV_A = 'G7_DEVICE_A';
const DEV_B = 'G7_DEVICE_B';

beforeAll(async () => {
  t = await createExamApp();
  A = t.h;
  B = await t.login({ userAgent: 'Mozilla/5.0 (Macintosh) G7 device B' });
}, 300_000);

afterAll(async () => {
  await t?.close();
});

interface Op {
  entity_type: string;
  entity_id: string;
  op: 'upsert' | 'append' | 'delete';
  payload: unknown;
  base_rev?: number | null;
  op_id?: string;
}

async function pushAs(h: AuthHeaders, device: string, ops: Op[]): Promise<SyncOpResult[]> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: h,
    payload: { ops: ops.map((o) => ({ op_id: o.op_id ?? newId(), device_id: device, client_ts: t.ctx.clock.now(), base_rev: null, ...o })) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: SyncOpResult[] }).results;
}

async function get<T>(h: AuthHeaders, url: string): Promise<T> {
  const res = await t.app.inject({ method: 'GET', url, headers: h });
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as T;
}

const rt = (text: string) => ({ v: 1 as const, paragraphs: [{ dir: 'rtl' as const, runs: [{ t: text }] }] });
const plain = (n: Pick<NoteDTO, 'body'>) => n.body.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');

function anchor(i = 0) {
  return { type: 'page' as const, source_id: t.lecture.sourceId, version_id: t.lecture.versionId, page_id: pageId(t, t.lecture.versionId, i), page_index: i, space: 'page_norm' as const };
}

async function notesOfLecture(h: AuthHeaders): Promise<NoteDTO[]> {
  return (await get<{ notes: NoteDTO[] }>(h, `/api/annotations/notes?source_id=${t.lecture.sourceId}`)).notes;
}

async function pullAll(h: AuthHeaders): Promise<SyncPullResponse['changes']> {
  const out: SyncPullResponse['changes'] = [];
  let since = 0;
  for (;;) {
    const r = await get<SyncPullResponse>(h, `/api/sync/pull?since=${since}&limit=1000`);
    out.push(...r.changes);
    if (!r.has_more) return out;
    since = r.next_since;
  }
}

describe('AC-24 notes: concurrent edits from two devices keep both texts; nothing is deleted', () => {
  const noteId = newId();
  const original = 'ملاحظة: علامة McBurney عند 1/3 المسافة';
  const fromA = 'نسخة الآيباد: ألم ينتقل إلى RLQ خلال 24 ساعة';
  const fromB = 'نسخة الحاسوب: WBC > 11 ×10⁹/L مع انحراف لليسار';
  const bEdit: Op = { op_id: newId(), entity_type: 'note', entity_id: noteId, op: 'upsert', base_rev: 1, payload: { title: 'التهاب الزائدة', body: rt(fromB), anchor: null as unknown, origin: 'owner' } };

  it('a note written on A reaches B through the pull feed (rev 1)', async () => {
    (bEdit.payload as { anchor: unknown }).anchor = anchor(0);
    const r = await pushAs(A, DEV_A, [{ entity_type: 'note', entity_id: noteId, op: 'upsert', payload: { title: 'التهاب الزائدة', body: rt(original), anchor: anchor(0), origin: 'owner' } }]);
    expect(r[0]!.result).toBe('applied');
    const seen = (await pullAll(B)).find((c) => c.entity_type === 'note' && c.entity_id === noteId);
    expect((seen?.entity as NoteDTO).rev).toBe(1);
    expect(plain(seen!.entity as NoteDTO)).toBe(original);
  });

  it('both devices edit the same note offline (base rev 1): the first applies, the second is kept as a separate note pointing at it', async () => {
    const ra = await pushAs(A, DEV_A, [{ entity_type: 'note', entity_id: noteId, op: 'upsert', base_rev: 1, payload: { title: 'التهاب الزائدة', body: rt(fromA), anchor: anchor(0), origin: 'owner' } }]);
    expect(ra[0]!.result).toBe('applied');
    const rb = await pushAs(B, DEV_B, [bEdit]);
    expect(rb[0]!.result).toBe('conflict_kept_both');
    expect(rb[0]!.detail).toContain('حُفظ نصك كملاحظة منفصلة');

    const notes = await notesOfLecture(A);
    const orig = notes.find((n) => n.id === noteId)!;
    const copy = notes.find((n) => n.conflict_of_id === noteId)!;
    expect(plain(orig)).toBe(fromA);
    expect(copy, 'B’s text is a separate note next to the original').toBeTruthy();
    expect(plain(copy)).toBe(fromB); // Arabic + English + numbers + units kept exactly
    expect(copy.device_id).toBe(DEV_B);
    expect(orig.deleted_at).toBeNull();
    expect(copy.deleted_at).toBeNull();
    // both reach the other device through the pull feed
    const feed = await pullAll(B);
    expect(feed.filter((c) => c.entity_type === 'note' && (c.entity_id === noteId || c.entity_id === copy.id)).map((c) => (c.entity as NoteDTO).deleted_at)).toEqual([null, null]);
  });

  it('the conflicting edit sent again (its answer was lost → same op id) creates NO extra copy and reports the first verdict', async () => {
    const before = (await notesOfLecture(A)).length;
    const r = await pushAs(B, DEV_B, [bEdit]);
    expect(r[0]!).toMatchObject({ result: 'duplicate', original_result: 'conflict_kept_both' });
    expect((await notesOfLecture(A)).length).toBe(before);
  });

  it('the same conflicting edit re-built with a NEW op id (owner pressed «retry» on another tab) does not pile up identical copies', async () => {
    const before = (await notesOfLecture(A)).filter((n) => n.conflict_of_id === noteId).length;
    const r = await pushAs(B, DEV_B, [{ ...bEdit, op_id: newId() }]);
    expect(r[0]!.result).toBe('duplicate');
    expect(r[0]!.detail).toContain('لم تُنشأ نسخة مكررة');
    expect((await notesOfLecture(A)).filter((n) => n.conflict_of_id === noteId).length).toBe(before);
  });

  it('a stale delete from B (it never saw A’s edit) does not delete the edited note', async () => {
    const r = await pushAs(B, DEV_B, [{ entity_type: 'note', entity_id: noteId, op: 'delete', base_rev: 1, payload: { id: noteId } }]);
    expect(r[0]!.result).toBe('conflict_kept_both');
    const n = (await notesOfLecture(A)).find((x) => x.id === noteId)!;
    expect(n.deleted_at).toBeNull();
    expect(plain(n)).toBe(fromA);
  });

  it('A deletes the note, B (offline) keeps editing it: the edit brings the note back — the text is never lost', async () => {
    const rev = (await notesOfLecture(A)).find((x) => x.id === noteId)!.rev;
    const del = await pushAs(A, DEV_A, [{ entity_type: 'note', entity_id: noteId, op: 'delete', base_rev: rev, payload: { id: noteId } }]);
    expect(del[0]!.result).toBe('applied');
    expect((await notesOfLecture(A)).some((x) => x.id === noteId)).toBe(false);
    const later = 'تعديل لاحق من الحاسوب بعد الحذف';
    const ed = await pushAs(B, DEV_B, [{ entity_type: 'note', entity_id: noteId, op: 'upsert', base_rev: rev, payload: { title: 'التهاب الزائدة', body: rt(later), anchor: anchor(0), origin: 'owner' } }]);
    expect(ed[0]!.result).toBe('merged');
    const back = (await notesOfLecture(A)).find((x) => x.id === noteId)!;
    expect(back.deleted_at).toBeNull();
    expect(plain(back)).toBe(later);
  });

  it('a delete without any base revision (an old client) still cannot remove text edited on the other device', async () => {
    // B never pulled A's newest revision; it sends a bare delete. The server must not treat «no base» as «latest».
    const id = newId();
    await pushAs(A, DEV_A, [{ entity_type: 'note', entity_id: id, op: 'upsert', payload: { title: null, body: rt('نص أول'), anchor: anchor(1), origin: 'owner' } }]);
    await pushAs(A, DEV_A, [{ entity_type: 'note', entity_id: id, op: 'upsert', base_rev: 1, payload: { title: null, body: rt('نص معدّل على الآيباد'), anchor: anchor(1), origin: 'owner' } }]);
    const r = await pushAs(B, DEV_B, [{ entity_type: 'note', entity_id: id, op: 'delete', base_rev: null, payload: { id } }]);
    const n = (await notesOfLecture(A)).find((x) => x.id === id);
    // either refused as a conflict or applied as a tombstone the owner can restore — but never a silent loss of text
    if (r[0]!.result === 'applied') {
      const raw = t.ctx.db.get<{ body_json: string; deleted_at: number | null }>('SELECT body_json, deleted_at FROM note WHERE id = ?', [id])!;
      expect(raw.deleted_at).not.toBeNull();
      expect(raw.body_json).toContain('نص معدّل على الآيباد'); // tombstone keeps the text (restorable)
    } else {
      expect(n).toBeTruthy();
    }
  });
});

describe('AC-24 ink: concurrent stroke edits keep both strokes; a stroke sent twice is one stroke', () => {
  const strokeId = newId();
  const ink = (dx: number) => ({
    kind: 'ink',
    tool: 'pen',
    anchor: anchor(0),
    data: { v: 1, points: [[0.2 + dx, 0.3, 0, 0.5], [0.25 + dx, 0.31, 16, 0.6], [0.3 + dx, 0.32, 32, 0.55]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.2 + dx, y: 0.3, w: 0.1, h: 0.02 }, pressure_available: true, tilt_available: false },
    layer: 'ink',
    z: 0,
    locked: false,
  });
  const inkOnPage0 = async () =>
    (await get<SourceAnnotationsResponse>(A, `/api/annotations/source/${t.lecture.sourceId}?version_id=${t.lecture.versionId}`)).annotations.filter((a: AnnotationDTO) => a.kind === 'ink' && a.anchor.type === 'page' && a.anchor.page_index === 0);

  it('the same stroke appended twice (two op ids, e.g. a retry after a timeout) is stored once', async () => {
    const r1 = await pushAs(A, DEV_A, [{ entity_type: 'annotation', entity_id: strokeId, op: 'append', payload: ink(0) }]);
    const r2 = await pushAs(A, DEV_A, [{ entity_type: 'annotation', entity_id: strokeId, op: 'append', payload: ink(0) }]);
    expect([r1[0]!.result, r2[0]!.result]).toEqual(['applied', 'duplicate']);
    expect((await inkOnPage0()).filter((a) => a.id === strokeId)).toHaveLength(1);
  });

  it('A moves the stroke while B moves it elsewhere (both from rev 1): both strokes are kept, none deleted', async () => {
    const ra = await pushAs(A, DEV_A, [{ entity_type: 'annotation', entity_id: strokeId, op: 'upsert', base_rev: 1, payload: ink(0.1) }]);
    const rb = await pushAs(B, DEV_B, [{ entity_type: 'annotation', entity_id: strokeId, op: 'upsert', base_rev: 1, payload: ink(0.3) }]);
    expect(ra[0]!.result).toBe('applied');
    expect(rb[0]!.result).toBe('conflict_kept_both');
    const strokes = await inkOnPage0();
    const orig = strokes.find((s) => s.id === strokeId)!;
    // the kept copy is an ordinary stroke next to the original (AnnotationDTO carries no conflict pointer; the row does)
    const copyId = t.ctx.db.get<{ id: string }>('SELECT id FROM annotation WHERE conflict_of_id = ?', [strokeId])!.id;
    const copy = strokes.find((s) => s.id === copyId)!;
    expect((orig.data as { bbox: { x: number } }).bbox.x).toBeCloseTo(0.3);
    expect((copy.data as { bbox: { x: number } }).bbox.x).toBeCloseTo(0.5);
    expect(copy.device_id).toBe(DEV_B);
  });

  it('the same moved stroke re-sent under a new op id is not stored a third time', async () => {
    const r = await pushAs(B, DEV_B, [{ entity_type: 'annotation', entity_id: strokeId, op: 'upsert', base_rev: 1, payload: ink(0.3) }]);
    expect(r[0]!.result).toBe('duplicate');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE conflict_of_id = ?', [strokeId])!.n).toBe(1);
  });

  it('an eraser on B that never saw A’s move does not erase the moved stroke', async () => {
    const r = await pushAs(B, DEV_B, [{ entity_type: 'annotation', entity_id: strokeId, op: 'delete', base_rev: 1, payload: { id: strokeId } }]);
    expect(r[0]!.result).toBe('conflict_kept_both');
    expect((await inkOnPage0()).some((s) => s.id === strokeId)).toBe(true);
  });
});

describe('AC-24 reviews: a review sent twice is counted once; the schedule is folded from unique events', () => {
  const cardId = newId();
  const eventId = newId();

  it('a card made on A is reviewed on A; the push is sent twice (same op) and re-sent with a new op id: ONE event, reps = 1', async () => {
    const c = await pushAs(A, DEV_A, [{ entity_type: 'flashcard', entity_id: cardId, op: 'upsert', payload: { kind: 'basic', front: rt('ما هي علامة Rovsing؟'), back: rt('ألم في RLQ عند الضغط على LLQ'), source_id: t.lecture.sourceId } }]);
    expect(c[0]!.result).toBe('applied');
    const op: Op = { op_id: newId(), entity_type: 'review_event', entity_id: eventId, op: 'append', payload: { card_id: cardId, rating: 3, reviewed_at: t.ctx.clock.now(), duration_ms: 4200 } };
    const r1 = await pushAs(A, DEV_A, [op]);
    const r2 = await pushAs(A, DEV_A, [op]); // the answer to the first request was lost
    const r3 = await pushAs(A, DEV_A, [{ ...op, op_id: newId() }]); // rebuilt after a reload
    expect(r1[0]!.result).toBe('applied');
    expect(r2[0]!).toMatchObject({ result: 'duplicate', original_result: 'applied' });
    expect(r3[0]!.result).toBe('duplicate');
    // and once more through the REST route a client could use
    const rest = await t.app.inject({ method: 'POST', url: '/api/learning/reviews', headers: A, payload: { id: eventId, card_id: cardId, rating: 3, reviewed_at: t.ctx.clock.now(), duration_ms: 4200 } });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({ result: 'duplicate' });

    const d = await get<CardDetailResponse>(B, `/api/learning/cards/${cardId}`);
    expect(d.events.map((e) => e.id)).toEqual([eventId]);
    expect(d.card.review_state.reps).toBe(1);
  });

  it('two devices each review the card once (two real reviews): both count, in time order, nothing lost', async () => {
    t.clock.advance(3 * 86_400_000);
    const ea = newId();
    const eb = newId();
    await pushAs(B, DEV_B, [{ entity_type: 'review_event', entity_id: eb, op: 'append', payload: { card_id: cardId, rating: 1, reviewed_at: t.ctx.clock.now() + 1000, duration_ms: 3000 } }]);
    await pushAs(A, DEV_A, [{ entity_type: 'review_event', entity_id: ea, op: 'append', payload: { card_id: cardId, rating: 4, reviewed_at: t.ctx.clock.now(), duration_ms: 2000 } }]);
    const d = await get<CardDetailResponse>(A, `/api/learning/cards/${cardId}`);
    expect(d.events.map((e) => e.id)).toEqual([eventId, ea, eb]); // folded by reviewed_at, not arrival
    expect(d.card.review_state.reps).toBe(3);
    expect(d.card.review_state.lapses).toBe(1);
  });

  it('concurrent card edits from both devices keep both versions (the second as a new card)', async () => {
    const rev = (await get<CardDetailResponse>(A, `/api/learning/cards/${cardId}`)).card.rev;
    const ra = await pushAs(A, DEV_A, [{ entity_type: 'flashcard', entity_id: cardId, op: 'upsert', base_rev: rev, payload: { kind: 'basic', front: rt('ما هي علامة Rovsing؟'), back: rt('نسخة A'), source_id: t.lecture.sourceId } }]);
    const rb = await pushAs(B, DEV_B, [{ entity_type: 'flashcard', entity_id: cardId, op: 'upsert', base_rev: rev, payload: { kind: 'basic', front: rt('ما هي علامة Rovsing؟'), back: rt('نسخة B'), source_id: t.lecture.sourceId } }]);
    expect(ra[0]!.result).toBe('applied');
    expect(rb[0]!.result).toBe('conflict_kept_both');
    const copy = t.ctx.db.get<{ id: string; back_json: string; deleted_at: number | null }>('SELECT id, back_json, deleted_at FROM flashcard WHERE conflict_of_id = ?', [cardId])!;
    expect(copy.back_json).toContain('نسخة B');
    expect(copy.deleted_at).toBeNull();
    // the review history stays on the original card, not copied (no double count through the copy)
    expect((await get<CardDetailResponse>(A, `/api/learning/cards/${copy.id}`)).events).toEqual([]);
    expect((await get<CardDetailResponse>(A, `/api/learning/cards/${cardId}`)).events).toHaveLength(3);
    // the same edit re-sent from B under a new op id keeps the one copy (no second identical card)
    const again = await pushAs(B, DEV_B, [{ entity_type: 'flashcard', entity_id: cardId, op: 'upsert', base_rev: rev, payload: { kind: 'basic', front: rt('ما هي علامة Rovsing؟'), back: rt('نسخة B'), source_id: t.lecture.sourceId } }]);
    expect(again[0]!.result).toBe('conflict_kept_both');
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flashcard WHERE conflict_of_id = ?', [cardId])!.n).toBe(1);
  });
});

describe('AC-24 exams: an answer or a finish sent twice / from two devices is counted once', () => {
  let s: ExamSessionView;

  it('practice: the same checked answer pushed twice and also sent through the REST check → ONE question attempt', async () => {
    s = (await createExam(t, { mode: 'practice', count: 3, source_ids: [t.qs.sourceId], seed: 'g7-ac24-practice' })).session;
    const item = s.items[0]!;
    const attemptId = newId();
    const payload = { question_id: item.question_id, question_version_id: item.question_version_id, exam_attempt_id: s.attempt.id, exam_item_index: 0, selected_option_ids: [item.options[0]!.id], confidence: 'confident', answered_at: t.ctx.clock.now() };
    const op: Op = { op_id: newId(), entity_type: 'question_attempt', entity_id: attemptId, op: 'append', payload };
    const r1 = await pushAs(A, DEV_A, [op]);
    const r2 = await pushAs(A, DEV_A, [op]);
    expect(r1[0]!.result).toBe('applied');
    expect(r2[0]!.result).toBe('duplicate');
    const check = await t.app.inject({ method: 'POST', url: `/api/exams/attempts/${s.attempt.id}/items/0/answer`, headers: B, payload: { id: attemptId, selected_option_ids: [item.options[0]!.id], answered_at: t.ctx.clock.now() } });
    expect(check.statusCode, check.body).toBe(200);
    // B answers the SAME item with another choice and another id: the first answer stays; not a second attempt
    const other = await pushAs(B, DEV_B, [{ entity_type: 'question_attempt', entity_id: newId(), op: 'append', payload: { ...payload, selected_option_ids: [item.options[1]!.id] } }]);
    expect(other[0]!.result).toBe('rejected');
    expect(other[0]!.detail).toContain('بقيت كما هي');
    const n = t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM question_attempt WHERE exam_attempt_id = ? AND exam_item_index = 0', [s.attempt.id])!.n;
    expect(n).toBe(1);
  });

  it('assessed exam answered on two devices: answers merge per item; finishing on both devices grades each item once', async () => {
    const ex = (await createExam(t, { mode: 'exam', count: 4, source_ids: [t.qs.sourceId], seed: 'g7-ac24-exam' })).session;
    const now = t.ctx.clock.now();
    const ans = (i: number, opt = 0, at = now) => ({ attempt_id: newId(), selected_option_ids: [ex.items[i]!.options[opt]!.id], confidence: 'confident', at, time_ms: 1000, hints_used: 0, solution_viewed_before_answer: false, submitted: false });
    // A answers items 0 and 1; B (offline, older copy) answers items 2 and 3
    const a01 = { '0': ans(0), '1': ans(1) };
    const b23 = { '2': ans(2, 1, now + 10), '3': ans(3, 2, now + 20) };
    const ra = await pushAs(A, DEV_A, [{ entity_type: 'exam_attempt', entity_id: ex.attempt.id, op: 'upsert', payload: stateOf(ex, { status: 'in_progress', answers: a01 as never, elapsed_ms: 2000 }) }]);
    const rb = await pushAs(B, DEV_B, [{ entity_type: 'exam_attempt', entity_id: ex.attempt.id, op: 'upsert', payload: stateOf(ex, { status: 'in_progress', answers: b23 as never, elapsed_ms: 1500 }) }]);
    expect(ra[0]!.result).toBe('applied');
    expect(rb[0]!.result).toBe('merged'); // B did not carry A's answers: kept, not dropped
    const merged = await get<ExamSessionView>(A, `/api/exams/attempts/${ex.attempt.id}`);
    expect(Object.keys(merged.attempt.answers).sort()).toEqual(['0', '1', '2', '3']);

    // A finishes with all four; the finish is re-sent (lost answer); B finishes too with its own (stale) copy
    const all = merged.attempt.answers;
    const finish: Op = { op_id: newId(), entity_type: 'exam_attempt', entity_id: ex.attempt.id, op: 'upsert', payload: stateOf(ex, { status: 'completed', answers: all, elapsed_ms: 9000, finished_at: now + 30 } as never) };
    const f1 = await pushAs(A, DEV_A, [finish]);
    const f2 = await pushAs(A, DEV_A, [finish]);
    const f3 = await pushAs(B, DEV_B, [{ ...finish, op_id: newId(), payload: stateOf(ex, { status: 'completed', answers: { ...b23, '0': ans(0, 3) } as never, elapsed_ms: 8000, finished_at: now + 40 } as never) }]);
    expect(f1[0]!.result).toBe('applied');
    expect(f2[0]!.result).toBe('duplicate');
    expect(['duplicate', 'rejected']).toContain(f3[0]!.result);
    const rows = t.ctx.db.all<{ exam_item_index: number }>('SELECT exam_item_index FROM question_attempt WHERE exam_attempt_id = ? ORDER BY exam_item_index', [ex.attempt.id]);
    expect(rows.map((r) => r.exam_item_index)).toEqual([0, 1, 2, 3]);
    const result = await get<ExamResultDetail>(B, `/api/exams/attempts/${ex.attempt.id}/result`);
    expect(result.answered).toBe(4);
    expect(result.items).toHaveLength(4);
    expect(result.missing_on_server).toBe(0);
  });
});

describe('AC-24 unmergeable conflicts keep both versions', () => {
  it('reading position: B’s stale position is not written over A’s; B gets the server copy to choose from', async () => {
    const sid = newId();
    const loc = (i: number) => ({ page_index: i, page_id: pageId(t, t.lecture.versionId, i), zoom: 1, rotation: 0, layout: 'continuous' });
    await pushAs(A, DEV_A, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', payload: { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, mode: 'learn', view: 'original', location: loc(0) } }]);
    await pushAs(A, DEV_A, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', base_rev: 1, payload: { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, mode: 'learn', view: 'original', location: loc(2) } }]);
    const rb = await pushAs(B, DEV_B, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', base_rev: 1, payload: { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, mode: 'learn', view: 'original', location: loc(1) } }]);
    expect(rb[0]!.result).toBe('rejected');
    expect((rb[0]!.entity as { location: { page_index: number } }).location.page_index).toBe(2); // the server copy travels back
    const latest = await get<{ session: { location: { page_index: number } } }>(A, `/api/annotations/sessions/latest?source_id=${t.lecture.sourceId}`);
    expect(latest.session.location.page_index).toBe(2);
  });

  it('both devices at the SAME place is not a conflict: no question to the owner, the newer view settings are kept', async () => {
    // found by the two-browser E2E: a device that only changed its zoom / rail on the same page got «a newer position from
    // another device — choose» although there was nothing to choose between
    const sid = newId();
    const loc = (zoom: number, tab: string) => ({ page_index: 1, page_id: pageId(t, t.lecture.versionId, 1), zoom, rotation: 0, layout: 'continuous', rail: { open: true, width: 360, tab } });
    const base = { source_id: t.lecture.sourceId, version_id: t.lecture.versionId, mode: 'learn', view: 'original' };
    await pushAs(A, DEV_A, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', payload: { ...base, location: loc(1, 'mine') } }]);
    await pushAs(A, DEV_A, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', base_rev: 1, payload: { ...base, location: loc(1.25, 'mine') } }]);
    const rb = await pushAs(B, DEV_B, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', base_rev: 1, payload: { ...base, location: loc(1.5, 'explain') } }]);
    expect(rb[0]!.result).toBe('merged');
    expect(rb[0]!.entity).toMatchObject({ rev: 3, location: { page_index: 1, zoom: 1.5, rail: { tab: 'explain' } } });
    // a different page from the stale device is still never written over the newer one
    const moved = await pushAs(B, DEV_B, [{ entity_type: 'study_session', entity_id: sid, op: 'upsert', base_rev: 1, payload: { ...base, location: { ...loc(1, 'mine'), page_index: 3, page_id: pageId(t, t.lecture.versionId, 3) } } }]);
    expect(moved[0]!.result).toBe('rejected');
    expect((moved[0]!.entity as { location: { page_index: number } }).location.page_index).toBe(1);
  });

  it('every conflict verdict is recorded and answered again for a re-sent op (the device never loses the outcome)', async () => {
    const conflicts = t.ctx.db.all<{ result: string; device_id: string }>("SELECT result, device_id FROM sync_operation WHERE result IN ('conflict_kept_both','rejected')");
    expect(conflicts.length).toBeGreaterThanOrEqual(5);
    expect(new Set(conflicts.map((c) => c.device_id))).toEqual(new Set([DEV_B]));
  });
});
