// P1-T5 step 2 — adversarial review (BUILD_PLAN §1.2, §3.7 «Reviewer focus»). Each block reproduces one finding of the
// review with the official path end to end: an official lecture published by the subject's moderator through the real
// upload + processing pipeline, students who «ابدأ الدراسة» (vault stubs with the space's ids), and a new official
// version. Scenario 4 uses P1-T3's synthetic Scenario 4 fixture (40 pages → 42: two pages inserted after p.10, p.30
// rewritten). Every file here is a TEST FIXTURE; the AI is the TEST-ONLY scripted provider.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DocumentCopyView,
  ExplainResponse,
  LinkToOfficialResponse,
  OfficialLinkCandidatesResponse,
  OfficialLectureView,
  ReanchorCopyActionResponse,
  ReanchorCopyPreview,
  ReanchorCopyRunResponse,
  StartStudyingResponse,
  SyncOp,
  SyncOpResult,
  UploadOfficialVersionResponse,
} from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { buildImpactReport, executePurge } from '../../src/modules/sources/purge';
import { scenario4V1, scenario4V2 } from '../fixtures/versions/build';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, SPACE_A, sp, type LectureWorld, type Person } from '../lectures/world';
import { addSource, processVersion } from '../processing/helpers';
import { aliasFor, content, createStudyApp, S, ScriptedAi } from '../studybook/helpers';
import { ensureStub } from '../../src/modules/forks/stubs';
import { holdings, inVault, startStudying } from './helpers';

const ai = new ScriptedAi();
let w: LectureWorld;
let lectureId = '';
let sourceId = '';
let v1 = '';
let v2 = '';

const space = () => w.t.ctx.dbs.space(SPACE_A);
const pagesOf = (versionId: string) => space().all<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? ORDER BY page_index', [versionId]).map((r) => r.id);
/** the regions of an official page (in the SPACE) that carry text and a box, in reading order */
const regionsOn = (pageId: string) =>
  space().all<{ id: string; text: string; bbox_json: string; kind: string }>(
    `SELECT id, text, bbox_json, kind FROM source_region WHERE page_id = ? AND text IS NOT NULL AND bbox_json IS NOT NULL AND status <> 'rejected' ORDER BY reading_order`,
    [pageId],
  );
/** the first body sentence of a page (what a highlight on it would quote) and its region */
function quoteOn(pageId: string): { exact: string; regionId: string; box: { x: number; y: number; w: number; h: number } } {
  const r = regionsOn(pageId).find((x) => !['heading', 'header', 'footer'].includes(x.kind))!;
  return { exact: r.text.replace(/\s+/g, ' ').trim().slice(0, 48).trim(), regionId: r.id, box: JSON.parse(r.bbox_json) };
}
const anchorOn = (versionId: string, pageIndex: number) => ({ type: 'page' as const, source_id: sourceId, version_id: versionId, page_id: pagesOf(versionId)[pageIndex]!, page_index: pageIndex, space: 'page_norm' as const });
const ink = (x = 0.2, y = 0.3) => ({
  v: 1,
  points: [
    [x, y, 0, 0.5],
    [x + 0.1, y + 0.02, 16, 0.6],
  ],
  style: { tool: 'pen', color: 'ink-blue', width: 0.0025 },
  bbox: { x, y, w: 0.1, h: 0.02 },
  pressure_available: true,
  tilt_available: false,
});
const rt = (text: string) => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] });
let opN = 0;
const op = (o: Partial<SyncOp> & Pick<SyncOp, 'entity_type' | 'entity_id'>): SyncOp => ({ op_id: `RVW2${Date.now()}${String(++opN).padStart(5, '0')}`, device_id: 'DEVICE_R', op: 'upsert', payload: {}, client_ts: Date.now(), ...o });

async function push(who: Person, ops: SyncOp[]): Promise<void> {
  const res = await w.req(who, 'POST', '/api/sync/push', { ops });
  expect(res.statusCode, res.body).toBe(200);
  for (const r of res.json().results as SyncOpResult[]) expect(r.result, JSON.stringify(r)).toBe('applied');
}

/** Scenario 4 step 1 for one student: ink on p.5, a text highlight on p.12, a note on p.30 (v1). */
async function seedScenario(who: Person): Promise<{ ink5: string; hl12: string; note30: string }> {
  const ids = { ink5: newId(), hl12: newId(), note30: newId() };
  const q = quoteOn(pagesOf(v1)[11]!);
  await push(who, [
    op({ entity_type: 'annotation', entity_id: ids.ink5, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchorOn(v1, 4), data: ink(), layer: 'ink', z: 0, locked: false } }),
    op({
      entity_type: 'annotation',
      entity_id: ids.hl12,
      op: 'append',
      payload: { kind: 'text_highlight', tool: 'highlight', anchor: anchorOn(v1, 11), data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ ...q.box, h: Math.min(q.box.h, 0.02) }], quote: { exact: q.exact } }, layer: 'highlight', z: 0, locked: false },
    }),
    op({ entity_type: 'note', entity_id: ids.note30, payload: { node_id: null, title: null, body: rt('ملاحظتي على الصفحة 30'), anchor: anchorOn(v1, 29), origin: 'owner' } }),
  ]);
  return ids;
}

/** Every stored row of these items (the guarantee: an official update never changes them). */
function itemRows(ids: string[]): string {
  const ph = ids.map(() => '?').join(',');
  const db = w.t.ctx.db;
  return JSON.stringify([
    ...db.all(`SELECT * FROM annotation WHERE id IN (${ph}) ORDER BY id`, ids),
    ...db.all(`SELECT * FROM note WHERE id IN (${ph}) ORDER BY id`, ids),
    ...db.all(`SELECT * FROM annotation_target WHERE annotation_id IN (${ph}) ORDER BY annotation_id`, ids),
  ]);
}
const liveItems = () => {
  const db = w.t.ctx.db;
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE deleted_at IS NULL')!.n + db.get<{ n: number }>('SELECT COUNT(*) AS n FROM note WHERE deleted_at IS NULL')!.n;
};

let zainab: { ink5: string; hl12: string; note30: string };
let autoIds: { ink5: string; hl12: string; note30: string };
let contribIds: { hl12: string; ink30: string };
let artifactId = '';
let citedRegion = '';
let zainabCopy: DocumentCopyView;

beforeAll(async () => {
  w = await createLectureWorld({ app: () => createStudyApp(ai) });
  const l = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Lecture 5 (TEST FIXTURE)', lecture_no: 5 });
  lectureId = l.id;
  const up = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'Abdomen Lecture 5.pdf', data: scenario4V1() });
  expect(up.statusCode, up.body).toBe(200);
  v1 = (up.json() as UploadOfficialVersionResponse).version_id;
  await drain(w);
  await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${l.id}/versions/${v1}/publish`), {});
  await drain(w);
  sourceId = space().get<{ source_id: string }>('SELECT source_id FROM official_lecture WHERE id = ?', [l.id])!.source_id;

  // زينب (the student): her copy, ink p.5, highlight p.12, note p.30, and a Study Book answer citing a region on p.12
  zainabCopy = (await startStudying(w, 'student', SPACE_A, lectureId)).copy;
  for (const p of ['student', 'contrib'] as const) w.t.ctx.system.quotas.setUserInternal(w.id[p], { ai_monthly_usd_limit: 5 }, w.id.owner);
  zainab = await seedScenario('student');
  const p12 = pagesOf(v1)[11]!;
  const q = quoteOn(p12);
  const sentence = regionsOn(p12).find((r) => r.id === q.regionId)!.text.split('.')[0]!.trim() + '.';
  ai.once('explain', (req) => content([{ kind: 'paragraph', sentences: [S.c(sentence, [aliasFor(req, sentence.slice(0, 30))], 'directly_stated')] }]));
  const ex = await w.req('student', 'POST', '/api/studybook/explain', {
    action: 'explain',
    style: 'detailed',
    anchor: { source_id: sourceId, version_id: v1, page_id: p12, region_ids: [q.regionId] },
    scope: { mode: 'lecture_only', lecture_source_id: sourceId },
    instruction: 'review step 2 — Scenario 4 citation',
  });
  expect(ex.statusCode, ex.body).toBe(200);
  const art = (ex.json() as ExplainResponse).artifact;
  artifactId = art.id;
  const cited = Object.values(art.claims).flatMap((c) => c.citations.map((x) => x.evidence));
  expect(cited.length).toBeGreaterThan(0);
  citedRegion = cited[0]!.region_id!;

  // a second student with «انقل ملاحظاتي تلقائيًا» (variant 6)
  w.setAccess('contrib2', SPACE_A, { access: 'member' });
  const auto = (await startStudying(w, 'contrib2', SPACE_A, lectureId)).copy;
  autoIds = await seedScenario('contrib2');
  await w.ok('contrib2', 'PATCH', `/api/copies/${auto.id}`, { reanchor_policy: 'auto' });

  // a third holder (preview policy): a highlight on p.12 and ink on the rewritten p.30
  w.setAccess('contrib', SPACE_A, { access: 'member' });
  await startStudying(w, 'contrib', SPACE_A, lectureId);
  const c12 = quoteOn(p12);
  contribIds = { hl12: newId(), ink30: newId() };
  await push('contrib', [
    op({
      entity_type: 'annotation',
      entity_id: contribIds.hl12,
      op: 'append',
      payload: { kind: 'text_highlight', tool: 'highlight', anchor: anchorOn(v1, 11), data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ ...c12.box, h: Math.min(c12.box.h, 0.02) }], quote: { exact: c12.exact } }, layer: 'highlight', z: 0, locked: false },
    }),
    op({ entity_type: 'annotation', entity_id: contribIds.ink30, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: anchorOn(v1, 29), data: ink(0.3, 0.4), layer: 'ink', z: 0, locked: false } }),
  ]);
  for (const who of ['student', 'contrib2', 'contrib'] as const) await w.ok(who, 'GET', '/api/copies'); // copies listed (no refresh needed)
  await w.ok('student', 'GET', `/api/copies/${zainabCopy.id}`); // refreshes the holder counts
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('Scenario 4 end to end on an OFFICIAL lecture (40 → 42 pages)', () => {
  let before = '';
  let countBefore = 0;

  it('steps 2–3: the moderator publishes v2; the confirmation counts holders; the page map has the Scenario 4 shape', async () => {
    before = inVault(w, 'student', () => itemRows(Object.values(zainab)));
    countBefore = inVault(w, 'student', liveItems);
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${lectureId}/upload`), { name: 'Abdomen lec5 final (1).pdf', data: scenario4V2() });
    expect(up.statusCode, up.body).toBe(200);
    v2 = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    const preview = await w.ok<{ holders: { value: number | null; label_ar: string } }>('mod', 'POST', sp(SPACE_A, `/lectures/${lectureId}/versions/${v2}/publish`), { preview: true });
    expect(preview.holders.label_ar).toBe('أقل من 5'); // 3 holders, a suppressed count — never names
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${lectureId}/versions/${v2}/publish`), {});
    await drain(w);
    await drain(w);
    const map = space().all<{ from_page_id: string; to_page_id: string | null; status: string }>(
      'SELECT from_page_id, to_page_id, status FROM version_page_map WHERE from_version_id = ? AND to_version_id = ?',
      [v1, v2],
    );
    const P1 = pagesOf(v1);
    const P2 = pagesOf(v2);
    const to = (i: number) => map.find((m) => m.from_page_id === P1[i])?.to_page_id;
    for (let i = 0; i < 10; i++) expect(to(i), `p.${i + 1}`).toBe(P2[i]);
    for (let i = 10; i < 40; i++) if (i !== 29) expect(to(i), `p.${i + 1}`).toBe(P2[i + 2]);
    expect(map.find((m) => m.from_page_id === P1[29])!.status).not.toMatch(/^(safe|confirmed)$/);
  });

  it('step 4 before the tap: the copy says a newer version exists; nothing in it changed', async () => {
    const view = await w.ok<DocumentCopyView>('student', 'GET', `/api/copies/${zainabCopy.id}`);
    expect(view.lecture?.version_no).toBe(2); // the stub's current version moved to v2 (the copy follows the official head)
    inVault(w, 'student', () => {
      expect(itemRows(Object.values(zainab))).toBe(before);
      expect(w.t.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation WHERE origin = 'reanchor_copy'`)!.n).toBe(0);
    });
    const pv = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${sourceId}&to_version_id=${v2}`);
    expect(pv).toMatchObject({ state: 'ready', copy: 2, needs_review: 1, kept: 0 });
    expect(pv.summary_ar).toBe('سيُنقل 2 · يحتاج مراجعة 1 · يبقى على الإصدار 1: 0');
  });

  it('step 4 the tap: ink p.5 → v2 p.5, highlight p.12 → v2 p.14, the p.30 note listed for review; v1 rows byte-identical; nothing missing', async () => {
    const pv = await w.ok<ReanchorCopyPreview>('student', 'GET', `/api/annotations/reanchor-copy?source_id=${sourceId}&to_version_id=${v2}`);
    const run = await w.ok<ReanchorCopyRunResponse>('student', 'POST', '/api/annotations/reanchor-copy', { source_id: sourceId, from_version_id: v1, to_version_id: v2, map_computed_at: pv.map_computed_at });
    expect(run.report).toMatchObject({ copied: 2, needs_review: 1, kept: 0 });
    expect(run.report.total).toBe(run.report.copied + run.report.already_moved + run.report.needs_review + run.report.kept);
    const P2 = pagesOf(v2);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      const copies = db.all<{ migrated_from_id: string; anchor_json: string }>(`SELECT migrated_from_id, anchor_json FROM annotation WHERE origin = 'reanchor_copy' AND deleted_at IS NULL`);
      const pageOf = (id: string) => JSON.parse(copies.find((c) => c.migrated_from_id === id)!.anchor_json).page_id;
      expect(pageOf(zainab.ink5)).toBe(P2[4]);
      expect(pageOf(zainab.hl12)).toBe(P2[13]);
      expect(itemRows(Object.values(zainab))).toBe(before);
      expect(liveItems()).toBe(countBefore + 2); // the originals + 2 copies: nothing missing, nothing moved
      expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    });
  });

  it('the Study Book citation still points to v1 and a content alert explains the new version (never moved silently)', () => {
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ version_id: string }>('SELECT version_id FROM evidence WHERE region_id = ?', [citedRegion])!.version_id).toBe(v1);
      const alert = db.get<{ id: string; severity: string }>(`SELECT id, severity FROM content_alert WHERE source_id = ? AND source_version_id = ? AND kind = 'source_replaced'`, [sourceId, v2]);
      expect(alert).toBeDefined();
      const items = db.all<{ dependent_id: string }>('SELECT dependent_id FROM content_alert_item WHERE alert_id = ?', [alert!.id]);
      expect(items.map((i) => i.dependent_id)).toContain(artifactId);
    });
  });

  it('variant (auto): the second student got the same copy without a tap, the same counts, originals kept', () => {
    inVault(w, 'contrib2', () => {
      const db = w.t.ctx.db;
      const run = db.get<{ counts_json: string }>('SELECT counts_json FROM reanchor_copy_run WHERE to_version_id = ?', [v2])!;
      expect(JSON.parse(run.counts_json)).toMatchObject({ copied: 2, needs_review: 1, kept: 0 });
      for (const id of Object.values(autoIds)) expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM annotation WHERE id = ? UNION ALL SELECT COUNT(*) FROM note WHERE id = ?', [id, id])).toBeDefined();
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation WHERE id IN (?, ?) AND deleted_at IS NULL`, [autoIds.ink5, autoIds.hl12])!.n).toBe(2);
    });
  });

  it('step 5: purging the lecture is refused while vaults hold personal items on v1 — a count, never names', () => {
    const res = inSpace(w, SPACE_A, () => {
      const report = buildImpactReport(w.t.ctx, 'source', sourceId, { sourceIds: [sourceId] }, 'purge');
      try {
        executePurge(w.t.ctx, 'source', sourceId, { sourceIds: [sourceId] }, report.confirm_token, { summary: 'review purge', before: null });
        return null;
      } catch (e) {
        return e as { code: string; message: string };
      }
    });
    expect(res?.code).toBe('CONFLICT');
    for (const p of ['student', 'contrib', 'contrib2'] as const) expect(JSON.stringify(res)).not.toContain(w.id[p]);
  });
});

describe('review findings', () => {
  it('R-A: a region the student cited on the NEW page does not hide the rest of that page from the highlight copy', async () => {
    // contrib asks about a paragraph of v2 p.14 (pinned into their vault) BEFORE tapping «انقل ملاحظاتي»
    const p14 = pagesOf(v2)[13]!;
    const quoteRegion = quoteOn(p14).regionId;
    const other = regionsOn(p14).find((r) => r.id !== quoteRegion)!;
    const ev = await w.req('contrib', 'POST', '/api/evidence/from-region', { region_id: other.id });
    expect(ev.statusCode, ev.body).toBe(200);
    const pv = await w.ok<ReanchorCopyPreview>('contrib', 'GET', `/api/annotations/reanchor-copy?source_id=${sourceId}&to_version_id=${v2}`);
    // the highlight's sentence is on v2 p.14 exactly as on v1 p.12: it is copied, not sent to review
    expect(pv.review.map((r) => r.id)).not.toContain(contribIds.hl12);
    expect(pv.copy).toBe(1);
  });

  it('R-B: «انقل يدويًا» to a paragraph of a stub page (regions live in the space) copies the item there', async () => {
    const p32 = pagesOf(v2)[31]!;
    const target = regionsOn(p32).find((r) => r.kind !== 'heading') ?? regionsOn(p32)[0]!;
    const rev = inVault(w, 'contrib', () => w.t.ctx.db.get<{ rev: number }>('SELECT rev FROM annotation WHERE id = ?', [contribIds.ink30])!.rev);
    const res = await w.req('contrib', 'POST', '/api/annotations/reanchor', {
      action: 'copy',
      items: [{ kind: 'annotation', id: contribIds.ink30, rev }],
      to_version_id: v2,
      target: { type: 'page', version_id: v2, page_id: p32, region_id: target.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ReanchorCopyActionResponse;
    expect(body.annotations).toHaveLength(1);
    expect(body.annotations[0]!.anchor).toMatchObject({ version_id: v2, page_id: p32 });
    // a region of ANOTHER page (or another lecture) is still refused
    const wrong = regionsOn(pagesOf(v2)[2]!)[0]!;
    const bad = await w.req('contrib', 'POST', '/api/annotations/reanchor', {
      action: 'copy',
      items: [{ kind: 'annotation', id: contribIds.hl12, rev: 1 }],
      to_version_id: v2,
      target: { type: 'page', version_id: v2, page_id: p32, region_id: wrong.id },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('two devices of the same student start the same copy at the same moment: one copy, one layer, one holding per version', async () => {
    const L2 = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Two devices (TEST FIXTURE)', lecture_no: 6 });
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${L2.id}/upload`), { name: 'two.pdf', data: lecturePdf(pagesFor('Two devices', 2)) });
    expect(up.statusCode, up.body).toBe(200);
    const ver = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${L2.id}/versions/${ver}/publish`), {});
    await drain(w);
    const body = (id: string) => ({ id, space_id: SPACE_A, lecture_id: L2.id, mode: 'personal' });
    const [a, b] = await Promise.all([w.req('student', 'POST', '/api/copies', body(newId())), w.req('student', 'POST', '/api/copies', body(newId()))]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    const ra = a.json() as StartStudyingResponse;
    const rb = b.json() as StartStudyingResponse;
    expect(ra.copy.id).toBe(rb.copy.id);
    expect([ra.created, rb.created].sort()).toEqual([false, true]);
    // each device replays its own request (a lost response): the same copy, nothing new
    const again = await w.req('student', 'POST', '/api/copies', body(ra.copy.id));
    expect((again.json() as StartStudyingResponse).copy.id).toBe(ra.copy.id);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_copy WHERE source_id = ?', [ra.copy.source_id])!.n).toBe(1);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM annotation_layer WHERE document_key = ? AND kind = 'personal'`, [ra.copy.document_key])!.n).toBe(1);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source WHERE origin_lecture_id = ?', [L2.id])!.n).toBe(1);
    });
    expect(holdings(w, 'student', SPACE_A, L2.id)).toEqual([{ version_id: ver, personal_items: 0 }]);
  });

  it('R-C: «اربط بالمحاضرة الرسمية» says honestly where the items it could not place are (they stay on the private lecture)', async () => {
    // the owner's private upload of Lecture 5 v1 (the same file), ink on p.5 and a note on p.30; the official head is v2
    w.setAccess('owner', SPACE_A, { access: 'member' });
    const priv = await addSource(w.t, 'x.pdf', 'pdf', { data: scenario4V1(), fileName: 'my lecture 5.pdf', title: 'My Lecture 5 (TEST FIXTURE)' });
    await processVersion(w.t, priv.versionId);
    const page = (i: number) => w.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = ?', [priv.versionId, i])!.id;
    const pa = (i: number) => ({ type: 'page' as const, source_id: priv.sourceId, version_id: priv.versionId, page_id: page(i), page_index: i, space: 'page_norm' as const });
    const inkId = newId();
    const noteId = newId();
    await push('owner', [
      op({ entity_type: 'annotation', entity_id: inkId, op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: pa(4), data: ink(), layer: 'ink', z: 0, locked: false } }),
      op({ entity_type: 'note', entity_id: noteId, payload: { node_id: null, title: null, body: rt('ملاحظتي الخاصة على الصفحة 30'), anchor: pa(29), origin: 'owner' } }),
    ]);
    const before = itemRows([inkId, noteId]);
    const cands = await w.ok<OfficialLinkCandidatesResponse>('owner', 'GET', `/api/copies/link-candidates?source_id=${priv.sourceId}`);
    const c = cands.candidates.find((x) => x.lecture_id === lectureId)!;
    expect(c.version_id).toBe(v2);
    const res = await w.ok<LinkToOfficialResponse>('owner', 'POST', '/api/copies/link', { id: newId(), source_id: priv.sourceId, space_id: SPACE_A, lecture_id: lectureId, to_version_id: v2 });
    expect(res.summary).toMatchObject({ total: 2, copied: 1, needs_review: 1, kept: 0 });
    // nothing lists the private note for review on the official copy (a cross-source review list does not exist): the
    // summary must say where it is instead of promising a review list
    expect(res.summary!.summary_ar).not.toMatch(/يحتاج مراجعتك|تحتاج مراجعتك/);
    expect(res.summary!.summary_ar).toContain('بقي في محاضرتك الخاصة كما هو');
    expect(itemRows([inkId, noteId])).toBe(before);
  });

  it('R-D: a purge is refused while a holder’s vault cannot be read (locked for a restore) — never purged under it', async () => {
    const M = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Locked holder (TEST FIXTURE)', lecture_no: 7 });
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${M.id}/upload`), { name: 'locked.pdf', data: lecturePdf(pagesFor('Locked', 2)) });
    expect(up.statusCode, up.body).toBe(200);
    const ver = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${M.id}/versions/${ver}/publish`), {});
    await drain(w);
    const copy = (await startStudying(w, 'student', SPACE_A, M.id)).copy;
    const pg = space().get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [ver])!.id;
    await push('student', [op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: { type: 'page', source_id: copy.source_id, version_id: ver, page_id: pg, page_index: 0, space: 'page_norm' }, data: ink(), layer: 'ink', z: 0, locked: false } })]);
    const msrc = space().get<{ source_id: string }>('SELECT source_id FROM official_lecture WHERE id = ?', [M.id])!.source_id;
    const sys = w.t.ctx.system.db;
    sys.run(`UPDATE vault SET status = 'locked' WHERE user_id = ?`, [w.id.student]);
    try {
      const res = inSpace(w, SPACE_A, () => {
        const report = buildImpactReport(w.t.ctx, 'source', msrc, { sourceIds: [msrc] }, 'purge');
        try {
          executePurge(w.t.ctx, 'source', msrc, { sourceIds: [msrc] }, report.confirm_token, { summary: 'review purge (locked holder)', before: null });
          return null;
        } catch (e) {
          return e as { code: string };
        }
      });
      expect(res?.code).toBe('CONFLICT');
      expect(space().get<{ n: number }>('SELECT COUNT(*) AS n FROM official_lecture WHERE id = ?', [M.id])!.n).toBe(1);
    } finally {
      sys.run(`UPDATE vault SET status = 'active' WHERE user_id = ?`, [w.id.student]);
    }
  });

  it('R-F: a vault stub is read-only content — it is never re-processed or replaced in the vault (official text stays in the space)', async () => {
    const T = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Stub read-only (TEST FIXTURE)', lecture_no: 8 });
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${T.id}/upload`), { name: 'ro.pdf', data: lecturePdf(pagesFor('Readonly', 2, { 0: 'zzstubtextsentinel appears only in the official file' })) });
    expect(up.statusCode, up.body).toBe(200);
    const ver = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${T.id}/versions/${ver}/publish`), {});
    await drain(w);
    const copy = (await startStudying(w, 'contrib2', SPACE_A, T.id)).copy;
    const re = await w.req('contrib2', 'POST', `/api/sources/versions/${ver}/reprocess`, {});
    expect(re.statusCode, re.body).toBe(409);
    const rep = await w.upload('contrib2', `/api/sources/${copy.source_id}/versions`, { name: 'mine.pdf', data: lecturePdf(pagesFor('Mine', 1)) });
    expect(rep.statusCode, rep.body).toBe(409);
    await drain(w);
    inVault(w, 'contrib2', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM document_chunk WHERE source_id = ?', [copy.source_id])!.n).toBe(0);
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM source_region WHERE text LIKE '%zzstubtextsentinel%'`)!.n).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE source_id = ?', [copy.source_id])!.n).toBe(1);
    });
    // the vault's own search never finds the official text (only the federated, member-checked search does)
    const r = await w.ok<{ results: Array<{ db?: { kind: string } }> }>('contrib2', 'GET', '/api/search?q=zzstubtextsentinel&scope=mine');
    expect(r.results.every((x) => x.db?.kind === 'space')).toBe(true);
  });

  it('R-G: a stub sync retried after its first attempt added the version (crash) still raises the alert and runs the automatic copy', async () => {
    const X = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Retry window (TEST FIXTURE)', lecture_no: 9 });
    const up1 = await w.upload('mod', sp(SPACE_A, `/lectures/${X.id}/upload`), { name: 'x1.pdf', data: lecturePdf(pagesFor('Retry', 3)) });
    const x1 = (up1.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${X.id}/versions/${x1}/publish`), {});
    await drain(w);
    const copy = (await startStudying(w, 'contrib2', SPACE_A, X.id)).copy;
    await w.ok('contrib2', 'PATCH', `/api/copies/${copy.id}`, { reanchor_policy: 'auto' });
    const pg = space().get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [x1])!.id;
    await push('contrib2', [op({ entity_type: 'annotation', entity_id: newId(), op: 'append', payload: { kind: 'ink', tool: 'pen', anchor: { type: 'page', source_id: copy.source_id, version_id: x1, page_id: pg, page_index: 0, space: 'page_norm' }, data: ink(), layer: 'ink', z: 0, locked: false } })]);
    const up2 = await w.upload('mod', sp(SPACE_A, `/lectures/${X.id}/upload`), { name: 'x2.pdf', data: lecturePdf(pagesFor('Retry', 3, { 2: 'Retry page 3 rewritten for version two' })) });
    const x2 = (up2.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${X.id}/versions/${x2}/publish`), {});
    // the first attempt of the vault job added v2 to the stub, then the process died before the alert and the copy
    inVault(w, 'contrib2', () => ensureStub(w.t.ctx, { spaceId: SPACE_A, lectureId: X.id, versionIds: [x1, x2], folderId: null, subjectTitle: 'Anatomy A' }));
    await drain(w);
    await drain(w);
    inVault(w, 'contrib2', () => {
      const db = w.t.ctx.db;
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM content_alert WHERE source_id = ? AND source_version_id = ?`, [copy.source_id, x2])!.n).toBe(1);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reanchor_copy_run WHERE to_version_id = ?', [x2])!.n).toBe(1);
    });
  });

  it('R-I: after a rights takedown a FORMER member’s copy says the file was removed (the takedown reached their vault too)', async () => {
    const T = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Takedown former member (TEST FIXTURE)', lecture_no: 10 });
    const up = await w.upload('mod', sp(SPACE_A, `/lectures/${T.id}/upload`), { name: 'td.pdf', data: lecturePdf(pagesFor('Takedown', 2)) });
    const ver = (up.json() as UploadOfficialVersionResponse).version_id;
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${T.id}/versions/${ver}/publish`), {});
    await drain(w);
    const copy = (await startStudying(w, 'contrib2', SPACE_A, T.id)).copy;
    w.setAccess('contrib2', SPACE_A, null);
    try {
      await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${T.id}/withdraw`), { reason: 'rights_takedown', note_ar: 'طلب صاحب الحقوق سحب الملف' });
      await drain(w);
      inVault(w, 'contrib2', () => expect(w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version WHERE source_id = ? AND file_id IS NOT NULL', [copy.source_id])!.n).toBe(0));
      const view = await w.ok<DocumentCopyView>('contrib2', 'GET', `/api/copies/${copy.id}`);
      expect(view.official).toMatchObject({ status: 'unavailable', file_removed: true });
    } finally {
      w.setAccess('contrib2', SPACE_A, { access: 'member' });
    }
  });
});
