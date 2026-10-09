// A server-built line mixing Arabic and English (origin labels «سؤال من مصدر الأسئلة — Surgery Bank — ص 1–2 …»,
// lecture titles): base direction from its strong characters, every opposite-direction island isolated in <bdi>
// so names and ranges never reorder (§21). No bidi control characters are inserted.
import { Fragment } from 'react';
import { detectDir, segmentRuns } from '@medlevo/shared';

export function MixedLine({ text, className }: { text: string; className?: string }) {
  const dir = detectDir(text);
  return (
    <bdi dir={dir} lang={dir === 'ltr' ? 'en' : 'ar'} className={className}>
      {segmentRuns(text, dir).map((r, i) =>
        r.dir && r.dir !== dir ? (
          <bdi key={i} dir={r.dir} lang={r.dir === 'ltr' ? 'en' : 'ar'}>
            {r.t}
          </bdi>
        ) : (
          <Fragment key={i}>{r.t}</Fragment>
        ),
      )}
    </bdi>
  );
}
