// Phase 1 completion, track C2 — AOS-4.18 (export part): the author and the lineage «مشتق من منشور X (الإصدار n) لـ Y»
// survive EXPORT. A student who follows (or forks) a classmate's published explanation and exports her notes or the
// lecture gets every copied item marked with where it came from — in Markdown, HTML, Word and JSON — and her own items
// carry no such line. A copied highlight is never exported as «تمييزي» (it is not hers). Real channels (pubWorld). Every
// file, stroke and note is a TEST FIXTURE generated here.
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicationView, StartStudyingResponse, SyncOp } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { mdEscape } from '../../src/modules/data/render';
import { rt } from '../annotations/helpers';
import { call, ok } from '../channels/helpers';
import { createLayer, createPubWorld, inVault, op, pageAnchor, publish, push, settle, startPersonal, typedNote, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
let pub: PublicationView;
let authorShown: string;
const TITLE = 'شرح حسن للمحاضرة 5';
const HASAN_NOTE = 'الجذع البطني يتفرع إلى ثلاثة فروع';
const OWN_NOTE = 'ملاحظتي أنا: أراجع هذا قبل الامتحان';
const QUOTE = 'Lecture 5';

async function get(who: Who, url: string): Promise<{ status: number; body: string; raw: Buffer }> {
  const res = await w.t.app.inject({ method: 'GET', url, headers: w.p[who].h });
  return { status: res.statusCode, body: res.body, raw: res.rawPayload };
}
async function docxText(who: Who, url: string): Promise<string> {
  const r = await get(who, url);
  expect(r.status, r.body).toBe(200);
  const zip = await JSZip.loadAsync(r.raw);
  const xml = await zip.file('word/document.xml')!.async('string');
  return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]!).join('').replace(/[⁦⁧⁩]/g, '');
}

beforeAll(async () => {
  w = await createPubWorld(4);
  await startPersonal(w, 'hasan');
  const layer = await createLayer(w, 'hasan', 'شرحي');
  await typedNote(w, 'hasan', layer, 0, HASAN_NOTE);
  const hl: SyncOp = op({
    entity_type: 'annotation',
    entity_id: newId(),
    payload: { kind: 'text_highlight', tool: 'highlight', anchor: pageAnchor(w, 0), data: { v: 1, style: 'highlight', color: 'marker-yellow', rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }], quote: { exact: QUOTE } }, layer: 'highlight', z: 0, locked: false, layer_id: layer },
  });
  for (const r of await push(w, 'hasan', [hl])) expect(r.result, JSON.stringify(r)).toBe('applied');
  pub = await publish(w, 'hasan', [layer], TITLE);
  await settle(w);
  ok<StartStudyingResponse>(await call(w.t, w.p.zainab.h, 'POST', '/api/copies', { id: newId(), space_id: w.space, lecture_id: w.lecture.id, mode: 'followed', publication_id: pub.id }));
  await typedNote(w, 'zainab', null, 1, OWN_NOTE);
  authorShown = inVault(w, 'zainab', () => w.t.ctx.db.get<{ d: string }>(`SELECT author_display AS d FROM attribution WHERE entity_type = 'note' LIMIT 1`)!.d);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const LINEAGE = () => `مشتق من منشور «${TITLE}» (الإصدار 1) لـ ${authorShown}`;
/** Markdown escapes the author's handle (e.g. «pw\_hasan»): it renders as the same text */
const MD_LINEAGE = () => mdEscape(LINEAGE());
/** HTML as the text a reader sees (English runs are wrapped in bidi-isolating elements) */
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('AOS-4.18 — attribution and lineage survive export', () => {
  it('notes as Markdown and HTML: the copied note says where it came from; her own note does not', async () => {
    const md = await get('zainab', `/api/data/export/notes?format=md&source_id=${w.lecture.sourceId}`);
    expect(md.status, md.body).toBe(200);
    expect(md.body).toContain(HASAN_NOTE);
    expect(md.body).toContain(OWN_NOTE);
    expect(md.body).toContain(MD_LINEAGE());
    // the lineage line belongs to the copied note's section, not to hers
    const sections = md.body.split('### ');
    const hers = sections.find((s) => s.includes(OWN_NOTE))!;
    const his = sections.find((s) => s.includes(HASAN_NOTE))!;
    expect(his).toContain(MD_LINEAGE());
    expect(hers).not.toContain('مشتق من');
    const html = await get('zainab', `/api/data/export/notes?format=html&source_id=${w.lecture.sourceId}`);
    expect(plain(html.body)).toContain(LINEAGE());
  });

  it('notes as Word and JSON keep the lineage (JSON: the attribution row with its chain)', async () => {
    expect(await docxText('zainab', `/api/data/export/notes?format=docx&source_id=${w.lecture.sourceId}`)).toContain(LINEAGE());
    const json = JSON.parse((await get('zainab', `/api/data/export/notes?format=json&source_id=${w.lecture.sourceId}`)).body) as {
      attributions: Array<{ entity_type: string; entity_id: string; author_user_id: string; lineage_ar: string; derived_from: Array<{ publication_id: string | null; version_no: number | null }> }>;
      notes: Array<{ id: string; body: unknown }>;
    };
    expect(json.attributions).toHaveLength(1);
    expect(json.attributions[0]).toMatchObject({ entity_type: 'note', author_user_id: w.p.hasan.user.id, lineage_ar: LINEAGE() });
    expect(json.attributions[0]!.derived_from[0]).toMatchObject({ publication_id: pub.id, version_no: 1 });
  });

  it('the lecture export: a copied highlight is not «تمييزي» — it names its lineage (Markdown, HTML, Word)', async () => {
    const md = await get('zainab', `/api/data/export/source/${w.lecture.sourceId}?format=md`);
    expect(md.status, md.body).toBe(200);
    expect(md.body).toContain(`«${QUOTE}»`);
    expect(md.body).not.toContain(`تمييزي: «${QUOTE}»`);
    expect(md.body).toContain(MD_LINEAGE());
    const html = await get('zainab', `/api/data/export/source/${w.lecture.sourceId}?format=html`);
    expect(plain(html.body)).not.toContain(`تمييزي: «${QUOTE}»`);
    expect(plain(html.body)).toContain(LINEAGE());
    const docx = await docxText('zainab', `/api/data/export/source/${w.lecture.sourceId}?format=docx`);
    expect(docx).not.toContain(`تمييزي: «${QUOTE}»`);
    expect(docx).toContain(LINEAGE());
    // the author's own export of his own explanation names nobody (it is his)
    const own = await get('hasan', `/api/data/export/notes?format=md&source_id=${w.lecture.sourceId}`);
    expect(own.body).toContain(HASAN_NOTE);
    expect(own.body).not.toContain('مشتق من منشور');
  });

  it('rich text bodies stay the author\'s words (no edit on export)', async () => {
    const md = await get('zainab', `/api/data/export/notes?format=md&source_id=${w.lecture.sourceId}`);
    expect(md.body).toContain(HASAN_NOTE);
    expect(rt(HASAN_NOTE).paragraphs.length).toBe(1);
  });
});
