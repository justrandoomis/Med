// G6 / AC-22 — «تغيير الكتاب»: updating the Study Book never leaves an owner's note over a DIFFERENT paragraph; a note
// that cannot be re-anchored is kept untouched and listed for review.
// Real pipeline on the Golden Set lecture (appendicitis), Study Book generated through the real job queue with the
// TEST-ONLY scripted provider (no key exists here). Notes / annotations reach the server through the real sync route.
//
// Adversarial angle beyond the module test (which only drops a whole block kind): block keys are
// hash(section, explained regions, kind, ORDINAL). When a regeneration writes FEWER paragraphs about the same region —
// or the same paragraphs in another order — the ordinal shifts and another paragraph inherits the key the note points
// at. Before the G6 fix the server reported such a note «matched» and the Study Book showed it «على» the other
// paragraph. The fix compares the paragraph the note was written on (its block in the anchored version, else the quote
// the note kept) with the paragraph now holding that key.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StudyBookView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { content, lectureOnly, regionsIn, S, ScriptedAi, studyLibrary, type StudyLib } from '../studybook/helpers';

const ai = new ScriptedAi();
let lib: StudyLib;

/** the region whose paragraphs the generator varies (chosen once: the first evidence region with ≥ 2 sentences) */
let target: { head: string; sentences: string[] } | null = null;
type Mode = 'both' | 'drop_first' | 'swap' | 'reworded';
let mode: Mode = 'both';

/** sentences, or clauses of one sentence (split after «;» / «,»), each a verbatim piece of the region text */
const sentencesOf = (t: string) => t.split(/(?<=[.!?؟;,،])\s+/).map((x) => x.trim()).filter((x) => x.length > 20 && /[A-Za-z\u0600-\u06FF]{4}/.test(x));
const cleanQuote = (t: string) => t.replace(/^\[E\d+\] \[R\d+\]\n/, '');
/** the same sentence without its last word (a light rewording of the same paragraph) */
const reworded = (s: string) => s.replace(/\s+\S+$/, '.');

function generator(req: Parameters<Parameters<ScriptedAi['always']>[1]>[0]) {
  const regions = regionsIn(req.prompt);
  const blocks: unknown[] = [{ kind: 'heading', sentences: [S.n('قسم من كتاب الدراسة')] }];
  for (const r of regions) {
    if (!r.alias) continue;
    const text = cleanQuote(r.text);
    const sentences = sentencesOf(text);
    if (process.env.G6_DEBUG) console.log('REGION', JSON.stringify(text));
    if (!target && sentences.length >= 2 && !/TEST FIXTURE/.test(text)) target = { head: text.slice(0, 40), sentences };
    const isTarget = target && text.startsWith(target.head);
    if (!isTarget) {
      if (sentences[0]) blocks.push({ kind: 'paragraph', sentences: [S.c(sentences[0].slice(0, 220), [r.alias], 'directly_stated')], explains_regions: [r.region] });
      continue;
    }
    const [a, b] = [target!.sentences[0]!, target!.sentences[1]!];
    const para = (s: string, extra: unknown[] = []) => ({ kind: 'paragraph', sentences: [S.c(s, [r.alias!], 'directly_stated'), ...extra], explains_regions: [r.region] });
    if (mode === 'both') blocks.push(para(a), para(b));
    else if (mode === 'drop_first') blocks.push(para(b));
    else if (mode === 'swap') blocks.push(para(b), para(a));
    else blocks.push(para(reworded(a)), para(b));
  }
  return content(blocks);
}

beforeAll(async () => {
  lib = await studyLibrary(ai);
  ai.always('study_book', generator);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

async function generate(m: Mode, regenerate: boolean): Promise<StudyBookView> {
  mode = m;
  const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/books', headers: lib.h, payload: { source_id: lib.lecture.sourceId, scope: lectureOnly(lib), ...(regenerate ? { regenerate: true } : {}) } });
  expect(res.statusCode, res.body).toBe(200);
  await lib.t.ctx.jobs.drain();
  const v = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books/${res.json().book.artifact.id}`, headers: lib.h })).json() as StudyBookView;
  expect(v.artifact.status).toBe('published');
  return v;
}
const plain = (b: StudyBookView['artifact']['blocks'][number]) => b.content.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
const blockWith = (v: StudyBookView, s: string) => v.artifact.blocks.find((b) => b.kind === 'paragraph' && plain(b).includes(s));
const statusOf = (v: StudyBookView, id: string) => v.reanchor.find((r) => r.target_id === id);
const openItem = (id: string) => lib.t.ctx.db.get<{ reason: string; details_json: string }>(`SELECT reason, details_json FROM review_queue_item WHERE kind = 'needs_reanchor' AND entity_id = ? AND status = 'open'`, [id]);

let v1: StudyBookView;
const ids = { noteA: newId(), noteB: newId(), annA: newId() };
let ownerRowsBefore: unknown;
const ownerRows = () => ({
  notes: lib.t.ctx.db.all('SELECT id, body_json, anchor_json, anchor_target_key, rev, deleted_at FROM note WHERE id IN (?, ?) ORDER BY id', [ids.noteA, ids.noteB]),
  ann: lib.t.ctx.db.all('SELECT id, anchor_json, data_json, rev, deleted_at FROM annotation WHERE id = ?', [ids.annA]),
});

describe('G6 AC-22 — a Study Book update never drops a note on a different paragraph', () => {
  it('v1: two paragraphs explain the same region; the owner writes a note on each and highlights the first', async () => {
    v1 = await generate('both', false);
    expect(target, 'a lecture region with two sentences').toBeTruthy();
    console.log('G6 AC-22 target region sentences:', JSON.stringify(target!.sentences));
    const pa = blockWith(v1, target!.sentences[0]!.slice(0, 18))!;
    const pb = blockWith(v1, target!.sentences[1]!.slice(0, 18))!;
    expect(pa && pb).toBeTruthy();
    expect(pa.source_region_ids).toEqual(pb.source_region_ids); // same region, same kind → keys differ only by ordinal
    expect(pa.block_key).not.toBe(pb.block_key);
    const anchor = (b: typeof pa, quote: boolean) => ({ type: 'block', lineage_id: v1.artifact.lineage_id, artifact_version: 1, block_key: b.block_key, ...(quote ? { quote: { exact: plain(b).slice(0, 300) } } : {}) });
    const note = (id: string, text: string, b: typeof pa) => ({ op_id: newId(), device_id: 'dev-g6', entity_type: 'note', entity_id: id, op: 'upsert', payload: { body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] }, anchor: anchor(b, true) } });
    const push = await lib.t.app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: lib.h,
      payload: {
        ops: [
          note(ids.noteA, 'ملاحظتي على الفقرة الأولى', pa),
          note(ids.noteB, 'ملاحظتي على الفقرة الثانية', pb),
          // a highlight anchored WITHOUT a quote (as the chat's «save as note» writes block anchors): the server still knows the paragraph
          { op_id: newId(), device_id: 'dev-g6', entity_type: 'annotation', entity_id: ids.annA, op: 'append', payload: { kind: 'highlight', anchor: anchor(pa, false), data: { color: 'yellow' }, layer: 'highlight' } },
        ],
      },
    });
    expect(push.json().results.map((r: { result: string }) => r.result)).toEqual(['applied', 'applied', 'applied']);
    ownerRowsBefore = ownerRows();
  });

  it('v2 drops the first paragraph: the second inherits its key — the note on the FIRST is NOT shown on it (needs re-anchoring, kept, listed)', async () => {
    const v2 = await generate('drop_first', true);
    expect(v2.artifact.version_no).toBe(2);
    const pa1 = blockWith(v1, target!.sentences[0]!.slice(0, 18))!;
    const pb2 = blockWith(v2, target!.sentences[1]!.slice(0, 18))!;
    expect(blockWith(v2, target!.sentences[0]!.slice(0, 18))).toBeUndefined();
    // the premise of the attack: the remaining paragraph now carries the key the first note points at
    expect(pb2.block_key).toBe(pa1.block_key);
    // the note and the highlight on the first paragraph must not be reported as attached to the second
    expect(statusOf(v2, ids.noteA)).toMatchObject({ status: 'needs_reanchor', block_key: pa1.block_key, previous_version_no: 1 });
    expect(statusOf(v2, ids.annA)).toMatchObject({ status: 'needs_reanchor' });
    expect(statusOf(v2, ids.noteA)!.reason_ar).toContain('تغيّر نصها');
    // the note on the second paragraph: its own key (ordinal 1) is gone — kept for review, never moved
    expect(statusOf(v2, ids.noteB)).toMatchObject({ status: 'needs_reanchor' });
    for (const id of [ids.noteA, ids.annA, ids.noteB]) expect(openItem(id)?.reason, `review item for ${id}`).toContain('تحتاج إعادة ربط');
    // listed in the Control Center review queue
    const queue = (await lib.t.app.inject({ method: 'GET', url: '/api/control/review?kind=needs_reanchor&status=open', headers: lib.h })).json() as { items: Array<{ entity_id: string }> };
    expect(queue.items.map((i) => i.entity_id)).toEqual(expect.arrayContaining([ids.noteA, ids.noteB, ids.annA]));
    // the owner's writing itself was never modified
    expect(ownerRows()).toEqual(ownerRowsBefore);
  });

  it('v3 swaps the two paragraphs: neither note is shown on the other paragraph', async () => {
    const v3 = await generate('swap', true);
    const pa1 = blockWith(v1, target!.sentences[0]!.slice(0, 18))!;
    const pb1 = blockWith(v1, target!.sentences[1]!.slice(0, 18))!;
    // the keys now point at the other paragraph's text
    expect(blockWith(v3, target!.sentences[1]!.slice(0, 18))!.block_key).toBe(pa1.block_key);
    expect(blockWith(v3, target!.sentences[0]!.slice(0, 18))!.block_key).toBe(pb1.block_key);
    expect(statusOf(v3, ids.noteA)?.status).toBe('needs_reanchor');
    expect(statusOf(v3, ids.noteB)?.status).toBe('needs_reanchor');
    expect(statusOf(v3, ids.annA)?.status).toBe('needs_reanchor');
    expect(ownerRows()).toEqual(ownerRowsBefore);
  });

  it('v4 brings the original paragraphs back (same text, same order): every note matches again and its review item is closed', async () => {
    const v4 = await generate('both', true);
    for (const id of [ids.noteA, ids.noteB, ids.annA]) {
      expect(statusOf(v4, id)?.status, id).toBe('matched');
      expect(openItem(id), `no open review item for ${id}`).toBeUndefined();
    }
    expect(ownerRows()).toEqual(ownerRowsBefore);
  });

  it('v5 keeps the first paragraph, lightly reworded (its last word dropped): still the same paragraph → still matched (no needless review)', async () => {
    const v5 = await generate('reworded', true);
    const first = plain(blockWith(v5, target!.sentences[0]!.slice(0, 18))!);
    expect(first).toBe(reworded(target!.sentences[0]!));
    expect(first).not.toBe(target!.sentences[0]);
    expect(statusOf(v5, ids.noteA)?.status).toBe('matched');
    expect(statusOf(v5, ids.annA)?.status).toBe('matched');
    expect(statusOf(v5, ids.noteB)?.status).toBe('matched');
  });
});
