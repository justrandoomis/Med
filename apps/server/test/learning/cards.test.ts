// Flashcards (§43): basic / cloze (one card per index) / image occlusion (one card per mask, no answer leak in the
// review payload or media headers), edits with rev checks, suspend / bury / tombstone, duplicate suggestions (never
// merged automatically; an owner merge keeps the history), the 'flashcard' sync entity (keep both on stale edits),
// and the Anki-compatible text export parsed back.
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardCreateResponse, CardReviewPayload, FlashcardView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { clozeHtml, escapeHtml, richToHtml } from '../../src/modules/learning/anki';
import { decodePng, encodePng } from '../../src/modules/processing/png';
import { api, createLearningApp, MIN, ok, push, rt, type LApp } from './helpers';

const T0 = Date.UTC(2026, 9, 9, 9, 0, 0);

/** Minimal parser of Anki's text-import format (file headers + tab-separated rows). */
export function parseAnkiTsv(text: string): { headers: Record<string, string>; rows: string[][] } {
  const headers: Record<string, string> = {};
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('#')) {
      const i = line.indexOf(':');
      headers[line.slice(1, i)] = line.slice(i + 1);
      continue;
    }
    rows.push(line.split('\t'));
  }
  return { headers, rows };
}

const htmlText = (h: string) =>
  h
    .replace(/<br>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

function whitePng(w = 100, h = 80): Buffer {
  return encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });
}

describe('flashcards', () => {
  let t: LApp;
  beforeEach(async () => {
    t = await createLearningApp({ now: T0 });
  });
  afterEach(async () => t.close());

  it('basic card: created with a new schedule, idempotent by client id, edited with rev checks', async () => {
    const id = newId();
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { id, kind: 'basic', front: 'Most common position of the appendix?', back: 'Retrocaecal (خلف الأعور)' }));
    expect(r.created).toBe(true);
    const c = r.cards[0]!;
    expect(c.id).toBe(id);
    expect(c.review_state.state).toBe('new');
    expect(c.origin).toBe('owner');
    expect(c.origin_label_ar).toMatch(/كتبتها بنفسك/);
    const again = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { id, kind: 'basic', front: 'changed', back: 'x' }));
    expect(again.created).toBe(false);
    expect(again.cards[0]!.front).toEqual(c.front);
    // edit with the current rev
    const edited = await ok(api(t).patch(`/api/learning/cards/${id}`, { base_rev: 1, back: 'Retrocaecal' }));
    expect(edited.card.rev).toBe(2);
    // stale rev → 409 with the server copy (never a silent overwrite)
    const stale = await api(t).patch(`/api/learning/cards/${id}`, { base_rev: 1, back: 'other' });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { details: { card: FlashcardView } } }).error.details.card.rev).toBe(2);
    // validation
    expect((await api(t).post('/api/learning/cards', { kind: 'basic', front: '  ', back: 'x' })).statusCode).toBe(400);
    expect((await api(t).post('/api/learning/cards', { kind: 'basic', front: 'x', back: 'y', extra: 1 })).statusCode).toBe(400);
  });

  it('unknown references are not attached and the response says so', async () => {
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A', evidence_ids: ['NOPE1'], source_id: 'NOSRC', concept_id: 'NOCONCEPT' }));
    expect(r.cards[0]!.evidence_ids).toEqual([]);
    expect(r.cards[0]!.source_id).toBeNull();
    expect(r.notes_ar.join(' ')).toMatch(/غير موجود/);
  });

  it('cloze: one card per index, front hides only the asked index, back reveals it; edits keep siblings in step', async () => {
    const text = 'The appendix is usually {{c1::retrocaecal}}; the pain starts {{c2::periumbilical::where?}} then moves to the {{c1::RIF}}.';
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'cloze', front: text, back: 'Back extra' }));
    expect(r.cards.map((c) => c.cloze_index)).toEqual([1, 2]);
    expect(new Set(r.cards.map((c) => c.note_id)).size).toBe(1);
    const p1 = await ok<CardReviewPayload>(api(t).get(`/api/learning/cards/${r.cards[0]!.id}/review`));
    const front1 = p1.front.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(front1).not.toMatch(/retrocaecal|RIF/);
    expect(front1).toMatch(/periumbilical/);
    expect(front1.match(/\[…\]/g)).toHaveLength(2);
    const back1 = p1.back.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(back1).toMatch(/retrocaecal/);
    expect(back1).toMatch(/Back extra/);
    const p2 = await ok<CardReviewPayload>(api(t).get(`/api/learning/cards/${r.cards[1]!.id}/review`));
    expect(p2.front.paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('')).toMatch(/\[where\?\]/);
    expect(p2.intervals[3].label_ar).toMatch(/بعد/);
    // editing adds c3 and removes c2 (tombstone, history kept)
    const upd = await ok(api(t).patch(`/api/learning/cards/${r.cards[0]!.id}`, { base_rev: 1, front: 'The appendix is {{c1::retrocaecal}} and McBurney point is {{c3::one third}} along.' }));
    expect(upd.notes_ar.join(' ')).toMatch(/c2/);
    expect(upd.notes_ar.join(' ')).toMatch(/c3/);
    const siblings = t.ctx.db.all<{ cloze_index: number; deleted_at: number | null }>('SELECT cloze_index, deleted_at FROM flashcard WHERE note_id = ? ORDER BY cloze_index', [r.cards[0]!.note_id]);
    expect(siblings.map((s) => [s.cloze_index, s.deleted_at === null])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect((await api(t).post('/api/learning/cards', { kind: 'cloze', front: 'no markers here' })).statusCode).toBe(400);
  });

  it('image occlusion: one card per mask; the review payload and media never reveal the answer', async () => {
    const now = t.ctx.clock.now();
    const file = await t.ctx.files.put(whitePng(), { mime: 'image/png', originalName: 'appendix_Retrocaecal_label.png' });
    const imageId = newId();
    t.ctx.db.run(
      `INSERT INTO image_asset (id, file_id, origin, image_kind, title, caption, created_at) VALUES (?, ?, 'source', 'diagram', 'Retrocaecal appendix diagram', 'Figure: Retrocaecal position', ?)`,
      [imageId, file.id, now],
    );
    const r = await ok<CardCreateResponse>(
      api(t).post('/api/learning/cards/occlusion', {
        image_asset_id: imageId,
        masks: [
          { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, label: 'Retrocaecal' },
          { box: { x: 0.6, y: 0.5, w: 0.3, h: 0.3 }, label: 'Caecum' },
        ],
      }),
    );
    expect(r.cards).toHaveLength(2);
    expect(r.cards.every((c) => c.kind === 'image_occlusion')).toBe(true);
    const card = r.cards.find((c) => c.back.paragraphs[0]!.runs.map((x) => x.t).join('') === 'Retrocaecal')!;
    const p = await ok<CardReviewPayload>(api(t).get(`/api/learning/cards/${card.id}/review`));
    const exposed = JSON.stringify({ front: p.front, image: p.image, evidence: p.evidence, impacts: p.impacts, origin: p.origin_label_ar });
    for (const leak of ['Retrocaecal', 'Caecum', 'appendix_Retrocaecal_label', 'Figure:', 'diagram', file.id]) expect(exposed).not.toContain(leak);
    expect(p.image!.masks).toHaveLength(2);
    expect(p.image!.masks.filter((m) => m.active)).toHaveLength(1);
    expect(Object.keys(p.image!.masks[0]!).sort()).toEqual(['active', 'box', 'id']);
    const media = await t.app.inject({ method: 'GET', url: p.image!.url, headers: t.h });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('image/png');
    expect(String(media.headers['content-disposition'])).not.toMatch(/filename|Retrocaecal/);
    // forged / expired tokens
    expect((await t.app.inject({ method: 'GET', url: `${p.image!.url}x`, headers: t.h })).statusCode).toBe(403);
    t.clock.advance(3 * 3_600_000);
    t.h = await t.login();
    expect((await t.app.inject({ method: 'GET', url: p.image!.url, headers: t.h })).statusCode).toBe(403);
    // invalid masks
    expect((await api(t).post('/api/learning/cards/occlusion', { image_asset_id: imageId, masks: [{ box: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, label: 'x' }] })).statusCode).toBe(400);
  });

  it('suspend, bury, delete (tombstone, history kept) and restore', async () => {
    const c = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A' }))).cards[0]!;
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: c.id, rating: 3, reviewed_at: T0 }));
    expect((await ok(api(t).post(`/api/learning/cards/${c.id}/suspend`, { suspended: true }))).card.suspended).toBe(true);
    let q = await ok(api(t).get('/api/learning/review/queue'));
    expect(q.counts.suspended).toBe(1);
    await ok(api(t).post(`/api/learning/cards/${c.id}/suspend`, { suspended: false }));
    const del = await ok(api(t).del(`/api/learning/cards/${c.id}`));
    expect(del.card.deleted_at).not.toBeNull();
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [c.id])!.n).toBe(1);
    q = await ok(api(t).get('/api/learning/review/queue'));
    expect(q.items).toHaveLength(0);
    const res = await ok(api(t).post(`/api/learning/cards/${c.id}/restore`, {}));
    expect(res.card.deleted_at).toBeNull();
    expect(res.card.review_state.reps).toBe(1);
    const audit = t.ctx.db.all<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'flashcard' AND entity_id = ? ORDER BY created_at`, [c.id]).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['suspend', 'delete', 'restore']));
  });

  it('duplicate suggestions are never merged automatically; an owner merge tombstones one card and keeps its history', async () => {
    const a = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'What is McBurney point?', back: 'One third from ASIS to umbilicus' }))).cards[0]!;
    const second = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'what is mcburney  point?', back: 'Junction of lateral third' }));
    expect(second.duplicates).toHaveLength(1);
    expect(second.duplicates[0]!.kind).toBe('same_front');
    const b = second.cards[0]!;
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flashcard WHERE deleted_at IS NULL')!.n).toBe(2);
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: b.id, rating: 2, reviewed_at: T0 }));
    // not a duplicate → never suggested again
    await ok(api(t).post('/api/learning/cards/duplicates/decide', { card_a_id: a.id, card_b_id: b.id, decision: 'not_duplicate' }));
    expect((await ok(api(t).get('/api/learning/cards/duplicates'))).items).toHaveLength(0);
    // an explicit merge
    const m = await ok(api(t).post('/api/learning/cards/duplicates/decide', { card_a_id: a.id, card_b_id: b.id, decision: 'merge', keep_id: a.id }));
    expect(m.kept.id).toBe(a.id);
    const gone = t.ctx.db.get<{ deleted_at: number | null; merged_into_id: string | null }>('SELECT deleted_at, merged_into_id FROM flashcard WHERE id = ?', [b.id])!;
    expect(gone.deleted_at).not.toBeNull();
    expect(gone.merged_into_id).toBe(a.id);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ?', [b.id])!.n).toBe(1);
    expect((await api(t).post('/api/learning/cards/duplicates/decide', { card_a_id: a.id, card_b_id: b.id, decision: 'merge' })).statusCode).toBe(400);
  });

  it("sync 'flashcard': camelCase create, rev upsert, stale edit keeps both, delete tombstone, edit after delete keeps both", async () => {
    const id = newId();
    const base = { kind: 'basic', front: rt('Dexie front'), back: rt('Dexie back'), origin: 'owner', suspended: false, updatedAt: T0, syncState: 'pending_sync', createdAt: T0 };
    let [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', payload: { id, ...base } }]);
    expect(r!.result).toBe('applied');
    expect((r!.entity as FlashcardView).review_state.state).toBe('new');
    // re-sent create (lost response) → duplicate
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', payload: { id, ...base } }]);
    expect(r!.result).toBe('duplicate');
    // edit on device A with the current rev
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', base_rev: 1, payload: { ...base, back: rt('edited on A') } }]);
    expect(r!.result).toBe('applied');
    expect((r!.entity as FlashcardView).rev).toBe(2);
    // device B edits from rev 1 (stale) → keep both
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', base_rev: 1, device_id: 'B', payload: { ...base, back: rt('edited on B') } }]);
    expect(r!.result).toBe('conflict_kept_both');
    const copies = t.ctx.db.all<{ id: string; back_json: string }>('SELECT id, back_json FROM flashcard WHERE conflict_of_id = ?', [id]);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.back_json).toMatch(/edited on B/);
    expect(t.ctx.db.get<{ back_json: string }>('SELECT back_json FROM flashcard WHERE id = ?', [id])!.back_json).toMatch(/edited on A/);
    // stale suspend only (same content): an OLDER device change does not undo a newer state; a newer one is applied
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', base_rev: 1, payload: { ...base, back: rt('edited on A'), suspended: true } }]);
    expect(r!.result).toBe('merged');
    expect((r!.entity as FlashcardView).suspended).toBe(false);
    t.clock.advance(MIN);
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', base_rev: 1, payload: { ...base, back: rt('edited on A'), suspended: true } }]);
    expect(r!.result).toBe('merged');
    expect((r!.entity as FlashcardView).suspended).toBe(true);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM flashcard WHERE conflict_of_id = ?', [id])!.n).toBe(1);
    // stale delete of an edited card → the card is kept
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'delete', base_rev: 1, payload: {} }]);
    expect(r!.result).toBe('conflict_kept_both');
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM flashcard WHERE id = ?', [id])!.deleted_at).toBeNull();
    const rev = t.ctx.db.get<{ rev: number }>('SELECT rev FROM flashcard WHERE id = ?', [id])!.rev;
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'delete', base_rev: rev, payload: {} }]);
    expect(r!.result).toBe('applied');
    // an edit that arrives after the delete is kept as a new card; the delete stays
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: id, op: 'upsert', base_rev: rev, payload: { ...base, back: rt('late edit') } }]);
    expect(r!.result).toBe('conflict_kept_both');
    expect(t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM flashcard WHERE conflict_of_id = ? AND back_json LIKE '%late edit%'`, [id])!.n).toBe(1);
    // pull returns the tombstone
    const pull = (await ok(api(t).get('/api/sync/pull?since=0&limit=500'))) as { changes: Array<{ entity_type: string; entity_id: string; entity: FlashcardView | null }> };
    expect(pull.changes.find((c) => c.entity_type === 'flashcard' && c.entity_id === id)!.entity!.deleted_at).not.toBeNull();
    // generated cards cannot be created from a device; unknown delete is rejected
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: newId(), op: 'upsert', payload: { ...base, origin: 'generated' } }]);
    expect(r!.result).toBe('rejected');
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: newId(), op: 'delete', payload: {} }]);
    expect(r!.result).toBe('rejected');
    // cloze sync payload needs its index when several exist
    [r] = await push(t, [{ entity_type: 'flashcard', entity_id: newId(), op: 'upsert', payload: { ...base, kind: 'cloze', front: rt('{{c1::a}} and {{c2::b}}') } }]);
    expect(r!.result).toBe('rejected');
    expect(r!.detail).toMatch(/cloze_index/);
  });

  it('a Dexie-shaped upsert (no cloze index / note / concept / evidence fields) keeps what the server stores', async () => {
    const now = t.ctx.clock.now();
    const concept = newId();
    t.ctx.db.run(`INSERT INTO concept (id, name_en, created_at, updated_at) VALUES (?, 'Appendicitis', ?, ?)`, [concept, now, now]);
    const r = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'cloze', front: 'Pain {{c1::periumbilical}} then {{c2::RIF}}', back: 'extra', concept_id: concept }));
    const c2 = r.cards[1]!;
    // a purged citation stays in the snapshot (shown unavailable) — simulate one
    t.ctx.db.run(`UPDATE flashcard SET evidence_ids_json = '["GONE1"]', evidence_snapshot_json = ? WHERE id = ?`, [
      JSON.stringify([{ evidence_id: 'GONE1', source_id: 'S', source_title: 'Old lecture', version_id: 'V', locator_label_ar: 'ص 3', quote: 'old quote' }]),
      c2.id,
    ]);
    const dexie = { kind: 'cloze', front: c2.front, back: rt('extra (edited)'), origin: 'owner', suspended: false, updatedAt: now, syncState: 'pending_sync', createdAt: c2.created_at };
    const [res] = await push(t, [{ entity_type: 'flashcard', entity_id: c2.id, op: 'upsert', base_rev: c2.rev, payload: dexie }]);
    expect(res!.result).toBe('applied');
    const after = res!.entity as FlashcardView;
    expect(after.cloze_index).toBe(2);
    expect(after.note_id).toBe(c2.note_id);
    expect(after.concept_id).toBe(concept);
    expect(after.evidence_ids).toEqual(['GONE1']);
    expect(after.evidence[0]).toMatchObject({ evidence_id: 'GONE1', available: false, quote: 'old quote' });
    // a server-generated card can still be suspended from a device (origin is never changed by a device)
    const gen = newId();
    t.ctx.db.run(
      `INSERT INTO flashcard (id, kind, front_json, back_json, evidence_ids_json, origin, rev, created_at, updated_at) VALUES (?, 'basic', ?, ?, '[]', 'generated', 1, ?, ?)`,
      [gen, JSON.stringify(rt('G front')), JSON.stringify(rt('G back')), now - 1000, now - 1000],
    );
    const [g] = await push(t, [{ entity_type: 'flashcard', entity_id: gen, op: 'upsert', base_rev: 1, payload: { kind: 'basic', front: rt('G front'), back: rt('G back'), origin: 'generated', suspended: true } }]);
    expect(g!.result).toBe('applied');
    expect((g!.entity as FlashcardView).origin).toBe('generated');
    expect((g!.entity as FlashcardView).suspended).toBe(true);
  });

  it('HTTP edits: null unlinks a concept; a «Back Extra» edit reaches every card of the cloze note', async () => {
    const now = t.ctx.clock.now();
    const concept = newId();
    t.ctx.db.run(`INSERT INTO concept (id, name_en, created_at, updated_at) VALUES (?, 'Shock', ?, ?)`, [concept, now, now]);
    const b = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q', back: 'A', concept_id: concept }))).cards[0]!;
    expect(b.concept_id).toBe(concept);
    const un = await ok(api(t).patch(`/api/learning/cards/${b.id}`, { base_rev: 1, concept_id: null }));
    expect(un.card.concept_id).toBeNull();
    const cl = await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'cloze', front: '{{c1::a}} {{c2::b}} {{c3::c}}', back: 'old extra' }));
    await ok(api(t).patch(`/api/learning/cards/${cl.cards[0]!.id}`, { base_rev: 1, back: 'new extra' }));
    for (const c of cl.cards) expect(t.ctx.db.get<{ back_json: string }>('SELECT back_json FROM flashcard WHERE id = ?', [c.id])!.back_json).toMatch(/new extra/);
  });

  it('Anki export: documented text-import headers, parsed back to the same cards; cloze + occlusion media in a ZIP', async () => {
    const basic = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Alvarado score ≥ 7 means? "likely"', back: 'Appendicitis likely\nsecond line' }))).cards[0]!;
    const ar = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'ما موقع الزائدة الأكثر شيوعًا؟', back: 'خلف الأعور (Retrocaecal)' }))).cards[0]!;
    // single TSV while there is no cloze / media
    const res = await t.app.inject({ method: 'GET', url: '/api/learning/export/anki?deck=Surgery', headers: t.h });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toMatch(/medlevo-basic\.txt/);
    const parsed = parseAnkiTsv(res.body);
    expect(parsed.headers).toMatchObject({ separator: 'tab', html: 'true', notetype: 'Basic', deck: 'Surgery', tags: 'medlevo', 'guid column': '1', 'tags column': '5' });
    const cols = parsed.headers.columns!.split('\t');
    expect(cols).toEqual(['GUID', 'Front', 'Back', 'Source', 'Tags']);
    expect(parsed.rows).toHaveLength(2);
    for (const row of parsed.rows) expect(row).toHaveLength(cols.length);
    const byId = new Map(parsed.rows.map((r) => [r[0], r]));
    expect(htmlText(byId.get(basic.id)![1]!)).toBe('Alvarado score ≥ 7 means? "likely"');
    expect(htmlText(byId.get(basic.id)![2]!)).toBe('Appendicitis likely\nsecond line');
    expect(htmlText(byId.get(ar.id)![1]!)).toBe('ما موقع الزائدة الأكثر شيوعًا؟');
    expect(byId.get(ar.id)![2]).toMatch(/<span dir=ltr>[^<]*Retrocaecal[^<]*<\/span>/);
    expect(htmlText(byId.get(ar.id)![2]!)).toBe('خلف الأعور (Retrocaecal)');
    expect(res.body).not.toContain('&quot;rtl'); // attributes are never mangled by the quote escaping
    expect(byId.get(ar.id)![4]).toContain('medlevo::basic');
    expect(res.body).not.toContain('apkg');

    // cloze + occlusion → ZIP
    await ok(api(t).post('/api/learning/cards', { kind: 'cloze', front: 'Pain starts {{c1::periumbilical}} then {{c2::RIF}}.' }));
    const file = await t.ctx.files.put(whitePng(), { mime: 'image/png', originalName: 'secret-name.png' });
    const imageId = newId();
    t.ctx.db.run(`INSERT INTO image_asset (id, file_id, origin, image_kind, created_at) VALUES (?, ?, 'source', 'diagram', ?)`, [imageId, file.id, T0]);
    const occ = await ok<CardCreateResponse>(api(t).post('/api/learning/cards/occlusion', { image_asset_id: imageId, masks: [{ box: { x: 0.1, y: 0.1, w: 0.2, h: 0.25 }, label: 'Caecum' }, { box: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 }, label: 'Ileum' }] }));
    const zipRes = await t.app.inject({ method: 'GET', url: '/api/learning/export/anki', headers: t.h });
    expect(zipRes.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(zipRes.rawPayload);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'medlevo-basic.txt', 'medlevo-cloze.txt']));
    const cloze = parseAnkiTsv(await zip.file('medlevo-cloze.txt')!.async('string'));
    expect(cloze.headers.notetype).toBe('Cloze');
    expect(cloze.headers.columns!.split('\t')).toEqual(['GUID', 'Text', 'Back Extra', 'Source', 'Tags']);
    expect(cloze.rows).toHaveLength(1); // one NOTE for the two cloze cards
    expect(htmlText(cloze.rows[0]![1]!)).toBe('Pain starts {{c1::periumbilical}} then {{c2::RIF}}.');
    const basics = parseAnkiTsv(await zip.file('medlevo-basic.txt')!.async('string'));
    expect(basics.rows).toHaveLength(4);
    const occCard = occ.cards.find((c) => c.back.paragraphs[0]!.runs[0]!.t === 'Caecum')!;
    const occRow = basics.rows.find((r) => r[0] === occCard.id)!;
    expect(occRow[1]).toContain(`<img src=medlevo-${occCard.id}-q.png>`);
    expect(occRow[1]).not.toContain('Caecum');
    expect(htmlText(occRow[2]!)).toContain('Caecum');
    expect(names.join(' ')).not.toContain('secret-name');
    // the question image hides every mask (active one in the accent colour); the answer image reveals the active one
    const q = decodePng(await zip.file(`media/medlevo-${occCard.id}-q.png`)!.async('uint8array'));
    const a = decodePng(await zip.file(`media/medlevo-${occCard.id}-a.png`)!.async('uint8array'));
    const px = (img: { width: number; data: Uint8Array }, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    expect(px(q, 20, 20)).toEqual([214, 110, 30]);
    expect(px(a, 20, 20)).toEqual([255, 255, 255]);
    expect(px(q, 70, 55)).toEqual([150, 150, 150]);
    expect(px(a, 70, 55)).toEqual([150, 150, 150]);
    expect(await zip.file('README.txt')!.async('string')).toMatch(/collection\.media/);
  });

  it('HTML helpers escape content and keep cloze markup intact', () => {
    expect(escapeHtml('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(richToHtml(rt('<script>'))).toBe('<div dir=ltr>&lt;script&gt;</div>');
    expect(clozeHtml({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'الألم {{c1::' }, { t: 'periumbilical', dir: 'ltr' }, { t: '}}' }] }] })).toBe('<div dir=rtl>الألم {{c1::periumbilical}}</div>');
  });

  it('forgetting forecast is an estimate and gives no number for unreviewed cards', async () => {
    const a = (await ok<CardCreateResponse>(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q1', back: 'A1' }))).cards[0]!;
    await ok(api(t).post('/api/learning/cards', { kind: 'basic', front: 'Q2', back: 'A2' }));
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: a.id, rating: 3, reviewed_at: T0 }));
    await ok(api(t).post('/api/learning/reviews', { id: newId(), card_id: a.id, rating: 3, reviewed_at: T0 + 2 * MIN }));
    t.clock.advance(15 * MIN);
    const f = await ok(api(t).get('/api/learning/forecast?days=1,7,30'));
    expect(f.estimate_note_ar).toMatch(/تقدير/);
    expect(f.not_estimated.cards).toBe(1);
    expect(f.overall.map((o: { days: number }) => o.days)).toEqual([1, 7, 30]);
    const recalls = f.overall.map((o: { avg_recall: number }) => o.avg_recall);
    expect(recalls[0]).toBeGreaterThan(recalls[2]);
  });
});
