// Regression (independent review of track B1): a quick horizontal FINGER STROKE in a paged layout turned the
// page right after it was written. The ink layer ends its stroke (onStrokeActiveChange(false)) in a native
// listener that runs BEFORE the canvas's React pointerup handler, so the old «is a stroke active?» check was
// already false when the swipe was evaluated. §24: no page flip during — or caused by — a pen stroke.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { SourcePageView } from '@medlevo/shared';
import { BookCanvas } from './BookCanvas';
import { buildSequence } from '../model/sequence';
import { ReaderPageContext, type ReaderPageContextValue } from './readerContext';
import { flipBlocked, STROKE_SETTLE_MS, SwipeTracker, type SwipePointer } from './swipe';

const p = (o: Partial<SwipePointer>): SwipePointer => ({ pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0, timeStamp: 0, defaultPrevented: false, ...o });

describe('SwipeTracker', () => {
  it('a plain horizontal finger swipe turns the page (RTL: left-to-right = next)', () => {
    const t = new SwipeTracker();
    t.down(p({ clientX: 100, clientY: 200, timeStamp: 0 }));
    expect(t.up(p({ clientX: 260, clientY: 210, timeStamp: 200 }), true)).toBe(1);
    t.down(p({ clientX: 260, clientY: 200, timeStamp: 0 }));
    expect(t.up(p({ clientX: 100, clientY: 200, timeStamp: 200 }), true)).toBe(-1);
    t.down(p({ clientX: 260, clientY: 200, timeStamp: 0 }));
    expect(t.up(p({ clientX: 100, clientY: 200, timeStamp: 200 }), false)).toBe(1);
  });

  it('a finger the ink layer claimed for writing is never a swipe (down, move or up claimed)', () => {
    const t = new SwipeTracker();
    t.down(p({ clientX: 100, defaultPrevented: true }));
    expect(t.up(p({ clientX: 300, timeStamp: 100 }), true)).toBe(0);
    t.down(p({ clientX: 100 }));
    t.move(p({ clientX: 200, defaultPrevented: true }));
    expect(t.up(p({ clientX: 300, timeStamp: 100 }), true)).toBe(0);
    t.down(p({ clientX: 100 }));
    expect(t.up(p({ clientX: 300, timeStamp: 100, defaultPrevented: true }), true)).toBe(0);
  });

  it('a touch that moved while a pen stroke was in progress (palm) is not a swipe', () => {
    const t = new SwipeTracker();
    t.down(p({ clientX: 100 }));
    t.move(p({ clientX: 150 }), true);
    expect(t.up(p({ clientX: 300, timeStamp: 100 }), true)).toBe(0);
  });

  it('ignores pens, slow drags, vertical moves, cancelled and pinched gestures', () => {
    const t = new SwipeTracker();
    t.down(p({ pointerType: 'pen', clientX: 100 }));
    expect(t.up(p({ pointerType: 'pen', clientX: 300, timeStamp: 100 }), true)).toBe(0);
    t.down(p({ clientX: 100 }));
    expect(t.up(p({ clientX: 300, timeStamp: 900 }), true)).toBe(0);
    t.down(p({ clientX: 100, clientY: 0 }));
    expect(t.up(p({ clientX: 180, clientY: 200, timeStamp: 100 }), true)).toBe(0);
    t.down(p({ clientX: 100 }));
    expect(t.up({ ...p({ clientX: 300, timeStamp: 100 }), cancelled: true }, true)).toBe(0);
    t.down(p({ clientX: 100 }));
    t.cancel();
    expect(t.up(p({ clientX: 300, timeStamp: 100 }), true)).toBe(0);
  });
});

describe('flipBlocked', () => {
  const base = { strokeActive: false, lastStrokeEndAt: null, now: 10_000, hasSelection: false, gesture: 'key' as const };
  it('blocks every flip during a stroke or a selection', () => {
    expect(flipBlocked(base)).toBe(false);
    expect(flipBlocked({ ...base, strokeActive: true })).toBe(true);
    expect(flipBlocked({ ...base, hasSelection: true, gesture: 'swipe' })).toBe(true);
  });
  it('blocks a swipe that arrives right after a stroke ended; keys are not delayed', () => {
    expect(flipBlocked({ ...base, gesture: 'swipe', lastStrokeEndAt: 10_000 - 20 })).toBe(true);
    expect(flipBlocked({ ...base, gesture: 'swipe', lastStrokeEndAt: 10_000 - STROKE_SETTLE_MS - 1 })).toBe(false);
    expect(flipBlocked({ ...base, gesture: 'key', lastStrokeEndAt: 10_000 - 20 })).toBe(false);
  });
});

describe('BookCanvas swipe (component)', () => {
  const page = (i: number): SourcePageView => ({
    id: `P${i}`,
    version_id: 'V1',
    page_index: i,
    printed_label: null,
    printed_label_origin: null,
    kind: 'page',
    width: 595,
    height: 842,
    unit: 'pt',
    rotation: 0,
    text_status: 'digital',
    ocr_confidence: null,
    has_images: false,
    processing_status: 'ready',
    error_code: null,
    error_detail_ar: null,
    thumbnail_file_id: null,
    render_file_id: null,
    section_key: null,
  });
  const ctx: ReaderPageContextValue = {
    sourceId: 'S1',
    versionId: 'V1',
    mode: 'pdf',
    pdf: null,
    textInteractive: true,
    inkInteractive: true,
    inkEnabled: false,
    onStrokeActiveChange: () => undefined,
    highlight: null,
    searchResults: [],
    currentResult: null,
    registerTextRoot: () => undefined,
    anchorFor: () => null,
    textLang: null,
    reportPageSize: () => undefined,
  };
  function setup() {
    const onSwipe = vi.fn();
    const r = render(
      <ReaderPageContext.Provider value={ctx}>
        <BookCanvas
          id="book"
          sheets={buildSequence([page(0), page(1), page(2)], [])}
          fallbackSize={null}
          pageIndex={0}
          zoom={1}
          fit={null}
          viewRotation={0}
          layout="single"
          spreadRtl
          flipAnimation={false}
          label="book"
          onLocation={() => undefined}
          onEffectiveZoom={() => undefined}
          onZoomGesture={() => undefined}
          onViewed={() => undefined}
          onSwipe={onSwipe}
          strokeActive={() => false}
        />
      </ReaderPageContext.Provider>,
    );
    return { onSwipe, el: r.container.querySelector<HTMLElement>('#book')! };
  }
  const touch = (x: number) => ({ pointerId: 7, pointerType: 'touch', clientX: x, clientY: 300, isPrimary: true });

  it('turns the page on a finger swipe the ink layer did not claim', () => {
    const { onSwipe, el } = setup();
    fireEvent.pointerDown(el, touch(100));
    fireEvent.pointerUp(el, touch(300));
    expect(onSwipe).toHaveBeenCalledWith(1);
  });

  it('does NOT turn the page after a finger stroke the ink layer wrote (it prevents the default of its events)', () => {
    const { onSwipe, el } = setup();
    // stands in for the ink layer's native listeners on its root (they run before React's root listener)
    const claim = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', claim);
    el.addEventListener('pointermove', claim);
    el.addEventListener('pointerup', claim);
    fireEvent.pointerDown(el, touch(100));
    fireEvent.pointerMove(el, touch(200));
    fireEvent.pointerUp(el, touch(300));
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
