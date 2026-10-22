// One page of an explanation drawn over the official page's thumbnail (P1-T5 step 3): the publication page's previews
// and the update preview's changed pages. The picture is the official version's thumbnail (members only); the marks are
// SVG in the page's normalized space. Marks of an update are told apart by their line (solid = added, dashed = changed,
// dotted = removed) and named in the caption — never by colour alone.
import { useState } from 'react';
import type { NormBox } from '@medlevo/shared';
import { publicationsApi } from './api';
import type { ChangeMark } from './publicationPreview';
import './publications.css';

const MARK_CLASS: Record<ChangeMark['kind'], string> = {
  added: 'pb-preview__mark pb-preview__mark--added',
  changed: 'pb-preview__mark pb-preview__mark--changed',
  removed: 'pb-preview__mark pb-preview__mark--removed',
};

export function PagePreviewFrame({
  spaceId,
  pageId,
  paths,
  boxes,
  marks = [],
  caption,
}: {
  spaceId: string;
  pageId: string;
  paths: readonly string[];
  boxes: readonly NormBox[];
  marks?: readonly ChangeMark[];
  caption: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <li className="pb-preview">
      <div className="pb-preview__frame">
        {!failed && <img src={publicationsApi.thumbnailUrl(spaceId, pageId)} alt="" loading="lazy" onError={() => setFailed(true)} />}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {paths.map((d, i) => (
            <path key={`p${i}`} className="pb-preview__ink" d={d} />
          ))}
          {boxes.map((b, i) => (
            <rect key={`b${i}`} className="pb-preview__box" x={b.x} y={b.y} width={b.w} height={b.h} />
          ))}
          {marks.map((m, i) => (
            <rect key={`m${i}`} className={MARK_CLASS[m.kind]} x={m.box.x} y={m.box.y} width={m.box.w} height={m.box.h} />
          ))}
        </svg>
      </div>
      <span className="pb-preview__caption">{caption}</span>
    </li>
  );
}

/** «أُضيف 3 · عُدّل 1 · حُذف 1» for the marks of one page (the words the lines stand for). */
export function marksCaptionAr(marks: readonly ChangeMark[]): string {
  const n = (k: ChangeMark['kind']) => marks.filter((m) => m.kind === k).length;
  const parts: string[] = [];
  if (n('added')) parts.push(`أُضيف ${n('added')} (خط متصل)`);
  if (n('changed')) parts.push(`عُدّل ${n('changed')} (خط متقطع)`);
  if (n('removed')) parts.push(`حُذف ${n('removed')} (خط منقّط)`);
  return parts.join(' · ');
}
