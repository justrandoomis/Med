// H2 item 5 — a page whose /Rotate turns UPRIGHT content sideways (the PDF draws its text horizontally in user space,
// then /Rotate 90 shows it rotated). Layout used to run in display space, where that text is vertical: lines were
// stored item by item, reading order scrambled, headings and the repeated footer missed (seen in G6 / AC-21:
// «the McBurney line becomes 6 regions»). Layout now runs in the orientation where the text is horizontal (from the
// text matrices), so the page gives the same regions as the same content without /Rotate; boxes stay in the
// unrotated page box. Fixture built in the test (two pages, /Rotate 90 and none).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormBox } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import type { TestApp } from '../helpers/app';
import { makePdf, text, type GenPage } from '../helpers/pdfgen';
import { addSource, createProcessingApp, processVersion, regions } from './helpers';

function lecturePage(rotate: 0 | 90 | 270, n: number): GenPage {
  let c = text(56, 760, 18, 'Acute Appendicitis: Clinical Features', { bold: true });
  const p1 = [
    'Pain typically starts around the umbilicus and migrates to the right',
    'iliac fossa within twenty-four hours. Anorexia and nausea are common,',
    'and a low-grade fever is usual in the first day of the illness.',
  ];
  p1.forEach((l, i) => (c += text(56, 725 - i * 15, 11, l)));
  c += text(56, 668, 14, 'Examination', { bold: true });
  const p2 = ["Tenderness at McBurney's point with rebound and guarding suggests", 'local peritonitis; Rovsing sign may be positive on palpation.'];
  p2.forEach((l, i) => (c += text(56, 645 - i * 15, 11, l)));
  c += text(56, 40, 9, 'Surgery Notes - TEST FIXTURE, synthetic document') + text(520, 40, 9, String(n));
  return { content: c, rotate };
}

let t: TestApp;
let upright: string;
let sideways: string;
let sideways270: string;

beforeAll(async () => {
  t = await createProcessingApp();
  upright = (await addSource(t, 'upright.pdf', 'pdf', { data: makePdf([lecturePage(0, 1), lecturePage(0, 2)]), fileName: 'upright.pdf' })).versionId;
  sideways = (await addSource(t, 'sideways.pdf', 'pdf', { data: makePdf([lecturePage(90, 1), lecturePage(90, 2)]), fileName: 'sideways.pdf' })).versionId;
  sideways270 = (await addSource(t, 'sideways270.pdf', 'pdf', { data: makePdf([lecturePage(270, 1), lecturePage(270, 2)]), fileName: 'sideways270.pdf' })).versionId;
  for (const v of [upright, sideways, sideways270]) await processVersion(t, v);
}, 120_000);
afterAll(async () => t?.close());

const key = (vid: string) => regions(t, vid).map((r) => `${r.page_index}|${r.kind}|${r.reading_order}|${r.status}|${r.text}`);

describe('a /Rotate page holding upright text is laid out where its text is horizontal (H2 item 5)', () => {
  it('whole lines, paragraphs, headings and reading order — the same regions as without /Rotate', () => {
    const rs = regions(t, sideways, 0);
    const heading = rs.find((r) => r.text === 'Acute Appendicitis: Clinical Features');
    expect(heading?.kind).toBe('heading');
    expect(rs.find((r) => r.text === 'Examination')?.kind).toBe('heading');
    const para = rs.find((r) => r.text?.startsWith('Pain typically starts'))!;
    expect(para.kind).toBe('paragraph');
    expect(para.text).toContain('migrates to the right iliac fossa within twenty-four hours');
    expect(rs.find((r) => r.text?.includes("McBurney's point"))!.text).toContain('local peritonitis; Rovsing sign');
    const order = rs.filter((r) => r.kind !== 'footer').map((r) => (r.text ?? '').slice(0, 12));
    expect(order).toEqual(['Acute Append', 'Pain typical', 'Examination', "Tenderness a"]);
    expect(key(sideways)).toEqual(key(upright));
    expect(key(sideways270)).toEqual(key(upright));
  });

  it('the repeated footer and the page number are recognised in the bands of the turned page', () => {
    for (const p of [0, 1]) {
      const footers = regions(t, sideways, p).filter((r) => r.kind === 'footer').map((r) => r.text);
      expect(footers, `page ${p}`).toEqual(expect.arrayContaining(['Surgery Notes - TEST FIXTURE, synthetic document']));
    }
  });

  it('boxes stay in the unrotated page box (where the text is drawn), and the turn is stored with its origin', () => {
    const a = regions(t, upright, 0);
    const b = regions(t, sideways, 0);
    for (let i = 0; i < a.length; i++) {
      const x = fromJson<NormBox>(a[i]!.bbox_json)!;
      const y = fromJson<NormBox>(b[i]!.bbox_json)!;
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(Math.abs(x[k] - y[k]), `${a[i]!.text} ${k}`).toBeLessThan(0.003);
    }
    const page = t.ctx.db.get<{ rotation: number; content_rotation: number; content_rotation_origin: string }>(
      'SELECT rotation, content_rotation, content_rotation_origin FROM source_page WHERE version_id = ? AND page_index = 0',
      [sideways],
    )!;
    expect(page).toEqual({ rotation: 90, content_rotation: 270, content_rotation_origin: 'text_direction' });
    const plain = t.ctx.db.get<{ content_rotation: number }>('SELECT content_rotation FROM source_page WHERE version_id = ? AND page_index = 0', [upright])!;
    expect(plain.content_rotation).toBe(0);
  });
});
