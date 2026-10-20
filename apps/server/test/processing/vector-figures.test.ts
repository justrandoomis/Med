// H2 item 1 — figures DRAWN with PDF path operators (a flowchart of boxes and arrows, a bar chart), not pictures. They
// were not detected at all: their labels became ordinary paragraphs, the «Figure 2» caption stayed unlinked and the
// figure had no region, crop or image asset. Dense drawing regions (closed shapes, curves, arrowheads) are now figure
// regions with a box, their text is the figure's label set, the caption is linked as for pictures, and the status is
// `uncertain` when the drawing is not clearly a diagram. Decoration is not a figure: table grids, a frame around a
// paragraph, bullets, a header bar. Fixtures are generated in the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramStructure, FigureStructure, NormBox } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import type { TestApp } from '../helpers/app';
import { arrowDown, line, makePdf, polygon, rect, roundRect, text } from '../helpers/pdfgen';
import { addSource, createProcessingApp, processVersion, regions } from './helpers';

function flowchartPage(): string {
  let c = text(56, 780, 18, 'Imaging in suspected appendicitis', { bold: true });
  c += text(56, 750, 11, 'The pathway below summarises the first imaging steps; see Figure 2 for the order.');
  // boxes and arrows
  c += roundRect(200, 640, 200, 40, 8) + text(222, 656, 11, 'Suspected appendicitis');
  c += arrowDown(300, 640, 600);
  c += rect(200, 560, 200, 40) + text(240, 576, 11, 'Ultrasound first');
  c += arrowDown(300, 560, 520);
  c += rect(200, 480, 200, 40) + text(236, 496, 11, 'Surgical review');
  c += line(400, 580, 450, 580) + polygon([[450, 576], [450, 584], [458, 580]]) + rect(458, 560, 90, 40) + text(468, 576, 10, 'CT if unclear');
  c += text(180, 455, 10, 'Figure 2. Imaging pathway (TEST FIXTURE)');
  c += text(56, 420, 11, 'Children and pregnant women are imaged with ultrasound before any CT scan.');
  return c;
}

function decorationPage(): string {
  let c = rect(0, 800, 595, 42, 'f') + text(56, 815, 16, 'Lecture 4 - Laboratory values');
  // a paragraph framed by one stroked box
  c += rect(50, 690, 495, 80) + text(60, 750, 11, 'Important: reference ranges differ between laboratories and must be') + text(60, 735, 11, 'checked against the local report before any result is interpreted.');
  // bullets drawn as small filled circles
  for (const [i, s] of ['Haemoglobin is lower in women.', 'Platelets rise after splenectomy.', 'Sodium falls with excess water.'].entries()) {
    const y = 650 - i * 18;
    c += `${62} ${y + 3} m ${66} ${y + 3} ${66} ${y + 7} ${62} ${y + 7} c ${58} ${y + 7} ${58} ${y + 3} ${62} ${y + 3} c f\n` + text(72, y, 11, s);
  }
  // a ruled table grid
  const rows = [['Test', 'Range'], ['Haemoglobin', '13.5 - 17.5 g/dL'], ['Platelets', '150 - 400 x10^9/L'], ['Sodium', '135 - 145 mmol/L']];
  rows.forEach((r, i) => (c += text(66, 560 - i * 20, 11, r[0]!) + text(266, 560 - i * 20, 11, r[1]!)));
  for (let i = 0; i <= rows.length; i++) c += line(60, 575 - i * 20, 460, 575 - i * 20, 0.6);
  for (const x of [60, 260, 460]) c += line(x, 575, x, 575 - rows.length * 20, 0.6);
  // zebra-striped rows of another table (filled bands sharing edges)
  for (let i = 0; i < 4; i++) c += `0.9 g ${60} ${400 - i * 20} 400 20 re f 0 g\n` + text(66, 406 - i * 20, 11, `Row ${i + 1} value ${i * 3 + 2}`);
  return c;
}

function barChartPage(): string {
  let c = text(56, 780, 16, 'Admissions by month', { bold: true });
  const bars = [60, 95, 40, 120, 80];
  bars.forEach((h, i) => (c += `${0.3 + i * 0.1} g ${120 + i * 60} 560 36 ${h} re f 0 g\n` + text(124 + i * 60, 545, 9, ['Jan', 'Feb', 'Mar', 'Apr', 'May'][i]!)));
  c += line(110, 560, 420, 560) + line(110, 560, 110, 700);
  c += text(150, 520, 10, 'Figure 3. Monthly admissions (TEST FIXTURE)');
  return c;
}

let t: TestApp;
let versionId: string;
beforeAll(async () => {
  t = await createProcessingApp();
  versionId = (await addSource(t, 'vector.pdf', 'pdf', { data: makePdf([{ content: flowchartPage() }, { content: decorationPage() }, { content: barChartPage() }]), fileName: 'vector.pdf' })).versionId;
  await processVersion(t, versionId);
}, 120_000);
afterAll(async () => t?.close());

describe('figures drawn with PDF paths (H2 item 1)', () => {
  it('a flowchart of boxes and arrows is a figure region with a box; its labels are the figure, not paragraphs', () => {
    const rs = regions(t, versionId, 0);
    const figs = rs.filter((r) => r.kind === 'figure');
    expect(figs, rs.map((r) => `${r.kind}:${r.text}`).join(' / ')).toHaveLength(1);
    const fig = figs[0]!;
    const b = fromJson<NormBox>(fig.bbox_json)!;
    // the drawing spans x 200–548 pt and y 480–680 pt (top-left space: 162–362) on a 595 × 842 page
    expect(b.x).toBeGreaterThan(0.3);
    expect(b.x).toBeLessThan(0.35);
    expect(b.x + b.w).toBeGreaterThan(0.9);
    expect(b.y).toBeGreaterThan(0.18);
    expect(b.y + b.h).toBeLessThan(0.45);
    expect(fig.status).toBe('extracted'); // boxes + arrowheads: clearly a diagram
    for (const label of ['Suspected appendicitis', 'Ultrasound first', 'Surgical review', 'CT if unclear']) {
      expect(rs.some((r) => (r.kind === 'paragraph' || r.kind === 'heading') && r.text?.includes(label)), `${label} is not a paragraph`).toBe(false);
    }
    const diagram = rs.find((r) => r.kind === 'diagram' && r.parent_region_id === fig.id)!;
    const ds = fromJson<DiagramStructure>(diagram.structure_json)!;
    expect(ds.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(['Suspected appendicitis', 'Ultrasound first', 'Surgical review', 'CT if unclear']));
    expect(ds.edges).toEqual([]); // relations are never inferred without a vision reading (AC-08)
  });

  it('its caption is linked as for pictures, the paragraph naming «Figure 2» refers to it, and it has a cropped image asset', () => {
    const rs = regions(t, versionId, 0);
    const fig = rs.find((r) => r.kind === 'figure')!;
    const s = fromJson<FigureStructure>(fig.structure_json)!;
    const caption = rs.find((r) => r.id === s.caption_region_id);
    expect(caption?.text).toContain('Figure 2. Imaging pathway');
    expect(s.origin).toBe('vector');
    expect(s.referenced_by_region_ids?.length).toBeGreaterThan(0);
    const asset = t.ctx.db.get<{ file_id: string | null; caption: string | null }>('SELECT file_id, caption FROM image_asset WHERE region_id = ?', [fig.id]);
    expect(asset?.file_id).toBeTruthy();
    expect(asset?.caption).toContain('Figure 2');
  });

  it('decoration is not a figure: a header bar, a framed paragraph, drawn bullets, a ruled table, zebra rows', () => {
    const rs = regions(t, versionId, 1);
    expect(rs.filter((r) => r.kind === 'figure').map((r) => r.bbox_json)).toEqual([]);
    expect(rs.find((r) => r.kind === 'table')).toBeTruthy();
    expect(rs.some((r) => r.text?.includes('Platelets rise after splenectomy.'))).toBe(true);
  });

  it('a drawing that is not clearly a diagram (filled bars, no arrows) is a figure marked uncertain, caption linked', () => {
    const rs = regions(t, versionId, 2);
    const fig = rs.find((r) => r.kind === 'figure');
    expect(fig, rs.map((r) => `${r.kind}:${r.text}`).join(' / ')).toBeTruthy();
    expect(fig!.status).toBe('uncertain');
    const s = fromJson<FigureStructure>(fig!.structure_json)!;
    expect(rs.find((r) => r.id === s.caption_region_id)?.text).toContain('Figure 3');
  });
});
