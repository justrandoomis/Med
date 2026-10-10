// Mixed Arabic / English text in this feature's copy: LTR runs (file names, sizes, commands, English terms) are
// isolated with <bdi dir="ltr"> through the design system's <Bidi> — never with invisible control characters.
import { Fragment } from 'react';
import { detectDir, segmentRuns } from '@medlevo/shared';
import { Bidi } from '../../design';

export function Mixed({ text }: { text: string }) {
  const dir = detectDir(text);
  if (dir === 'ltr') return <Bidi dir="ltr">{text}</Bidi>;
  return (
    <>
      {segmentRuns(text, 'rtl').map((r, i) =>
        r.dir === 'ltr' ? (
          <Bidi key={i} dir="ltr">
            {r.t}
          </Bidi>
        ) : (
          <Fragment key={i}>{r.t}</Fragment>
        ),
      )}
    </>
  );
}

/** A title of unknown direction (source titles are Arabic or English). */
export function Title({ text }: { text: string }) {
  return <Bidi dir={detectDir(text)}>{text}</Bidi>;
}
