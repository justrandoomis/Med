// Review of P1-T5 step 3 (BUILD_PLAN §1.2, §3.7 «Reviewer focus») — regression tests for the defects the adversarial
// review reproduced, each written to FAIL before its fix:
//   R3-A  attribution loss: a classmate's explanation copied into one's own layer («انسخ الطبقة» from a followed layer or
//         a fork) was republished under the copier's name (the snapshot looked at `author_user_id` only, and P1-T2's layer
//         copy writes NULL there and keeps the author in `attribution`) — PRD AOS-4.18;
//   R3-B  a hidden (moderator) or withdrawn (author) explanation stayed readable beyond what a holder had: the items and
//         the diff of versions the holder never took (a version published after their copy, or while hidden);
//   R3-C  a version published while the explanation was hidden never reached its followers after the restore — the
//         fan-out had run while hidden and stopped; the preview follower was then told «تخطّيت الإصدار 2» and had no way
//         to apply it, the automatic follower stayed behind silently;
//   R3-D  the author's private recording id rode along in every published stroke written while recording (`audio_link`);
//   R3-E  a moderator's restore of a WITHDRAWN explanation is a no-op that must not resurrect it (guard kept).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApplyUpstreamResponse, CopyLayersResponse, DocumentCopyView, PublicationView, ReportView, StartStudyingResponse } from '@medlevo/shared';
import { sourceDocumentKey } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { inkData } from '../annotations/helpers';
import { createLayer, createPubWorld, inVault, layerRows, op, pageAnchor, publish, push, settle, startPersonal, strokes, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let hLayer: string;
let pub: PublicationView;
const copies: Partial<Record<Who, DocumentCopyView>> = {};

async function start(who: Who, mode: 'followed' | 'independent_fork', publicationId = pub.id): Promise<DocumentCopyView> {
  return ok<StartStudyingResponse>(await call(w.t, w.p[who].h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode, publication_id: publicationId })).copy;
}
const copyOf = async (who: Who) => ok<DocumentCopyView>(await call(w.t, w.p[who].h, 'GET', `/api/copies/${copies[who]!.id}`));

beforeAll(async () => {
  w = await createPubWorld(4);
  await startPersonal(w, 'hasan');
  hLayer = await createLayer(w, 'hasan', 'شرحي');
  await strokes(w, 'hasan', hLayer, 0, 4);
  pub = await publish(w, 'hasan', [hLayer], 'شرح حسن');
  copies.zainab = await start('zainab', 'followed');
  copies.ali = await start('ali', 'independent_fork');
}, 300_000);
afterAll(async () => {
  await w?.close();
});

describe('R3-A attribution survives «انسخ الطبقة»: a classmate’s writing is never published under the copier’s name', () => {
  async function copyInto(who: Who, fromLayer: string, title: string): Promise<string> {
    const doc = sourceDocumentKey(w.lecture.sourceId);
    const res = ok<CopyLayersResponse>(await call(w.t, w.p[who].h, 'POST', '/api/annotations/layers/copy', { from_layer_ids: [fromLayer], document_key: doc, into: { new_title: title } }));
    expect(res.result!.copied).toBe(4);
    return res.result!.into_layer_id;
  }

  it('a follower copies حسن’s followed layer into her own layer: publishing it leaves his items out and says why', async () => {
    const mine = await copyInto('zainab', copies.zainab!.copied_layer_id!, 'نسختي من شرح حسن');
    // the copies are hers to edit (P1-T2) but the attribution row still names حسن
    for (const r of layerRows(w, 'zainab', mine)) expect(r.author_user_id).toBeNull();
    // one stroke of her own in the same layer
    await strokes(w, 'zainab', mine, 2, 1);
    const res = await call(w.t, w.p.zainab.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [mine], title: 'شرحي أنا', kind: 'explanation', visibility: 'course' });
    const v = ok<PublicationView>(res);
    expect(v.snapshot!.items).toBe(1);
    expect(v.snapshot!.skipped).toEqual([{ reason_ar: expect.stringContaining('كتبها غيرك'), items: 4 }]);
    const rows = w.t.ctx.dbs.space(w.space).all<{ n: number }>('SELECT COUNT(*) AS n FROM publication_item WHERE publication_id = ?', [v.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('a fork holder copies the fork into his own layer: only his own additions can be published', async () => {
    const mine = await copyInto('ali', copies.ali!.copied_layer_id!, 'من نسختي المستقلة');
    const res = await call(w.t, w.p.ali.h, 'POST', w.S('/publications'), { lecture_id: w.lecture.id, layer_ids: [mine], title: 'شرح علي', kind: 'explanation', visibility: 'course' });
    // nothing of his own in it: refused with the counts of what was left out (nothing was published)
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain('كتبها غيرك');
    expect(w.t.ctx.system.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM publication WHERE author_user_id = ?', [w.p.ali.user.id])!.n).toBe(0);
  });
});

describe('R3-B a hidden or withdrawn explanation: holders keep what they had, nothing newer', () => {
  let reportId: string;
  it('setup: حسن publishes version 2 (زينب has it pending), then مصطفى hides the explanation', async () => {
    await strokes(w, 'hasan', hLayer, 1, 3);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/versions`), { layer_ids: [hLayer], change_note: 'إضافة' }));
    await settle(w);
    expect((await copyOf('zainab')).pending_version_no).toBe(2);
    reportId = ok<ReportView>(await call(w.t, w.p.noor.h, 'POST', '/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'wrong_content' })).id;
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { report_id: reportId, action: 'hide', reason_ar: 'اسم مريض في الصفحة 2.' }));
    await settle(w);
  });

  it('while hidden: a follower reads her own version 1 but not version 2 (items, page filter, diff); the author and moderators read all', async () => {
    expect((await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/1/items`))).statusCode).toBe(200);
    for (const url of [`/publications/${pub.id}/versions/2/items`, `/publications/${pub.id}/versions/2/items?page_id=${w.lecture.pageIds[1]}`, `/publications/${pub.id}/diff?from=1&to=2`]) {
      const res = await call(w.t, w.p.zainab.h, 'GET', w.S(url));
      expect(res.statusCode, url).toBe(404);
    }
    // the fork holder took version 1: nothing newer either
    expect((await call(w.t, w.p.ali.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).statusCode).toBe(404);
    for (const who of ['hasan', 'mustafa', 'sara'] as const) {
      expect((await call(w.t, w.p[who].h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).statusCode, who).toBe(200);
      expect((await call(w.t, w.p[who].h, 'GET', w.S(`/publications/${pub.id}/diff?from=1&to=2`))).statusCode, who).toBe(200);
    }
  });

  it('after the restore everything is readable again', async () => {
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'restore', reason_ar: 'أزيل الاسم.' }));
    await settle(w);
    expect((await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).statusCode).toBe(200);
    expect((await call(w.t, w.p.ali.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).statusCode).toBe(200);
  });
});

describe('R3-C a version published while hidden reaches the followers after the restore', () => {
  let p2: PublicationView;
  let layer2: string;
  it('preview follower gets it pending (not «تخطّيت»), the automatic follower gets it applied', async () => {
    layer2 = await createLayer(w, 'hasan', 'شرح ثان');
    await strokes(w, 'hasan', layer2, 2, 2);
    p2 = await publish(w, 'hasan', [layer2], 'شرح حسن الثاني');
    copies.huda = await start('huda', 'followed', p2.id);
    copies.huda = ok<DocumentCopyView>(await call(w.t, w.p.huda.h, 'PATCH', `/api/copies/${copies.huda.id}`, { update_policy: 'auto' }));
    copies.noor = await start('noor', 'followed', p2.id);
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: p2.id }, action: 'hide', reason_ar: 'مراجعة.' }));
    // the author fixes his explanation while it is hidden (allowed: he can still edit it)
    await strokes(w, 'hasan', layer2, 3, 2);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p2.id}/versions`), { layer_ids: [layer2], change_note: 'صحّحت' }));
    await settle(w);
    // still hidden: nothing reaches anyone
    expect((await copyOf('noor')).pending_version_no).toBeNull();
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: p2.id }, action: 'restore', reason_ar: 'صُحّح.' }));
    await settle(w);
    const noor = await copyOf('noor');
    expect(noor.pending_version_no).toBe(2);
    expect(noor.publication!.status_note_ar ?? '').not.toContain('تخطّيت');
    const huda = await copyOf('huda');
    expect(huda.publication!.applied_version_no).toBe(2);
    expect(layerRows(w, 'huda', huda.copied_layer_id)).toHaveLength(4);
    // and the preview follower can apply it
    const applied = ok<ApplyUpstreamResponse>(await call(w.t, w.p.noor.h, 'POST', `/api/copies/${noor.id}/upstream/apply`, { version_no: 2 }));
    expect(applied.applied).toEqual({ upserted: 2, tombstoned: 0 });
  });

  it('a version a follower SKIPPED before a hide is not offered again by the restore', async () => {
    // version 3 → نور skips it; hide; restore: نور is not asked about version 3 again
    await strokes(w, 'hasan', layer2, 0, 1);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p2.id}/versions`), { layer_ids: [layer2], change_note: null }));
    await settle(w);
    const noor = await copyOf('noor');
    expect(noor.pending_version_no).toBe(3);
    ok(await call(w.t, w.p.noor.h, 'POST', `/api/copies/${noor.id}/upstream/apply`, { version_no: 3, skip: true }));
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: p2.id }, action: 'hide', reason_ar: 'مراجعة.' }));
    ok(await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: p2.id }, action: 'restore', reason_ar: 'لا شيء.' }));
    await settle(w);
    expect((await copyOf('noor')).pending_version_no).toBeNull();
  });
});

describe('R3-D the author’s private recording never rides along in a publication', () => {
  it('a stroke written while recording is published without its `audio_link`', async () => {
    const layer = await createLayer(w, 'reem', 'شرح ريم');
    await startPersonal(w, 'reem');
    const id = newId();
    const data = { ...inkData(0.3, 0.3), audio_link: { recording_id: 'REC_PRIVATE_OF_REEM_1', offset_ms: 4200, origin: 'auto' } };
    const [r] = await push(w, 'reem', [op({ entity_type: 'annotation', entity_id: id, payload: { kind: 'ink', tool: 'pen', anchor: pageAnchor(w, 0), data, layer: 'ink', z: 0, locked: false, layer_id: layer } })]);
    expect(r!.result, JSON.stringify(r)).toBe('applied');
    const v = await publish(w, 'reem', [layer], 'شرح ريم');
    const body = (await call(w.t, w.p.zainab.h, 'GET', w.S(`/publications/${v.id}/versions/1/items`))).body;
    expect(body).not.toContain('REC_PRIVATE_OF_REEM_1');
    expect(body).not.toContain('audio_link');
    const stored = w.t.ctx.dbs.space(w.space).all<{ row_json: string }>('SELECT row_json FROM publication_item WHERE publication_id = ?', [v.id]);
    for (const s of stored) expect(s.row_json).not.toContain('REC_PRIVATE_OF_REEM_1');
  });
});

describe('R3-E a moderator cannot bring back an explanation its author withdrew', () => {
  it('withdrawn stays withdrawn whatever the moderator does', async () => {
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${pub.id}/withdraw`), {}));
    const res = await call(w.t, w.p.mustafa.h, 'POST', '/api/moderation/actions', { target: { db: 'system', type: 'publication', id: pub.id }, action: 'restore', reason_ar: 'أعده.' });
    expect([404, 409]).toContain(res.statusCode);
    expect(w.t.ctx.system.db.get<{ status: string }>('SELECT status FROM publication WHERE id = ?', [pub.id])!.status).toBe('withdrawn');
    // the follower: frozen at what she had; nothing newer readable
    expect((await call(w.t, w.p.ali.h, 'GET', w.S(`/publications/${pub.id}/versions/2/items`))).statusCode).toBe(404);
  });
});

describe('probes that held (kept as regression tests)', () => {
  it('a follower cannot move حسن’s stroke into her own layer through the sync (the next update would overwrite it)', async () => {
    const p3 = await publish(w, 'hasan', [hLayer], 'شرح حسن الثالث');
    const z = await start('zainab', 'followed', p3.id);
    const target = layerRows(w, 'zainab', z.copied_layer_id)[0]!;
    const [r] = await push(w, 'zainab', [
      op({
        entity_type: 'annotation',
        entity_id: target.id as string,
        payload: { kind: 'ink', tool: 'pen', anchor: JSON.parse(target.anchor_json as string), data: inkData(0.7, 0.7), layer: 'ink', z: 0, locked: false, layer_id: z.personal_layer_id },
        base_rev: target.rev as number,
      }),
    ]);
    expect(r!.result).toBe('rejected');
    const after = layerRows(w, 'zainab', z.copied_layer_id).find((x) => x.id === target.id)!;
    expect(after.data_json).toBe(target.data_json);
    expect(after.layer_id).toBe(z.copied_layer_id);
  });

  it('a member removed from the subject: no update, no inbox entry, the publication routes answer «not found»; the copy stays', async () => {
    const layer = await createLayer(w, 'hasan', 'شرح رابع');
    await strokes(w, 'hasan', layer, 0, 2);
    const p4 = await publish(w, 'hasan', [layer], 'شرح حسن الرابع');
    const c = await start('reem', 'followed', p4.id);
    ok(await call(w.t, await w.t.login(), 'POST', `/api/channels/nodes/${w.subject.id}/members/${w.p.reem.user.id}/decision`, { decision: 'remove' }));
    await strokes(w, 'hasan', layer, 1, 2);
    ok(await call(w.t, w.p.hasan.h, 'POST', w.S(`/publications/${p4.id}/versions`), { layer_ids: [layer], change_note: 'سرّ جديد' }));
    await settle(w);
    const copy = ok<DocumentCopyView>(await call(w.t, w.p.reem.h, 'GET', `/api/copies/${c.id}`));
    expect(copy.pending_version_no).toBeNull();
    expect(copy.publication!.applied_version_no).toBe(1);
    expect(layerRows(w, 'reem', c.copied_layer_id)).toHaveLength(2);
    const inbox = (await call(w.t, w.p.reem.h, 'GET', '/api/notifications')).body;
    expect(inbox).not.toContain('publication_updated');
    for (const url of [`/publications/${p4.id}`, `/publications/${p4.id}/versions/1/items`, `/publications/${p4.id}/versions/2/items`, `/lectures/${w.lecture.id}/publications`]) {
      expect((await call(w.t, w.p.reem.h, 'GET', w.S(url))).statusCode, url).toBe(404);
    }
    expect((await call(w.t, w.p.reem.h, 'GET', `/api/copies/${c.id}/upstream`)).statusCode).toBe(409);
  });
});

describe('R3-F Q14 / AOS-21.44: after the author deletes the account his name is gone from the copies others keep', () => {
  it('the followed and forked layers, their origin and every attribution row read «طالب سابق»; the content stays', async () => {
    const layer = await createLayer(w, 'hasan', 'شرح أخير');
    await strokes(w, 'hasan', layer, 2, 3);
    const p5 = await publish(w, 'hasan', [layer], 'شرح حسن الأخير');
    const huda = await start('huda', 'followed', p5.id);
    const noor = await start('noor', 'independent_fork', p5.id);
    // هدى also copies his layer into one of her own (attribution keeps his name today)
    ok<CopyLayersResponse>(await call(w.t, w.p.huda.h, 'POST', '/api/annotations/layers/copy', { from_layer_ids: [huda.copied_layer_id], document_key: sourceDocumentKey(w.lecture.sourceId), into: { new_title: 'من شرح زميلي' } }));
    const name = w.p.hasan.user.display_name;
    const doc = encodeURIComponent(sourceDocumentKey(w.lecture.sourceId));
    expect((await call(w.t, w.p.huda.h, 'GET', `/api/annotations/layers?document_key=${doc}`)).body).toContain(name);
    const preview = ok<{ confirm_token: string }>(await call(w.t, w.p.hasan.h, 'POST', '/api/accounts/me/delete', { preview: true }));
    ok(await call(w.t, w.p.hasan.h, 'POST', '/api/accounts/me/delete', { confirm_token: preview.confirm_token, password: w.p.hasan.password }));
    const { finishPendingDeletions } = await import('../../src/modules/accounts/deletion');
    await finishPendingDeletions(w.t.ctx);
    await settle(w);
    for (const who of ['huda', 'noor'] as const) {
      const body = (await call(w.t, w.p[who].h, 'GET', `/api/annotations/layers?document_key=${doc}`)).body;
      expect(body, who).not.toContain(name);
      expect(body, who).toContain('طالب سابق');
      const attr = inVault(w, who, () => w.t.ctx.db.all<{ author_display: string }>('SELECT author_display FROM attribution WHERE author_user_id = ?', [w.p.hasan.user.id]));
      expect(attr.length, who).toBeGreaterThan(0);
      for (const a of attr) expect(a.author_display, who).toBe('طالب سابق');
    }
    // the content is kept (copy, never move)
    expect(layerRows(w, 'huda', huda.copied_layer_id)).toHaveLength(3);
    expect(layerRows(w, 'noor', noor.copied_layer_id)).toHaveLength(3);
  });
});
