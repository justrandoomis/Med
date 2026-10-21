// Shared helpers of the parity-N1 ink tests: a real <InkLayer> in jsdom with synthetic pointer events (no 2D canvas:
// input and persistence run, painting is skipped), an in-memory `ink` settings backend, and a stub 2D context for the
// paint-path tests.
import { act, render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { vi } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor, type QuarterTurn } from '@medlevo/shared';
import { InkLayer, InkProvider, InkToolbar, useInk } from '../../src/features/workspace/ink';
import { memoryInkSettingsBackend, setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { getDocumentStore } from '../../src/features/workspace/ink/store';
import type { InkTextEditorProps, InkToolId } from '../../src/features/workspace/ink/types';

export function ToolProbe({ set }: { set?: InkToolId }) {
  const ink = useInk();
  useEffect(() => {
    if (set) ink.setTool(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  return <output data-testid="tool">{ink.toolState.tool}</output>;
}

export function installSettings(initial?: unknown) {
  const b = memoryInkSettingsBackend(initial);
  setInkSettingsBackend(b);
  return b;
}

export interface LayerSetup {
  root: HTMLElement;
  store: ReturnType<typeof getDocumentStore>;
  key: string;
  anchor: AnnotationAnchor;
  docKey: string;
  view: { pageWidth: number; pageHeight: number; scale: number; rotation: QuarterTurn };
  rerender: () => void;
}

export function setupLayer(
  tool: InkToolId,
  opts: {
    rotation?: QuarterTurn;
    scale?: number;
    penOnly?: boolean;
    toolbar?: boolean;
    wrap?: (n: ReactNode) => ReactNode;
    /** (review) wraps everything inside the provider — the toolbar too (e.g. an <InkHost>) */
    around?: (n: ReactNode) => ReactNode;
    textEditor?: React.ComponentType<InkTextEditorProps>;
    docKey?: string;
    anchor?: AnnotationAnchor;
    prefs?: Record<string, unknown>;
  } = {},
): LayerSetup {
  const { rotation = 0, scale = 1, penOnly = false } = opts;
  window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly, ...opts.prefs }));
  const anchor: AnnotationAnchor = opts.anchor ?? { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 0, space: 'page_norm' };
  const key = annotationTargetKey(anchor);
  const view = { pageWidth: 600, pageHeight: 800, scale, rotation };
  const docKey = opts.docKey ?? `doc-n1-${newId()}`;
  const wrap = opts.wrap ?? ((n: ReactNode) => n);
  const around = opts.around ?? ((n: ReactNode) => n);
  const tree = () => (
    <InkProvider documentKey={docKey} textEditor={opts.textEditor}>
      {around(
        <>
          <ToolProbe set={tool} />
          {opts.toolbar && <InkToolbar />}
          {wrap(
            <div style={{ position: 'relative' }}>
              <InkLayer targetKey={key} anchor={anchor} view={view} interactive />
            </div>,
          )}
        </>,
      )}
    </InkProvider>
  );
  const r = render(tree());
  const root = r.container.querySelector('.ml-ink-layer') as HTMLElement;
  const w = rotation % 180 ? 800 * scale : 600 * scale;
  const h = rotation % 180 ? 600 * scale : 800 * scale;
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: w, height: h, right: 10 + w, bottom: 20 + h, x: 10, y: 20, toJSON: () => ({}) } as DOMRect);
  return { root, store: getDocumentStore(docKey), key, anchor, docKey, view, rerender: () => r.rerender(tree()) };
}

let pid = 100;
/** A pointer event at layer-local css px (x, y). */
export function pointer(root: HTMLElement, type: string, x: number, y: number, init: PointerEventInit = {}) {
  act(() => {
    root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'mouse',
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x + 10,
        clientY: y + 20,
        pressure: type === 'pointerup' ? 0 : 0.5,
        isPrimary: true,
        ...init,
      }),
    );
  });
}

/** One stroke through the given layer-local points. */
export function stroke(root: HTMLElement, pts: Array<[number, number]>, init: PointerEventInit = {}) {
  const id = ++pid;
  pointer(root, 'pointerdown', pts[0]![0], pts[0]![1], { pointerId: id, ...init });
  for (const p of pts.slice(1, -1)) pointer(root, 'pointermove', p[0], p[1], { pointerId: id, ...init });
  const last = pts[pts.length - 1]!;
  pointer(root, 'pointerup', last[0], last[1], { pointerId: id, ...init });
}

/** A 2D context that records what was drawn (jsdom has none). */
export function stubContext(): CanvasRenderingContext2D & { calls: string[] } {
  const calls: string[] = [];
  const noop = (name: string) => (..._args: unknown[]) => {
    calls.push(name);
  };
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    save: noop('save'),
    restore: noop('restore'),
    setTransform: noop('setTransform'),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    clearRect: noop('clearRect'),
    beginPath: noop('beginPath'),
    rect: noop('rect'),
    clip: noop('clip'),
    stroke: noop('stroke'),
    fill: noop('fill'),
    fillRect: noop('fillRect'),
    strokeRect: noop('strokeRect'),
    moveTo: noop('moveTo'),
    lineTo: noop('lineTo'),
    arc: noop('arc'),
    closePath: noop('closePath'),
    setLineDash: noop('setLineDash'),
    drawImage: noop('drawImage'),
    getContextAttributes: () => ({ desynchronized: false }),
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
}
