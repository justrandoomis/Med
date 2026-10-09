// Golden Set (§57): every fixture goes through the REAL pipeline (pdfjs, poppler, tesseract.js, mammoth,
// jszip, LibreOffice when installed) and the result is checked against fixtures/golden/expected.json.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiagramStructure, FigureStructure, TableStructure } from '@medlevo/shared';
import { normalizeForSearch } from '@medlevo/shared';
import { fromJson } from '../../src/db/db';
import { findExecutable } from '../../src/modules/processing/tools';
import type { TestApp } from '../helpers/app';
import { addSource, type AddedSource, createProcessingApp, expected, pages, pageText, processVersion, regions } from './helpers';

const HAS_PDFTOPPM = findExecutable('pdftoppm') !== null;
const HAS_SOFFICE = (findExecutable('soffice') ?? findExecutable('libreoffice')) !== null;

let t: TestApp;
const v: Record<string, AddedSource & { jobStatus: string }> = {};

const FIXTURES: Array<[string, 'pdf' | 'docx' | 'pptx' | 'image' | 'image_set', string?]> = [
  ['lecture_appendicitis.pdf', 'pdf'],
  ['lecture_cholecystitis.pdf', 'pdf'],
  ['mixed_scanned_lecture.pdf', 'pdf'],
  ['questions_surgery_course1.pdf', 'pdf', 'question_source'],
  ['questions_previous_exam_2024.pdf', 'pdf', 'previous_exam'],
  ['question_photo_circled.png', 'image', 'question_source'],
  ['low_quality_scan.png', 'image'],
  ['scanned_page.png', 'image'],
  ['lecture_notes_shock.docx', 'docx', 'my_notes'],
  ['slides_shock.pptx', 'pptx'],
  ['histology_images.zip', 'image_set', 'image_atlas'],
];

beforeAll(async () => {
  t = await createProcessingApp();
  for (const [file, format, sourceType] of FIXTURES) {
    const added = await addSource(t, file, format, sourceType ? { sourceType } : {});
    const job = await processVersion(t, added.versionId);
    v[file] = { ...added, jobStatus: job.status };
  }
}, 240_000);

afterAll(async () => {
  await t?.close();
});

const norm = (s: string) => normalizeForSearch(s).replace(/\s+/g, ' ');

describe('Golden Set — lecture_appendicitis.pdf', () => {
  const file = 'lecture_appendicitis.pdf';
  const exp = () => expected[file];

  it('page count, /PageLabels printed labels 11–14 (AC-04) and no OCR needed', () => {
    const ps = pages(t, v[file]!.versionId);
    expect(ps).toHaveLength(exp().page_count);
    expect(ps.map((p) => p.printed_label)).toEqual(exp().printed_labels);
    expect(ps.every((p) => p.printed_label_origin === 'pdf_page_labels')).toBe(true);
    expect(ps.every((p) => p.unit === 'pt' && p.width! > 590 && p.height! > 840)).toBe(true);
    expect(ps.filter((p) => p.text_status === 'ocr' || p.text_status === 'mixed').map((p) => p.page_index)).toEqual(exp().pages_need_ocr);
  });

  it('contains the expected text on each page', () => {
    for (const [idx, needles] of Object.entries(exp().must_contain as Record<string, string[]>)) {
      const text = pageText(t, v[file]!.versionId, Number(idx));
      for (const n of needles) expect(text, `page ${idx} must contain «${n}»`).toContain(n);
    }
  });

  it('repairs the reversed lam-alef ligature (never stores «األلم») and keeps the Arabic text', () => {
    for (const [idx, needles] of Object.entries(exp().arabic_must_contain as Record<string, string[]>)) {
      const text = pageText(t, v[file]!.versionId, Number(idx));
      for (const n of needles) expect(text, `page ${idx} must contain «${n}»`).toContain(n);
    }
    const all = regions(t, v[file]!.versionId).map((r) => r.text ?? '').join('\n');
    expect(all).not.toContain('األلم');
    expect(all).not.toContain('اإلنجاب');
    expect(all).toContain('سن الإنجاب');
  });

  it('flags the stray Latin «S» (tanween mapped by the font) for review instead of passing silently', () => {
    const flagged = regions(t, v[file]!.versionId, 0).find((r) => r.text?.includes('عادةS'));
    expect(flagged).toBeDefined();
    expect(flagged!.status).toBe('needs_review');
    const item = t.ctx.db.get<{ kind: string; reason: string; entity_type: string }>(
      `SELECT kind, reason, entity_type FROM review_queue_item WHERE entity_id = ?`,
      [flagged!.id],
    );
    expect(item?.kind).toBe('ocr_error');
    expect(item?.entity_type).toBe('source_region');
    expect(item?.reason).toContain('«S»');
    expect(pages(t, v[file]!.versionId)[0]!.processing_status).toBe('needs_review');
  });

  it('reads the two-column page in column order', () => {
    const rs = regions(t, v[file]!.versionId, exp().two_column_page_index);
    const order = (exp().reading_order_page_1 as string[]).map((needle) => rs.findIndex((r) => r.text?.includes(needle)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the table structure: merged header row spanning every column, ≥ 10 rows, units verbatim', () => {
    const spec = exp().tables[0];
    const table = regions(t, v[file]!.versionId, spec.page_index).find((r) => r.kind === 'table');
    expect(table).toBeDefined();
    const s = fromJson<TableStructure>(table!.structure_json)!;
    expect(s.type).toBe('table');
    expect(s.rows).toBeGreaterThanOrEqual(spec.min_rows);
    expect(s.cols).toBe(3);
    const merged = s.cells.find((c) => c.text.includes(spec.merged_header));
    expect(merged).toBeDefined();
    expect(merged!.colspan).toBe(s.cols);
    expect(merged!.header).toBe(true);
    expect(merged!.r).toBe(0);
    const header = s.cells.filter((c) => c.r === 1).map((c) => c.text);
    expect(header).toEqual(['Feature', 'Points', 'Unit / threshold']);
    expect(s.cells.filter((c) => c.r === 1).every((c) => c.header)).toBe(true);
    const leuko = s.cells.find((c) => c.text === 'Leukocytosis')!;
    const unit = s.cells.find((c) => c.r === leuko.r && c.c === 2)!;
    expect(unit.text).toBe('> 10 ×10⁹/L');
    expect(s.cells.find((c) => c.r === leuko.r && c.c === 1)!.text).toBe('2');
    // caption linked; table cells are individually citable regions
    const caption = regions(t, v[file]!.versionId, spec.page_index).find((r) => r.id === s.caption_region_id);
    expect(caption?.text).toMatch(/^Table 1/);
    const cells = regions(t, v[file]!.versionId, spec.page_index).filter((r) => r.kind === 'table_cell' && r.parent_region_id === table!.id);
    // 1 merged title cell + 3 column headers + 8 data rows × 3 columns
    expect(cells.length).toBe(s.cells.filter((c) => c.text.trim()).length);
    expect(cells.length).toBe(1 + 3 + 8 * 3);
    // the table chunk carries the header context
    const chunk = t.ctx.db.get<{ text: string }>(`SELECT text FROM document_chunk WHERE version_id = ? AND kind = 'table'`, [v[file]!.versionId]);
    expect(chunk?.text).toContain('Unit / threshold: > 10 ×10⁹/L');
  });

  it('links the figure to its caption and to the paragraph that references it; labels stay uncertain (AC-08)', () => {
    const spec = exp().figures[0];
    const rs = regions(t, v[file]!.versionId, spec.page_index);
    const fig = rs.find((r) => r.kind === 'figure');
    expect(fig).toBeDefined();
    const s = fromJson<FigureStructure>(fig!.structure_json)!;
    const caption = rs.find((r) => r.id === s.caption_region_id);
    expect(caption?.kind).toBe('caption');
    expect(caption?.text).toContain(spec.caption_contains);
    const ref = rs.find((r) => r.text?.startsWith('As shown in Figure 1'));
    expect(s.referenced_by_region_ids).toContain(ref!.id);
    const asset = t.ctx.db.get<{ id: string; file_id: string | null; caption_region_id: string; origin: string; image_kind: string }>(
      'SELECT id, file_id, caption_region_id, origin, image_kind FROM image_asset WHERE region_id = ?',
      [fig!.id],
    );
    expect(asset?.origin).toBe('source');
    expect(asset?.caption_region_id).toBe(caption!.id);
    expect(s.image_asset_id).toBe(asset!.id);
    if (HAS_PDFTOPPM) {
      expect(asset?.file_id).toBeTruthy();
      expect(t.ctx.files.stat(asset!.file_id!)?.mime).toBe('image/png');
      const diagram = rs.find((r) => r.kind === 'diagram' && r.parent_region_id === fig!.id);
      expect(diagram).toBeDefined();
      expect(diagram!.status).toBe('uncertain');
      const d = fromJson<DiagramStructure>(diagram!.structure_json)!;
      expect(d.understanding).toBe('labels_ocr_only');
      expect(d.edges).toEqual([]); // relations are never invented without vision
      expect(d.nodes.length).toBeGreaterThan(0);
      expect(d.nodes.every((n) => n.certainty === 'uncertain')).toBe(true);
      expect(d.nodes.map((n) => n.label).join(' ')).toMatch(/Suspected appendicitis/i);
    }
  });

  it('classifies repeated header/footer bands and keeps them out of chunks', () => {
    const rs = regions(t, v[file]!.versionId);
    expect(rs.filter((r) => r.kind === 'header')).toHaveLength(4);
    expect(rs.filter((r) => r.kind === 'footer').map((r) => r.text)).toEqual(['11', '12', '13', '14']);
    const chunks = t.ctx.db.all<{ text: string; prev_chunk_id: string | null; next_chunk_id: string | null; index_version: string; heading_path: string | null }>(
      'SELECT text, prev_chunk_id, next_chunk_id, index_version, heading_path FROM document_chunk WHERE version_id = ?',
      [v[file]!.versionId],
    );
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.some((c) => c.text.includes('Surgery · Course 1 · Lecture 3'))).toBe(false);
    expect(chunks.every((c) => c.index_version === 'chunk-v1')).toBe(true);
    expect(chunks.filter((c) => c.prev_chunk_id === null)).toHaveLength(1);
    expect(chunks.filter((c) => c.next_chunk_id === null)).toHaveLength(1);
    expect(chunks.some((c) => c.heading_path?.includes('Clinical presentation'))).toBe(true);
  });

  it('writes a real summary and status (needs_review because one region needs review) and suggests the lecture kind', () => {
    const row = t.ctx.db.get<{ processing_status: string; processing_summary_json: string; display_file_id: string | null; file_id: string; page_count: number }>(
      'SELECT processing_status, processing_summary_json, display_file_id, file_id, page_count FROM source_version WHERE id = ?',
      [v[file]!.versionId],
    )!;
    expect(row.processing_status).toBe('needs_review');
    expect(row.display_file_id).toBe(row.file_id);
    expect(row.page_count).toBe(4);
    const summary = JSON.parse(row.processing_summary_json);
    expect(summary).toMatchObject({ stage: 'done', pages_total: 4, pages_ready: 3, pages_needs_review: 1, pages_failed: 0, coverage_complete: false });
    const src = t.ctx.db.get<{ processing_status: string; lecture_kind: string | null; lecture_kind_origin: string | null }>(
      'SELECT processing_status, lecture_kind, lecture_kind_origin FROM source WHERE id = ?',
      [v[file]!.sourceId],
    )!;
    expect(src.processing_status).toBe('needs_review');
    expect(src.lecture_kind).toBe('clinical');
    expect(src.lecture_kind_origin).toBe('auto');
    const suggestion = t.ctx.db.get<{ details_json: string }>(
      `SELECT details_json FROM review_queue_item WHERE kind = 'classification_suggestion' AND entity_id = ?`,
      [v[file]!.sourceId],
    );
    expect(JSON.parse(suggestion!.details_json).reasons_ar.join(' ')).toContain('diagnosis');
  });
});

describe('Golden Set — lecture_cholecystitis.pdf', () => {
  const file = 'lecture_cholecystitis.pdf';
  it('detects printed page numbers 31–32 from the footer with a cross-page consistency check', () => {
    const ps = pages(t, v[file]!.versionId);
    expect(ps).toHaveLength(expected[file].page_count);
    expect(ps.map((p) => p.printed_label)).toEqual(expected[file].printed_labels);
    expect(ps.every((p) => p.printed_label_origin === expected[file].printed_label_origin)).toBe(true);
  });

  it('repairs lam-alef after a proclitic and flags the stray Latin letter from the damma', () => {
    const text = pageText(t, v[file]!.versionId, 1);
    expect(text).toContain('بالأمواج فوق الصوتية الفحص الأولي');
    const flagged = regions(t, v[file]!.versionId, 1).find((r) => /[A-Za-z]عد/.test(r.text ?? ''));
    expect(flagged?.status).toBe('needs_review');
  });
});

describe('Golden Set — mixed_scanned_lecture.pdf (AC-02)', () => {
  const file = 'mixed_scanned_lecture.pdf';
  it.skipIf(!HAS_PDFTOPPM)('OCRs the image-only page instead of treating it as empty; digital pages keep their text layer', () => {
    const ps = pages(t, v[file]!.versionId);
    expect(ps).toHaveLength(expected[file].page_count);
    for (const i of expected[file].pages_need_ocr as number[]) {
      expect(ps[i]!.text_status).toBe('ocr');
      expect(ps[i]!.render_file_id).toBeTruthy();
      expect(ps[i]!.ocr_confidence).toBeGreaterThan(0.6);
      const text = pageText(t, v[file]!.versionId, i).toLowerCase();
      for (const n of expected[file].ocr_must_contain[String(i)] as string[]) expect(text).toContain(n.toLowerCase());
      const rs = regions(t, v[file]!.versionId, i);
      expect(rs.every((r) => r.kind === 'header' || r.kind === 'footer' || r.text_origin === 'ocr' || r.text_origin === null)).toBe(true);
      // Arabic OCR line in logical order, no bidi marks
      const arabic = rs.find((r) => r.text?.includes('جرثومة'));
      expect(arabic?.text).toBe('جرثومة H. pylori سبب شائع لقرحة المعدة.');
      expect(rs.some((r) => /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(r.text ?? ''))).toBe(false);
    }
    for (const i of expected[file].digital_pages as number[]) expect(ps[i]!.text_status).toBe('digital');
    const summary = JSON.parse(t.ctx.db.get<{ s: string }>('SELECT processing_summary_json AS s FROM source_version WHERE id = ?', [v[file]!.versionId])!.s);
    expect(summary.pages_ocr).toBe(1);
  });
});

describe('Golden Set — question sources keep negations, numbers and units verbatim', () => {
  it('questions_surgery_course1.pdf', () => {
    const all = regions(t, v['questions_surgery_course1.pdf']!.versionId).map((r) => r.text ?? '').join('\n');
    expect(all).toContain('11.5 ×10⁹/L');
    expect(all).toContain('NOT typically part of the Alvarado score');
    expect(all).toContain('EXCEPT');
    expect(all).toContain('ما هو الفحص الأولي المفضل عند الشك بحصى المرارة؟');
    expect(all).toContain('Section A');
    expect(all).toContain('Section B');
  });
  it('questions_previous_exam_2024.pdf', () => {
    const all = regions(t, v['questions_previous_exam_2024.pdf']!.versionId).map((r) => r.text ?? '').join('\n');
    for (const n of expected['questions_previous_exam_2024.pdf'].questions[2].must_contain as string[]) expect(all).toContain(n);
  });
});

describe('Golden Set — images', () => {
  it('question_photo_circled.png: OCR text; the hand-marked option is low-confidence → review', () => {
    const vid = v['question_photo_circled.png']!.versionId;
    const ps = pages(t, vid);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.kind).toBe('image');
    expect(ps[0]!.text_status).toBe('ocr');
    const rs = regions(t, vid);
    expect(rs.map((r) => r.text).join('\n')).toContain('Which investigation is first-line for suspected gallstones?');
    expect(rs.every((r) => (r.locator_json ?? '').includes('question_photo_circled.png'))).toBe(true);
    expect(rs.some((r) => r.status === 'needs_review')).toBe(true);
    expect(ps[0]!.processing_status).toBe('needs_review');
  });

  it('low_quality_scan.png: low-quality scan goes to review, not silent acceptance', () => {
    const vid = v['low_quality_scan.png']!.versionId;
    const p = pages(t, vid)[0]!;
    expect(expected['low_quality_scan.png'].expect_low_confidence_or_review).toBe(true);
    expect(p.processing_status).toBe('needs_review');
    expect(p.error_code).toBe('LOW_QUALITY_SCAN');
    expect(p.error_detail).toContain('جودة الصورة منخفضة');
    const item = t.ctx.db.get<{ kind: string; entity_type: string }>('SELECT kind, entity_type FROM review_queue_item WHERE entity_id = ?', [p.id]);
    expect(item).toEqual({ kind: 'ocr_error', entity_type: 'source_page' });
    expect(regions(t, vid).every((r) => r.status === 'needs_review')).toBe(true);
    const src = t.ctx.db.get<{ processing_status: string }>('SELECT processing_status FROM source WHERE id = ?', [v['low_quality_scan.png']!.sourceId]);
    expect(src?.processing_status).toBe('needs_review');
  });

  it('scanned_page.png: OCR of a scanned page image', () => {
    const text = pageText(t, v['scanned_page.png']!.versionId, 0).toLowerCase();
    expect(text).toContain('pylori');
    expect(text).toContain('urea breath test');
  });

  it('histology_images.zip: pages keep the natural file order 01, 02, 10 and each region carries its file name', () => {
    const vid = v['histology_images.zip']!.versionId;
    const ps = pages(t, vid);
    expect(ps.map((p) => p.section_key)).toEqual(expected['histology_images.zip'].accepted_order);
    for (const p of ps) {
      const rs = regions(t, vid, p.page_index);
      expect(rs.length).toBeGreaterThan(0);
      expect(rs.every((r) => JSON.parse(r.locator_json!).file_name === p.section_key)).toBe(true);
    }
    // each image is its own chunk unit (text never flows from one image into the next)
    const chunks = t.ctx.db.all<{ page_ids_json: string }>('SELECT page_ids_json FROM document_chunk WHERE version_id = ?', [vid]);
    expect(chunks.every((c) => JSON.parse(c.page_ids_json).length === 1)).toBe(true);
  });
});

describe('Golden Set — DOCX paragraph locators (no invented page numbers)', () => {
  const file = 'lecture_notes_shock.docx';
  it('sections, headings and paragraph locators', () => {
    const vid = v[file]!.versionId;
    const ps = pages(t, vid);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.kind === 'docx_section' && p.printed_label === null && p.width === null)).toBe(true);
    const rs = regions(t, vid);
    const locs = rs.map((r) => JSON.parse(r.locator_json ?? '{}') as { paragraph_index?: number; heading_path?: string[] });
    expect(locs.every((l) => Number.isInteger(l.paragraph_index))).toBe(true);
    const idx = locs.map((l) => l.paragraph_index!);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(rs.length).toBeGreaterThanOrEqual(expected[file].min_paragraphs);
    expect(rs.filter((r) => r.kind === 'heading').map((r) => r.text)).toEqual(expected[file].headings);
    expect(rs.every((r) => r.bbox_json === null)).toBe(true);
    const arabic = rs.find((r) => r.text?.includes('تُصنف الصدمة'));
    expect(JSON.parse(arabic!.locator_json!).heading_path).toEqual(['Shock — الصدمة', 'Classification']);
    const chunk = t.ctx.db.get<{ heading_path: string }>(`SELECT heading_path FROM document_chunk WHERE version_id = ? AND text LIKE '%hypovolaemic%'`, [vid]);
    expect(chunk?.heading_path).toBe('Shock — الصدمة › Classification');
  });
});

describe('Golden Set — PPTX slide numbers', () => {
  const file = 'slides_shock.pptx';
  it('3 slides in presentation order with titles, slide-number labels and shape boxes', () => {
    const vid = v[file]!.versionId;
    const ps = pages(t, vid);
    expect(ps).toHaveLength(expected[file].slide_count);
    expect(ps.map((p) => p.kind)).toEqual(['slide', 'slide', 'slide']);
    expect(ps.map((p) => p.printed_label)).toEqual(['1', '2', '3']);
    expect(ps.every((p) => p.printed_label_origin === 'slide_number' && p.unit === 'pt' && p.width! > 0)).toBe(true);
    const titles = ps.map((p) => regions(t, vid, p.page_index).find((r) => r.kind === 'heading')?.text);
    expect(titles).toEqual(expected[file].slide_titles);
    const bullets = regions(t, vid, 1).filter((r) => r.kind === 'list_item').map((r) => r.text);
    expect(bullets).toEqual(['Hypovolaemic', 'Cardiogenic', 'Distributive', 'Obstructive']);
    const title = regions(t, vid, 0).find((r) => r.kind === 'heading')!;
    const box = JSON.parse(title.bbox_json!);
    expect(box.x).toBeCloseTo(457200 / 9144000, 3);
    expect(JSON.parse(title.locator_json!).slide).toBe(1);
  });

  it.skipIf(!HAS_SOFFICE)('produces a fixed display PDF with LibreOffice', () => {
    const row = t.ctx.db.get<{ display_file_id: string | null }>('SELECT display_file_id FROM source_version WHERE id = ?', [v[file]!.versionId]);
    expect(row?.display_file_id).toBeTruthy();
    expect(t.ctx.files.stat(row!.display_file_id!)?.mime).toBe('application/pdf');
  });
});

describe('Golden Set — normalized search', () => {
  it('finds «الألم» when searching «الالم» (normalized FTS) and the jobs completed', () => {
    for (const [file] of FIXTURES) expect(['completed', 'partial'], file).toContain(v[file]!.jobStatus);
    const hits = t.ctx.db.all<{ text: string }>(
      `SELECT c.text FROM chunk_fts JOIN document_chunk c ON c.rowid = chunk_fts.rowid WHERE chunk_fts MATCH ? AND c.version_id = ?`,
      ['"' + norm('الالم') + '"', v['lecture_appendicitis.pdf']!.versionId],
    );
    expect(hits.some((h) => h.text.includes('الألم'))).toBe(true);
  });
});
