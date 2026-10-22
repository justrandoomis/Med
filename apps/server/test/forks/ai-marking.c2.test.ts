// Phase 1 completion, track C2 — AOS-19I.5 (server part): machine-generated content stays marked when it is PUBLISHED.
// A saved AI answer (note origin `ai_answer`) and a handwriting reading (`handwriting_recognition`) inside a student's
// explanation keep their origin in the publication's items (the page labels them), in a follower's copy, and in that
// follower's export («إجابة مولَّدة محفوظة كملاحظة — ليست مصدرًا مستقلًا»). Real channels (pubWorld). TEST FIXTURES only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicationItemsResponse, PublicationView, StartStudyingResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { rt } from '../annotations/helpers';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, op, pageAnchor, publish, push, settle, startPersonal, typedNote, type PubWorld } from './pubWorld';

let w: PubWorld;
let pub: PublicationView;
const AI_TEXT = 'إجابة الذكاء الاصطناعي عن الشريان الكلوي';
const HW_TEXT = 'نص مقروء من خط يدي';

beforeAll(async () => {
  w = await createPubWorld(3);
  await startPersonal(w, 'hasan');
  const layer = await createLayer(w, 'hasan', 'شرحي');
  await typedNote(w, 'hasan', layer, 0, 'كتبتها بنفسي');
  for (const [text, origin] of [
    [AI_TEXT, 'ai_answer'],
    [HW_TEXT, 'handwriting_recognition'],
  ] as const) {
    const [r] = await push(w, 'hasan', [op({ entity_type: 'note', entity_id: newId(), payload: { node_id: null, title: null, body: rt(text), anchor: pageAnchor(w, 1), origin, layer_id: layer } })]);
    expect(r!.result, JSON.stringify(r)).toBe('applied');
  }
  pub = await publish(w, 'hasan', [layer], 'شرح حسن للكلية');
  await settle(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('AOS-19I.5 — published AI output keeps its machine-generated mark', () => {
  it('the publication\'s items carry each note\'s origin (the page counts and labels them)', async () => {
    const items = ok<PublicationItemsResponse>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items`)));
    expect(items.notes.map((n) => n.origin).sort()).toEqual(['ai_answer', 'handwriting_recognition', 'owner']);
  });

  it('a follower\'s copy keeps the origin, and her export labels the generated answer', async () => {
    ok<StartStudyingResponse>(await call(w.t, w.p.zainab.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id }));
    const origins = inVault(w, 'zainab', () => w.t.ctx.db.all<{ origin: string }>('SELECT origin FROM note WHERE source_id = ? AND deleted_at IS NULL', [w.lecture.sourceId]).map((r) => r.origin).sort());
    expect(origins).toEqual(['ai_answer', 'handwriting_recognition', 'owner']);
    const md = await w.t.app.inject({ method: 'GET', url: `/api/data/export/notes?format=md&source_id=${w.lecture.sourceId}`, headers: w.p.zainab.h });
    expect(md.statusCode, md.body).toBe(200);
    const section = md.body.split('### ').find((s) => s.includes(AI_TEXT))!;
    expect(section).toContain('إجابة مولَّدة محفوظة كملاحظة — ليست مصدرًا مستقلًا');
    expect(md.body.split('### ').find((s) => s.includes(HW_TEXT))).toContain('نص مقروء آليًا من خط اليد');
    expect(md.body.split('### ').find((s) => s.includes('كتبتها بنفسي'))).not.toContain('مولَّدة');
  });
});
