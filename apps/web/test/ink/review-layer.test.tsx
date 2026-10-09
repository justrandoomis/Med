// Regression tests from the independent review: the InkLayer input path at its edges
// (pointercancel / lost capture / unmount mid-stroke / scrolling mid-stroke) and what a screen
// reader is told about the page.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkData } from '@medlevo/shared';
import { CapabilityPanel, InkLayer, InkProvider, useInk } from '../../src/features/workspace/ink';
import { buildCapabilityReport, EMPTY_OBSERVATIONS, type ApiSupport } from '../../src/features/workspace/ink/capabilities';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { getDb } from '../../src/lib/localdb';
import type { InkToolId } from '../../src/features/workspace/ink/types';

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  __resetStores();
});

function ToolProbe({ set }: { set: InkToolId }) {
  const ink = useInk();
  useEffect(() => {
    ink.setTool(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  return null;
}

interface Rect {
  left: number;
  top: number;
}

function setup(tool: InkToolId = 'pen') {
  window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly: true }));
  const anchor: AnnotationAnchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 0, space: 'page_norm' };
  const key = annotationTargetKey(anchor);
  const view = { pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 as const };
  const active = vi.fn();
  const docKey = `doc-review-${newId()}`;
  const ui = (mounted: boolean) => (
    <InkProvider documentKey={docKey}>
      <ToolProbe set={tool} />
      {mounted && <InkLayer targetKey={key} anchor={anchor} view={view} interactive onStrokeActiveChange={active} />}
    </InkProvider>
  );
  const r = render(ui(true));
  const root = r.container.querySelector('.ml-ink-layer') as HTMLElement;
  const rect: Rect = { left: 10, top: 20 };
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(
    () => ({ left: rect.left, top: rect.top, width: 600, height: 800, right: rect.left + 600, bottom: rect.top + 800, x: rect.left, y: rect.top, toJSON: () => ({}) }) as DOMRect,
  );
  return { root, rect, key, active, store: getDocumentStore(docKey), unmountLayer: () => r.rerender(ui(false)) };
}

/** page-local css px → client px with the layer at `rect` */
function pointer(root: HTMLElement, rect: Rect, type: string, x: number, y: number, init: PointerEventInit = {}) {
  act(() => {
    root.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'pen', button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x + rect.left, clientY: y + rect.top, pressure: 0.5, isPrimary: true, ...init }),
    );
  });
}

describe('pointercancel / lost capture never lose or duplicate a stroke', () => {
  it('pointercancel keeps the stroke once; a following lostpointercapture adds nothing', async () => {
    const { root, rect, key, active, store } = setup();
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, rect, 'pointerdown', 60, 80);
    pointer(root, rect, 'pointermove', 120, 80);
    pointer(root, rect, 'pointercancel', 120, 80);
    act(() => {
      root.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3, pointerType: 'pen' }));
    });
    expect(store.items(key)).toHaveLength(1);
    expect(active.mock.calls.map((c) => c[0])).toEqual([true, false]);
    await store.flush();
    const ops = await getDb().outbox.where('entity_id').equals(store.items(key)[0]!.id).toArray();
    expect(ops.map((o) => o.op)).toEqual(['append']);
  });

  it('lostpointercapture alone (capture taken away) ends the stroke and keeps it', async () => {
    const { root, rect, key, store } = setup();
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, rect, 'pointerdown', 60, 80);
    pointer(root, rect, 'pointermove', 160, 80);
    act(() => {
      root.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 3, pointerType: 'pen' }));
    });
    pointer(root, rect, 'pointerup', 160, 80);
    expect(store.items(key)).toHaveLength(1);
    await store.flush();
  });

  it('the page layer unmounting in the middle of a stroke (virtualized page) keeps what was written', async () => {
    const { root, rect, key, active, store, unmountLayer } = setup();
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, rect, 'pointerdown', 60, 80);
    pointer(root, rect, 'pointermove', 120, 90);
    pointer(root, rect, 'pointermove', 180, 100);
    act(() => unmountLayer());
    const items = store.items(key);
    expect(items).toHaveLength(1);
    expect((items[0]!.data as InkData).points.length).toBe(3);
    expect(active).toHaveBeenLastCalledWith(false);
    await store.flush();
    expect(await getDb().annotations.get(items[0]!.id)).toBeDefined();
  });
});

describe('lasso drag interrupted (Escape / tool switch while dragging)', () => {
  it('the dragged strokes become visible again and the reader is told the gesture ended', async () => {
    const { root, rect, key, active, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, rect, 'pointerdown', 60, 300);
    pointer(root, rect, 'pointermove', 200, 300);
    pointer(root, rect, 'pointerup', 300, 300);
    const id = store.items(key)[0]!.id;
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    act(() => store.setSelection({ targetKey: key, ids: [id] }));
    const frame = await waitFor(() => {
      const f = root.querySelector('.ml-ink-selection');
      expect(f).not.toBeNull();
      return f as HTMLElement;
    });
    act(() => {
      fireEvent.pointerDown(frame, { pointerId: 5, button: 0, pointerType: 'mouse', clientX: 100, clientY: 320 });
    });
    expect(store.isHidden(id)).toBe(true); // drawn by the live preview while dragging
    expect(active).toHaveBeenLastCalledWith(true);
    // Escape during the drag clears the selection → the overlay goes away mid-drag
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => expect(root.querySelector('.ml-ink-selection')).toBeNull());
    expect(store.isHidden(id)).toBe(false);
    expect(active).toHaveBeenLastCalledWith(false);
    // nothing was moved (an interrupted drag is a cancel)
    expect(store.items(key)[0]!.id).toBe(id);
    expect(store.history.size.undo).toBe(1);
    await store.flush();
  });
});

describe('coordinates while the page scrolls under the pen', () => {
  it('a scroll during the stroke is taken into account (the stroke follows the page, not stale layout)', async () => {
    const { root, rect, key, store } = setup();
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, rect, 'pointerdown', 60, 80);
    // a finger elsewhere scrolls the reader by 100 px while the pen keeps writing
    const clientY = 80 + rect.top;
    rect.top -= 100;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      root.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'pen', buttons: 1, clientX: 200 + 10, clientY, pressure: 0.5 }));
    });
    pointer(root, rect, 'pointerup', 200, 180);
    const pts = (store.items(key)[0]!.data as InkData).points;
    expect(pts[0]![1]).toBeCloseTo(80 / 800, 5);
    // the same client y is now 100 css px further down the page
    expect(pts[1]![1]).toBeCloseTo(180 / 800, 5);
    await store.flush();
  });
});

describe('screen-reader summary of the page', () => {
  it('counts strokes as they are written (not only text boxes / sticky notes)', async () => {
    const { root, rect, key, store } = setup();
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    await act(() => store.whenLoaded(key));
    const summary = () => root.querySelector('p.ml-visually-hidden')!.textContent ?? '';
    await waitFor(() => expect(summary()).toContain('لا توجد كتابة'));
    pointer(root, rect, 'pointerdown', 60, 80);
    pointer(root, rect, 'pointermove', 160, 80);
    pointer(root, rect, 'pointerup', 200, 80);
    await waitFor(() => expect(summary()).toContain('خطوط بالقلم 1'));
    await store.flush();
  });
});

describe('capability panel: offline writing is only claimed after local storage really opened', () => {
  const api: ApiSupport = { pointerEvents: true, coalesced: true, predicted: true, altitude: true, touchType: false, indexedDB: true, anyFinePointer: true, anyHover: true };
  const offline = (storage: 'ok' | 'failed' | null) => buildCapabilityReport(api, EMPTY_OBSERVATIONS, { storage }).find((r) => r.key === 'offline')!;

  it('the IndexedDB global alone is not proof (private modes expose it but refuse to open)', () => {
    expect(offline(null).state).toBe('not_observed');
    expect(offline('failed').state).toBe('not_reported');
    expect(offline('ok').state).toBe('supported');
  });

  it('the live panel opens the local database before saying «مدعوم»', async () => {
    const spy = vi.spyOn(getDb(), 'open').mockRejectedValueOnce(new Error('InvalidStateError'));
    render(<CapabilityPanel />);
    const row = (await screen.findByText('الكتابة دون اتصال')).closest('li') as HTMLElement;
    await waitFor(() => expect(row.textContent).toContain('لا يبلّغ عنه هذا الجهاز'));
    expect(spy).toHaveBeenCalled();
  });
});
