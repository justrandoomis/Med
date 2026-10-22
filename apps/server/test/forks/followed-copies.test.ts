// P1-T5 step 3 — forks and followed copies of a course-only explanation (BUILD_PLAN §3.7 «test/forks/publications»;
// ARCHITECTURE_DELTA §6.4, §6.5; ADR-0004 §2.4; PRD AOS-2.19, 4.2, 4.3, 4.11, 4.14, 4.18, 4.20, 5.18, Q25 and PRD
// Scenario 2 steps 2–7 with variants (a)–(d) on the server):
//   * a followed copy: a read-only layer under the publication's stable ids, authored by the explainer; the server
//     refuses a raw delete of one of his strokes; the personal layer is the reader's and never touched by an update;
//   * an update waits for «طبّق التحديث» (preview counts; an inbox entry), then upserts changed / added items and
//     tombstones removed ones — row counts asserted, unchanged ids kept, a replay changes nothing, a stale version 409;
//   * (a) a fork stays on version 1 (own ids, writable); (b) «طبّق التحديثات تلقائيًا» applies without a tap; (c) a
//     skipped version leaves the copy on version 1 and it says so; (d) «انقل ملاحظاتي من نسختي إليها» copies the 8
//     strokes of «نسختي» into the new copy with attribution — «نسختي» unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyUpstreamResponse, DocumentCopiesResponse, DocumentCopyView, PublicationView, StartStudyingResponse, UpstreamPreview } from '@medlevo/shared';
import { defaultPersonalLayerId, sourceDocumentKey } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, layerHash, layerRows, op, publish, push, settle, startPersonal, strokes, textBox, typedNote, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let hLayer: string;
let pub: PublicationView;
const hStrokes: string[] = [];
const copies: Partial<Record<Who, DocumentCopyView>> = {};

async function start(who: Who, mode: 'followed' | 'independent_fork', extra: Record<string, unknown> = {}): Promise<StartStudyingResponse> {
  return ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode, publication_id: pub.id, ...extra }));
}

beforeAll(async () => {
  w = await createPubWorld(6);
  await startPersonal(w, 'hasan');
  hLayer = await createLayer(w, 'hasan', 'شرحي');
  hStrokes.push(...(await strokes(w, 'hasan', hLayer, 0, 4)), ...(await strokes(w, 'hasan', hLayer, 1, 4)), ...(await strokes(w, 'hasan', hLayer, 2, 4)));
  await textBox(w, 'hasan', hLayer, 0, 'الجذع البطني');
  await textBox(w, 'hasan', hLayer, 2, 'الشريان المساريقي');
  pub = await publish(w, 'hasan', [hLayer], 'شرح حسن');
  // variant (d): ريم has «نسختي» with 8 strokes BEFORE she follows
  await startPersonal(w, 'reem');
  await strokes(w, 'reem', null, 1, 8);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const followedLayer = (who: Who) => copies[who]!.copied_layer_id!;

describe('Scenario 2 steps 2–4: a followed copy', () => {
  it('«ابدأ الدراسة» → «نسخة متابَعة»: stub + «ملاحظاتي» + a read-only layer with the explanation, under stable ids', async () => {
    const res = await start('zainab', 'followed');
    expect(res.created).toBe(true);
    const c = (copies.zainab = res.copy);
    expect(c.mode).toBe('followed');
    expect(c.personal_layer_id).toBe(defaultPersonalLayerId(sourceDocumentKey(w.lecture.sourceId)));
    expect(c.publication).toMatchObject({ id: pub.id, title: 'شرح حسن', applied_version_no: 1, head_version_no: 1, status: 'active', status_note_ar: null, built_on_version_no: 1 });
    expect(c.publication!.author.id).toBe(w.p.hasan.user.id);
    const rows = layerRows(w, 'zainab', followedLayer('zainab'));
    expect(rows).toHaveLength(14);
    for (const r of rows) {
      expect(r.author_user_id).toBe(w.p.hasan.user.id);
      expect(r.origin).toBe('follow_copy');
      expect(hStrokes).not.toContain(r.id); // never the author's own ids
    }
    const layer = inVault(w, 'zainab', () => w.t.ctx.db.get<{ kind: string; writable: number; title: string }>('SELECT kind, writable, title FROM annotation_layer WHERE id = ?', [followedLayer('zainab')]))!;
    expect(layer).toMatchObject({ kind: 'followed', writable: 0 });
    expect(layer.title).toContain('شرح');
    // the system knows she follows it (who, not what)
    expect(w.t.ctx.system.db.get('SELECT mode, applied_version_no FROM publication_copy WHERE user_id = ? AND publication_id = ?', [w.p.zainab.user.id, pub.id])).toEqual({ mode: 'followed', applied_version_no: 1 });
    // «ابدأ الدراسة بهذا الشرح» twice reopens the same copy
    const again = await start('zainab', 'followed');
    expect(again.created).toBe(false);
    expect(again.copy.id).toBe(c.id);
    // the publication page now says she follows it
    expect(ok<PublicationView>(await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}`))).viewer.copy).toBe('followed');
  });

  it('her personal writing (some offline, replayed) goes to «ملاحظاتي»; a raw delete of حسن’s stroke is refused', async () => {
    await strokes(w, 'zainab', null, 1, 3);
    await typedNote(w, 'zainab', null, 1, 'ملاحظتي على الصفحة 2');
    const target = layerRows(w, 'zainab', followedLayer('zainab'))[0]!;
    const [r] = await push(w, 'zainab', [op({ entity_type: 'annotation', entity_id: target.id as string, op: 'delete', payload: {}, base_rev: 1 })]);
    expect(r!.result).toBe('rejected');
    expect(r!.detail_code).toBe('layer_read_only');
    expect(layerRows(w, 'zainab', followedLayer('zainab'))).toHaveLength(14);
  });

  it('the author cannot follow or fork his own explanation; another subject’s student gets «not found»', async () => {
    const own = await call(w.t, w.p.hasan.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id });
    expect(own.statusCode).toBe(403);
    const stranger = await call(w.t, w.p.physio.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id });
    expect(stranger.statusCode).toBe(404);
  });
});

describe('variants before the update: (a) fork, (b) auto, (c) skip, (d) carry my notes', () => {
  it('(a) a fork copies version 1 under its own ids, writable, with attribution', async () => {
    const res = await start('ali', 'independent_fork', { version_no: 1 });
    const c = (copies.ali = res.copy);
    expect(c.mode).toBe('independent_fork');
    const rows = layerRows(w, 'ali', c.copied_layer_id);
    expect(rows).toHaveLength(14);
    for (const r of rows) {
      expect(r.author_user_id).toBeNull(); // the reader's own from now on
      expect(r.origin).toBe('fork_copy');
    }
    const layer = inVault(w, 'ali', () => w.t.ctx.db.get<{ kind: string; writable: number }>('SELECT kind, writable FROM annotation_layer WHERE id = ?', [c.copied_layer_id]))!;
    expect(layer).toEqual({ kind: 'forked', writable: 1 });
    const attr = inVault(w, 'ali', () => w.t.ctx.db.get<{ author_user_id: string; derived_from_json: string }>('SELECT author_user_id, derived_from_json FROM attribution WHERE entity_type = ? AND entity_id = ?', ['annotation', rows[0]!.id]))!;
    expect(attr.author_user_id).toBe(w.p.hasan.user.id);
    expect(JSON.parse(attr.derived_from_json)[0]).toMatchObject({ publication_id: pub.id, version_no: 1 });
  });

  it('(b) a follower switches «طبّق التحديثات تلقائيًا» on; (c) another follows with the default preview', async () => {
    copies.huda = (await start('huda', 'followed')).copy;
    copies.huda = ok<DocumentCopyView>(await call(w.t, w.p.huda.h, 'PATCH', `/api/copies/${copies.huda.id}`, { update_policy: 'auto' }));
    expect(copies.huda.update_policy).toBe('auto');
    copies.noor = (await start('noor', 'followed')).copy;
    expect(copies.noor.update_policy).toBe('preview');
  });

  it('(d) «انقل ملاحظاتي من نسختي إليها»: the 8 strokes exist in both copies, with attribution; «نسختي» unchanged', async () => {
    const mine = ok<DocumentCopiesResponse>(await call(w.t, w.p.reem.h, 'GET', '/api/copies')).copies.find((c) => c.mode === 'personal')!;
    const before = layerHash(w, 'reem', mine.personal_layer_id);
    const res = await start('reem', 'followed', { carry_personal_from_copy_id: mine.id });
    const c = (copies.reem = res.copy);
    expect(c.personal_layer_id).not.toBe(mine.personal_layer_id); // her «نسختي» keeps the document's «ملاحظاتي»
    const carried = layerRows(w, 'reem', c.personal_layer_id);
    expect(carried).toHaveLength(8);
    for (const r of carried) expect(r.migrated_from_id).toBeTruthy();
    const attr = inVault(w, 'reem', () => w.t.ctx.db.get<{ derived_from_json: string }>('SELECT derived_from_json FROM attribution WHERE entity_type = ? AND entity_id = ?', ['annotation', carried[0]!.id]))!;
    expect(JSON.parse(attr.derived_from_json)[0]).toMatchObject({ layer_id: mine.personal_layer_id });
    expect(layerHash(w, 'reem', mine.personal_layer_id)).toBe(before);
    expect(layerRows(w, 'reem', mine.personal_layer_id)).toHaveLength(8);
  });
});

describe('Scenario 2 steps 5–6: حسن republishes; the follower previews, then applies', () => {
  let zPersonal: string;
  let followedV1: string[];
  it('nothing changes in her copy before the tap; the version waits as pending and her inbox says so', async () => {
    zPersonal = layerHash(w, 'zainab', null);
    followedV1 = layerRows(w, 'zainab', followedLayer('zainab')).map((r) => r.id as string).sort();
    const followedBefore = layerHash(w, 'zainab', followedLayer('zainab'));
    // step 5: moves one stroke, deletes another, adds 6 on p.4
    await push(w, 'hasan', [
      op({ entity_type: 'annotation', entity_id: hStrokes[0]!, payload: { kind: 'ink', tool: 'pen', anchor: { type: 'page', source_id: w.lecture.sourceId, version_id: w.lecture.versionId, page_id: w.lecture.pageIds[0]!, page_index: 0, space: 'page_norm' }, data: { v: 1, points: [[0.5, 0.5, 0, 0.5], [0.6, 0.55, 16, 0.5]], style: { tool: 'pen', color: 'ink-blue', width: 0.0025 }, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 }, pressure_available: true, tilt_available: false }, layer: 'ink', z: 0, locked: false, layer_id: hLayer }, base_rev: 1 }),
      op({ entity_type: 'annotation', entity_id: hStrokes[1]!, op: 'delete', payload: {}, base_rev: 1 }),
    ]);
    await strokes(w, 'hasan', hLayer, 3, 6);
    const v2 = ok<PublicationView>(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: 'أضفت فروع الجذع البطني ص 4' }));
    expect(v2.head_version_no).toBe(2);
    await settle(w);
    expect(layerHash(w, 'zainab', followedLayer('zainab'))).toBe(followedBefore);
    expect(layerHash(w, 'zainab', null)).toBe(zPersonal);
    const c = ok<DocumentCopyView>(await call(w.t, w.p.zainab.h, 'GET', `/api/copies/${copies.zainab!.id}`));
    expect(c.pending_version_no).toBe(2);
    expect(c.publication).toMatchObject({ applied_version_no: 1, head_version_no: 2 });
    const inbox = ok<{ items: Array<{ kind: string; payload: Record<string, unknown> }> }>(await call(w.t, w.p.zainab.h, 'GET', '/api/notifications'));
    expect(inbox.items.find((n) => n.kind === 'publication_updated')?.payload).toMatchObject({ version_no: 2, added: 6, removed: 1, changed: 1 });
    // the author is not told about his own update
    const hInbox = ok<{ items: Array<{ kind: string }> }>(await call(w.t, w.p.hasan.h, 'GET', '/api/notifications'));
    expect(hInbox.items.some((n) => n.kind === 'publication_updated')).toBe(false);
  });

  it('«اعرض التغييرات» names the change; «طبّق التحديث» writes 7 rows and tombstones 1; her items are byte-identical', async () => {
    const pre = ok<UpstreamPreview>(await call(w.t, w.p.zainab.h, 'GET', `/api/copies/${copies.zainab!.id}/upstream`));
    expect(pre).toMatchObject({ from_version_no: 1, to_version_no: 2, counts: { added: 6, removed: 1, changed: 1 }, personal_items_affected: 0, summary_ar: 'أضاف 6 عناصر في صفحة واحدة، حذف 1، عدّل 1' });
    const res = ok<ApplyUpstreamResponse>(await call(w.t, w.p.zainab.h, 'POST', `/api/copies/${copies.zainab!.id}/upstream/apply`, { version_no: 2 }));
    expect(res.skipped).toBe(false);
    expect(res.applied).toEqual({ upserted: 7, tombstoned: 1 });
    expect(res.copy.pending_version_no).toBeNull();
    expect(res.copy.publication!.applied_version_no).toBe(2);
    expect(layerHash(w, 'zainab', null)).toBe(zPersonal);
    // her followed layer equals version 2, item for item; the 13 untouched items kept their ids
    const v2items = (await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).json().items as Array<{ id: string; data: unknown }>;
    const mine = layerRows(w, 'zainab', followedLayer('zainab'));
    expect(mine.map((r) => r.id).sort()).toEqual(v2items.map((i) => i.id).sort());
    for (const i of v2items) expect(JSON.parse(mine.find((r) => r.id === i.id)!.data_json as string)).toEqual(i.data);
    expect(followedV1.filter((id) => mine.some((r) => r.id === id))).toHaveLength(13);
    // no conflict copies
    expect(inVault(w, 'zainab', () => w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE conflict_of_id IS NOT NULL')!.n)).toBe(0);
    // a replay (lost answer, second device) changes nothing
    const replay = ok<ApplyUpstreamResponse>(await call(w.t, w.p.zainab.h, 'POST', `/api/copies/${copies.zainab!.id}/upstream/apply`, { version_no: 2 }));
    expect(replay.applied).toEqual({ upserted: 0, tombstoned: 0 });
  });

  it('(a) the fork still equals version 1; (b) the auto follower got version 2 without a tap; (c) a skip stays on 1 and says so', async () => {
    expect(layerRows(w, 'ali', copies.ali!.copied_layer_id)).toHaveLength(14);
    const huda = ok<DocumentCopyView>(await call(w.t, w.p.huda.h, 'GET', `/api/copies/${copies.huda!.id}`));
    expect(huda.publication!.applied_version_no).toBe(2);
    expect(huda.pending_version_no).toBeNull();
    expect(layerRows(w, 'huda', huda.copied_layer_id)).toHaveLength(19);
    const skip = ok<ApplyUpstreamResponse>(await call(w.t, w.p.noor.h, 'POST', `/api/copies/${copies.noor!.id}/upstream/apply`, { version_no: 2, skip: true }));
    expect(skip.skipped).toBe(true);
    expect(skip.copy.publication!.applied_version_no).toBe(1);
    expect(skip.copy.pending_version_no).toBeNull();
    expect(skip.copy.publication!.status_note_ar).toContain('تخطّيت الإصدار 2');
    expect(layerRows(w, 'noor', copies.noor!.copied_layer_id)).toHaveLength(14);
  });

  it('a stale version (the head moved) is refused and changes nothing', async () => {
    // ريم still has version 2 pending; حسن publishes version 3 meanwhile
    await strokes(w, 'hasan', hLayer, 4, 1);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: null }));
    await settle(w);
    const before = layerHash(w, 'reem', copies.reem!.copied_layer_id);
    const stale = await call(w.t, w.p.reem.h, 'POST', `/api/copies/${copies.reem!.id}/upstream/apply`, { version_no: 2 });
    expect(stale.statusCode).toBe(409);
    expect(layerHash(w, 'reem', copies.reem!.copied_layer_id)).toBe(before);
    const fresh = ok<ApplyUpstreamResponse>(await call(w.t, w.p.reem.h, 'POST', `/api/copies/${copies.reem!.id}/upstream/apply`, { version_no: 3 }));
    expect(fresh.applied!.upserted).toBe(8); // v1 → v3 in one step: 6 + 1 added on p.4/p.5, 1 changed
    expect(layerRows(w, 'reem', copies.reem!.copied_layer_id)).toHaveLength(20);
  });

  it('lecture_copy counts only the reader’s own items, never the followed explanation', async () => {
    const held = w.t.ctx.system.db.get<{ personal_items: number }>('SELECT personal_items FROM lecture_copy WHERE user_id = ? AND space_id = ? AND lecture_id = ?', [w.p.zainab.user.id, w.space, w.lecture.id])!;
    expect(held.personal_items).toBe(4); // 3 strokes + 1 note on p.2
  });
});
