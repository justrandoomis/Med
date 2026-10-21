// Review of parity N1 wave 2 — R9: the neat copy (G11) is derived from the stored strokes; it was derived again on every
// zoom / pinch frame (every line regrouped, every point transformed) although the strokes had not changed. It is now
// derived once per change of the page's writing; a new zoom only redraws it.
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { annotationTargetKey, newId, type AnnotationAnchor } from '@medlevo/shared';
import { InkLayer, InkProvider } from '../../src/features/workspace/ink';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { makeInkItem } from '../../src/features/workspace/ink/model';
import * as neat from '../../src/features/workspace/ink/neatCopy';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { installSettings, stubContext, ToolProbe } from './n1-helpers';

vi.mock('../../src/features/workspace/ink/neatCopy', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/features/workspace/ink/neatCopy')>();
  return { ...m, neatCopyItems: vi.fn(m.neatCopyItems) };
});

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
      closePath() {}
      arc() {}
      quadraticCurveTo() {}
      bezierCurveTo() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubContext() as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setInkSettingsBackend(null);
  __resetStores();
  vi.restoreAllMocks();
});

describe('R9 the neat copy across zoom', () => {
  it('is derived once for the page writing, not again on every zoom step', async () => {
    const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: newId(), space: 'page_norm' };
    const key = annotationTargetKey(anchor);
    const docKey = `doc-n1-neat-${newId()}`;
    const store = getDocumentStore(docKey);
    const tree = (scale: number) => (
      <InkProvider documentKey={docKey}>
        <ToolProbe set="lasso" />
        <div className="wk-sheet">
          <InkLayer targetKey={key} anchor={anchor} view={{ pageWidth: 600, pageHeight: 800, scale, rotation: 0 }} interactive />
        </div>
      </InkProvider>
    );
    const r = render(tree(1));
    await store.whenLoaded(key);
    const pts: Array<[number, number, number]> = [0, 1, 2, 3, 4, 5].map((i) => [0.2 + i * 0.05, 0.3 + i * 0.01, i * 10]);
    const stroke = makeInkItem({ id: newId(), anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: pts, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
    act(() => store.commit('كتابة', [{ id: stroke.id, targetKey: key, before: null, after: stroke }]));
    // the neat copy on (the page menu's toggle sets this session state)
    const { useInkInternal } = await import('../../src/features/workspace/ink/InkProvider');
    let toggle: ((k: string) => void) | null = null;
    function Grab() {
      toggle = useInkInternal().toggleNeat;
      return null;
    }
    r.rerender(
      <InkProvider documentKey={docKey}>
        <ToolProbe set="lasso" />
        <Grab />
        <div className="wk-sheet">
          <InkLayer targetKey={key} anchor={anchor} view={{ pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 }} interactive />
        </div>
      </InkProvider>,
    );
    act(() => toggle!(key));
    const calls = () => (neat.neatCopyItems as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const first = calls();
    expect(first).toBeGreaterThan(0);
    for (const scale of [1.1, 1.25, 1.5, 2]) {
      r.rerender(
        <InkProvider documentKey={docKey}>
          <ToolProbe set="lasso" />
          <Grab />
          <div className="wk-sheet">
            <InkLayer targetKey={key} anchor={anchor} view={{ pageWidth: 600, pageHeight: 800, scale, rotation: 0 }} interactive />
          </div>
        </InkProvider>,
      );
    }
    expect(calls()).toBe(first);
    // new writing: derived again
    const more = { ...stroke, id: newId(), data: { ...stroke.data, points: stroke.data.points.map((p) => [p[0], p[1] + 0.2, p[2]] as [number, number, number]) } };
    act(() => store.commit('كتابة', [{ id: more.id, targetKey: key, before: null, after: more }]));
    expect(calls()).toBeGreaterThan(first);
  });
});
