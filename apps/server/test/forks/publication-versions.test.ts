// P1-T5 step 3 — a followed explanation across a NEW OFFICIAL VERSION (PRD Scenario 4 «حسن gets the same migration flow
// for his explanation layer; زينب's followed layer stays on v1 until حسن republishes, and she sees «الشرح مبني على
// الإصدار 1»»; ARCHITECTURE_DELTA §6.3, §6.4; PRD AOS-4.20, Q35):
//   * the official version 2 (a page inserted after p.1) reaches both copies; زينب's one-tap note copy copies HER notes
//     and keeps حسن's followed items on version 1 (read-only layer: they follow their author's republish);
//   * حسن copies his explanation to version 2 with the same one-tap flow and republishes: the explanation is now built
//     on version 2 (his originals on version 1 are counted as left out, never published twice);
//   * زينب's copy says «مبني على الإصدار 1» with version 2 pending «مبني على الإصدار 2»; applying it moves the followed
//     layer onto version 2's pages; none of her items changed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyUpstreamResponse, DocumentCopyView, PublicationView, ReanchorCopyPreview, ReanchorCopyRunResponse, StartStudyingResponse, UploadOfficialVersionResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import { createLayer, createPubWorld, layerHash, layerRows, publish, settle, startPersonal, strokes, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let layer: string;
let pub: PublicationView;
let zCopy: DocumentCopyView;
let v2: string;

async function oneTap(who: Who, sourceId: string, toVersion: string): Promise<ReanchorCopyRunResponse> {
  const pre = ok<ReanchorCopyPreview>(await call(w.t, w.p[who].h, 'GET', `/api/annotations/reanchor-copy?source_id=${sourceId}&to_version_id=${toVersion}`));
  expect(pre.state).toBe('ready');
  return ok<ReanchorCopyRunResponse>(await call(w.t, w.p[who].h, 'POST', '/api/annotations/reanchor-copy', { source_id: sourceId, from_version_id: pre.from_version!.id, to_version_id: toVersion, map_computed_at: pre.map_computed_at }));
}

beforeAll(async () => {
  w = await createPubWorld(6);
  await startPersonal(w, 'hasan');
  layer = await createLayer(w, 'hasan', 'شرحي');
  await strokes(w, 'hasan', layer, 2, 3);
  await strokes(w, 'hasan', layer, 4, 2);
  pub = await publish(w, 'hasan', [layer], 'شرح حسن');
  zCopy = ok<StartStudyingResponse>(await call(w.t, w.p.zainab.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id })).copy;
  await strokes(w, 'zainab', null, 2, 2);
  // the official version 2: a page inserted after p.1
  const v1pages = pagesFor('Lecture 5', 6);
  const pages = [v1pages[0]!, ['Inserted page about the coeliac trunk branches', 'Left gastric, splenic and common hepatic arteries', 'TEST FIXTURE inserted page'], ...v1pages.slice(1)];
  const mp = multipart({}, { name: 'Abdomen lec5 final (1).pdf', data: lecturePdf(pages) });
  const up = await w.t.app.inject({ method: 'POST', url: w.S(`/lectures/${w.lecture.id}/upload`), headers: { ...w.p.sara.h, 'content-type': mp.contentType }, payload: mp.body });
  expect(up.statusCode, up.body).toBe(200);
  v2 = (up.json() as UploadOfficialVersionResponse).version_id;
  await settle(w);
  ok(await call(w.t, w.p.sara.h, 'POST', w.S(`/lectures/${w.lecture.id}/versions/${v2}/publish`), {}));
  await settle(w);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('Scenario 4 with a followed explanation', () => {
  it('her one-tap copy moves HER notes to version 2 and keeps حسن’s followed items on version 1', async () => {
    const c = ok<DocumentCopyView>(await call(w.t, w.p.zainab.h, 'GET', `/api/copies/${zCopy.id}`));
    // the fan-out added version 2 to her stub (P1-T2's banner announces it); her notes are still on version 1
    expect(c.lecture!.version_no).toBe(2);
    expect(c.publication).toMatchObject({ built_on_version_no: 1, pending_built_on_version_no: null });
    const followedBefore = layerHash(w, 'zainab', c.copied_layer_id);
    const run = await oneTap('zainab', c.source_id, v2);
    expect(run.report.copied).toBe(2);
    expect(run.report.kept).toBe(5); // حسن's five strokes: read-only layer, they follow his republish
    expect(layerHash(w, 'zainab', c.copied_layer_id)).toBe(followedBefore);
  });

  it('حسن copies his explanation to version 2 and republishes: built on version 2, his v1 originals left out with the reason', async () => {
    const run = await oneTap('hasan', w.lecture.sourceId, v2);
    expect(run.report.copied).toBe(5);
    const r = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [layer], change_note: 'نقلت الشرح إلى الإصدار 2 من المحاضرة' }));
    expect(r.head_version_no).toBe(2);
    expect(r.versions.map((v) => v.lecture_version_no)).toEqual([1, 2]);
    expect(r.completeness.pages_total).toBe(7);
    expect(r.snapshot!.items).toBe(5);
    expect(r.snapshot!.skipped).toEqual([{ reason_ar: 'ما كتبته على الإصدار 1 من المحاضرة لا يدخل هذا الشرح؛ الشرح مبني على الإصدار 2.', items: 5 }]);
  });

  it('her copy says «مبني على الإصدار 1» with version 2 pending «مبني على الإصدار 2»; applying it moves the followed layer only', async () => {
    await settle(w);
    const c = ok<DocumentCopyView>(await call(w.t, w.p.zainab.h, 'GET', `/api/copies/${zCopy.id}`));
    expect(c.pending_version_no).toBe(2);
    expect(c.publication).toMatchObject({ built_on_version_no: 1, pending_built_on_version_no: 2 });
    const personal = layerHash(w, 'zainab', null);
    const res = ok<ApplyUpstreamResponse>(await call(w.t, w.p.zainab.h, 'POST', `/api/copies/${zCopy.id}/upstream/apply`, { version_no: 2 }));
    expect(res.applied).toEqual({ upserted: 5, tombstoned: 5 });
    expect(res.copy.publication!.built_on_version_no).toBe(2);
    const rows = layerRows(w, 'zainab', c.copied_layer_id);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(JSON.parse(r.anchor_json as string).version_id).toBe(v2);
    expect(layerHash(w, 'zainab', null)).toBe(personal);
  });
});
