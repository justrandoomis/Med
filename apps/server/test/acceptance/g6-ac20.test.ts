// G6 / AC-20 — «النص المختلط»: numbers, units, parentheses and English terms keep their correct order inside Arabic in
// display, copy, search and export. Server side, on the REAL pipeline (Golden Set lecture: an Arabic sentence that
// ends with «McBurney», «11 ×10⁹/L», «(β-hCG)») and an owner note typed with the §21 samples plus super/subscripts.
// What is checked here: what is STORED / SEARCHED / EXPORTED is the logical text (never visual order, never bidi
// control characters), and the export's isolates (<bdi dir="ltr">) cover whole expressions — «10⁹», «CO₂», «HCO₃⁻»
// were split before the G6 fix (the bare «⁹»/«₂» then renders on the wrong side). The visual result of the same text
// in Chromium (note view, search snippet, exported HTML, reader copy) is e2e/g6-ac20-mixed-text.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextFromPlain, type PageRegionsResponse, type SearchResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { studyLibrary, type StudyLib } from '../studybook/helpers';

let lib: StudyLib;
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/;

/** an owner's note typed in Arabic with the §21 formatting samples (formatting test only, not a recommendation) */
const NOTE =
  'عدد الكريات البيضاء أعلى من 11 ×10⁹ في اللتر، ويرتفع CO₂ (في الدم) وتنخفض HCO₃⁻؛ الصوديوم Na+ 135 mmol/L والجرعة 5 mg IV وpH 7.35 وجرثومة H. pylori والفحص (CT abdomen) والتسلسل A → B → C.';
const noteId = newId();

beforeAll(async () => {
  lib = await studyLibrary(null);
  const page = lib.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [lib.lecture.versionId])!;
  const push = await lib.t.app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: lib.h,
    payload: {
      ops: [
        {
          op_id: newId(),
          device_id: 'dev-g6',
          entity_type: 'note',
          entity_id: noteId,
          op: 'upsert',
          // the web's note editor stores richTextFromPlain(text) — the same function
          payload: { body: richTextFromPlain(NOTE), anchor: { type: 'page', source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: page.id, page_index: 0, space: 'page_norm' } },
        },
      ],
    },
  });
  expect(push.json().results[0].result).toBe('applied');
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});

const get = async <T>(url: string) => {
  const res = await lib.t.app.inject({ method: 'GET', url, headers: lib.h });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return { body: res.body, json: () => res.json() as T, headers: res.headers };
};
const search = (q: string, mode: 'keyword' | 'exact' = 'keyword', types = 'chunks,notes') =>
  get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}&types=${types}`).then((r) => r.json());
const hitText = (r: SearchResponse['results'][number]) => r.snippet.highlights.map((h) => r.snippet.text.slice(h.start, h.end)).join(' ');
const stripTags = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

describe('G6 AC-20 — mixed Arabic/English text keeps its logical order', () => {
  it('the processed lecture stores the mixed Arabic line in LOGICAL order (Arabic start … «نقطة McBurney.»), no control characters', async () => {
    const page = lib.t.ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE version_id = ? AND page_index = 0', [lib.lecture.versionId])!;
    const { regions } = (await get<PageRegionsResponse>(`/api/sources/pages/${page.id}/regions`)).json();
    const ar = regions.find((r) => (r.text ?? '').includes('McBurney') && /[؀-ۿ]/.test(r.text ?? ''))!;
    expect(ar, 'the Arabic line with «McBurney»').toBeTruthy();
    const t = ar.text!;
    expect(t).toMatch(/^يبدأ الألم/); // logical start (the lam-alef defect of the PDF text layer is repaired)
    expect(t).toMatch(/عند نقطة McBurney\.?$/); // the English term where the sentence ends, then the full stop
    expect(t.indexOf('حول السرة')).toBeGreaterThan(t.indexOf('يبدأ'));
    expect(BIDI_CONTROLS.test(t)).toBe(false);
    // the units line is stored exactly as printed (no normalization of ×, ⁹, /L)
    expect(regions.some((r) => (r.text ?? '').includes('11 ×10⁹/L'))).toBe(true);
  });

  it('universal search finds the mixed phrase in reading order, highlights exactly it, and refuses the reversed order in exact mode', async () => {
    const kw = await search('نقطة McBurney');
    const hit = kw.results.find((r) => r.type === 'chunks' && r.location?.source_id === lib.lecture.sourceId);
    expect(hit, 'keyword hit in the lecture').toBeTruthy();
    expect(hit!.location!.page_label_ar).toMatch(/^ص 11/);
    expect(hitText(hit!)).toMatch(/نقطة.*McBurney/);
    const exact = await search('عند نقطة McBurney', 'exact');
    expect(exact.results.some((r) => r.location?.source_id === lib.lecture.sourceId)).toBe(true);
    const reversed = await search('McBurney عند نقطة', 'exact');
    expect(reversed.results.some((r) => r.location?.source_id === lib.lecture.sourceId && r.type === 'chunks')).toBe(false);
  });

  it('numbers with units are found as written, also typed with Arabic-Indic digits; the highlight is the logical substring', async () => {
    for (const q of ['11 ×10⁹/L', '١١ ×١٠⁹/L', '(β-hCG)']) {
      const r = await search(q);
      const hit = r.results.find((x) => x.type === 'chunks' && x.location?.source_id === lib.lecture.sourceId);
      expect(hit, q).toBeTruthy();
      expect(BIDI_CONTROLS.test(hit!.snippet.text), q).toBe(false);
    }
    const units = (await search('11 ×10⁹/L')).results.find((x) => x.type === 'chunks' && x.location?.source_id === lib.lecture.sourceId)!;
    expect(units.snippet.text).toContain('11 ×10⁹/L');
  });

  it('the owner note is stored and searched in logical order (mixed Arabic + English phrase, exact mode)', async () => {
    const row = lib.t.ctx.db.get<{ body_json: string }>('SELECT body_json FROM note WHERE id = ?', [noteId])!;
    const plain = (JSON.parse(row.body_json) as { paragraphs: Array<{ runs: Array<{ t: string }> }> }).paragraphs.map((p) => p.runs.map((x) => x.t).join('')).join('\n');
    expect(plain).toBe(NOTE);
    for (const q of ['ويرتفع CO₂', 'الصوديوم Na+ 135 mmol/L', 'والفحص (CT abdomen)', 'H. pylori']) {
      const r = await search(q, 'exact', 'notes');
      expect(r.results.some((x) => x.type === 'notes' && x.id === noteId), q).toBe(true);
    }
    // the same words in the wrong order are not an exact match
    expect((await search('CO₂ ويرتفع', 'exact', 'notes')).results.some((x) => x.id === noteId)).toBe(false);
  });

  it('HTML export: logical text, whole expressions isolated in <bdi dir="ltr"> (incl. 10⁹, CO₂, HCO₃⁻), RTL document, no control characters', async () => {
    const html = (await get(`/api/data/export/notes?source_id=${lib.lecture.sourceId}&format=html`)).body;
    expect(html).toMatch(/<html lang="ar" dir="rtl">/);
    expect(BIDI_CONTROLS.test(html)).toBe(false);
    for (const expr of ['11 ×10⁹', 'CO₂', 'HCO₃⁻', 'Na+ 135 mmol/L', '5 mg IV', 'pH 7.35', 'H. pylori', '(CT abdomen)', 'A → B → C']) {
      expect(html, expr).toContain(`<bdi dir="ltr" lang="en">${expr.replace(/&/g, '&amp;')}</bdi>`);
    }
    // nothing outside an isolate is a dangling superscript/subscript digit
    expect(stripTags(html.replace(/<bdi dir="ltr" lang="en">[^<]*<\/bdi>/g, ''))).not.toMatch(/[⁰¹²³⁴-⁹₀-₉]/);
    // taking the tags away gives back the note exactly as typed (logical order)
    expect(stripTags(html)).toContain(NOTE);

    const src = (await get(`/api/data/export/source/${lib.lecture.sourceId}?format=html`)).body;
    expect(BIDI_CONTROLS.test(src)).toBe(false);
    expect(src).toMatch(/عند نقطة <bdi dir="ltr" lang="en">McBurney<\/bdi>\./);
    expect(src).toContain('11 ×10⁹/L');
  });

  it('Markdown export keeps the logical text (only Markdown syntax escaped, no control characters)', async () => {
    const md = (await get(`/api/data/export/notes?source_id=${lib.lecture.sourceId}&format=md`)).body;
    expect(BIDI_CONTROLS.test(md)).toBe(false);
    const unescaped = md.replace(/\\([\\`*_[\]<>#|~!{}+\-=.])/g, '$1');
    expect(unescaped).toContain(NOTE);
    const src = (await get(`/api/data/export/source/${lib.lecture.sourceId}?format=md`)).body;
    expect(src.replace(/\\([\\`*_[\]<>#|~!{}+\-=.])/g, '$1')).toMatch(/عند نقطة McBurney\./);
  });
});
