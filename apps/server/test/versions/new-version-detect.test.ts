// P1-T3 step 2 — «إصدار جديد من …» (PRD AOS-3.11, 19H.2; Scenario 4 steps 2–3 without channels). A renamed upload whose
// pages match ≥ 60 % of an existing lecture is PROPOSED as its new version; nothing is applied without the owner's
// confirmation; confirming adds a new version of the existing lecture (made from the same stored file) and keeps every
// earlier version and note. All inputs are labelled TEST FIXTURES.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecideSuggestionResponse, SourceDetail, SourceIdentityResponse, UploadResponse, VersionCompareResponse } from '@medlevo/shared';
import { scenario4V1, scenario4V2, unrelatedDeck } from '../fixtures/versions/build';
import type { AuthHeaders, TestApp } from '../helpers/app';
import { createProcessingApp } from '../processing/helpers';

let t: TestApp;
afterEach(async () => t?.close());

async function upload(h: AuthHeaders, nodeId: string, name: string, data: Buffer): Promise<{ source_id: string; version_id: string }> {
  const boundary = '----p1t3';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="node_id"\r\n\r\n${nodeId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  expect(res.statusCode, res.body).toBe(200);
  const r = (res.json() as UploadResponse).results[0]!;
  expect(r.status, JSON.stringify(r)).toBe('accepted');
  return { source_id: r.source_id!, version_id: r.version_id! };
}

async function setup() {
  t = await createProcessingApp();
  const h = await t.login();
  const nb = await t.app.inject({ method: 'POST', url: '/api/library/nodes', headers: h, payload: { kind: 'notebook', title: 'TEST Year 2', parent_id: null } });
  expect(nb.statusCode, nb.body).toBe(200);
  const nodeId = (nb.json() as { node: { id: string } }).node.id;
  return { h, nodeId };
}

async function identity(h: AuthHeaders, sourceId: string): Promise<SourceIdentityResponse> {
  const res = await t.app.inject({ method: 'GET', url: `/api/versions/sources/${sourceId}/identity`, headers: h });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SourceIdentityResponse;
}

describe('new-version detection', () => {
  it('«Abdomen lec5 final (1).pdf» is proposed as a new version of Lecture 5; nothing is applied until confirmed', async () => {
    const { h, nodeId } = await setup();
    const v1 = await upload(h, nodeId, 'Abdomen Lecture 5.pdf', scenario4V1());
    await t.ctx.jobs.drain();
    const v2 = await upload(h, nodeId, 'Abdomen lec5 final (1).pdf', scenario4V2());
    await t.ctx.jobs.drain();

    const id = await identity(h, v2.source_id);
    const p = id.suggestions.find((s) => s.field === 'new_version_of')!;
    expect(p).toBeTruthy();
    expect(p.status).toBe('open');
    expect(p.value).toMatchObject({ field: 'new_version_of', source_id: v1.source_id, version_id: v1.version_id, matched_pages: 39, total_pages: 40, inserted: 2, changed: 1 });
    expect(p.reasons_ar.join(' ')).toContain('تتطابق 39 من 40');
    expect(p.reasons_ar.join(' ')).toContain('رقم المحاضرة نفسه (5)');
    expect(p.effect_ar).toContain('إصدار جديد');

    // nothing applied: the existing lecture still has ONE version, the upload is a separate live source
    const before = (await t.app.inject({ method: 'GET', url: `/api/sources/${v1.source_id}`, headers: h })).json() as SourceDetail;
    expect(before.versions).toHaveLength(1);
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [v2.source_id])!.deleted_at).toBeNull();

    // the side-by-side compare carries the proposal
    const cmp = (await t.app.inject({ method: 'GET', url: `/api/versions/compare?from=${v1.version_id}&to=${v2.version_id}`, headers: h })).json() as VersionCompareResponse;
    expect(cmp.state).toBe('ready');
    expect(cmp.proposal?.id).toBe(p.id);
    expect(cmp.counts).toMatchObject({ inserted: 2, changed: 1 });

    // confirm → a new version of Lecture 5 from the same stored file; the upload goes to the trash (nothing written on it)
    const dec = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${p.id}/decide`, headers: h, payload: { action: 'accept' } });
    expect(dec.statusCode, dec.body).toBe(200);
    const d = dec.json() as DecideSuggestionResponse;
    expect(d.new_version).toMatchObject({ source_id: v1.source_id, version_no: 2, upload_trashed: true });
    await t.ctx.jobs.drain();
    const after = (await t.app.inject({ method: 'GET', url: `/api/sources/${v1.source_id}`, headers: h })).json() as SourceDetail;
    expect(after.versions.map((v) => v.version_no).sort()).toEqual([1, 2]);
    expect(after.current_version_id).toBe(d.new_version!.version_id);
    const files = t.ctx.db.all<{ file_id: string }>('SELECT file_id FROM source_version WHERE id IN (?, ?)', [v2.version_id, d.new_version!.version_id]);
    expect(new Set(files.map((f) => f.file_id)).size).toBe(1); // no byte copy
    // the map from version 1 to the new version 2 follows processing
    const m = (await t.app.inject({ method: 'GET', url: `/api/versions/compare?from=${v1.version_id}&to=${d.new_version!.version_id}`, headers: h })).json() as VersionCompareResponse;
    expect(m.state).toBe('ready');
    expect(m.counts).toMatchObject({ unchanged: 39, changed: 1, inserted: 2 });
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [v2.source_id])!.deleted_at).not.toBeNull();
  });

  it('a rejected proposal changes nothing and is not proposed again; an unrelated deck is never proposed', async () => {
    const { h, nodeId } = await setup();
    await upload(h, nodeId, 'Abdomen Lecture 5.pdf', scenario4V1());
    await t.ctx.jobs.drain();
    const other = await upload(h, nodeId, 'Lecture 9 posterior wall.pdf', unrelatedDeck());
    const v2 = await upload(h, nodeId, 'Abdomen lec5 final (1).pdf', scenario4V2());
    await t.ctx.jobs.drain();
    expect((await identity(h, other.source_id)).suggestions.filter((s) => s.field === 'new_version_of')).toEqual([]);
    const p = (await identity(h, v2.source_id)).suggestions.find((s) => s.field === 'new_version_of')!;
    const rej = await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${p.id}/decide`, headers: h, payload: { action: 'reject' } });
    expect(rej.statusCode, rej.body).toBe(200);
    // re-analysis (e.g. reprocessing) does not bring it back
    const re = await t.app.inject({ method: 'POST', url: `/api/versions/sources/${v2.source_id}/analyze`, headers: h });
    expect(re.statusCode, re.body).toBe(200);
    await t.ctx.jobs.drain();
    const list = (await identity(h, v2.source_id)).suggestions.filter((s) => s.field === 'new_version_of');
    expect(list.map((s) => s.status)).toEqual(['rejected']);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE source_id = ?', [p.value.field === 'new_version_of' ? p.value.source_id : ''])!.n).toBe(1);
  });

  it('an upload with the owner’s writing on it stays in the library after confirming', async () => {
    const { h, nodeId } = await setup();
    await upload(h, nodeId, 'Abdomen Lecture 5.pdf', scenario4V1());
    await t.ctx.jobs.drain();
    const v2 = await upload(h, nodeId, 'Abdomen lec5 final (1).pdf', scenario4V2());
    await t.ctx.jobs.drain();
    const now = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO note (id, title, body_json, source_id, created_at, updated_at) VALUES ('n-own', 'mine', '{"v":1,"paragraphs":[]}', ?, ?, ?)`, [v2.source_id, now, now]);
    const p = (await identity(h, v2.source_id)).suggestions.find((s) => s.field === 'new_version_of')!;
    const d = (await t.app.inject({ method: 'POST', url: `/api/versions/suggestions/${p.id}/decide`, headers: h, payload: { action: 'accept' } })).json() as DecideSuggestionResponse;
    expect(d.new_version?.upload_trashed).toBe(false);
    expect(d.result_ar).toContain('بقي الملف المرفوع');
    expect(t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM source WHERE id = ?', [v2.source_id])!.deleted_at).toBeNull();
  });
});
