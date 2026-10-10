// DOCX export (§46, track F5): a real .docx (zip + WordprocessingML) for the Study Book, notes, questions and a
// source's text. Checked by opening the archive: RTL paragraphs (<w:bidi/>), Arabic runs <w:rtl/>, English terms and
// values as their own LTR runs (no <w:rtl/>, en-US) — never invisible bidi control characters —, citations as numbered
// TEXT (source — page — version + the evidence quote), the generated label, no hyperlinks, solutions only on request,
// and the capability / formats endpoint saying DOCX is available.
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportFormatsResponse, StudyArtifactView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { buildDocx, para, textSegs } from '../../src/modules/data/docx';
import { dataLibrary, getJson, pageAnchor, push, writeOwnerData, type DataLib, type OwnerData } from './helpers';

let lib: DataLib;
let owner: OwnerData;
// marks, embeddings and overrides are never written; only the isolates LRI / RLI … PDI around opposite-direction islands
const FORBIDDEN_BIDI = /[\u200e\u200f\u202a-\u202e\u2068\u061c]/;
const ISOLATES = /[\u2066\u2067\u2069]/g;
const stripIso = (s: string) => s.replace(ISOLATES, '');
/** isolates are balanced: every LRI / RLI has its PDI */
const balanced = (s: string) => (s.match(/[\u2066\u2067]/g) ?? []).length === (s.match(/\u2069/g) ?? []).length;

beforeAll(async () => {
  lib = await dataLibrary();
  owner = await writeOwnerData(lib, { attempt: false });
  await push(lib, [
    {
      entity_type: 'note',
      entity_id: newId(),
      op: 'upsert',
      payload: {
        title: 'قيمة مهمة',
        body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'تعداد الكريات البيض أعلى من 11 ×10⁹/L يدعم التشخيص، و CT abdomen في البالغين.' }] }] },
        anchor: pageAnchor(lib, 0),
        origin: 'owner',
      },
    },
  ]);
}, 240_000);
afterAll(async () => {
  await lib?.t.close();
});

async function getDocx(url: string): Promise<{ status: number; headers: Record<string, unknown>; xml: string; zip: JSZip | null; body: string }> {
  const res = await lib.t.app.inject({ method: 'GET', url, headers: lib.h });
  if (res.statusCode !== 200) return { status: res.statusCode, headers: res.headers, xml: '', zip: null, body: res.body };
  const zip = await JSZip.loadAsync(res.rawPayload);
  const xml = await zip.file('word/document.xml')!.async('string');
  return { status: res.statusCode, headers: res.headers, xml, zip, body: '' };
}

/** text of the document (all <w:t>), in document order, isolate marks included */
const rawTextOf = (xml: string) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')).join('');
/** each run: its rtl flag and text */
/** the logical text a reader copies (isolate marks are formatting, not text) */
const textOf = (xml: string) => stripIso(rawTextOf(xml));
const runsOf = (xml: string) =>
  [...xml.matchAll(/<w:r>(.*?)<\/w:r>/gs)].map((m) => ({ rtl: /<w:rtl\/>/.test(m[1]!), lang: /<w:lang w:val="([^"]+)"/.exec(m[1]!)?.[1] ?? null, raw: rawTextOf(m[1]!), text: textOf(m[1]!) }));

describe('Study Book → DOCX', () => {
  it('is a real Word document with the generated label, RTL paragraphs, isolated English runs and citations as text', async () => {
    const id = owner.book!.artifact.id;
    const r = await getDocx(`/api/data/export/artifact/${id}?format=docx`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(String(r.headers['content-disposition'])).toMatch(/attachment; filename=".*\.docx"/);
    expect(r.zip!.file('[Content_Types].xml')).toBeTruthy();
    const text = textOf(r.xml);
    expect(text).toContain('محتوى مولَّد بواسطة MedLevo');
    expect(text).toContain('الأدلة المستشهد بها');
    // the first cited evidence: «Acute Appendicitis (TEST FIXTURE) — ص 11 … — الإصدار 1» + its quote, as TEXT
    const view = (await getJson<{ artifact: StudyArtifactView }>(lib, `/api/studybook/artifacts/${id}`)).body.artifact;
    const ev = Object.values(view.claims).flatMap((c) => c.citations)[0]!.evidence;
    expect(text).toContain('Acute Appendicitis (TEST FIXTURE)');
    expect(text).toContain(`الإصدار ${ev.version_no}`);
    expect(text.replace(/\s+/g, ' ')).toContain(ev.quote.replace(/\s+/g, ' ').slice(0, 40));
    expect(text).toMatch(/\[1\]/);
    // RTL paragraphs, Arabic runs rtl, English runs NOT rtl and tagged en-US
    expect(r.xml).toContain('<w:bidi/>');
    const runs = runsOf(r.xml);
    expect(runs.some((x) => x.rtl && /[؀-ۿ]/.test(x.text))).toBe(true);
    const english = runs.filter((x) => /^[\sA-Za-z().,'-]+$/.test(x.text) && /[A-Za-z]{3}/.test(x.text));
    expect(english.length).toBeGreaterThan(0);
    expect(english.every((x) => !x.rtl && x.lang === 'en-US')).toBe(true);
    // never a hyperlink, never an invisible bidi control, never markup from the content
    expect(r.xml).not.toContain('<w:hyperlink');
    expect(await r.zip!.file('word/_rels/document.xml.rels')!.async('string')).not.toMatch(/TargetMode="External"/);
    expect(FORBIDDEN_BIDI.test(rawTextOf(r.xml))).toBe(false);
    expect(balanced(rawTextOf(r.xml))).toBe(true);
    // English islands of Arabic paragraphs are isolated (LRI … PDI), so their neutrals cannot be reordered
    expect(runs.some((x) => x.raw.trim().startsWith('\u2066') && /[A-Za-z]{3}/.test(x.raw))).toBe(true);
  });
});

describe('notes, questions, source → DOCX', () => {
  it('notes: the value with its unit stays one LTR run inside the Arabic sentence, in logical order', async () => {
    const r = await getDocx(`/api/data/export/notes?format=docx&source_id=${lib.lecture.sourceId}`);
    expect(r.status).toBe(200);
    const text = textOf(r.xml);
    expect(text).toContain('ملاحظاتي — Acute Appendicitis (TEST FIXTURE)');
    expect(text).toContain('تعداد الكريات البيض أعلى من 11 ×10⁹/L يدعم التشخيص');
    const runs = runsOf(r.xml);
    const value = runs.find((x) => x.text.includes('11 ×10⁹/L'))!;
    expect(value.rtl).toBe(false);
    expect(value.text.trim()).toBe('11 ×10⁹/L');
    // isolated as one LTR island — without the isolate the bidi algorithm lays it out «L/10⁹× 11» (measured, LibreOffice)
    expect(value.raw.trim()).toBe('\u206611 ×10⁹/L\u2069');
    expect(runs.find((x) => x.text.includes('CT abdomen'))!.rtl).toBe(false);
    // the hostile-looking note body from the shared fixture is plain text, not markup
    expect(r.xml).not.toMatch(/<b>|<script/);
    expect(FORBIDDEN_BIDI.test(rawTextOf(r.xml))).toBe(false);
    expect(balanced(rawTextOf(r.xml))).toBe(true);
  });

  it('questions: with solutions names who stands behind each key; without solutions there is no key', async () => {
    const withKeys = await getDocx(`/api/data/export/questions?format=docx&source_id=${lib.questions.sourceId}`);
    expect(withKeys.status).toBe(200);
    const t1 = textOf(withKeys.xml);
    expect(t1).toContain('يتضمن هذا الملف الحلول');
    expect(t1).toContain('(الإجابة)');
    expect(t1).toContain('الإجابة: ');
    expect(t1).toContain('NOT');
    const without = await getDocx(`/api/data/export/questions?format=docx&source_id=${lib.questions.sourceId}&include_solutions=0`);
    const t2 = textOf(without.xml);
    expect(t2).toContain('دون حلول');
    expect(t2).not.toContain('(الإجابة)');
    expect(t2).not.toContain('الإجابة: ');
  });

  it('source: page labels as printed, the extracted text, the ink note; Arabic text in logical order', async () => {
    const r = await getDocx(`/api/data/export/source/${lib.lecture.sourceId}?format=docx`);
    expect(r.status).toBe(200);
    const text = textOf(r.xml);
    expect(text).toContain('ص 11');
    expect(text).toContain('Ultrasound is the first-line');
    expect(text).toContain('الحفرة الحرقفية اليمنى');
    expect(text).not.toContain('األلم');
    expect(text).toContain('لا تُصدَّر الكتابة بالقلم');
    expect(FORBIDDEN_BIDI.test(rawTextOf(r.xml))).toBe(false);
    expect(balanced(rawTextOf(r.xml))).toBe(true);
  });

  it('an unknown artifact is 404 in DOCX too; DOCX needs the owner session', async () => {
    expect((await getDocx(`/api/data/export/artifact/${newId()}?format=docx`)).status).toBe(404);
    const anon = await lib.t.app.inject({ method: 'GET', url: `/api/data/export/notes?format=docx` });
    expect(anon.statusCode).toBe(401);
  });
});

describe('formats and capability', () => {
  it('DOCX is a listed format and the capability is available', async () => {
    const f = (await getJson<ExportFormatsResponse>(lib, '/api/data/export/formats')).body;
    expect(f.formats.map((x) => x.format)).toEqual(['md', 'html', 'json', 'docx']);
    expect(f.formats.find((x) => x.format === 'docx')!.note_ar).toContain('دون روابط');
    expect(f.other.some((o) => o.key === 'export.docx')).toBe(false);
    const caps = (await lib.t.app.inject({ method: 'GET', url: '/api/capabilities', headers: lib.h })).json().features;
    expect(caps['export.docx'].state).toBe('available');
  });

  it('the builder strips characters XML cannot carry and never writes bidi controls', async () => {
    const buf = await buildDocx('عنوان\u202e', [para('نص \u0007 مع McBurney\u200f و 5 mg IV')]);
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).not.toMatch(/[\u0000-\u0008\u200e\u200f\u202a-\u202e]/); // eslint-disable-line no-control-regex -- asserting control characters are absent
    expect(balanced(xml)).toBe(true);
    expect(textSegs('الجرعة 5 mg IV مهمة').map((s) => `${s.dir}:${s.t}`)).toEqual(['rtl:الجرعة ', 'ltr:5 mg IV', 'rtl: مهمة']);
  });
});
