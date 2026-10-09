import { Fragment, type ReactNode } from 'react';
import type { Paragraph, RichText, Run } from '@medlevo/shared';
import { cx } from '../utils';

export interface BidiProps {
  dir: 'ltr' | 'rtl';
  /** BCP-47 language of the run (defaults: ltr → en, rtl → ar). */
  lang?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Isolates a run of text in its own direction with <bdi dir> (§21). Use for every English term,
 * unit, formula or number embedded in Arabic UI copy, e.g. «افحص <Bidi dir="ltr">Na+ 135 mmol/L</Bidi>».
 * Never inserts invisible bidi control characters, so copy/search see the logical text.
 */
export function Bidi({ dir, lang, children, className }: BidiProps) {
  return (
    <bdi dir={dir} lang={lang ?? (dir === 'ltr' ? 'en' : 'ar')} className={cx(dir === 'ltr' ? 'ml-ltr' : 'ml-rtl-island', className)}>
      {children}
    </bdi>
  );
}

/** Shorthand for an English/LTR term inside Arabic. */
export function Term({ children, lang = 'en' }: { children: ReactNode; lang?: string }) {
  return (
    <Bidi dir="ltr" lang={lang} className="ml-term">
      {children}
    </Bidi>
  );
}

const MARK_TAG: Record<NonNullable<Run['marks']>[number], 'b' | 'i' | 'u' | 'sup' | 'sub' | 'em'> = {
  b: 'b',
  i: 'i',
  u: 'u',
  sup: 'sup',
  sub: 'sub',
  em: 'em',
};

function wrapMarks(node: ReactNode, marks: Run['marks']): ReactNode {
  if (!marks || marks.length === 0) return node;
  return marks.reduceRight<ReactNode>((inner, m) => {
    const Tag = MARK_TAG[m];
    return <Tag>{inner}</Tag>;
  }, node);
}

function RunView({ run, paragraphDir }: { run: Run; paragraphDir: 'rtl' | 'ltr' }) {
  const dir = run.dir ?? paragraphDir;
  const kindClass = run.kind && run.kind !== 'text' ? `ml-run--${run.kind}` : undefined;
  const dataProps = {
    'data-kind': run.kind,
    'data-claim': run.claim,
    'data-ev': run.ev && run.ev.length ? run.ev.join(' ') : undefined,
    'data-term': run.term,
  };
  let content: ReactNode = run.kind === 'code' ? <code>{run.t}</code> : run.t;
  content = wrapMarks(content, run.marks);

  if (dir !== paragraphDir) {
    // Opposite-direction island → isolate it.
    return (
      <bdi dir={dir} lang={run.lang ?? (dir === 'ltr' ? 'en' : 'ar')} className={cx(dir === 'ltr' ? 'ml-ltr' : 'ml-rtl-island', kindClass)} {...dataProps}>
        {content}
      </bdi>
    );
  }
  if (run.lang || kindClass || run.claim || run.ev || run.term) {
    return (
      <span lang={run.lang} className={kindClass} {...dataProps}>
        {content}
      </span>
    );
  }
  return <>{content}</>;
}

function ParagraphView({ p, headingOffset }: { p: Paragraph; headingOffset: number }) {
  const runs = p.runs.map((r, i) => <RunView key={i} run={r} paragraphDir={p.dir} />);
  // An LTR paragraph inside the Arabic document must not inherit lang="ar" (screen readers would read
  // English with an Arabic voice). Use the language its same-direction runs declare, else English.
  const lang = p.dir === 'rtl' ? 'ar' : (p.runs.find((r) => (r.dir ?? p.dir) === 'ltr' && r.lang)?.lang ?? 'en');
  switch (p.kind) {
    case 'h': {
      const level = Math.min(6, headingOffset + (p.level ?? 1)) as 1 | 2 | 3 | 4 | 5 | 6;
      const H = `h${level}` as const;
      return (
        <H dir={p.dir} lang={lang} className="ml-rt__h">
          {runs}
        </H>
      );
    }
    case 'quote':
      return (
        <blockquote dir={p.dir} lang={lang} className="ml-rt__quote">
          {runs}
        </blockquote>
      );
    case 'caption':
      return (
        <p dir={p.dir} lang={lang} className="ml-rt__caption">
          {runs}
        </p>
      );
    case 'li':
      return (
        <li dir={p.dir} lang={lang} className="ml-rt__li">
          {runs}
        </li>
      );
    default:
      return (
        <p dir={p.dir} lang={lang} className="ml-rt__p">
          {runs}
        </p>
      );
  }
}

export interface RichTextViewProps {
  value: RichText | null | undefined;
  /** reading: book text (Naskh, larger, looser). ui: interface text. */
  variant?: 'reading' | 'ui';
  /** Heading level offset: a paragraph with kind 'h' level 1 renders as h(offset+1). */
  headingOffset?: number;
  className?: string;
  /** Rendered when value has no paragraphs. */
  empty?: ReactNode;
}

/**
 * Renders structured RichText (§21): each paragraph carries its own dir; runs in the opposite
 * direction (English terms, units, formulas inside Arabic) are isolated with <bdi dir="ltr"> and a
 * lang attribute. DOM order equals logical order, so selection, copy and find-in-page return the
 * stored text unchanged (no invisible characters are added).
 */
export function RichTextView({ value, variant = 'ui', headingOffset = 2, className, empty = null }: RichTextViewProps) {
  if (!value || value.paragraphs.length === 0) return <>{empty}</>;
  // group consecutive list items into one <ul>
  const blocks: Array<{ list: boolean; items: Paragraph[] }> = [];
  for (const p of value.paragraphs) {
    const isLi = p.kind === 'li';
    const last = blocks[blocks.length - 1];
    if (isLi && last?.list) last.items.push(p);
    else blocks.push({ list: isLi, items: [p] });
  }
  return (
    <div className={cx('ml-rt', `ml-rt--${variant}`, className)}>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} dir={b.items[0]!.dir} className="ml-rt__ul">
            {b.items.map((p, j) => (
              <ParagraphView key={j} p={p} headingOffset={headingOffset} />
            ))}
          </ul>
        ) : (
          <Fragment key={i}>
            <ParagraphView p={b.items[0]!} headingOffset={headingOffset} />
          </Fragment>
        ),
      )}
    </div>
  );
}
