// H2 item 2 — tables on SCANNED pages. tesseract reads every cell of a ruled table as its own text line, and the layout
// trusted those line ids: a 5 × 3 drug table became 15 one-word paragraphs in column order («Drug, Amoxicillin, …,
// Usual adult dose, …»). Row bands now join OCR lines that sit side by side on one baseline, so the cells form rows and
// the column alignment builds the TableStructure. A table read from a picture is never presented as certain: its grid
// is inferred from word positions (structure method `ocr_aligned`, certainty `uncertain`, region `uncertain`), weak
// cells are flagged, and no cell is invented (an empty cell stays empty, every cell text comes from OCR words).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableStructure } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import type { TestApp } from '../helpers/app';
import { line, makePdf, renderPng, text } from '../helpers/pdfgen';
import { addSource, createProcessingApp, processVersion, regions, type RegionRow } from './helpers';

const ROWS = [
  ['Drug', 'Usual adult dose', 'Main adverse effect'],
  ['Amoxicillin', '500 mg every 8 hours', 'Rash'],
  ['Metronidazole', '400 mg every 8 hours', 'Metallic taste'],
  ['Ciprofloxacin', '500 mg every 12 hours', ''],
  ['Doxycycline', '100 mg daily', 'Photosensitivity'],
];

function tablePage(grid: boolean): Buffer {
  let c = text(40, 370, 14, 'Antibiotic doses', { bold: true }) + text(40, 350, 11, 'The table below lists usual adult doses for common infections in this course.');
  ROWS.forEach((r, i) => {
    const y = 315 - i * 24;
    c += text(48, y, 11, r[0]!) + text(210, y, 11, r[1]!) + (r[2] ? text(400, y, 11, r[2]) : '');
  });
  if (grid) {
    for (let i = 0; i <= ROWS.length; i++) c += line(40, 331 - i * 24, 560, 331 - i * 24, 0.8);
    for (const x of [40, 200, 390, 560]) c += line(x, 331, x, 331 - ROWS.length * 24, 0.8);
  }
  c += text(40, 170, 11, 'Doses must be adjusted in renal impairment and in children by weight.');
  return makePdf([{ content: c, width: 600, height: 400 }]);
}

function proseColumns(): Buffer {
  const left = ['Acute appendicitis presents with', 'periumbilical pain that migrates', 'to the right iliac fossa within', 'a day; anorexia is usual.'];
  const right = ['Ultrasound is preferred in children', 'and in pregnancy; CT is used in', 'adults when the diagnosis is', 'uncertain after examination.'];
  let c = '';
  left.forEach((l, i) => (c += text(40, 330 - i * 16, 11, l)));
  right.forEach((l, i) => (c += text(320, 330 - i * 16, 11, l)));
  return makePdf([{ content: c, width: 600, height: 400 }]);
}

let t: TestApp;
const v: Record<string, string> = {};

beforeAll(async () => {
  t = await createProcessingApp();
  for (const [name, pdf] of [
    ['ruled', tablePage(true)],
    ['borderless', tablePage(false)],
    ['prose', proseColumns()],
  ] as const) {
    v[name] = (await addSource(t, `${name}.png`, 'image', { data: await renderPng(pdf, 1, 200), fileName: `${name}.png` })).versionId;
    await processVersion(t, v[name]!);
  }
}, 240_000);
afterAll(async () => t?.close());

const tableOf = (rs: RegionRow[]) => rs.find((r) => r.kind === 'table');
const grid = (s: TableStructure) => Array.from({ length: s.rows }, (_, r) => Array.from({ length: s.cols }, (_, c) => s.cells.find((x) => x.r === r && x.c === c)?.text ?? ''));

describe('tables on scanned pages (H2 item 2)', () => {
  for (const name of ['ruled', 'borderless']) {
    it(`${name}: rows and columns from the OCR word boxes, read in the right order, honestly uncertain`, () => {
      const rs = regions(t, v[name]!);
      const table = tableOf(rs);
      expect(table, `${name}: ${rs.map((r) => `${r.kind}:${r.text}`).join(' / ')}`).toBeTruthy();
      const s = fromJson<TableStructure>(table!.structure_json)!;
      expect([s.rows, s.cols]).toEqual([5, 3]);
      const g = grid(s);
      expect(g[0]).toEqual(['Drug', 'Usual adult dose', 'Main adverse effect']);
      expect(g[1]).toEqual(['Amoxicillin', '500 mg every 8 hours', 'Rash']);
      expect(g[2]).toEqual(['Metronidazole', '400 mg every 8 hours', 'Metallic taste']);
      // the empty cell stays empty: nothing is invented
      expect(g[3]).toEqual(['Ciprofloxacin', '500 mg every 12 hours', '']);
      expect(rs.filter((r) => r.kind === 'table_cell').map((r) => r.text)).not.toContain('');
      // a grid inferred from a picture is never presented as certain
      expect(s.method).toBe('ocr_aligned');
      expect(s.certainty).toBe('uncertain');
      expect(table!.status).toBe('uncertain');
      // no cell text left behind as a loose paragraph; prose before and after keeps its place
      const paras = rs.filter((r) => r.kind === 'paragraph' || r.kind === 'heading').map((r) => r.text);
      expect(paras.some((p) => p === 'Amoxicillin' || p === 'Rash' || p === 'Drug')).toBe(false);
      const order = rs.filter((r) => r.kind !== 'table_cell').map((r) => r.text?.slice(0, 14));
      expect(order.indexOf('The table belo')).toBeLessThan(order.indexOf(table!.text!.slice(0, 14)));
      expect(order.indexOf(table!.text!.slice(0, 14))).toBeLessThan(order.indexOf('Doses must be '));
    });
  }

  it('two columns of prose on a scan are not a table (and keep their own reading order)', () => {
    const rs = regions(t, v.prose!);
    expect(tableOf(rs)).toBeUndefined();
    const texts = rs.map((r) => r.text ?? '');
    expect(texts.some((x) => x.includes('periumbilical pain that migrates to the right iliac fossa'))).toBe(true);
    expect(texts.some((x) => x.includes('Ultrasound is preferred in children and in pregnancy'))).toBe(true);
  });
});
