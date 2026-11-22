// A small, SAFE markdown renderer for the chat (the owner's messages and the streamed, unverified draft): headings,
// bullet / numbered lists, tables, fenced code, quotes, **bold**, *italic*, `code`. It builds React elements only —
// never HTML strings, never links or images (nothing a model writes can become markup, a URL or a script).
// AC-20: every block takes the direction of its first strong letter and every inline run of the other script is
// isolated in <bdi> by BidiText (shared segmentRuns), so «… البطن (CT abdomen)» keeps its brackets on the right side.
import { Fragment, type ReactNode } from 'react';
import { BidiText } from '../../evidence/BidiText';
import { firstStrongDir } from '../../../lib/MixedText';

export type MdInline = { kind: 'text' | 'bold' | 'italic' | 'code'; text: string };
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string; lang: string | null }
  | { kind: 'quote'; text: string };

const BULLET = /^\s*(?:[-*•]|\d+[.)]|[٠-٩]+[.)])\s+/u;
const ORDERED = /^\s*(?:\d+|[٠-٩]+)[.)]\s+/u;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Block structure of a markdown text (tolerant: an unfinished draft parses as far as it goes). */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of an unfinished draft)
      out.push({ kind: 'code', text: body.join('\n'), lang: fence[1] || null });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'heading', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, text: h[2]!.trim() });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ kind: 'table', header, rows });
      continue;
    }
    if (BULLET.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i]!) && ORDERED.test(lines[i]!) === ordered) items.push(lines[i++]!.replace(BULLET, '').trim());
      out.push({ kind: 'list', ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      out.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !BULLET.test(lines[i]!) && !/^\s*(#{1,6}\s|```|>)/.test(lines[i]!) && !(lines[i]!.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!))) {
      para.push(lines[i++]!.trim());
    }
    out.push({ kind: 'paragraph', text: para.join('\n') });
  }
  return out;
}

/** Inline marks: `code` first (nothing inside it is a mark), then **bold**, then *italic* / _italic_. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ kind: 'bold', text: (m[2] ?? m[3])! });
    else out.push({ kind: 'italic', text: (m[4] ?? m[5])! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Plain text of a block line (marks removed) — its direction is that of its first strong letter. */
function plain(text: string): string {
  return parseInline(text)
    .map((x) => x.text)
    .join('');
}

function Inline({ text }: { text: string }) {
  const dir = firstStrongDir(plain(text));
  return (
    <>
      {parseInline(text).map((x, i) => {
        if (x.kind === 'code') {
          return (
            <bdi key={i} dir="ltr">
              <code className="ch-md__code">{x.text}</code>
            </bdi>
          );
        }
        // line breaks inside a paragraph stay line breaks
        const parts = x.text.split('\n');
        const body = parts.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {p && <BidiText as="span" dir={dir} text={p} />}
          </Fragment>
        ));
        if (x.kind === 'bold') return <strong key={i}>{body}</strong>;
        if (x.kind === 'italic') return <em key={i}>{body}</em>;
        return <Fragment key={i}>{body}</Fragment>;
      })}
    </>
  );
}

function Line({ as: Tag, text, className }: { as: 'p' | 'li' | 'h3' | 'h4' | 'h5' | 'th' | 'td' | 'blockquote'; text: string; className?: string }) {
  const dir = firstStrongDir(plain(text));
  return (
    <Tag dir={dir} lang={dir === 'rtl' ? 'ar' : 'en'} className={className}>
      <Inline text={text} />
    </Tag>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  const blocks = parseMarkdown(text);
  return (
    <div className={['ch-md', className].filter(Boolean).join(' ')}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <Line key={i} as={b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5'} className="ch-md__h" text={b.text} />;
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul';
            return (
              <L key={i} className="ch-md__list" dir={firstStrongDir(plain(b.items.join(' ')))}>
                {b.items.map((it, j) => (
                  <Line key={j} as="li" text={it} />
                ))}
              </L>
            );
          }
          case 'table':
            return (
              <div key={i} className="ch-md__table-wrap" role="region" aria-label="جدول" tabIndex={0}>
                <table className="ch-md__table" dir={firstStrongDir(plain(b.header.join(' ')))}>
                  <thead>
                    <tr>
                      {b.header.map((c, j) => (
                        <Line key={j} as="th" text={c} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <Line key={k} as="td" text={c} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return (
              <pre key={i} className="ch-md__pre" dir="ltr" lang="en">
                <code>{b.text}</code>
              </pre>
            );
          case 'quote':
            return <Line key={i} as="blockquote" className="ch-md__quote" text={b.text} />;
          default:
            return <Line key={i} as="p" className="ch-md__p" text={b.text} />;
        }
      })}
    </div>
  );
}
