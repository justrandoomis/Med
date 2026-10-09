// Bidi-safe rendering of mixed Arabic/English text with optional highlight ranges (§21, AC-20).
// Direction runs are computed on the WHOLE text first (segmentRuns), then highlights are cut INSIDE each run,
// so a highlight never splits an LTR island into two isolates (which would reorder «11 ×10⁹/L» visually).
// DOM order = logical order; no bidi control characters are inserted.
import { Fragment, type ReactNode } from 'react';
import { detectDir, segmentRuns, type Dir, type Run, type SearchHighlight } from '@medlevo/shared';

function cut(text: string, offset: number, highlights: SearchHighlight[]): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  const end = offset + text.length;
  for (const h of highlights) {
    if (h.end <= offset || h.start >= end) continue;
    // overlapping ranges must never print the same characters twice
    const s = Math.max(Math.max(h.start, offset) - offset, cursor);
    const e = Math.min(h.end, end) - offset;
    if (s > cursor) out.push(text.slice(cursor, s));
    if (e > s) out.push(<mark key={`${offset}-${s}`} className="ev-mark">{text.slice(s, e)}</mark>);
    cursor = Math.max(cursor, e);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export interface BidiTextProps {
  text: string;
  highlights?: SearchHighlight[];
  /** paragraph direction (default: detected from the text) */
  dir?: Dir;
  as?: 'p' | 'span' | 'div' | 'blockquote';
  className?: string;
  lang?: string;
}

/** A paragraph of mixed text with LTR/RTL islands isolated in <bdi> and optional <mark> highlights. */
export function BidiText({ text, highlights = [], dir, as: Tag = 'p', className, lang }: BidiTextProps) {
  const paraDir = dir ?? detectDir(text);
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  const runs: Run[] = segmentRuns(text, paraDir);
  let offset = 0;
  const nodes = runs.map((r, i) => {
    const start = offset;
    offset += r.t.length;
    const content = cut(r.t, start, sorted);
    const rdir = r.dir ?? paraDir;
    if (rdir !== paraDir) {
      return (
        <bdi key={i} dir={rdir} lang={rdir === 'ltr' ? 'en' : 'ar'} className={rdir === 'ltr' ? 'ml-ltr' : 'ml-rtl-island'}>
          {content}
        </bdi>
      );
    }
    return <Fragment key={i}>{content}</Fragment>;
  });
  return (
    <Tag dir={paraDir} lang={lang ?? (paraDir === 'rtl' ? 'ar' : 'en')} className={className}>
      {nodes}
    </Tag>
  );
}

/**
 * A snippet that may span several source lines (chunks join regions with «\n»): each line is its own
 * paragraph with its own direction, highlights rebased per line. Text stays in logical order.
 */
export function BidiLines({ text, highlights = [], className }: { text: string; highlights?: SearchHighlight[]; className?: string }) {
  const lines: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start });
    start += line.length + 1;
  }
  return (
    <div className={className}>
      {lines
        .filter((l) => l.text.trim().length > 0)
        .map((l) => (
          <BidiText
            key={l.start}
            text={l.text}
            highlights={highlights
              .filter((h) => h.end > l.start && h.start < l.start + l.text.length)
              .map((h) => ({ start: Math.max(h.start, l.start) - l.start, end: Math.min(h.end, l.start + l.text.length) - l.start }))}
          />
        ))}
    </div>
  );
}
