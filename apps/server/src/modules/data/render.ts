// Text rendering for exports (§46): RichText / plain text → Markdown or print-ready HTML.
//  * HTML: every value is escaped; paragraphs carry dir + lang; LTR runs inside RTL paragraphs (terms, units,
//    numbers with units) are isolated with <bdi dir="ltr" lang="en"> — no invisible bidi control characters are
//    ever inserted (logical order is kept, so copy/search in the exported file return the stored text).
//  * Markdown: logical-order text, Markdown syntax characters escaped (source text can never become a link,
//    an image or raw HTML), no links at all (an export never turns an internal location into a fake link).
import { detectDir, segmentRuns, type EvidenceView, type Paragraph, type RichText } from '@medlevo/shared';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Escape Markdown syntax so source/owner text renders literally (no links, images, HTML, emphasis or headings). */
export function mdEscape(s: string): string {
  return s
    .replace(/[\\`*_[\]<>#|~!{}]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([-+=]|\d+[.)])(\s)/gm, (_m, a: string, b: string, c: string) => `${a}\\${b}${c}`);
}

function bidiHtml(text: string, paragraphDir: 'rtl' | 'ltr'): string {
  return segmentRuns(text, paragraphDir)
    .map((r) => {
      const dir = r.dir ?? paragraphDir;
      if (dir === paragraphDir) return escapeHtml(r.t);
      return `<bdi dir="${dir}" lang="${dir === 'ltr' ? 'en' : 'ar'}">${escapeHtml(r.t)}</bdi>`;
    })
    .join('');
}

/** Plain text (e.g. a region or a question stem) → one HTML paragraph with direction and isolated runs. */
export function textToHtml(text: string, tag: 'p' | 'li' | 'blockquote' | 'h2' | 'h3' | 'span' = 'p', cls?: string): string {
  const dir = detectDir(text);
  const lang = dir === 'rtl' ? 'ar' : 'en';
  return `<${tag} dir="${dir}" lang="${lang}"${cls ? ` class="${cls}"` : ''}>${bidiHtml(text, dir)}</${tag}>`;
}

/** Mixed inline text inside an element of known direction (labels, citations). */
export function inlineHtml(text: string, dir: 'rtl' | 'ltr' = 'rtl'): string {
  return bidiHtml(text, dir);
}

export interface ClaimMarkerFn {
  (claimId: string): { md: string; html: string } | null;
}

function paragraphRuns(p: Paragraph, marker?: ClaimMarkerFn): { md: string; html: string } {
  let md = '';
  let html = '';
  const runs = p.runs;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    const runDir = r.dir ?? (r.kind === 'latin' || r.kind === 'term' || r.kind === 'unit' || r.kind === 'formula' || r.kind === 'number' ? 'ltr' : p.dir);
    // an RTL run of a mixed paragraph may still hold Latin islands (generated text): isolate them too
    let h = runDir === p.dir && p.dir === 'rtl' && !r.dir ? bidiHtml(r.t, 'rtl') : escapeHtml(r.t);
    let m = mdEscape(r.t);
    for (const mark of r.marks ?? []) {
      if (mark === 'b') {
        h = `<b>${h}</b>`;
        m = m.trim() ? `**${m}**` : m;
      } else if (mark === 'i' || mark === 'em') {
        h = `<i>${h}</i>`;
        m = m.trim() ? `*${m}*` : m;
      } else if (mark === 'u') h = `<u>${h}</u>`;
      else if (mark === 'sup') h = `<sup>${h}</sup>`;
      else if (mark === 'sub') h = `<sub>${h}</sub>`;
    }
    if (runDir !== p.dir) h = `<bdi dir="${runDir}" lang="${escapeHtml(r.lang ?? (runDir === 'ltr' ? 'en' : 'ar'))}">${h}</bdi>`;
    md += m;
    html += h;
    // a claim's citations follow its LAST run
    if (r.claim && marker && runs[i + 1]?.claim !== r.claim) {
      const mk = marker(r.claim);
      if (mk) {
        md += mk.md;
        html += mk.html;
      }
    }
  }
  return { md, html };
}

export function richTextToMarkdown(rt: RichText | null | undefined, marker?: ClaimMarkerFn): string {
  if (!rt) return '';
  const out: string[] = [];
  for (const p of rt.paragraphs) {
    const { md } = paragraphRuns(p, marker);
    if (p.kind === 'h') out.push(`${'#'.repeat(Math.min(6, (p.level ?? 2) + 1))} ${md}`);
    else if (p.kind === 'li') out.push(`- ${md}`);
    else if (p.kind === 'quote') out.push(`> ${md}`);
    else out.push(md);
  }
  return out.join('\n\n');
}

export function richTextToHtml(rt: RichText | null | undefined, marker?: ClaimMarkerFn): string {
  if (!rt) return '';
  const out: string[] = [];
  let inList = false;
  for (const p of rt.paragraphs) {
    const { html } = paragraphRuns(p, marker);
    const attrs = `dir="${p.dir}" lang="${p.dir === 'rtl' ? 'ar' : 'en'}"`;
    if (p.kind === 'li') {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li ${attrs}>${html}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (p.kind === 'h') out.push(`<h${Math.min(6, (p.level ?? 2) + 1)} ${attrs}>${html}</h${Math.min(6, (p.level ?? 2) + 1)}>`);
    else if (p.kind === 'quote') out.push(`<blockquote ${attrs}>${html}</blockquote>`);
    else if (p.kind === 'caption') out.push(`<p class="caption" ${attrs}>${html}</p>`);
    else out.push(`<p ${attrs}>${html}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

export function richTextPlain(rt: RichText | null | undefined): string {
  if (!rt) return '';
  return rt.paragraphs.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
}

/** «المصدر — ص 12 (الصفحة 14 في الملف) — الإصدار 1» (+ availability note) — text only, never a link. */
export function citationLabel(e: Pick<EvidenceView, 'source_title' | 'locator_label_ar' | 'version_no' | 'availability'>): string {
  const note =
    e.availability === 'source_deleted'
      ? ' (المصدر محذوف الآن)'
      : e.availability === 'version_replaced'
        ? ' (هذا الإصدار استُبدل بإصدار أحدث)'
        : '';
  return `${e.source_title} — ${e.locator_label_ar} — الإصدار ${e.version_no}${note}`;
}

export const PRINT_CSS = `
@page { size: A4; margin: 18mm 16mm; }
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 44rem; padding: 24px 16px; font-family: "IBM Plex Sans Arabic", "Noto Naskh Arabic", "Segoe UI", Tahoma, sans-serif; font-size: 16px; line-height: 1.8; color: #1C2230; background: #FFFFFF; }
h1 { font-size: 1.6rem; line-height: 1.4; margin: 0 0 .5rem; }
h2 { font-size: 1.25rem; margin: 1.6rem 0 .5rem; }
h3, h4, h5, h6 { font-size: 1.05rem; margin: 1.2rem 0 .4rem; }
p, li { margin: .4rem 0; }
bdi[dir="ltr"] { font-family: "IBM Plex Sans Arabic", "Segoe UI", Arial, sans-serif; }
.meta { color: #4F5764; font-size: .9rem; }
.label { display: block; border-inline-start: 3px solid #3A47A8; padding: .4rem .8rem; margin: .8rem 0; background: #F4F5FB; font-size: .92rem; }
.generated { border-inline-start-color: #7D5200; background: #FFF8E8; }
.aside { border-inline-start: 3px solid #B5B2AB; padding-inline-start: .8rem; margin: .8rem 0; }
.aside > .aside-title { font-weight: 600; font-size: .92rem; }
blockquote { margin: .6rem 0; padding: .3rem .9rem; border-inline-start: 3px solid #666D79; color: #1C2230; background: #F7F7F5; }
.cite { font-size: .8em; vertical-align: super; color: #3A47A8; }
.unverified { font-size: .85em; color: #7D5200; }
.citations li { font-size: .92rem; }
.quote { display: block; margin-top: .15rem; color: #4F5764; }
table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .92rem; }
th, td { border: 1px solid #B5B2AB; padding: .35rem .5rem; vertical-align: top; text-align: start; }
.page { page-break-inside: auto; border-top: 1px solid #DDD; padding-top: .6rem; margin-top: 1rem; }
.page-label { font-weight: 600; font-size: .95rem; }
.option-correct { font-weight: 600; }
.question { page-break-inside: avoid; border-top: 1px solid #DDD; padding-top: .6rem; margin-top: 1rem; }
.caption { color: #4F5764; font-size: .9rem; }
@media print { body { max-width: none; padding: 0; } .noprint { display: none; } a { color: inherit; text-decoration: none; } }
`;

/**
 * Complete print-ready RTL HTML document (no scripts, no external resources). The document carries its own CSP so
 * that, wherever it is opened (a saved file, or the print window the app fills from a same-origin blob: URL),
 * nothing in it can ever run or load — defence in depth on top of the escaping above.
 */
export function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="generator" content="MedLevo export">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<p class="label noprint">للحصول على PDF: افتح هذا الملف في المتصفح ثم اختر «طباعة» ← «حفظ بصيغة PDF». (PDF عبر الطباعة من المتصفح.)</p>
${body}
</body>
</html>
`;
}
