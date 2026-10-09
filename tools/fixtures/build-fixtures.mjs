// Golden Set fixture builder (§57). Produces SYNTHETIC structural test documents under fixtures/golden.
//
// Every document is labelled "TEST FIXTURE". The text is authored for structural testing
// (layout, page labels, OCR, question/key extraction, negation, units, duplicates). It is not a
// medical reference and must never be shown to the owner as study material.
//
// Requirements: LibreOffice (`soffice`) for DOCX→PDF, Chromium via @playwright/test (repo root) for
// rasterizing images/"scanned" pages. Run: `npm run fixtures` (repo root) or `node build-fixtures.mjs`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, BorderStyle, ColumnBreak, Document, Footer, Header, HeadingLevel, ImageRun, Packer, PageBreak,
  PageNumber, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, SectionType,
} from 'docx';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../fixtures/golden');
const TMP = mkdtempSync(path.join(tmpdir(), 'medlevo-fixtures-'));
mkdirSync(OUT, { recursive: true });

const FIXTURE_NOTICE = 'TEST FIXTURE — synthetic structural document for automated tests. Not a medical reference.';

// ───────────────────────── helpers ─────────────────────────
const p = (text, opts = {}) =>
  new Paragraph({
    bidirectional: opts.rtl ?? false,
    alignment: opts.rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    heading: opts.heading,
    spacing: { after: 160 },
    children: [new TextRun({ text, bold: opts.bold, size: opts.size, rightToLeft: opts.rtl ?? false, font: 'DejaVu Sans' })],
  });

const footerWithNumber = () =>
  new Footer({
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: 'DejaVu Sans' })] })],
  });

const headerText = (text) =>
  new Header({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text, size: 16, color: '666666', font: 'DejaVu Sans' })] })] });

async function docxToPdf(doc, name) {
  const docxPath = path.join(TMP, `${name}.docx`);
  writeFileSync(docxPath, await Packer.toBuffer(doc));
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', TMP, docxPath], { stdio: 'ignore', timeout: 120_000 });
  return readFileSync(path.join(TMP, `${name}.pdf`));
}

async function setPageLabels(pdfBytes, startAt) {
  const pdf = await PDFDocument.load(pdfBytes);
  const ctx = pdf.context;
  const labelDict = ctx.obj({ S: PDFName.of('D'), St: PDFNumber.of(startAt) });
  const nums = ctx.obj([PDFNumber.of(0), labelDict]);
  pdf.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: nums }));
  return Buffer.from(await pdf.save());
}

let browser;
async function renderPng(html, { width = 1240, height = 1754, selector = 'body', scale = 1 } = {}) {
  browser ??= await chromium.launch({ executablePath: process.env.MEDLEVO_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:'DejaVu Sans',sans-serif;background:#fff;color:#111}
  </style></head><body>${html}</body></html>`);
  const el = await page.$(selector);
  const buf = await el.screenshot({ type: 'png' });
  await page.close();
  return buf;
}

// ───────────────────────── 1. digital lecture with /PageLabels starting at 11 ─────────────────────────
async function buildAppendicitisLecture() {
  const flowchart = await renderPng(
    `<svg id="fc" xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" style="background:#fff">
      <defs><marker id="a" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111"/></marker></defs>
      <style>text{font:22px 'DejaVu Sans';fill:#111} rect{fill:#fff;stroke:#111;stroke-width:2}</style>
      <rect x="300" y="20" width="300" height="60" rx="8"/><text x="450" y="58" text-anchor="middle">Suspected appendicitis</text>
      <line x1="450" y1="80" x2="450" y2="140" stroke="#111" stroke-width="2" marker-end="url(#a)"/>
      <rect x="320" y="140" width="260" height="60" rx="8"/><text x="450" y="178" text-anchor="middle">Alvarado score</text>
      <line x1="450" y1="200" x2="150" y2="300" stroke="#111" stroke-width="2" marker-end="url(#a)"/>
      <line x1="450" y1="200" x2="450" y2="300" stroke="#111" stroke-width="2" marker-end="url(#a)"/>
      <line x1="450" y1="200" x2="750" y2="300" stroke="#111" stroke-width="2" marker-end="url(#a)"/>
      <rect x="20" y="300" width="260" height="90" rx="8"/><text x="150" y="338" text-anchor="middle">Score ≥ 7</text><text x="150" y="370" text-anchor="middle">Surgical review</text>
      <rect x="320" y="300" width="260" height="90" rx="8"/><text x="450" y="338" text-anchor="middle">Score 5–6</text><text x="450" y="370" text-anchor="middle">Imaging (US / CT)</text>
      <rect x="620" y="300" width="260" height="90" rx="8"/><text x="750" y="338" text-anchor="middle">Score ≤ 4</text><text x="750" y="370" text-anchor="middle">Observe, re-assess</text>
    </svg>`,
    { width: 900, height: 520, selector: '#fc' },
  );

  const cell = (text, opts = {}) =>
    new TableCell({
      columnSpan: opts.colSpan,
      rowSpan: opts.rowSpan,
      width: { size: opts.w ?? 3000, type: WidthType.DXA },
      children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold, font: 'DejaVu Sans', size: 20 })] })],
    });

  const table = new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({ tableHeader: true, children: [cell('Alvarado score (MANTRELS) — مكونات المقياس', { colSpan: 3, bold: true, w: 9000 })] }),
      new TableRow({ tableHeader: true, children: [cell('Feature', { bold: true, w: 4200 }), cell('Points', { bold: true, w: 1400 }), cell('Unit / threshold', { bold: true, w: 3400 })] }),
      new TableRow({ children: [cell('Migration of pain to RIF', { w: 4200 }), cell('1', { w: 1400 }), cell('—', { w: 3400 })] }),
      new TableRow({ children: [cell('Anorexia', { w: 4200 }), cell('1', { w: 1400 }), cell('—', { w: 3400 })] }),
      new TableRow({ children: [cell('Nausea / vomiting', { w: 4200 }), cell('1', { w: 1400 }), cell('—', { w: 3400 })] }),
      new TableRow({ children: [cell('Tenderness in right iliac fossa', { w: 4200 }), cell('2', { w: 1400 }), cell('—', { w: 3400 })] }),
      new TableRow({ children: [cell('Rebound tenderness', { w: 4200 }), cell('1', { w: 1400 }), cell('—', { w: 3400 })] }),
      new TableRow({ children: [cell('Elevated temperature', { w: 4200 }), cell('1', { w: 1400 }), cell('≥ 37.3 °C', { w: 3400 })] }),
      new TableRow({ children: [cell('Leukocytosis', { w: 4200 }), cell('2', { w: 1400 }), cell('> 10 ×10⁹/L', { w: 3400 })] }),
      new TableRow({ children: [cell('Shift to the left', { w: 4200 }), cell('1', { w: 1400 }), cell('neutrophils > 75%', { w: 3400 })] }),
    ],
  });

  const header = headerText('Surgery · Course 1 · Lecture 3 — TEST FIXTURE');
  const doc = new Document({
    sections: [
      {
        properties: { page: { pageNumbers: { start: 11 } } },
        headers: { default: header },
        footers: { default: footerWithNumber() },
        children: [
          p('Acute Appendicitis — التهاب الزائدة الدودية الحاد', { heading: HeadingLevel.HEADING_1 }),
          p(FIXTURE_NOTICE, { size: 18 }),
          p('Learning objectives', { heading: HeadingLevel.HEADING_2 }),
          p('• Describe the typical migration of pain in acute appendicitis.'),
          p('• List the investigations used when the diagnosis is uncertain.'),
          p('Clinical presentation', { heading: HeadingLevel.HEADING_2 }),
          p('Pain usually begins in the periumbilical region and later migrates to the right iliac fossa (McBurney\'s point).'),
          p('يبدأ الألم عادةً حول السرة ثم ينتقل إلى الحفرة الحرقفية اليمنى عند نقطة McBurney.', { rtl: true }),
          p('Anorexia and nausea are common; vomiting usually follows the onset of pain.'),
          p('A white cell count above 11 ×10⁹/L supports the diagnosis, but a normal count does NOT exclude it.'),
        ],
      },
      {
        properties: { type: SectionType.NEXT_PAGE, column: { count: 2, space: 708 } },
        headers: { default: header },
        footers: { default: footerWithNumber() },
        children: [
          p('Investigations — الفحوصات', { heading: HeadingLevel.HEADING_2 }),
          p('Ultrasound is the first-line imaging test in children and in pregnant women.'),
          p('CT abdomen is preferred in adults when the diagnosis remains uncertain after clinical assessment.'),
          p('A pregnancy test (β-hCG) is required in women of reproductive age.'),
          new Paragraph({ children: [new ColumnBreak()] }),
          p('Differential diagnosis', { heading: HeadingLevel.HEADING_3 }),
          p('The differential diagnosis includes mesenteric adenitis, ectopic pregnancy and right ureteric colic.'),
          p('يجب استبعاد الحمل خارج الرحم عند النساء في سن الإنجاب.', { rtl: true }),
        ],
      },
      {
        properties: { type: SectionType.NEXT_PAGE },
        headers: { default: header },
        footers: { default: footerWithNumber() },
        children: [
          p('Table 1: Alvarado score components', { heading: HeadingLevel.HEADING_2 }),
          table,
          p('Total score ranges from 0 to 10.'),
        ],
      },
      {
        properties: { type: SectionType.NEXT_PAGE },
        headers: { default: header },
        footers: { default: footerWithNumber() },
        children: [
          p('Management pathway', { heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ children: [new ImageRun({ type: 'png', data: flowchart, transformation: { width: 540, height: 312 } })] }),
          p('Figure 1: Management pathway by Alvarado score (synthetic diagram).', { size: 18 }),
          p('As shown in Figure 1, the score directs the next step: surgical review, imaging, or observation.'),
        ],
      },
    ],
  });
  const pdf = await docxToPdf(doc, 'lecture_appendicitis');
  writeFileSync(path.join(OUT, 'lecture_appendicitis.pdf'), await setPageLabels(pdf, 11));
  writeFileSync(path.join(OUT, 'flowchart.png'), flowchart);
}

// ───────────────────────── 2. lecture with printed numbers only (no /PageLabels) ─────────────────────────
async function buildCholecystitisLecture() {
  const doc = new Document({
    sections: [
      {
        properties: { page: { pageNumbers: { start: 31 } } },
        headers: { default: headerText('Surgery · Course 1 · Lecture 4 — TEST FIXTURE') },
        footers: { default: footerWithNumber() },
        children: [
          p('Acute Cholecystitis — التهاب المرارة الحاد', { heading: HeadingLevel.HEADING_1 }),
          p(FIXTURE_NOTICE, { size: 18 }),
          p('Right upper quadrant pain with fever suggests acute cholecystitis.'),
          p("Murphy's sign is elicited by palpation under the right costal margin during inspiration."),
          new Paragraph({ children: [new PageBreak()] }),
          p('Investigations', { heading: HeadingLevel.HEADING_2 }),
          p('Ultrasound is the first-line investigation for suspected gallstones.'),
          p('يُعد التصوير بالأمواج فوق الصوتية الفحص الأولي عند الشك بحصى المرارة.', { rtl: true }),
        ],
      },
    ],
  });
  writeFileSync(path.join(OUT, 'lecture_cholecystitis.pdf'), await docxToPdf(doc, 'lecture_cholecystitis'));
}

// ───────────────────────── 3. mixed PDF: digital + scanned (image-only) + digital ─────────────────────────
async function buildMixedScanned() {
  const digital = await docxToPdf(
    new Document({
      sections: [
        {
          children: [
            p('Peptic Ulcer Disease — page 1 (digital text)', { heading: HeadingLevel.HEADING_1 }),
            p(FIXTURE_NOTICE, { size: 18 }),
            p('This page has a real text layer.'),
            new Paragraph({ children: [new PageBreak()] }),
            p('Page 3 (digital text) — summary table follows.', { heading: HeadingLevel.HEADING_2 }),
            p('Test | Purpose'),
            p('Urea breath test | detects active infection'),
          ],
        },
      ],
    }),
    'mixed_digital',
  );
  const scan = await renderPng(
    `<div id="pg" style="width:1240px;height:1754px;padding:120px;box-sizing:border-box;filter:grayscale(1) blur(0.4px);transform:rotate(0.4deg);background:#fdfdfb">
       <h1 style="font-size:44px">Page 2 — scanned page (image only)</h1>
       <p style="font-size:30px;line-height:1.6">Helicobacter pylori (H. pylori) infection is a common cause of peptic ulcer disease.</p>
       <p style="font-size:30px;line-height:1.6">The urea breath test is a non-invasive test for active infection.</p>
       <p dir="rtl" style="font-size:32px;line-height:1.8">جرثومة H. pylori سبب شائع لقرحة المعدة.</p>
       <p style="font-size:24px;color:#444">${FIXTURE_NOTICE}</p>
     </div>`,
    { selector: '#pg' },
  );
  writeFileSync(path.join(OUT, 'scanned_page.png'), scan);

  const src = await PDFDocument.load(digital);
  const out = await PDFDocument.create();
  const [p1, p3] = await out.copyPages(src, [0, 1]);
  out.addPage(p1);
  const img = await out.embedPng(scan);
  const page2 = out.addPage([595.28, 841.89]);
  page2.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  out.addPage(p3);
  writeFileSync(path.join(OUT, 'mixed_scanned_lecture.pdf'), Buffer.from(await out.save()));
}

// ───────────────────────── 4. question source with two renumbered sections + keys ─────────────────────────
const Q = (n, stem, opts = {}) => p(`${n}. ${stem}`, { rtl: opts.rtl });
const O = (label, text, opts = {}) => p(`${label}. ${text}`, { rtl: opts.rtl });

async function buildQuestionSource() {
  const doc = new Document({
    sections: [
      {
        headers: { default: headerText('Surgery Course 1 — Question Bank — TEST FIXTURE') },
        footers: { default: footerWithNumber() },
        children: [
          p('Surgery Course 1 — Question Bank', { heading: HeadingLevel.HEADING_1 }),
          p(FIXTURE_NOTICE, { size: 18 }),
          p('Section A — Abdominal pain', { heading: HeadingLevel.HEADING_2 }),
          Q(1, 'Which point is classically tender in acute appendicitis?'),
          O('A', "Murphy's point"), O('B', "McBurney's point"), O('C', "Kehr's point"), O('D', "Castell's point"),
          Q(2, 'Which of the following is NOT typically part of the Alvarado score?'),
          O('A', 'Migration of pain'), O('B', 'Anorexia'), O('C', 'Serum amylase'), O('D', 'Leukocytosis'),
          Q(3, 'A 30-year-old woman of reproductive age presents with right iliac fossa pain. Which investigation should be performed first to exclude an important differential diagnosis?'),
          new Paragraph({ children: [new PageBreak()] }),
          O('A', 'Serum lipase'), O('B', 'Pregnancy test (β-hCG)'), O('C', 'Barium enema'), O('D', 'Colonoscopy'), O('E', 'Upper GI endoscopy'),
          Q(4, 'In suspected appendicitis, a white cell count of 11.5 ×10⁹/L:'),
          O('A', 'Confirms the diagnosis'), O('B', 'Supports but does not confirm the diagnosis'), O('C', 'Excludes the diagnosis'), O('D', 'Indicates perforation'),
          p('Section B — Biliary disease', { heading: HeadingLevel.HEADING_2 }),
          Q(1, 'Which sign is associated with acute cholecystitis?'),
          O('A', "Murphy's sign"), O('B', 'Psoas sign'), O('C', 'Obturator sign'), O('D', "Rovsing's sign"),
          Q(2, 'All of the following are risk factors for gallstones EXCEPT:'),
          O('A', 'Female sex'), O('B', 'Obesity'), O('C', 'Rapid weight loss'), O('D', 'Regular physical activity'),
          Q(3, 'ما هو الفحص الأولي المفضل عند الشك بحصى المرارة؟', { rtl: true }),
          O('أ', 'Ultrasound', { rtl: true }), O('ب', 'CT abdomen', { rtl: true }), O('ج', 'MRCP', { rtl: true }), O('د', 'Plain X-ray', { rtl: true }),
          new Paragraph({ children: [new PageBreak()] }),
          p('Answer Key', { heading: HeadingLevel.HEADING_2 }),
          p('Section A: 1. B   2. C   3. B   4. B'),
          p('Section B: 1. A   2. D'),
        ],
      },
    ],
  });
  writeFileSync(path.join(OUT, 'questions_surgery_course1.pdf'), await docxToPdf(doc, 'questions_surgery_course1'));
}

async function buildPreviousExam() {
  const doc = new Document({
    sections: [
      {
        footers: { default: footerWithNumber() },
        children: [
          p('Surgery — Previous exam 2024', { heading: HeadingLevel.HEADING_1 }),
          p(FIXTURE_NOTICE, { size: 18 }),
          Q(1, 'Which point is classically tender in acute appendicitis?'),
          O('A', "Murphy's point"), O('B', "McBurney's point"), O('C', "Kehr's point"), O('D', "Castell's point"),
          Q(2, 'Which of the following is typically part of the Alvarado score?'),
          O('A', 'Migration of pain'), O('B', 'Serum amylase'), O('C', 'Serum lipase'), O('D', 'Blood glucose'),
          Q(3, 'Which electrolyte value is within the usual adult reference range?'),
          O('A', 'Na+ 125 mmol/L'), O('B', 'Na+ 140 mmol/L'), O('C', 'K+ 6.5 mmol/L'), O('D', 'K+ 2.5 mmol/L'),
          p('Answers', { heading: HeadingLevel.HEADING_2 }),
          p('1. B   2. A'),
        ],
      },
    ],
  });
  writeFileSync(path.join(OUT, 'questions_previous_exam_2024.pdf'), await docxToPdf(doc, 'questions_previous_exam_2024'));
}

// ───────────────────────── 5. images: single question photo with a hand-drawn circle; low-quality scan ─────────────────────────
async function buildImages() {
  const photo = await renderPng(
    `<div id="q" style="width:1000px;padding:60px;background:#f7f5ef;font-size:30px;line-height:1.7;position:relative">
       <div style="font-size:18px;color:#555">${FIXTURE_NOTICE}</div>
       <p><b>7.</b> Which investigation is first-line for suspected gallstones?</p>
       <p style="position:relative">A. Ultrasound
         <span style="position:absolute;left:-18px;top:-6px;width:70px;height:56px;border:4px solid #c0392b;border-radius:50%;transform:rotate(-8deg)"></span></p>
       <p>B. CT abdomen</p><p>C. MRCP</p><p>D. ERCP</p>
     </div>`,
    { width: 1000, height: 800, selector: '#q' },
  );
  writeFileSync(path.join(OUT, 'question_photo_circled.png'), photo);

  const low = await renderPng(
    `<div id="lq" style="width:900px;padding:40px;background:#d9d6cf;color:#8a877f;filter:blur(2.2px);font-size:22px">
       <p>Low quality scan — TEST FIXTURE</p><p>The cystic duct joins the common hepatic duct.</p>
     </div>`,
    { width: 900, height: 300, selector: '#lq' },
  );
  writeFileSync(path.join(OUT, 'low_quality_scan.png'), low);
}

// ───────────────────────── 6. DOCX (paragraph locators) and PPTX (slide numbers) ─────────────────────────
async function buildOffice() {
  const doc = new Document({
    sections: [
      {
        children: [
          p('Shock — الصدمة', { heading: HeadingLevel.HEADING_1 }),
          p(FIXTURE_NOTICE, { size: 18 }),
          p('Classification', { heading: HeadingLevel.HEADING_2 }),
          p('Shock is classified as hypovolaemic, cardiogenic, distributive or obstructive.'),
          p('تُصنف الصدمة إلى نقص الحجم، قلبية، توزيعية، أو انسدادية.', { rtl: true }),
          p('Initial assessment', { heading: HeadingLevel.HEADING_2 }),
          p('Assess airway, breathing and circulation (ABC) first.'),
        ],
      },
    ],
  });
  writeFileSync(path.join(OUT, 'lecture_notes_shock.docx'), await Packer.toBuffer(doc));

  const pptx = new PptxGenJS();
  const s1 = pptx.addSlide();
  s1.addText('Shock — overview', { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 32, bold: true });
  s1.addText(FIXTURE_NOTICE, { x: 0.5, y: 1.6, w: 9, h: 0.6, fontSize: 12 });
  const s2 = pptx.addSlide();
  s2.addText('Types of shock', { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, bold: true });
  s2.addText('Hypovolaemic\nCardiogenic\nDistributive\nObstructive', { x: 0.5, y: 1.5, w: 9, h: 3, fontSize: 20, bullet: true });
  const s3 = pptx.addSlide();
  s3.addText('Initial management', { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28, bold: true });
  s3.addText('ABC assessment\nIV access', { x: 0.5, y: 1.5, w: 9, h: 3, fontSize: 20, bullet: true });
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  writeFileSync(path.join(OUT, 'slides_shock.pptx'), buf);
}

// ───────────────────────── 7. ZIP of ordered images (with junk entries to skip) ─────────────────────────
async function buildZip() {
  const zip = new JSZip();
  const tile = async (label) =>
    renderPng(`<div id="t" style="width:600px;height:400px;display:flex;align-items:center;justify-content:center;font-size:36px;border:6px solid #333">${label}<br>TEST FIXTURE</div>`, {
      width: 600, height: 400, selector: '#t',
    });
  zip.file('slides/01_epithelium.png', await tile('01 Epithelium'));
  zip.file('slides/02_connective_tissue.png', await tile('02 Connective tissue'));
  zip.file('slides/10_muscle.png', await tile('10 Muscle'));
  zip.file('__MACOSX/slides/._01_epithelium.png', Buffer.from('junk'));
  zip.file('slides/.DS_Store', Buffer.from('junk'));
  zip.file('slides/readme.txt', 'not an image');
  writeFileSync(path.join(OUT, 'histology_images.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

// ───────────────────────── expected ground truth ─────────────────────────
const EXPECTED = {
  _note: 'Ground truth for the Golden Set. Authored by hand together with the fixtures; reviewed by the orchestrator. Synthetic content.',
  'lecture_appendicitis.pdf': {
    source_type: 'lecture',
    page_count: 4,
    printed_labels: ['11', '12', '13', '14'],
    printed_label_origin: 'pdf_page_labels',
    pages_need_ocr: [],
    must_contain: { 0: ['periumbilical', 'McBurney', 'NOT exclude'], 1: ['Ultrasound is the first-line', 'ectopic pregnancy'], 2: ['Alvarado', 'Leukocytosis', '10 ×10⁹/L'], 3: ['Figure 1'] },
    tables: [{ page_index: 2, min_rows: 10, merged_header: 'Alvarado score (MANTRELS)' }],
    figures: [{ page_index: 3, caption_contains: 'Figure 1' }],
    two_column_page_index: 1,
    reading_order_page_1: ['Ultrasound is the first-line', 'CT abdomen is preferred', 'Differential diagnosis'],
    arabic_must_contain: { 0: ['يبدأ الألم', 'الحفرة الحرقفية اليمنى'], 1: ['الحمل خارج الرحم'] },
    known_extraction_defects: [
      'Raw PDF text (pdfjs and pdftotext) emits the lam-alef ligature reversed: "األلم" instead of "الألم". The pipeline must normalize it (or flag the region) — never store the reversed form silently.',
      'The tanween glyph in "عادةً" maps to a stray Latin "S" via the font ToUnicode table. A lone Latin letter inside an Arabic word must flag the region for review (extraction accuracy), not pass silently.',
    ],
  },
  'lecture_cholecystitis.pdf': {
    source_type: 'lecture',
    page_count: 2,
    printed_labels: ['31', '32'],
    printed_label_origin: 'detected_text',
    pages_need_ocr: [],
  },
  'mixed_scanned_lecture.pdf': {
    page_count: 3,
    pages_need_ocr: [1],
    ocr_must_contain: { 1: ['pylori', 'urea breath test'] },
    digital_pages: [0, 2],
  },
  'questions_surgery_course1.pdf': {
    source_type: 'question_source',
    sections: [
      { key: 'A', title_contains: 'Section A', questions: [
        { n: '1', options: 4, key: 'B', negation: false, answer_status: 'source_key' },
        { n: '2', options: 4, key: 'C', negation: true, negation_term: 'NOT', answer_status: 'source_key' },
        { n: '3', options: 5, key: 'B', negation: false, spans_pages: [0, 1], answer_status: 'source_key' },
        { n: '4', options: 4, key: 'B', negation: false, must_contain: '11.5 ×10⁹/L', answer_status: 'source_key' },
      ] },
      { key: 'B', title_contains: 'Section B', questions: [
        { n: '1', options: 4, key: 'A', negation: false, answer_status: 'source_key' },
        { n: '2', options: 4, key: 'D', negation: true, negation_term: 'EXCEPT', answer_status: 'source_key' },
        { n: '3', options: 4, key: null, negation: false, option_labels: ['أ', 'ب', 'ج', 'د'], answer_status: 'missing_key' },
      ] },
    ],
    total_questions: 7,
  },
  'questions_previous_exam_2024.pdf': {
    source_type: 'previous_exam',
    questions: [
      { n: '1', options: 4, key: 'B', exact_duplicate_of: { file: 'questions_surgery_course1.pdf', section: 'A', n: '1' } },
      { n: '2', options: 4, key: 'A', near_duplicate_of: { file: 'questions_surgery_course1.pdf', section: 'A', n: '2' }, must_not_merge: true, reason: 'negation differs and options differ' },
      { n: '3', options: 4, key: null, answer_status: 'missing_key', must_contain: ['Na+ 140 mmol/L', 'K+ 6.5 mmol/L'] },
    ],
  },
  'question_photo_circled.png': {
    format: 'image', needs_ocr: true, questions: [{ n: '7', options: 4, answer_status: 'missing_key', unofficial_mark_on: 'A' }],
  },
  'low_quality_scan.png': { format: 'image', needs_ocr: true, expect_low_confidence_or_review: true },
  'lecture_notes_shock.docx': { format: 'docx', pagination: 'paragraphs', min_paragraphs: 6, headings: ['Shock — الصدمة', 'Classification', 'Initial assessment'] },
  'slides_shock.pptx': { format: 'pptx', pagination: 'slides', slide_count: 3, slide_titles: ['Shock — overview', 'Types of shock', 'Initial management'] },
  'histology_images.zip': { format: 'image_set', accepted_order: ['01_epithelium.png', '02_connective_tissue.png', '10_muscle.png'], rejected: ['__MACOSX/slides/._01_epithelium.png', 'slides/.DS_Store', 'slides/readme.txt'] },
  matching: {
    lecture: 'lecture_appendicitis.pdf',
    question_source: 'questions_surgery_course1.pdf',
    expect_linked_to_lecture: [{ section: 'A', n: '1' }, { section: 'A', n: '2' }, { section: 'A', n: '3' }, { section: 'A', n: '4' }],
    expect_not_directly_covered: [{ section: 'B', n: '1' }, { section: 'B', n: '2' }, { section: 'B', n: '3' }],
  },
};

try {
  await buildAppendicitisLecture();
  await buildCholecystitisLecture();
  await buildMixedScanned();
  await buildQuestionSource();
  await buildPreviousExam();
  await buildImages();
  await buildOffice();
  await buildZip();
  writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
  console.log('fixtures written to', OUT);
} finally {
  await browser?.close();
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}
