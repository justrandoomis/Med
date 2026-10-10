// Exports (§46): Study Book with claim-level citations as text («المصدر — ص 12 (الصفحة 14 في الملف) — الإصدار 1»
// + quote), generated content labelled, no fake links, RTL + bidi-isolated HTML for printing to PDF, JSON with a
// manifest of ids / versions / hashes, questions with and without solutions, notes, and no secrets anywhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportFormatsResponse, ExportManifest, StudyArtifactView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { mdEscape, richTextToHtml } from '../../src/modules/data/render';
import { dataLibrary, getJson, pageAnchor, push, writeOwnerData, type DataLib, type OwnerData } from './helpers';

let lib: DataLib;
let owner: OwnerData;

beforeAll(async () => {
  lib = await dataLibrary();
  owner = await writeOwnerData(lib, { attempt: false });
  // an AI answer saved as a note and a note with hostile markup
  await push(lib, [
    {
      entity_type: 'note',
      entity_id: newId(),
      op: 'upsert',
      payload: {
        title: '<script>alert(1)</script>',
        body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'رابط [اضغط](http://evil.example) و <img src=x onerror=alert(1)> و CT abdomen' }] }] },
        anchor: pageAnchor(lib, 0),
        origin: 'owner',
      },
    },
  ]);
}, 240_000);
afterAll(async () => {
  await lib?.t.close();
});

const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩؜]/;

describe('export: Study Book (generated, cited)', () => {
  it('Markdown: generated label, citations as «source — page label — version» + quote, no links', async () => {
    const id = owner.book!.artifact.id;
    const r = await getJson<null>(lib, `/api/data/export/artifact/${id}?format=md`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/markdown');
    expect(String(r.headers['content-disposition'])).toContain('attachment');
    const md = r.raw;
    expect(md).toContain('محتوى مولَّد بواسطة MedLevo');
    expect(md).toMatch(/\[\^1\]/);
    // «Acute Appendicitis (TEST FIXTURE) — ص 11 … — الإصدار 1: «quote»»
    expect(md).toMatch(/\n\[\^1\]: Acute Appendicitis \(TEST FIXTURE\) — ص \d+( \(الصفحة \d+ في الملف\))? — الإصدار 1: «.+»/);
    expect(md).not.toMatch(/https?:\/\//);
    expect(md).not.toContain('/api/');
    expect(BIDI_CONTROLS.test(md)).toBe(false);
    // the cited quote is the evidence text, verbatim
    const view = (await getJson<{ artifact: StudyArtifactView }>(lib, `/api/studybook/artifacts/${id}`)).body.artifact;
    const firstEvidence = Object.values(view.claims).flatMap((c) => c.citations)[0]!.evidence;
    expect(md).toContain(mdEscape(firstEvidence.quote));
  });

  it('HTML: RTL document, English runs isolated with <bdi dir="ltr">, escaped, no scripts, honest PDF note', async () => {
    const r = await getJson<null>(lib, `/api/data/export/artifact/${owner.book!.artifact.id}?format=html`);
    expect(r.status).toBe(200);
    const html = r.raw;
    expect(html).toMatch(/^<!doctype html>\n<html lang="ar" dir="rtl">/);
    expect(html).toContain('<bdi dir="ltr" lang="en">');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link /i);
    // the document locks itself down wherever it is opened (saved file or the app's same-origin print window)
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`);
    expect(html).toContain('PDF عبر الطباعة من المتصفح');
    expect(html).toContain('class="label generated"');
    expect(html).toContain('<sup class="cite">[1]</sup>');
    expect(BIDI_CONTROLS.test(html)).toBe(false);
  });

  it('JSON: the artifact + manifest of ids, versions and sha256 hashes; labelled generated', async () => {
    const r = await getJson<{ manifest: ExportManifest; generated: boolean; artifact: StudyArtifactView }>(lib, `/api/data/export/artifact/${owner.book!.artifact.id}?format=json`);
    expect(r.body.generated).toBe(true);
    expect(r.body.manifest).toMatchObject({ format: 'medlevo-export-1', kind: 'artifact' });
    expect(r.body.manifest.entities[0]).toMatchObject({ type: 'artifact', id: owner.book!.artifact.id, version: 1 });
    expect(r.body.manifest.entities.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
    expect(r.body.manifest.entities.some((e) => e.type === 'evidence')).toBe(true);
  });

  it('unknown artifact → 404; bad format → 400; no session → 401', async () => {
    expect((await getJson(lib, `/api/data/export/artifact/${newId()}?format=md`)).status).toBe(404);
    expect((await getJson(lib, `/api/data/export/artifact/${owner.book!.artifact.id}?format=pdf`)).status).toBe(400);
    expect((await lib.t.app.inject({ method: 'GET', url: `/api/data/export/artifact/${owner.book!.artifact.id}?format=md` })).statusCode).toBe(401);
  });
});

describe('export: source, notes, questions, all', () => {
  it('source Markdown/HTML: page by page with «ص N (الصفحة M في الملف)» labels, highlights and notes; JSON manifest with file hashes', async () => {
    const md = (await getJson<null>(lib, `/api/data/export/source/${lib.lecture.sourceId}?format=md`)).raw;
    expect(md).toMatch(/## ص 11( \(الصفحة 1 في الملف\))?/);
    expect(md).toContain('تمييزي: «Murphy sign»');
    expect(md).toContain('ملاحظاتي على هذا المصدر');
    expect(md).toContain('لا تُصدَّر الكتابة بالقلم (1 عنصر)');
    const html = (await getJson<null>(lib, `/api/data/export/source/${lib.lecture.sourceId}?format=html`)).raw;
    expect(html).toContain('dir="rtl"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<img/i);
    const json = (await getJson<{ manifest: ExportManifest; annotations: Array<{ id: string; kind: string }> }>(lib, `/api/data/export/source/${lib.lecture.sourceId}?format=json`)).body;
    const pdfHash = lib.t.ctx.db.get<{ sha256: string }>('SELECT s.sha256 FROM stored_file s JOIN source_version v ON v.file_id = s.id WHERE v.id = ?', [lib.lecture.versionId])!.sha256;
    expect(json.manifest.files.find((f) => f.role === 'version_file')!.sha256).toBe(pdfHash);
    expect(json.annotations.map((a) => a.id).sort()).toEqual([owner.inkId, owner.highlightId].sort());
    expect(json.manifest.entities.filter((e) => e.type === 'source_page').length).toBe(lib.lecture.pageIds.length);
  });

  it('notes: hostile text is escaped in Markdown (no link / HTML) and HTML; terms isolated', async () => {
    const md = (await getJson<null>(lib, `/api/data/export/notes?source_id=${lib.lecture.sourceId}&format=md`)).raw;
    expect(md).toContain('\\[اضغط\\](http://evil.example)');
    expect(md).not.toMatch(/(^|[^\\])\[اضغط\]\(/);
    expect(md).toContain('\\<img src=x onerror=alert(1)\\>');
    const html = (await getJson<null>(lib, `/api/data/export/notes?source_id=${lib.lecture.sourceId}&format=html`)).raw;
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)</bdi>&gt;');
    expect(html).toContain('<bdi dir="ltr" lang="en">CT abdomen</bdi>');
  });

  it('questions: with solutions shows who stands behind the key; without solutions hides keys in every format', async () => {
    const withSol = (await getJson<null>(lib, `/api/data/export/questions?source_id=${lib.questions.sourceId}&format=md&include_solutions=1`)).raw;
    expect(withSol).toContain('يتضمن هذا الملف الحلول');
    expect(withSol).toMatch(/\*\*الإجابة:\*\* (مفتاح المصدر|لا يوجد مفتاح|مفتاح متعارض|مفتاح حددته بنفسي)/);
    expect(withSol).toContain('سؤال من مصدر الأسئلة');
    const noSol = (await getJson<null>(lib, `/api/data/export/questions?source_id=${lib.questions.sourceId}&format=md&include_solutions=0`)).raw;
    expect(noSol).toContain('دون حلول');
    expect(noSol).not.toContain('**الإجابة:**');
    expect(noSol).not.toContain('✓');
    const json = (await getJson<{ contains_solutions: boolean; questions: Array<{ question: { current: { correct_option_ids: unknown } }; key_entries: unknown[]; review_items: unknown[] }> }>(
      lib,
      `/api/data/export/questions?source_id=${lib.questions.sourceId}&format=json&include_solutions=0`,
    )).body;
    expect(json.contains_solutions).toBe(false);
    expect(json.questions.length).toBeGreaterThan(0);
    expect(json.questions.every((q) => q.question.current.correct_option_ids === null && q.key_entries.length === 0)).toBe(true);
    // review items can quote the key (a key conflict): they travel only with the solutions
    expect(json.questions.every((q) => Array.isArray(q.review_items) && q.review_items.length === 0)).toBe(true);
  });

  it('full JSON export: owner content with a manifest, never secrets', async () => {
    // a secret VALUE under an innocent key is dropped too (same rule as the backup)
    lib.t.ctx.db.run(`INSERT OR REPLACE INTO owner_setting (key, value_json, updated_at) VALUES ('integration.note', '"sk-ant-api03-VALUE-ONLY-SECRET"', 1)`);
    const r = await getJson<{ manifest: ExportManifest; data: Record<string, unknown[]> }>(lib, '/api/data/export/all?format=json');
    expect(r.status).toBe(200);
    expect(r.body.manifest.kind).toBe('all');
    expect(r.body.data.annotation!.length).toBe(2);
    expect(r.body.data.question!.length).toBeGreaterThan(0);
    expect(r.body.manifest.files.length).toBe(lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n);
    const raw = r.raw;
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('recovery_codes');
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain(lib.t.ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM owner')!.password_hash);
    expect(raw).not.toContain('sk-ant-api03-VALUE-ONLY-SECRET');
    lib.t.ctx.db.run(`DELETE FROM owner_setting WHERE key = 'integration.note'`);
  });

  it('formats endpoint says PDF is via browser printing and names other formats honestly', async () => {
    const f = (await getJson<ExportFormatsResponse>(lib, '/api/data/export/formats')).body;
    expect(f.pdf_note_ar).toContain('PDF عبر الطباعة من المتصفح');
    // (track F5) DOCX is a real format now (test/data/docx-export.test.ts); no longer listed as «not built»
    expect(f.formats.map((x) => x.format)).toEqual(['md', 'html', 'json', 'docx']);
    expect(f.other.some((o) => o.key === 'export.docx')).toBe(false);
  });

  it('render: a run that is LTR inside an RTL paragraph is isolated; marks kept; no controls inserted', () => {
    const html = richTextToHtml({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'الجرعة ' }, { t: '5 mg IV', dir: 'ltr', kind: 'unit' }, { t: ' مهمة', marks: ['b'] }] }] });
    expect(html).toBe('<p dir="rtl" lang="ar">الجرعة <bdi dir="ltr" lang="en">5 mg IV</bdi><b> مهمة</b></p>');
  });
});
