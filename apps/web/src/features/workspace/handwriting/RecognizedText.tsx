// A machine reading of handwriting (track F4): lines of words, each word isolated in its own direction (Arabic /
// Latin), uncertain words marked by a dotted underline AND a «؟» marker AND a spoken label — never by colour alone.
import { Fragment } from 'react';
import { detectDir, UNCERTAIN_WORD_LABEL_AR, type RecognizedLine, type RecognizedWord } from '@medlevo/shared';

function Word({ w }: { w: RecognizedWord }) {
  const dir = detectDir(w.text) === 'ltr' ? 'ltr' : 'rtl';
  if (!w.uncertain) return <bdi dir={dir}>{w.text}</bdi>;
  const alts = w.alternatives?.length ? `؛ قراءات أخرى ممكنة: ${w.alternatives.join('، ')}` : '';
  return (
    <mark className="hw-uncertain" title={`${UNCERTAIN_WORD_LABEL_AR}${alts}`} data-uncertain="">
      <bdi dir={dir}>{w.text}</bdi>
      <span className="hw-uncertain__flag" aria-hidden="true">
        ؟
      </span>
      <span className="ml-visually-hidden">
        {' '}
        ({UNCERTAIN_WORD_LABEL_AR}
        {alts})
      </span>
    </mark>
  );
}

export function lineDir(l: RecognizedLine): 'rtl' | 'ltr' {
  let rtl = 0;
  let ltr = 0;
  for (const w of l.words) {
    if (detectDir(w.text) === 'ltr') ltr += w.text.length;
    else rtl += w.text.length;
  }
  return ltr > rtl ? 'ltr' : 'rtl';
}

export function RecognizedLines({ lines, label = 'النص المقروء من خط يدك' }: { lines: RecognizedLine[]; label?: string }) {
  if (lines.length === 0) return null;
  return (
    <div className="hw-lines" role="group" aria-label={label}>
      {lines.map((l, i) => (
        <p key={i} className="hw-line" dir={lineDir(l)}>
          {l.words.map((w, j) => (
            <Fragment key={j}>
              {j > 0 && ' '}
              <Word w={w} />
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

export function uncertainSummaryAr(n: number): string | null {
  if (n <= 0) return null;
  if (n === 1) return 'كلمة واحدة غير مؤكدة (مسطّرة بخط منقّط وعليها «؟»): راجعها.';
  if (n === 2) return 'كلمتان غير مؤكدتين (مسطّرتان بخط منقّط وعليهما «؟»): راجعهما.';
  return `${n} ${n <= 10 ? 'كلمات غير مؤكدة' : 'كلمة غير مؤكدة'} (مسطّرة بخط منقّط وعليها «؟»): راجعها.`;
}
