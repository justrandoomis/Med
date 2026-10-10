// DOCX export (§46, track F5): a Word document for a Study Book (generated, cited), notes, questions or a source's
// text — built with the `docx` package on the server, from the SAME views the Markdown / HTML exports use.
//   * RTL: every Arabic paragraph is a bidi paragraph (<w:bidi/>, base direction right-to-left) and its Arabic runs
//     carry <w:rtl/> + an Arabic language tag.
//   * Bidi isolation: English terms, numbers with units and formulas inside an Arabic paragraph are SEPARATE runs with
//     their own direction (no <w:rtl/>, English language tag) AND are wrapped in the Unicode isolate marks LRI … PDI
//     (RLI … PDI for an Arabic island in an English paragraph) — the DOCX equivalent of <bdi dir="ltr">. Run properties
//     alone do not isolate: without the marks «11 ×10⁹/L» inside an Arabic sentence is laid out «L/10⁹× 11» by the
//     Unicode bidi algorithm (measured with LibreOffice). These isolates are the ONLY invisible characters written,
//     only around such islands, never LRM/RLM, embeddings or overrides; the app, the Markdown and the HTML exports
//     never insert any (HTML uses <bdi>).
//   * Citations are TEXT: «المصدر — ص 12 (الصفحة 14 في الملف) — الإصدار 1» + the evidence quote, numbered [n] after
//     the claim. An internal location never becomes a hyperlink (the document has no hyperlinks at all).
//   * Generated content is labelled at the top and per aside; unverified claims say so next to their number.
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { detectDir, segmentRuns, stripBidiControls, type ClaimView, type ContentBlockView, type Paragraph as RtParagraph, type RichText } from '@medlevo/shared';
import { citationLabel } from './render';

type Dir = 'rtl' | 'ltr';

/** One run of text with its own direction and marks. */
export interface Seg {
  t: string;
  dir: Dir;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  sup?: boolean;
  sub?: boolean;
  /** quieter ink (labels, metadata) */
  muted?: boolean;
}

export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; segs: Seg[]; dir: Dir }
  | { kind: 'para'; dir: Dir; segs: Seg[]; style?: 'label' | 'generated' | 'meta' | 'quote' | 'aside' | 'caption' }
  | { kind: 'bullet'; dir: Dir; segs: Seg[] }
  | { kind: 'table'; dir: Dir; header: Seg[][]; rows: Seg[][][] };

/** Claim markers: «[n]» after a claim's last run (+ «(لم يُتحقق منه بعد)» when not linked). */
export type ClaimMarker = (claimId: string) => Seg[] | null;

const LTR_KINDS = new Set(['latin', 'term', 'unit', 'formula', 'number']);
// XML 1.0 forbids C0 controls except tab / LF / CR; bidi controls are never written (logical order is kept)
// eslint-disable-next-line no-control-regex -- removing control characters that XML cannot carry
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const clean = (s: string) => stripBidiControls(s).replace(XML_INVALID, '');

/** Plain text → segments: LTR islands of an RTL paragraph (and RTL islands of an LTR one) become their own runs. */
export function textSegs(text: string, dir: Dir = detectDir(text), extra: Omit<Seg, 't' | 'dir'> = {}): Seg[] {
  return segmentRuns(clean(text).replace(/\s*\n\s*/g, ' '), dir).map((r) => ({ t: r.t, dir: r.dir ?? dir, ...extra }));
}

function paragraphSegs(p: RtParagraph, marker?: ClaimMarker): Seg[] {
  const out: Seg[] = [];
  const runs = p.runs;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const marks = new Set(r.marks ?? []);
    const extra = { b: marks.has('b'), i: marks.has('i') || marks.has('em'), u: marks.has('u'), sup: marks.has('sup'), sub: marks.has('sub') };
    const runDir: Dir = r.dir ?? (r.kind && LTR_KINDS.has(r.kind) ? 'ltr' : p.dir);
    // an RTL run of a mixed paragraph may still hold Latin islands (generated text): isolate them too
    if (runDir === p.dir && !r.dir) out.push(...textSegs(r.t, p.dir, extra));
    else out.push({ t: clean(r.t).replace(/\s*\n\s*/g, ' '), dir: runDir, ...extra });
    if (r.claim && marker && runs[i + 1]?.claim !== r.claim) {
      const m = marker(r.claim);
      if (m) out.push(...m);
    }
  }
  return out;
}

/** RichText → blocks (headings, lists, quotes, captions keep their kind). */
export function richTextBlocks(rt: RichText | null | undefined, marker?: ClaimMarker, style?: 'aside' | 'quote'): DocBlock[] {
  if (!rt) return [];
  return rt.paragraphs.map((p): DocBlock => {
    const segs = paragraphSegs(p, marker);
    if (p.kind === 'h') return { kind: 'heading', level: Math.min(3, Math.max(2, (p.level ?? 2) + 1)) as 2 | 3, segs, dir: p.dir };
    if (p.kind === 'li') return { kind: 'bullet', dir: p.dir, segs };
    if (p.kind === 'quote') return { kind: 'para', dir: p.dir, segs, style: 'quote' };
    if (p.kind === 'caption') return { kind: 'para', dir: p.dir, segs, style: 'caption' };
    return { kind: 'para', dir: p.dir, segs, ...(style ? { style } : {}) };
  });
}

export const heading = (text: string, level: 1 | 2 | 3 = 2): DocBlock => {
  const dir = detectDir(text);
  return { kind: 'heading', level, segs: textSegs(text, dir), dir };
};
export const para = (text: string, style?: Extract<DocBlock, { kind: 'para' }>['style'], extra: Omit<Seg, 't' | 'dir'> = {}): DocBlock => {
  const dir = detectDir(text);
  return { kind: 'para', dir, segs: textSegs(text, dir, extra), ...(style ? { style } : {}) };
};
export const bullet = (text: string): DocBlock => {
  const dir = detectDir(text);
  return { kind: 'bullet', dir, segs: textSegs(text, dir) };
};

// ───────────── claim citations (numbered, text only) ─────────────
const CLAIM_STATUS_AR: Record<string, string | null> = {
  linked: null,
  owner_reviewed: null,
  needs_review: 'لم يُتحقق منه بعد',
  pending: 'لم يُتحقق منه بعد',
  conflict: 'تعارض مع الدليل',
  rejected: 'مرفوض',
};
const RELATION_AR: Record<string, string> = { supports: '', partially_supports: ' (يدعم جزئيًا)', context: ' (سياق)', contradicts: ' (يناقض)' };

export class DocxCitations {
  private readonly order = new Map<string, number>();
  private readonly items: Array<{ n: number; ev: ClaimView['citations'][number]['evidence']; relation: string }> = [];
  constructor(private readonly claims: Record<string, ClaimView>) {}

  marker: ClaimMarker = (claimId) => {
    const claim = this.claims[claimId];
    if (!claim) return null;
    const out: Seg[] = [];
    for (const c of claim.citations) {
      let n = this.order.get(c.evidence.id);
      if (n === undefined) {
        n = this.items.length + 1;
        this.order.set(c.evidence.id, n);
        this.items.push({ n, ev: c.evidence, relation: c.relation });
      }
      out.push({ t: `[${n}]`, dir: 'ltr', sup: true });
    }
    const status = CLAIM_STATUS_AR[claim.verification_status] ?? null;
    if (status) out.push({ t: ` (${status})`, dir: 'rtl', muted: true });
    return out.length ? out : null;
  };

  blocks(): DocBlock[] {
    if (!this.items.length) return [];
    return [
      heading('الأدلة المستشهد بها', 2),
      ...this.items.map((i): DocBlock => {
        const quoteDir = detectDir(i.ev.quote);
        return {
          kind: 'para',
          dir: 'rtl',
          segs: [
            { t: `[${i.n}] `, dir: 'ltr', b: true },
            ...textSegs(`${citationLabel(i.ev)}${RELATION_AR[i.relation] ?? ''}: `, 'rtl'),
            { t: '«', dir: 'rtl' },
            ...textSegs(i.ev.quote, quoteDir),
            { t: '»', dir: 'rtl' },
          ],
        };
      }),
    ];
  }
}

/** A comparison table of a Study Book block. */
export function tableBlock(t: NonNullable<ContentBlockView['table']>, marker?: ClaimMarker): DocBlock {
  const cell = (rt: RichText) => rt.paragraphs.flatMap((p, i) => [...(i ? [{ t: ' / ', dir: p.dir } as Seg] : []), ...paragraphSegs(p, marker)]);
  return { kind: 'table', dir: 'rtl', header: t.header.map(cell), rows: t.rows.map((r) => r.map(cell)) };
}

// ───────────── rendering ─────────────
const INK_2 = '4F5764';
const ACCENT = '3A47A8';
const CONTENT_WIDTH = 9026; // A4 (11906 DXA) minus 2 × 1440 margins

const LRI = '\u2066';
const RLI = '\u2067';
const PDI = '\u2069';

/** An island whose direction differs from its paragraph is isolated (whitespace stays outside the isolate). */
function isolated(s: Seg, paragraphDir: Dir): string {
  if (s.dir === paragraphDir) return s.t;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.t)!;
  if (!m[2]) return s.t;
  return `${m[1]}${s.dir === 'ltr' ? LRI : RLI}${m[2]}${PDI}${m[3]}`;
}

function runOf(s: Seg, base: { size?: number; bold?: boolean; color?: string } = {}, paragraphDir: Dir = s.dir): TextRun {
  const bold = s.b || base.bold || false;
  return new TextRun({
    text: isolated(s, paragraphDir),
    rightToLeft: s.dir === 'rtl',
    bold,
    boldComplexScript: bold,
    italics: s.i ?? false,
    italicsComplexScript: s.i ?? false,
    ...(s.u ? { underline: {} } : {}),
    ...(s.sup ? { superScript: true } : {}),
    ...(s.sub ? { subScript: true } : {}),
    ...(s.muted || base.color ? { color: s.muted ? INK_2 : base.color } : {}),
    ...(base.size ? { size: base.size, sizeComplexScript: base.size } : {}),
    language: s.dir === 'rtl' ? { value: 'ar-SA', bidirectional: 'ar-SA' } : { value: 'en-US', bidirectional: 'ar-SA' },
  });
}

function paragraphOf(b: Exclude<DocBlock, { kind: 'table' }>): Paragraph {
  const bidirectional = b.dir === 'rtl';
  if (b.kind === 'heading') {
    const level = b.level === 1 ? HeadingLevel.TITLE : b.level === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
    return new Paragraph({ heading: level, bidirectional, children: b.segs.map((s) => runOf(s, {}, b.dir)), spacing: { before: b.level === 1 ? 0 : 240, after: 120 } });
  }
  if (b.kind === 'bullet') return new Paragraph({ bidirectional, numbering: { reference: 'ml-bullets', level: 0 }, children: b.segs.map((s) => runOf(s, {}, b.dir)) });
  switch (b.style) {
    case 'generated':
      return new Paragraph({
        bidirectional,
        children: b.segs.map((s) => runOf(s, { bold: true, color: ACCENT }, b.dir)),
        shading: { type: ShadingType.CLEAR, fill: 'E7E9F6', color: 'auto' },
        border: { top: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 }, bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } },
        spacing: { after: 160 },
      });
    case 'label':
      return new Paragraph({ bidirectional, children: b.segs.map((s) => runOf(s, { color: INK_2 }, b.dir)), shading: { type: ShadingType.CLEAR, fill: 'F7F5EF', color: 'auto' }, spacing: { after: 120 } });
    case 'meta':
      return new Paragraph({ bidirectional, children: b.segs.map((s) => runOf(s, { size: 18, color: INK_2 }, b.dir)), spacing: { after: 120 } });
    case 'quote':
    case 'aside':
      return new Paragraph({
        bidirectional,
        indent: { left: 360, right: 360 },
        border: { right: { style: BorderStyle.SINGLE, size: 12, color: 'CFCDC6', space: 8 } },
        children: b.segs.map((s) => runOf(s, {}, b.dir)),
      });
    case 'caption':
      return new Paragraph({ bidirectional, children: b.segs.map((s) => runOf({ ...s, i: true }, { color: INK_2 }, b.dir)) });
    default:
      return new Paragraph({ bidirectional, children: b.segs.map((s) => runOf(s, {}, b.dir)), spacing: { after: 120 } });
  }
}

function tableOf(b: Extract<DocBlock, { kind: 'table' }>): Table {
  const cols = Math.max(1, b.header.length, ...b.rows.map((r) => r.length));
  const w = Math.floor(CONTENT_WIDTH / cols);
  const cell = (segs: Seg[], header: boolean) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F7F5EF', color: 'auto' } } : {}),
      children: [new Paragraph({ bidirectional: b.dir === 'rtl', children: segs.map((s) => runOf({ ...s, b: s.b || header }, {}, b.dir)) })],
    });
  const pad = (r: Seg[][]) => [...r, ...new Array<Seg[]>(Math.max(0, cols - r.length)).fill([])];
  return new Table({
    visuallyRightToLeft: b.dir === 'rtl',
    width: { size: w * cols, type: WidthType.DXA },
    columnWidths: new Array<number>(cols).fill(w),
    rows: [new TableRow({ tableHeader: true, children: pad(b.header).map((c) => cell(c, true)) }), ...b.rows.map((r) => new TableRow({ children: pad(r).map((c) => cell(c, false)) }))],
  });
}

/** Build the .docx (A4, RTL defaults, bullets through a numbering definition). */
export async function buildDocx(title: string, blocks: DocBlock[], opts: { description?: string } = {}): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  for (const b of blocks) {
    if (b.kind === 'table') {
      children.push(tableOf(b));
      children.push(new Paragraph({ bidirectional: true, children: [] }));
    } else children.push(paragraphOf(b));
  }
  const doc = new Document({
    creator: 'MedLevo',
    title: clean(title),
    description: opts.description ? clean(opts.description) : undefined,
    styles: {
      default: {
        document: {
          run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial', eastAsia: 'Calibri' }, size: 22, sizeComplexScript: 24 },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'ml-bullets',
          levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
        },
      ],
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
