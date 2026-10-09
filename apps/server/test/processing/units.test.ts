// Unit tests for the processing building blocks (no app, no database).
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decideDir, logicalLineText, buildSegments, joinLines } from '../../src/modules/processing/layout/lines';
import {
  captionInfo,
  detectPrintedLabels,
  figureReferences,
  isListStart,
  orderElements,
  parsePageNumber,
  repeatedBandSignatures,
  type BandLine,
} from '../../src/modules/processing/layout/page';
import { detectRuledTables, serializeTable } from '../../src/modules/processing/layout/tables';
import type { Rule, TextItem } from '../../src/modules/processing/layout/types';
import { cropImage, decodePng, encodePng, imageSize, measureImageQuality, PngError, type RgbaImage } from '../../src/modules/processing/png';
import { suggestLectureKind } from '../../src/modules/processing/structure';
import { cleanRun, detectSuspicious, fixReversedLamAlef, prepareRegionText, suspicionReasonAr } from '../../src/modules/processing/text';
import { convertToPdf, findExecutable, runCommand, ToolError } from '../../src/modules/processing/tools';
import { parseXml, XmlError } from '../../src/modules/processing/xml';

const item = (text: string, x0: number, x1: number, top = 100, size = 10, extra: Partial<TextItem> = {}): TextItem => ({
  text,
  x0,
  x1,
  top,
  bottom: top + size * 1.2,
  size,
  bold: false,
  ...extra,
});

describe('reversed lam-alef repair (known PDF defect)', () => {
  it('repairs the reversed ligature at word start and after one-letter proclitics', () => {
    expect(fixReversedLamAlef('يبدأ األلم عادة').text).toBe('يبدأ الألم عادة');
    expect(fixReversedLamAlef('سن اإلنجاب.').text).toBe('سن الإنجاب.');
    expect(fixReversedLamAlef('اآلن').text).toBe('الآن');
    expect(fixReversedLamAlef('باألمواج و واأللم').text).toBe('بالأمواج و والألم');
    expect(fixReversedLamAlef('األولي األلم').fixes).toBe(2);
  });

  it('never touches correct words (no false positives)', () => {
    for (const w of ['ألم', 'أل', 'الألم', 'إلى', 'الآن', 'آلة', 'والألم', 'لألم', 'الإنجاب', 'سألت', 'المسألة', 'إلا', 'Alarm', 'ا']) {
      const r = fixReversedLamAlef(w);
      expect(r.text, w).toBe(w);
      expect(r.fixes, w).toBe(0);
    }
    // inside a word (no word boundary) the pattern is not repaired
    expect(fixReversedLamAlef('كتاألب').text).toBe('كتاألب');
  });
});

describe('suspicious extraction detection', () => {
  it('flags a lone Latin letter glued to an Arabic word (tanween/damma mapped to a letter)', () => {
    const s = detectSuspicious('يبدأ الألم عادةS حول السرة');
    expect(s).toEqual([expect.objectContaining({ kind: 'lone_latin_in_arabic', token: 'S' })]);
    expect(detectSuspicious('يPعد التصوير')[0]?.token).toBe('P');
    expect(suspicionReasonAr(s)).toContain('«S»');
  });

  it('does not flag normal mixed Arabic/English text', () => {
    for (const t of ['جرثومة H. pylori سبب شائع', 'β-hCG and الـCT scan', 'Vitamin B12 فيتامين', 'نقطة McBurney.', 'الحمل خارج الرحم', 'Na+ 140 mmol/L', 'تُصنف الصدمة']) {
      expect(detectSuspicious(t), t).toEqual([]);
    }
  });

  it('flags orphan diacritics, U+FFFD and private-use glyphs', () => {
    expect(detectSuspicious('ُت-صنف الصدمة')[0]?.kind).toBe('orphan_mark');
    expect(detectSuspicious('x\uFFFDy')[0]?.kind).toBe('replacement_char');
    expect(detectSuspicious('abc \uE012 def')[0]).toMatchObject({ kind: 'private_use', token: 'U+E012' });
  });

  it('cleans runs: bidi controls removed, presentation forms mapped, NFC, odd spaces', () => {
    expect(cleanRun('\u200F\u202Bنص\u202C\u200E')).toBe('نص');
    expect(cleanRun('\uFEFB')).toBe('لا'); // lam-alef presentation form → logical «لا»
    expect(cleanRun('10\u00A0mg\u200B')).toBe('10 mg');
    expect(cleanRun('e\u0301')).toBe('\u00E9');
    const p = prepareRegionText('  سن  اإلنجاب.  ');
    expect(p).toMatchObject({ text: 'سن الإنجاب.', ligatureFixes: 1, suspicions: [] });
  });
});

describe('bidi-aware line assembly', () => {
  it('reads an RTL line right-to-left and keeps an embedded English term (with its period) in order', () => {
    // visual positions as pdfjs reports them for «يبدأ الألم ... عند نقطة McBurney.»
    const items = [item('.', 163.5, 166.7), item('McBurney', 166.5, 216.3), item('حول السرة عند نقطة', 219.6, 462.8), item('يبدأ الألم', 471.6, 523.4)];
    expect(logicalLineText(items, 'rtl')).toBe('يبدأ الألم حول السرة عند نقطة McBurney.');
  });

  it('keeps multi-run LTR islands (H. pylori) left-to-right inside an RTL line', () => {
    const items = [item('سبب شائع', 100, 180), item('H.', 190, 200), item('pylori', 203, 230), item('جرثومة', 240, 280)];
    expect(logicalLineText(items, 'rtl')).toBe('جرثومة H. pylori سبب شائع');
  });

  it('keeps RTL islands right-to-left inside an LTR line', () => {
    const items = [item('Acute Appendicitis —', 72, 242), item('الزائدة الحاد', 300, 360), item('التهاب', 365, 400)];
    expect(logicalLineText(items, 'ltr')).toBe('Acute Appendicitis — التهاب الزائدة الحاد');
  });

  it('decides paragraph direction of mixed lines from alignment', () => {
    const [left] = buildSegments([item('Acute Appendicitis —', 72, 242), item('التهاب الزائدة الدودية الحاد', 247, 425)]);
    const [right] = buildSegments([item('McBurney.', 163, 216), item('يبدأ الألم عادة حول السرة عند نقطة', 219, 523)]);
    expect(decideDir([left!], 72, 523, 12)).toBe('ltr');
    expect(decideDir([right!], 72, 523, 12)).toBe('rtl');
    expect(decideDir(buildSegments([item('11', 290, 300)]), 72, 523, 12)).toBe('ltr');
  });

  it('splits rows into segments at column gaps and at vertical rules', () => {
    const segs = buildSegments([item('Feature', 78, 122), item('Points', 288, 323), item('Unit', 358, 380)]);
    expect(segs.map((s) => s.items.map((i) => i.text).join(' '))).toEqual(['Feature', 'Points', 'Unit']);
    const rule: Rule = { orientation: 'v', x0: 130, x1: 130, top: 90, bottom: 130 };
    expect(buildSegments([item('a', 100, 125), item('b', 131, 140)], [rule])).toHaveLength(2);
  });

  it('joins lines, keeping hyphenated compounds intact', () => {
    expect(joinLines(['Ultrasound is the first-', 'line test', ''])).toBe('Ultrasound is the first-line test');
    expect(joinLines(['does NOT', 'exclude it.'])).toBe('does NOT exclude it.');
  });
});

describe('page labels, captions, lists', () => {
  it('parses printed page numbers in several forms', () => {
    expect(parsePageNumber('31')).toBe(31);
    expect(parsePageNumber('- 12 -')).toBe(12);
    expect(parsePageNumber('Page 7')).toBe(7);
    expect(parsePageNumber('ص ١٢')).toBe(12);
    expect(parsePageNumber('12 / 40')).toBe(12);
    expect(parsePageNumber('Lecture 3')).toBeNull();
    expect(parsePageNumber('Table 2')).toBeNull();
  });

  it('accepts detected numbers only when they agree across pages; never invents missing ones', () => {
    const band = (t: string): BandLine[] => [{ text: t, where: 'bottom', box: { x0: 290, top: 800, x1: 300, bottom: 810 } }];
    expect([...detectPrintedLabels([band('31'), band('32')])]).toEqual([
      [0, '31'],
      [1, '32'],
    ]);
    // page 2 has no number → no label for it (not "33")
    expect([...detectPrintedLabels([band('31'), band('32'), [], band('34')])]).toEqual([
      [0, '31'],
      [1, '32'],
      [3, '34'],
    ]);
    // inconsistent numbers → nothing
    expect(detectPrintedLabels([band('5'), band('19')]).size).toBe(0);
    // a single page cannot be cross-checked
    expect(detectPrintedLabels([band('9')]).size).toBe(0);
  });

  it('finds header/footer lines repeated across pages (digits ignored)', () => {
    const page = (n: number): BandLine[] => [
      { text: 'Surgery · Course 1 · Lecture 3', where: 'top', box: { x0: 0, top: 0, x1: 1, bottom: 1 } },
      { text: String(n), where: 'bottom', box: { x0: 0, top: 0, x1: 1, bottom: 1 } },
    ];
    const sigs = repeatedBandSignatures([page(1), page(2), page(3)]);
    expect(sigs.has('top:surgery · course # · lecture #')).toBe(true);
  });

  it('recognizes captions, figure references and list markers', () => {
    expect(captionInfo('Figure 1: Management pathway')).toEqual({ for: 'figure', number: '1' });
    expect(captionInfo('Fig. 2 — ECG')).toEqual({ for: 'figure', number: '2' });
    expect(captionInfo('شكل ٣: مخطط')).toEqual({ for: 'figure', number: '3' });
    expect(captionInfo('Table 1: Alvarado score components')).toEqual({ for: 'table', number: '1' });
    expect(captionInfo('As shown in Figure 1, the score')).toBeNull();
    expect(figureReferences('As shown in Figure 1 and Fig. 2, …')).toEqual(['1', '2']);
    expect(isListStart('• Describe the pain')).toBe(true);
    expect(isListStart('1. Which point')).toBe(true);
    expect(isListStart('أ. Ultrasound')).toBe(true);
    expect(isListStart('Pain usually begins')).toBe(false);
  });
});

describe('reading order (column-aware XY-cut)', () => {
  const el = (id: string, x0: number, top: number, x1: number, bottom: number) => ({ id, box: { x0, top, x1, bottom } });
  it('reads a full-width title, then the left column, then the right column (LTR)', () => {
    const els = [
      el('title', 72, 40, 520, 60),
      el('L1', 72, 80, 280, 120),
      el('R1', 315, 85, 520, 110),
      el('L2', 72, 130, 280, 170),
      el('R2', 315, 120, 520, 160),
      el('foot', 72, 200, 520, 220),
    ];
    expect(orderElements(els, 'ltr', 10).map((e) => e.id)).toEqual(['title', 'L1', 'L2', 'R1', 'R2', 'foot']);
    expect(orderElements(els, 'rtl', 10).map((e) => e.id)).toEqual(['title', 'R1', 'R2', 'L1', 'L2', 'foot']);
  });

  it('does not treat stacked short lines that never sit side by side as columns', () => {
    const els = [el('a', 400, 50, 520, 60), el('b', 72, 80, 200, 90)];
    expect(orderElements(els, 'ltr', 10).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('ruled table detection', () => {
  it('builds rows/cols, merged title row and header flags from ruling lines', () => {
    const h = (y: number, x0 = 70, x1 = 330): Rule => ({ orientation: 'h', x0, x1, top: y, bottom: y });
    const v = (x: number, top: number, bottom: number): Rule => ({ orientation: 'v', x0: x, x1: x, top, bottom });
    const rules = [h(100), h(115), h(130), h(145), v(70, 100, 145), v(200, 115, 145), v(330, 100, 145)];
    const bold = { bold: true };
    const segs = buildSegments([
      item('Score (title)', 75, 150, 102, 10, bold),
      item('Feature', 75, 120, 117, 10, bold),
      item('Points', 205, 240, 117, 10, bold),
      item('Fever', 75, 105, 132),
      item('≥ 37.3 °C', 205, 250, 132),
    ]);
    const { tables, used } = detectRuledTables(rules, segs, { pageWidth: 600 });
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect([t.rows, t.cols]).toEqual([3, 2]);
    expect(t.cells.find((c) => c.r === 0)).toMatchObject({ colspan: 2, header: true, text: 'Score (title)' });
    expect(t.cells.filter((c) => c.r === 1).every((c) => c.header)).toBe(true);
    expect(t.cells.find((c) => c.r === 2 && c.c === 1)?.text).toBe('≥ 37.3 °C');
    expect(used.size).toBe(5);
    expect(serializeTable(t, 'Table 9: x')).toBe('Table 9: x\nScore (title)\nFeature | Points\nFeature: Fever | Points: ≥ 37.3 °C');
  });

  it('ignores a simple box around a paragraph (one cell is not a table)', () => {
    const rules: Rule[] = [
      { orientation: 'h', x0: 70, x1: 300, top: 100, bottom: 100 },
      { orientation: 'h', x0: 70, x1: 300, top: 140, bottom: 140 },
      { orientation: 'v', x0: 70, x1: 70, top: 100, bottom: 140 },
      { orientation: 'v', x0: 300, x1: 300, top: 100, bottom: 140 },
    ];
    const segs = buildSegments([item('A note in a box with enough words to be prose.', 80, 290, 110)]);
    expect(detectRuledTables(rules, segs, { pageWidth: 600 }).tables).toHaveLength(0);
  });
});

describe('PNG codec and scan-quality metrics', () => {
  const synth = (w: number, h: number, paper: number, ink: number, blur = false): RgbaImage => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // "text": dark 2-px strokes every 12 px on a band of lines
        const stroke = y % 20 < 10 && x % 12 < 2;
        let v = stroke ? ink : paper;
        if (blur && x % 12 === 2) v = Math.round((ink + paper) / 2);
        if (blur && x % 12 === 3) v = Math.round((ink + 3 * paper) / 4);
        const o = (y * w + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  };

  it('round-trips encode → decode and crops', () => {
    const img = synth(64, 40, 250, 10);
    const png = encodePng(img);
    expect(imageSize(png)).toEqual({ width: 64, height: 40 });
    const back = decodePng(png);
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
    const crop = cropImage(back, { left: 10, top: 5, width: 20, height: 10 });
    expect([crop.width, crop.height]).toEqual([20, 10]);
    expect(crop.data[0]).toBe(img.data[(5 * 64 + 10) * 4]);
  });

  it('tells crisp scans from washed-out ones, and blank pages from content', () => {
    expect(measureImageQuality(synth(200, 200, 250, 10)).lowQuality).toBe(false);
    const faint = measureImageQuality(synth(200, 200, 215, 180, true));
    expect(faint.lowQuality).toBe(true);
    expect(faint.reasons).toContain('low_contrast');
    const blank = measureImageQuality(synth(100, 100, 250, 250));
    expect(blank.blank).toBe(true);
    expect(blank.lowQuality).toBe(false);
  });

  it('refuses decompression bombs and interlaced/garbage input', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(100_000, 0);
    ihdr.writeUInt32BE(100_000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
    };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bomb = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(10))), chunk('IEND', Buffer.alloc(0))]);
    expect(() => decodePng(bomb)).toThrow(PngError);
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(PngError);
  });
});

describe('XML parser safety', () => {
  it('parses OOXML-like parts and decodes entities', () => {
    const el = parseXml('<?xml version="1.0"?><a:p xmlns:a="x"><a:r><a:t>Shock &amp; sepsis &#x2022;</a:t></a:r></a:p>');
    expect(el.name).toBe('a:p');
    expect(JSON.stringify(el)).toContain('Shock & sepsis •');
  });
  it('rejects DTDs (no external entities / entity expansion)', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')).toThrow(XmlError);
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
  });
});

describe('lecture kind suggestion', () => {
  it('suggests from term frequencies with reasons, and abstains on weak signal', () => {
    const clinical = suggestLectureKind('Clinical presentation. Diagnosis and management of the patient. Differential diagnosis. Treatment.');
    expect(clinical.kind).toBe('clinical');
    expect(clinical.reasons_ar.join(' ')).toContain('diagnosis');
    const practical = suggestLectureKind('Practical lab: staining steps. Prepare the slide, use the microscope, follow the procedure steps.');
    expect(practical.kind).toBe('practical');
    expect(suggestLectureKind('Hello world.').kind).toBeNull();
    const mixed = suggestLectureKind('Definition and mechanism and classification and pathophysiology. Patient diagnosis management treatment.');
    expect(mixed.kind).toBe('mixed');
  });
});

describe('external tool runner', () => {
  it('kills a command that exceeds its timeout', async () => {
    const sleep = findExecutable('sleep');
    if (!sleep) return;
    await expect(runCommand(sleep, ['5'], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' });
  });
  it('reports a failing converter as a ToolError (never a fake PDF)', async () => {
    const falseBin = findExecutable('false');
    if (!falseBin) return;
    await expect(convertToPdf({ soffice: falseBin, input: Buffer.from('x'), inputExt: 'doc', tmpRoot: '/tmp' })).rejects.toBeInstanceOf(ToolError);
  });
});
