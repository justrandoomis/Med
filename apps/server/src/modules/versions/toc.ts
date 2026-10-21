// Printed table of contents → page links (PRD AOS-3.9). A «Contents» / «الفهرس» page among the first pages is parsed
// into entries «title …… page», and each printed page number is resolved to a page of the file: by the page's own
// printed number first, then by a page whose heading carries the entry title, and only as a labelled estimate by the
// file order. Computed on request from the stored regions (cheap: the first pages only); nothing is stored.
import type { PrintedTocEntry, PrintedTocView, TocResolution } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { normalizeIdentityText, toLatinDigits } from '../sources/classify';
import { pageLabelKnown, versionIsNumbered } from '../sources/pagelabel';

const TOC_SCAN_PAGES = 12;
const TOC_HEADING = /^(?:table of contents|contents|content|فهرس المحتويات|الفهرس|فهرس|المحتويات|محتويات)\s*:?$/;
// «Title ........ 12», «Title …… 12», «Title — 12», «Title    12»; also RTL text extracted number-first: «12 ..... العنوان»
const ENTRY_TRAILING = /^(.{2,140}?)\s*(?:[.·…•_\-–—]{2,}|\s{2,}|\t+)\s*(\d{1,4})$/u;
const ENTRY_LEADING = /^(\d{1,4})\s*(?:[.·…•_\-–—]{2,}|\s{2,}|\t+)\s*(.{2,140}?)$/u;
const ENTRY_LOOSE = /^(.{3,140}?)\s+(\d{1,4})$/u;

export interface TocPageInput {
  page_index: number;
  lines: string[];
}

export interface ParsedToc {
  toc_page_indexes: number[];
  entries: Array<{ title: string; printed_page: string; toc_page_index: number }>;
}

function parseLine(line: string, loose: boolean): { title: string; page: string } | null {
  const l = toLatinDigits(line).replace(/\s+$/, '').trim();
  let m = ENTRY_TRAILING.exec(l);
  if (m) return { title: m[1]!.trim(), page: m[2]! };
  m = ENTRY_LEADING.exec(l);
  if (m) return { title: m[2]!.trim(), page: m[1]! };
  if (loose) {
    m = ENTRY_LOOSE.exec(l);
    if (m && /\p{L}{2}/u.test(m[1]!)) return { title: m[1]!.trim(), page: m[2]! };
  }
  return null;
}

/** Pure: find the printed contents page(s) among the first pages and read their entries. */
export function parsePrintedToc(pages: readonly TocPageInput[]): ParsedToc {
  const out: ParsedToc = { toc_page_indexes: [], entries: [] };
  let inToc = false;
  for (const p of pages.slice(0, TOC_SCAN_PAGES)) {
    const lines = p.lines.map((l) => l.trim()).filter(Boolean);
    const titled = lines.slice(0, 3).some((l) => TOC_HEADING.test(normalizeIdentityText(l)));
    // a contents page has its heading, or (continuing one) at least 3 dotted entries
    const strict = lines.map((l) => parseLine(l, false)).filter((x): x is { title: string; page: string } => !!x);
    const isToc = titled ? true : inToc && strict.length >= 3;
    if (!isToc) {
      if (inToc) break;
      continue;
    }
    inToc = true;
    out.toc_page_indexes.push(p.page_index);
    for (const l of lines) {
      if (TOC_HEADING.test(normalizeIdentityText(l))) continue;
      const e = parseLine(l, titled);
      if (e && +e.page > 0) out.entries.push({ title: e.title.replace(/[.·…•_\-–—\s]+$/u, ''), printed_page: String(+e.page), toc_page_index: p.page_index });
    }
  }
  return out;
}

const norm = (s: string) => normalizeIdentityText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

export function printedToc(ctx: AppContext, versionId: string): PrintedTocView {
  if (!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [versionId])) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  const pages = ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: string }>(
    'SELECT id, page_index, printed_label, kind FROM source_page WHERE version_id = ? ORDER BY page_index',
    [versionId],
  );
  const regions = ctx.db.all<{ page_index: number; kind: string; text: string }>(
    `SELECT p.page_index, r.kind, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.status <> 'rejected' AND r.text IS NOT NULL AND r.kind NOT IN ('header','footer','table_cell')
      ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const linesByPage = new Map<number, string[]>();
  const headingsByPage = new Map<number, string[]>();
  for (const r of regions) {
    if (r.page_index < TOC_SCAN_PAGES) linesByPage.set(r.page_index, [...(linesByPage.get(r.page_index) ?? []), ...r.text.split(/\n+/)]);
    if (r.kind === 'heading' || !headingsByPage.has(r.page_index)) headingsByPage.set(r.page_index, [...(headingsByPage.get(r.page_index) ?? []), norm(r.text.split(/\n/)[0] ?? '')]);
  }
  const parsed = parsePrintedToc([...linesByPage].map(([page_index, lines]) => ({ page_index, lines })).sort((a, b) => a.page_index - b.page_index));
  const numbered = versionIsNumbered(ctx.db, versionId);
  const lastToc = Math.max(-1, ...parsed.toc_page_indexes);
  const byLabel = new Map<string, (typeof pages)[number]>();
  for (const p of pages) if (p.printed_label && p.page_index > lastToc && !byLabel.has(p.printed_label)) byLabel.set(p.printed_label, p);
  const target = (p: (typeof pages)[number]) => ({
    page_id: p.id,
    page_index: p.page_index,
    label_ar: pageLabelKnown({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind, numbered_version: numbered }),
  });
  const entries: PrintedTocEntry[] = parsed.entries.map((e) => {
    let resolution: TocResolution = 'unresolved';
    let page: (typeof pages)[number] | undefined = byLabel.get(e.printed_page);
    if (page) resolution = 'printed_label';
    if (!page) {
      const t = norm(e.title);
      if (t.length >= 4) page = pages.find((p) => p.page_index > lastToc && (headingsByPage.get(p.page_index) ?? []).some((h) => h.includes(t)));
      if (page) resolution = 'title_match';
    }
    if (!page && !numbered) {
      const n = Number(e.printed_page);
      page = pages[n - 1];
      if (page) resolution = 'file_order';
    }
    return { title: e.title, printed_page: e.printed_page, toc_page_index: e.toc_page_index, target: page ? target(page) : null, resolution: page ? resolution : 'unresolved' };
  });
  return { version_id: versionId, toc_page_indexes: parsed.toc_page_indexes, entries };
}
