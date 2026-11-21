// AOS-21.27 — a deck shared through a publication is copied on use (ARCHITECTURE_DELTA §10.4): حسن publishes his
// explanation WITH his cards on the lecture; زينب and علي tap «ادرس هذه البطاقات» and get the cards in their OWN vaults.
//   * each student's FSRS state and review log are theirs: زينب's reviews change nothing of علي's (or of حسن's);
//   * حسن edits / deletes / adds cards and republishes: nothing changes for either student until they apply the
//     update; applying it rewrites the text of cards زينب did not edit (same card id, same review log, same schedule),
//     keeps the card she edited as she wrote it, tombstones the removed one (its review log stays), adds the new one;
//     علي skips the version and keeps version 1;
//   * a stranger (another subject's student, a signed-in member of nothing) gets «not found»; the author cannot copy
//     his own deck.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyDeckUpdateResponse, CardCreateResponse, FlashcardView, PublicationDeckView, PublicationView, StudyDeckResponse } from '@medlevo/shared';
import { richTextToPlain, type RichText } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, publish, startPersonal, strokes, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let hLayer: string;
let pub: PublicationView;
const hCards: Record<'A' | 'B' | 'C' | 'Z1' | 'Z2', string> = { A: '', B: '', C: '', Z1: '', Z2: '' };

async function card(who: Who, kind: 'basic' | 'cloze', front: string, back: string | null): Promise<FlashcardView[]> {
  return ok<CardCreateResponse>(await call(w.t, w.p[who].h, 'POST', '/api/learning/cards', { kind, front, back, source_id: w.lecture.sourceId })).cards;
}

const deck = async (who: Who) => call(w.t, w.p[who].h, 'GET', `/api/copies/decks/${pub.id}?space_id=${w.space}`);
const study = async (who: Who) => call(w.t, w.p[who].h, 'POST', '/api/copies/decks', { space_id: w.space, publication_id: pub.id });

/** The person's vault card copied from حسن's card `key` (by the published stable id it maps). */
function copied(who: Who, key: keyof typeof hCards): { id: string; front_json: string; deleted_at: number | null; rev: number } {
  return inVault(w, who, () => {
    const rows = w.t.ctx.db.all<{ id: string; front_json: string; deleted_at: number | null; rev: number; origin_ref_json: string }>(
      `SELECT f.id, f.front_json, f.deleted_at, f.rev, f.origin_ref_json FROM deck_copy_card m JOIN flashcard f ON f.id = m.card_id`,
    );
    const item = itemOf(key);
    const r = rows.find((x) => (JSON.parse(x.origin_ref_json) as { publication_deck: { item_id: string } }).publication_deck.item_id === item);
    if (!r) throw new Error(`no copy of ${key} in ${who}'s vault`);
    return r;
  });
}

const items = new Map<string, string>();
function itemOf(key: keyof typeof hCards): string {
  return items.get(key)!;
}

function reviewsOf(who: Who, cardId: string): number {
  return inVault(w, who, () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [cardId])!.n);
}
function stateOf(who: Who, cardId: string): { state: string; reps: number; due_at: number; stability: number | null } {
  return inVault(w, who, () => w.t.ctx.db.get<{ state: string; reps: number; due_at: number; stability: number | null }>('SELECT state, reps, due_at, stability FROM review_state WHERE card_id = ?', [cardId])!);
}
const text = (json: string) => richTextToPlain(JSON.parse(json) as RichText);

async function review(who: Who, cardId: string, rating: 1 | 2 | 3 | 4) {
  const r = await call(w.t, w.p[who].h, 'POST', '/api/learning/reviews', { id: newId(), card_id: cardId, rating, reviewed_at: w.t.ctx.clock.now() });
  expect(r.statusCode, r.body).toBe(200);
}

beforeAll(async () => {
  w = await createPubWorld(3);
  await startPersonal(w, 'hasan');
  hLayer = await createLayer(w, 'hasan', 'شرحي');
  await strokes(w, 'hasan', hLayer, 0, 3);
  hCards.A = (await card('hasan', 'basic', 'ما الشريان الذي يغذي الكلية؟', 'الشريان الكلوي'))[0]!.id;
  hCards.B = (await card('hasan', 'basic', 'أين يقع الحالب؟', 'خلف الصفاق'))[0]!.id;
  hCards.C = (await card('hasan', 'basic', 'كم عدد الكلى؟', 'اثنتان'))[0]!.id;
  const cz = await card('hasan', 'cloze', 'الكلية {{c1::يمنى}} و{{c2::يسرى}}', null);
  hCards.Z1 = cz[0]!.id;
  hCards.Z2 = cz[1]!.id;
  pub = await publish(w, 'hasan', [hLayer], 'شرح حسن', { include_cards: true });
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('a deck published with an explanation', () => {
  it('the author’s 5 cards are in the space (text only); the author sees them but cannot copy his own deck', async () => {
    const space = w.t.ctx.dbs.space(w.space);
    const rows = space.all<{ card_id: string; row_json: string }>('SELECT card_id, row_json FROM publication_card WHERE publication_id = ?', [pub.id]);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(Object.values(hCards)).not.toContain(r.card_id); // stable ids, never the author's vault ids
      expect(Object.keys(JSON.parse(r.row_json)).sort()).toEqual(['back', 'cloze_index', 'front', 'kind', 'note_key', 't']);
    }
    const d = ok<PublicationDeckView>(await deck('hasan'));
    expect(d.card_count).toBe(5);
    expect(d.viewer).toMatchObject({ is_author: true, can_study: false, copy: null });
    for (const c of d.cards) {
      const t = c.kind === 'basic' ? text(JSON.stringify(c.front)) : '';
      if (t === 'ما الشريان الذي يغذي الكلية؟') items.set('A', c.item_id);
      if (t === 'أين يقع الحالب؟') items.set('B', c.item_id);
      if (t === 'كم عدد الكلى؟') items.set('C', c.item_id);
    }
    expect(items.size).toBe(3);
    const own = await study('hasan');
    expect(own.statusCode).toBe(403);
  });

  it('a stranger gets «not found» (another subject’s student, a member of nothing, an unknown id)', async () => {
    for (const who of ['physio', 'ahmad'] as const) {
      expect((await deck(who)).statusCode).toBe(404);
      expect((await study(who)).statusCode).toBe(404);
      expect((await call(w.t, w.p[who].h, 'POST', `/api/copies/decks/${pub.id}/update`, { version_no: 2 })).statusCode).toBe(404);
    }
    expect((await call(w.t, w.p.zainab.h, 'GET', `/api/copies/decks/pub_missing?space_id=${w.space}`)).statusCode).toBe(404);
    // nothing was written in the strangers' vaults
    for (const who of ['physio', 'ahmad'] as const) expect(inVault(w, who, () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flashcard')!.n)).toBe(0);
  });
});

describe('«ادرس هذه البطاقات»: copied on use, separate FSRS state per user', () => {
  it('زينب and علي each get the 5 cards in their own vault (own ids, linked to their copy of the lecture); a second tap reopens', async () => {
    expect(ok<PublicationDeckView>(await deck('zainab')).viewer).toMatchObject({ is_author: false, can_study: true, copy: null });
    for (const who of ['zainab', 'ali'] as const) {
      const r = ok<StudyDeckResponse>(await study(who));
      expect(r).toMatchObject({ created: true, copied: 5 });
      expect(r.deck).toMatchObject({ publication_id: pub.id, applied_version_no: 1, head_version_no: 1, cards: 5, update: null, status_note_ar: null });
      expect(r.deck.author.id).toBe(w.p.hasan.user.id);
      const again = ok<StudyDeckResponse>(await study(who));
      expect(again).toMatchObject({ created: false, copied: 0 });
      expect(ok<PublicationDeckView>(await deck(who)).viewer.can_study).toBe(false);
    }
    const zA = copied('zainab', 'A');
    const aA = copied('ali', 'A');
    expect(zA.id).not.toBe(aA.id);
    expect(zA.id).not.toBe(hCards.A);
    // the cloze siblings stay one note in the student's vault
    const notes = inVault(w, 'zainab', () => w.t.ctx.db.all<{ note_id: string | null }>(`SELECT note_id FROM flashcard WHERE kind = 'cloze'`));
    expect(notes).toHaveLength(2);
    expect(notes[0]!.note_id).toBeTruthy();
    expect(notes[0]!.note_id).toBe(notes[1]!.note_id);
    // they are ordinary cards of hers: in her review queue
    const queue = ok<{ items: Array<{ card: { id: string } }> }>(await call(w.t, w.p.zainab.h, 'GET', '/api/learning/review/queue?limit=50'));
    expect(JSON.stringify(queue)).toContain(zA.id);
  });

  it('reviews by زينب change her FSRS state only — not علي’s, not حسن’s', async () => {
    const zA = copied('zainab', 'A');
    const zC = copied('zainab', 'C');
    const aA = copied('ali', 'A');
    const aliBefore = stateOf('ali', aA.id);
    await review('zainab', zA.id, 3);
    await review('zainab', zC.id, 1);
    expect(reviewsOf('zainab', zA.id)).toBe(1);
    expect(stateOf('zainab', zA.id).reps).toBe(1);
    expect(stateOf('zainab', zA.id).state).not.toBe('new');
    expect(reviewsOf('ali', aA.id)).toBe(0);
    expect(stateOf('ali', aA.id)).toEqual(aliBefore);
    expect(stateOf('ali', aA.id)).toMatchObject({ state: 'new', reps: 0 });
    expect(reviewsOf('hasan', hCards.A)).toBe(0);
    expect(stateOf('hasan', hCards.A)).toMatchObject({ state: 'new', reps: 0 });
    // and علي's own review does not reach زينب's
    await review('ali', aA.id, 4);
    expect(reviewsOf('zainab', zA.id)).toBe(1);
    expect(stateOf('zainab', zA.id).reps).toBe(1);
  });

  it('زينب edits card B herself (copy on write: it is hers now)', async () => {
    const zB = copied('zainab', 'B');
    const r = await call(w.t, w.p.zainab.h, 'PATCH', `/api/learning/cards/${zB.id}`, { base_rev: zB.rev, front: 'أين يقع الحالب؟ (بكلماتي)' });
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe('the author’s later edits: an update preview, never a rewrite of anyone’s history', () => {
  let zState: ReturnType<typeof stateOf>;

  it('حسن edits A and B, deletes C, adds D and republishes — nothing changes for either student yet', async () => {
    zState = stateOf('zainab', copied('zainab', 'A').id);
    const hA = inVault(w, 'hasan', () => w.t.ctx.db.get<{ rev: number }>('SELECT rev FROM flashcard WHERE id = ?', [hCards.A])!);
    const hB = inVault(w, 'hasan', () => w.t.ctx.db.get<{ rev: number }>('SELECT rev FROM flashcard WHERE id = ?', [hCards.B])!);
    expect((await call(w.t, w.p.hasan.h, 'PATCH', `/api/learning/cards/${hCards.A}`, { base_rev: hA.rev, back: 'الشريان الكلوي من الأبهر' })).statusCode).toBe(200);
    expect((await call(w.t, w.p.hasan.h, 'PATCH', `/api/learning/cards/${hCards.B}`, { base_rev: hB.rev, back: 'خلف الصفاق، على العضلة القطنية' })).statusCode).toBe(200);
    expect((await call(w.t, w.p.hasan.h, 'DELETE', `/api/learning/cards/${hCards.C}`)).statusCode).toBe(200);
    await card('hasan', 'basic', 'ما وحدة الكلية الوظيفية؟', 'النفرون');
    // include_cards omitted: the head had a deck, so the deck is published again
    const v = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: 'صححت بطاقتين' }));
    expect(v.head_version_no).toBe(2);
    const space = w.t.ctx.dbs.space(w.space);
    expect(space.get<{ n: number }>('SELECT COUNT(*) AS n FROM publication_card WHERE publication_id = ? AND valid_from <= 2 AND (valid_to IS NULL OR valid_to > 2)', [pub.id])!.n).toBe(5);

    // the students' cards and histories are exactly as they were
    expect(text(copied('zainab', 'A').front_json)).toBe('ما الشريان الذي يغذي الكلية؟');
    expect(inVault(w, 'zainab', () => w.t.ctx.db.get<{ back_json: string }>('SELECT back_json FROM flashcard WHERE id = ?', [copied('zainab', 'A').id])!.back_json)).toContain('الشريان الكلوي');
    expect(stateOf('zainab', copied('zainab', 'A').id)).toEqual(zState);
    expect(copied('zainab', 'C').deleted_at).toBeNull();
    expect(copied('ali', 'C').deleted_at).toBeNull();
  });

  it('the preview says what would change and that her own edit stays', async () => {
    const d = ok<PublicationDeckView>(await deck('zainab'));
    expect(d.version_no).toBe(2);
    expect(d.viewer.copy!.update).toMatchObject({ from_version_no: 1, to_version_no: 2, change_note: 'صححت بطاقتين', counts: { added: 1, removed: 1, changed: 2 }, kept_yours: 1 });
    expect(d.viewer.copy!.update!.summary_ar).toContain('تبقى كما كتبتها');
  });

  it('a stale or future version is refused; «طبّق التحديث» applies — same ids, same review log, same schedule; her edit kept', async () => {
    const stale = await call(w.t, w.p.zainab.h, 'POST', `/api/copies/decks/${pub.id}/update`, { version_no: 3 });
    expect(stale.statusCode).toBe(409);
    const zA = copied('zainab', 'A');
    const zC = copied('zainab', 'C');
    const res = ok<ApplyDeckUpdateResponse>(await call(w.t, w.p.zainab.h, 'POST', `/api/copies/decks/${pub.id}/update`, { version_no: 2 }));
    expect(res).toMatchObject({ skipped: false, applied: { added: 1, updated: 1, removed: 1, kept_yours: 1 } });
    expect(res.deck).toMatchObject({ applied_version_no: 2, update: null, cards: 5 });
    // A: the author's new text, under her same card id, with her review log and schedule untouched
    const after = copied('zainab', 'A');
    expect(after.id).toBe(zA.id);
    expect(inVault(w, 'zainab', () => w.t.ctx.db.get<{ back_json: string }>('SELECT back_json FROM flashcard WHERE id = ?', [zA.id])!.back_json)).toContain('من الأبهر');
    expect(reviewsOf('zainab', zA.id)).toBe(1);
    expect(stateOf('zainab', zA.id)).toEqual(zState);
    // B: her own words stay
    expect(text(copied('zainab', 'B').front_json)).toBe('أين يقع الحالب؟ (بكلماتي)');
    // C: tombstoned, its review log kept
    expect(copied('zainab', 'C').deleted_at).not.toBeNull();
    expect(reviewsOf('zainab', zC.id)).toBe(1);
    // a replay changes nothing
    const replay = ok<ApplyDeckUpdateResponse>(await call(w.t, w.p.zainab.h, 'POST', `/api/copies/decks/${pub.id}/update`, { version_no: 2 }));
    expect(replay.applied).toEqual({ added: 0, updated: 0, removed: 0, kept_yours: 0 });
  });

  it('علي skips version 2: his cards and history stay as they were; the author’s edit altered neither student’s history', async () => {
    const aA = copied('ali', 'A');
    const aliState = stateOf('ali', aA.id);
    expect(ok<PublicationDeckView>(await deck('ali')).viewer.copy!.update).toMatchObject({ counts: { added: 1, removed: 1, changed: 2 }, kept_yours: 0 });
    const res = ok<ApplyDeckUpdateResponse>(await call(w.t, w.p.ali.h, 'POST', `/api/copies/decks/${pub.id}/update`, { version_no: 2, skip: true }));
    expect(res).toMatchObject({ skipped: true, applied: null });
    expect(res.deck).toMatchObject({ applied_version_no: 1, update: null });
    expect(inVault(w, 'ali', () => w.t.ctx.db.get<{ back_json: string }>('SELECT back_json FROM flashcard WHERE id = ?', [aA.id])!.back_json)).not.toContain('من الأبهر');
    expect(copied('ali', 'C').deleted_at).toBeNull();
    expect(reviewsOf('ali', aA.id)).toBe(1);
    expect(stateOf('ali', aA.id)).toEqual(aliState);
    // the author's own cards never received anyone's reviews
    for (const id of Object.values(hCards)) expect(reviewsOf('hasan', id)).toBe(0);
  });
});
