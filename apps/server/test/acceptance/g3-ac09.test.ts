// G3 / AC-09 — «an image search result of a different modality or region is excluded, and the system never writes
// an explanation implying it is the requested example». The derived fixture `fixtures/acceptance/g3_image_atlas.pdf`
// (make_g3_fixtures.mjs: ten drawn pictures labelled TEST FIXTURE, each with a printed caption — the only thing that
// says what it is) is uploaded through the REAL route and processed by the REAL pipeline (figures cropped, captions
// linked). The AC-09 gate (`POST /api/media/images/match`, «ابحث في صوري») runs over those images.
//
// Adversarial angles beyond the module tests (which use hand-made rows): captions as processing really extracts them
// (Arabic caption from a Chrome-made PDF), a caption whose finding is GONE («resolved pneumothorax»), a composite caption
// naming two modalities («Chest X-ray and CT side by side; the CT shows …»), a drawing whose caption names the modality
// first («Chest X-ray appearance of … (artist's illustration)»), Arabic requests, age, the owner's own classification,
// and no side effects (no AI call, no explanation, no stored «match» verdict).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImageMatchResponse, ImageRequest } from '@medlevo/shared';
import { MODULES } from '../../src/modules';
import { validateImageCandidate } from '../../src/modules/media/validate-image';
import { createProcessingModule } from '../../src/modules/processing';
import { ScriptedAi } from '../exams/helpers';
import { createTestApp } from '../helpers/app';
import { createNode, uploadAndProcess, type QApp } from '../questions/helpers';

const ACCEPTANCE = join(__dirname, '..', '..', '..', '..', 'fixtures', 'acceptance');
const ai = new ScriptedAi(); // no handler at all: any AI call would fail the request
let t: QApp;
let atlas: { sourceId: string; versionId: string };
const fig = new Map<number, string>(); // figure number → image_asset id

beforeAll(async () => {
  const app = await createTestApp({
    ai,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
  t = Object.assign(app, { h: await app.login() }) as QApp;
  const course = (await createNode(t, 'Radiology (G3)')).id;
  atlas = await uploadAndProcess(t, course, 'g3_image_atlas.pdf', readFileSync(join(ACCEPTANCE, 'g3_image_atlas.pdf')), 'course_reference', 'Chest imaging atlas (TEST FIXTURE)');
  for (const r of t.ctx.db.all<{ id: string; caption: string | null }>('SELECT id, caption FROM image_asset WHERE version_id = ?', [atlas.versionId])) {
    const n = /(?:Figure|الشكل)\s*(\d+)/.exec(r.caption ?? '')?.[1];
    if (n) fig.set(Number(n), r.id);
  }
}, 180_000);

afterAll(async () => {
  await t?.close();
});

async function match(request: ImageRequest): Promise<ImageMatchResponse> {
  const res = await t.app.inject({ method: 'POST', url: '/api/media/images/match', headers: t.h, payload: { request } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ImageMatchResponse;
}
const figOf = (imageId: string) => [...fig.entries()].find(([, id]) => id === imageId)?.[0] ?? -1;
const accepted = (r: ImageMatchResponse) => r.accepted.map((a) => figOf(a.image.id)).sort((a, b) => a - b);
const reasonsOf = (r: ImageMatchResponse, n: number) => r.excluded.find((x) => x.image.id === fig.get(n))?.validation.reasons_ar.join(' ') ?? '(not excluded)';

describe('G3 AC-09 — the real atlas through the real pipeline', () => {
  it('processing found all ten figures with their captions (including the Arabic one)', () => {
    expect([...fig.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ar = t.ctx.db.get<{ caption: string }>('SELECT caption FROM image_asset WHERE id = ?', [fig.get(7)!])!.caption;
    expect(ar).toContain('أشعة سينية للصدر');
    expect(ar).toContain('استرواح الصدر');
  });

  it('«chest X-ray showing a pneumothorax»: only true examples accepted; other modality / region / denied / gone / drawn / ambiguous images excluded with their reason', async () => {
    const r = await match({ modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax', 'استرواح الصدر'] });
    expect(accepted(r)).toEqual([1, 7, 9]);
    expect(reasonsOf(r, 2)).toMatch(/تصوير مقطعي \(CT\) لا يطابق/); // other modality
    expect(reasonsOf(r, 6)).toMatch(/أمواج فوق صوتية \(Ultrasound\) لا يطابق/);
    expect(reasonsOf(r, 3)).toMatch(/المنطقة \(abdomen\) تختلف/); // other region
    expect(reasonsOf(r, 4)).toMatch(/منفية أو مستبعدة/); // «no evidence of pneumothorax»
    expect(reasonsOf(r, 8)).toMatch(/منفية أو مستبعدة/); // «resolved pneumothorax»: the finding is gone
    expect(reasonsOf(r, 5)).toMatch(/رسم تعليمي/); // «(artist's illustration)»
    expect(reasonsOf(r, 10)).toMatch(/أكثر من نوع تصوير/); // «Chest X-ray and CT side by side; the CT shows …»
    // nothing in the answer explains an excluded image: only the gate's reasons; the note says no explanation is written
    for (const x of r.excluded) {
      expect(Object.keys(x).sort()).toEqual(['image', 'validation']);
      expect(x.validation.accepted).toBe(false);
      expect(x.validation.reasons_ar.length).toBeGreaterThan(0);
    }
    expect(r.note_ar).toContain('لا تُكتب لها شروح تلقائيًا');
    expect(r.external.state).not.toBe('available');
  });

  it('Arabic request («أشعة سينية» / «الصدر» / «استرواح الصدر»): the Arabic caption is the example; an English caption without the requested finding words is not', async () => {
    const r = await match({ modality: 'أشعة سينية', anatomic_region: 'الصدر', finding_terms: ['استرواح الصدر'] });
    expect(accepted(r)).toEqual([7]);
    expect(reasonsOf(r, 1)).toMatch(/لا يذكر العلامة المطلوبة/);
  });

  it('a CT request: the CT figure only — the composite caption is not taken as the CT example either', async () => {
    const r = await match({ modality: 'CT', anatomic_region: 'thorax', finding_terms: ['pneumothorax'] });
    expect(accepted(r)).toEqual([2]);
    expect(reasonsOf(r, 10)).toMatch(/أكثر من نوع تصوير/);
    expect(reasonsOf(r, 1)).toMatch(/أشعة سينية \(X-ray\) لا يطابق/);
  });

  it('age group: a child example is the child X-ray; an image whose age cannot be checked is not accepted', async () => {
    const r = await match({ modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'], age_group: 'child' });
    expect(accepted(r)).toEqual([9]);
    expect(reasonsOf(r, 1)).toMatch(/الفئة العمرية للصورة غير معروفة/);
  });

  it("the owner's classification decides: a CT the owner labels as such is accepted for CT and still excluded for X-ray; a picture the owner marks as a drawing is never a real example", async () => {
    const patch = (id: string, payload: unknown) => t.app.inject({ method: 'PATCH', url: `/api/media/images/${id}/meta`, headers: t.h, payload: payload as never });
    expect((await patch(fig.get(10)!, { modality: 'ct' })).statusCode).toBe(200);
    expect((await patch(fig.get(9)!, { image_kind: 'educational_drawing' })).statusCode).toBe(200);
    const ct = await match({ modality: 'CT', anatomic_region: 'chest', finding_terms: ['pneumothorax'] });
    expect(accepted(ct)).toEqual([2, 10]);
    const xr = await match({ modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'] });
    expect(accepted(xr)).toEqual([1]);
    expect(reasonsOf(xr, 10)).toMatch(/تصوير مقطعي \(CT\) لا يطابق/);
    expect(reasonsOf(xr, 9)).toMatch(/رسم تعليمي/);
  });

  it('no side effects: no AI call, no artifact or explanation written, no stored «match» verdict on any image', async () => {
    const before = {
      artifacts: t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n,
      statuses: t.ctx.db.all<{ match_status: string }>('SELECT match_status FROM image_asset WHERE version_id = ?', [atlas.versionId]).map((x) => x.match_status),
    };
    await match({ modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'] });
    expect(ai.calls).toHaveLength(0);
    expect(t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact')!.n).toBe(before.artifacts);
    expect(before.statuses.every((s) => s === 'unverified')).toBe(true);
    expect(t.ctx.db.all<{ match_status: string }>('SELECT match_status FROM image_asset WHERE version_id = ?', [atlas.versionId]).map((x) => x.match_status)).toEqual(before.statuses);
  });
});

describe('G3 AC-09 — gate edge cases (validator, Arabic captions)', () => {
  const req: ImageRequest = { modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax', 'استرواح الصدر'] };
  const v = (caption: string, extra: Record<string, unknown> = {}) => validateImageCandidate({ caption, origin: 'source', image_kind: 'unknown', ...extra }, req);

  it('a finding that is gone or drawn is never the example; a plain positive caption still is', () => {
    expect(v('Chest X-ray showing a right pneumothorax.').accepted).toBe(true);
    expect(v('صورة أشعة سينية للصدر تُظهر استرواح الصدر.').accepted).toBe(true);
    expect(v('Chest X-ray: resolution of the pneumothorax after drainage.').accepted).toBe(false);
    expect(v('Chest X-ray: healed pneumothorax.').accepted).toBe(false);
    expect(v('صورة أشعة سينية للصدر بعد زوال استرواح الصدر.').accepted).toBe(false);
    expect(v('صورة أشعة سينية للصدر: استرواح الصدر زال بعد التصريف.').accepted).toBe(false);
    expect(v('رسم توضيحي: صورة أشعة سينية للصدر تُظهر استرواح الصدر.').accepted).toBe(false);
    expect(v('Chest radiograph of a pneumothorax (schematic).').accepted).toBe(false);
    // a drawing explicitly requested is allowed to be a drawing
    expect(validateImageCandidate({ caption: 'Schematic drawing of a chest pneumothorax.', origin: 'source', image_kind: 'unknown' }, { ...req, modality: 'drawing' }).accepted).toBe(true);
  });

  it('one modality named twice is one modality; a denied second modality does not make it ambiguous', () => {
    expect(v('Chest X-ray (CXR) showing a pneumothorax.').accepted).toBe(true);
    expect(v('Chest X-ray showing a pneumothorax; no CT was performed.').accepted).toBe(true);
    expect(v('Chest X-ray and ECG of the same patient: pneumothorax.').checks.find((c) => c.check === 'modality')!.passed).toBe(false);
  });
});
