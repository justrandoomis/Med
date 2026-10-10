// Overlays drawn in the page's UNROTATED layer (normalized boxes map straight to percentages; the layer
// itself is rotated with the page). Region / evidence highlight (§11), text highlights, search hits.
import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { NormBox, TextHighlightData } from '@medlevo/shared';
import { cx } from '../../../design';
import { getDb, type AnnotationRow } from '../../../lib/localdb';

function boxStyle(b: NormBox): React.CSSProperties {
  return { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` };
}

export interface RegionHighlightProps {
  pageId: string;
  /** normalized to the unrotated page box; null → whole page */
  bbox: NormBox | null;
  label?: string;
  className?: string;
}

/**
 * Highlights a cited region on its page (Source Jump, §11). Rendered inside a page's unrotated layer, so
 * it follows zoom and rotation exactly. Announces itself once for screen readers.
 */
export function RegionHighlight({ pageId, bbox, label = 'الموضع المطلوب', className }: RegionHighlightProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // keep the highlighted region in view (the page itself was scrolled to by the navigation)
    ref.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pageId, bbox?.x, bbox?.y]);
  return (
    <div
      ref={ref}
      className={cx('wk-region-hl', !bbox && 'wk-region-hl--page', className)}
      style={bbox ? boxStyle(bbox) : undefined}
      data-page-id={pageId}
      role="note"
      aria-label={label}
    />
  );
}

/** Generic boxes (search hits). `current` marks the active one. */
export function BoxesLayer({ boxes, current, className }: { boxes: NormBox[]; current?: number | null; className: string }) {
  if (boxes.length === 0) return null;
  return (
    <div className="wk-overlay" aria-hidden="true">
      {boxes.map((b, i) => (
        <span key={i} className={cx(className, i === current && `${className}--current`)} style={boxStyle(b)} />
      ))}
    </div>
  );
}

/** Saved text highlights / underlines of one page (local-first rows; synced through the outbox). */
export function TextHighlightsLayer({ targetKey }: { targetKey: string }) {
  const [rows, setRows] = useState<AnnotationRow[]>([]);
  useEffect(() => {
    // indexed by [targetKey+kind]: reads only this page's highlights (never its ink strokes), and is not re-run by
    // ink writes — with 5 000 strokes on a page the old targetKey scan re-read every stroke on every write (I2)
    const sub = liveQuery(() =>
      getDb()
        .annotations.where('[targetKey+kind]')
        .equals([targetKey, 'text_highlight'])
        .filter((a) => !a.deletedAt)
        .toArray(),
    ).subscribe({ next: setRows, error: () => setRows([]) });
    return () => sub.unsubscribe();
  }, [targetKey]);
  if (rows.length === 0) return null;
  return (
    <div className="wk-overlay" aria-hidden="true">
      {rows.flatMap((r) => {
        const d = r.data as TextHighlightData;
        if (!d || !Array.isArray(d.rects)) return [];
        return d.rects.map((b, i) => (
          <span key={`${r.id}-${i}`} className={cx('wk-mark', d.style === 'underline' ? 'wk-mark--underline' : 'wk-mark--highlight')} data-annotation-id={r.id} style={boxStyle(b)} />
        ));
      })}
    </div>
  );
}
