// Review of parity N1 wave 2 (independent adversarial review, BUILD_PLAN §1.2). Each test reproduced a defect before
// its fix (or guards a scope item the review verified):
//  * R1 «أفسح مكانًا» sideways moved the writing of EVERY line left of the press, not only the line pressed;
//  * R2 «أفسح مكانًا» pushed writing past the page edge, where it is drawn nowhere and no tool can reach it;
//  * R3 a duplicated / pasted diagram kept its connectors attached to the ORIGINAL shapes: moving an original pulled the
//    copy's connector away from the copied shapes;
//  * R4 the zoom window's box lost the strip's proportions (wide strip, large line height, narrow margins): the ink was
//    saved away from where the pen wrote in the strip;
//  * R5 auto-advance on the last line of the page wrapped onto that same line (writing over it);
//  * R6 drawing a shape rebuilt every snap target of the page on each pointer move;
//  * R7 closing the page menu from the keyboard dropped the focus to the document;
//  * R8 a diagram's connections were spoken once when drawn and never again (canvas only): the page summary now says them;
//  * guard: every new kind (pencil grain, dashes, fill, pathway heads) draws in e-ink greys only.
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INK_SETTINGS, newId, richTextFromPlain, type InkData, type ShapeData } from '@medlevo/shared';
import { useInkInternal } from '../../src/features/workspace/ink/InkProvider';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { itemBBox, makeInkItem, makeShapeItem, type InkItem, type InkItemOf } from '../../src/features/workspace/ink/model';
import { drawItem } from '../../src/features/workspace/ink/render';
import { __setServerSpeaksInkV2, inkFromWire, inkToWire } from '../../src/features/workspace/ink/codec';
import { __setPageRegions } from '../../src/features/workspace/ink/pageOverlays';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { advanceBox, boxSize, lineStartBox, boxAt } from '../../src/features/workspace/ink/zoomGeometry';
import { installSettings, pointer, setupLayer, stroke, stubContext, type LayerSetup } from './n1-helpers';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setInkSettingsBackend(null);
  document.documentElement.removeAttribute('data-eink');
  __resetStores();
  vi.restoreAllMocks();
});

const AR = 800 / 600;
const px = (x: number, y: number): [number, number] => [x * 600, y * 800];
const style = { tool: 'pen' as const, color: 'ink-black', width: 0.002 };
async function put(s: LayerSetup, items: InkItem[]) {
  await s.store.whenLoaded(s.key);
  act(() => {
    s.store.commit('كتابة', items.map((it) => ({ id: it.id, targetKey: s.key, before: null, after: it })));
  });
}
function word(s: LayerSetup, x0: number, x1: number, y: number) {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i <= 8; i++) pts.push([x0 + ((x1 - x0) * i) / 8, y + (i % 2 ? 0.01 : 0), i * 10]);
  return makeInkItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), style, points: pts, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
}
function rect(s: LayerSetup, from: [number, number], to: [number, number], extra: Partial<ShapeData> = {}) {
  return makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'rect', from, to, style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra });
}
const pts = (s: LayerSetup, id: string) => (s.store.item(s.key, id) as InkItemOf<InkData>).data.points;
const shapeData = (s: LayerSetup, id: string) => (s.store.item(s.key, id) as InkItemOf<ShapeData>).data;

describe('R1 / R2 «أفسح مكانًا»', () => {
  it('sideways: only the line pressed makes room (the other lines stay where they are)', async () => {
    const s = setupLayer('insert_space');
    const right = word(s, 0.6, 0.75, 0.1);
    const left = word(s, 0.15, 0.3, 0.1);
    const otherLine = word(s, 0.15, 0.3, 0.5);
    await put(s, [right, left, otherLine]);
    // between the two words of the first line, dragged to the left (Arabic: the rest of the line moves on to the left)
    stroke(s.root, [px(0.45, 0.105), px(0.4, 0.106), px(0.35, 0.107)]);
    expect(pts(s, left.id)[0]![0]).toBeCloseTo(0.05, 2);
    expect(pts(s, right.id)).toEqual(right.data.points);
    expect(pts(s, otherLine.id)).toEqual(otherLine.data.points);
    await s.store.flush();
  });

  it('down: the writing at the bottom never leaves the page (the room made is what the page has left)', async () => {
    const s = setupLayer('insert_space');
    const above = word(s, 0.1, 0.5, 0.1);
    const bottom = word(s, 0.1, 0.5, 0.9);
    await put(s, [above, bottom]);
    stroke(s.root, [px(0.5, 0.5), px(0.5, 0.65), px(0.5, 0.8)]);
    const b = itemBBox(s.store.item(s.key, bottom.id)!, AR);
    expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-6);
    expect(b.y).toBeGreaterThan(0.9); // it did move down, as far as the page allows
    expect(pts(s, above.id)).toEqual(above.data.points);
    await waitFor(() => expect(document.body.textContent).toContain('أسفل الصفحة'));
    await s.store.flush();
  });
});

describe('R3 copies of a diagram', () => {
  it('a duplicated diagram is attached to its own copies; moving an original leaves the copy alone', async () => {
    const s = setupLayer('lasso');
    const a = rect(s, [0.1, 0.1], [0.3, 0.2]);
    const b = rect(s, [0.6, 0.1], [0.8, 0.2]);
    const c = makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'arrow', from: [0.306, 0.15], to: [0.594, 0.15], style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra: { attach: { from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } }, relation: 'causes' } });
    await put(s, [a, b, c]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [a.id, b.id, c.id] }));
    act(() => {
      s.store.duplicateSelection();
    });
    const copies = s.store.getSelection()!.ids.map((id) => s.store.item(s.key, id)! as InkItemOf<ShapeData>);
    const conn = copies.find((x) => x.data.attach)!;
    const copyIds = new Set(copies.map((x) => x.id));
    expect(copyIds.has(conn.data.attach!.from!.id)).toBe(true);
    expect(copyIds.has(conn.data.attach!.to!.id)).toBe(true);
    const before = shapeData(s, conn.id);
    // the original A moves down: only the original connector follows it
    const movedA = { ...a, data: { ...a.data, from: [0.1, 0.5] as [number, number], to: [0.3, 0.6] as [number, number] } };
    act(() => s.store.commit('نقل', [{ id: a.id, targetKey: s.key, before: s.store.item(s.key, a.id)!, after: movedA }]));
    expect(shapeData(s, conn.id)).toEqual(before);
    expect(shapeData(s, c.id).from[1]).toBeGreaterThan(0.5);
    await s.store.flush();
  });

  it('a connector copied without its shapes is pasted free (no attachment to the originals)', async () => {
    const s = setupLayer('lasso');
    const a = rect(s, [0.1, 0.1], [0.3, 0.2]);
    const b = rect(s, [0.6, 0.1], [0.8, 0.2]);
    const c = makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'arrow', from: [0.306, 0.15], to: [0.594, 0.15], style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra: { attach: { from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } } } });
    await put(s, [a, b, c]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [c.id] }));
    act(() => {
      s.store.duplicateSelection();
    });
    const pasted = s.store.item(s.key, s.store.getSelection()!.ids[0]!) as InkItemOf<ShapeData>;
    expect(pasted.id).not.toBe(c.id);
    expect(pasted.data.attach).toBeUndefined();
    const at = pasted.data.from;
    const movedA = { ...a, data: { ...a.data, from: [0.1, 0.5] as [number, number], to: [0.3, 0.6] as [number, number] } };
    act(() => s.store.commit('نقل', [{ id: a.id, targetKey: s.key, before: s.store.item(s.key, a.id)!, after: movedA }]));
    expect(shapeData(s, pasted.id).from).toEqual(at);
    await s.store.flush();
  });
});

describe('R4 / R5 the zoom window geometry', () => {
  const cssAspect = (b: { w: number; h: number }) => b.w / (b.h * AR);
  it('the box keeps the strip proportions on a wide strip and with a large line height', () => {
    // a 1 904 × 112 strip (wide screen, small strip) and a 1 348 × 152 strip with the largest line height
    for (const [lh, aspect] of [
      [0.045, 1904 / 112],
      [0.12, 1348 / 152],
      [0.015, 304 / 212],
    ] as const) {
      const b = boxSize(lh, aspect, AR);
      expect(cssAspect(b)).toBeCloseTo(aspect, 6);
      expect(b.w).toBeLessThanOrEqual(0.9 + 1e-9);
    }
  });

  it('a box placed inside narrow margins keeps the strip proportions too', () => {
    const size = boxSize(0.06, 8, AR);
    const z = { margin_start: 0.35, margin_end: 0.35 };
    for (const b of [lineStartBox(0.4, size, 'rtl', z), boxAt([0.6, 0.4], size, 'rtl', z)]) {
      expect(b.w).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(cssAspect(b)).toBeCloseTo(cssAspect(size), 6);
    }
  });

  it('on the last line of the page the window stops instead of wrapping onto that same line', () => {
    const z = { ...DEFAULT_INK_SETTINGS.zoom };
    const size = boxSize(z.line_height, 6, AR);
    const last = lineStartBox(1, size, 'rtl', z);
    const atLineEnd = { ...last, x: z.margin_end };
    const n = advanceBox(atLineEnd, 'rtl', z);
    expect(n.end).toBe(true);
    expect(n.box).toEqual(atLineEnd);
    // an earlier line still wraps to the next one
    const mid = advanceBox({ ...atLineEnd, y: 0.4 }, 'rtl', z);
    expect(mid.wrapped).toBe(true);
    expect(mid.box.y).toBeGreaterThan(0.4);
  });

  it('a stroke written in a measured strip is saved where it was drawn there (strip and box agree)', async () => {
    installSettings({ zoom: { line_height: 0.12 } });
    let internal: ReturnType<typeof useInkInternal> | null = null;
    function Probe() {
      const i = useInkInternal();
      useEffect(() => {
        internal = i;
      });
      return null;
    }
    // the strip measures 1 348 × 152 css px (an iPad in landscape)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('ml-ink-zoom__strip') ? 1348 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList?.contains('ml-ink-zoom__strip') ? 152 : 0;
    });
    const s = setupLayer('zoom_window', { toolbar: true, around: (n) => <>{n}<Probe /></> });
    await s.store.whenLoaded(s.key);
    pointer(s.root, 'pointerdown', ...px(0.8, 0.3));
    pointer(s.root, 'pointerup', ...px(0.8, 0.3));
    const strip = (await screen.findByRole('application', { name: /اكتب هنا/ })) as HTMLElement;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 500, width: 1348, height: 152, right: 1348, bottom: 652, x: 0, y: 500, toJSON: () => ({}) } as DOMRect);
    await waitFor(() => expect(cssAspect(internal!.zoom!.box)).toBeCloseTo(1348 / 152, 3));
    const box = internal!.zoom!.box;
    // the strip draws the page at one scale across and down (css px per normalized page width)
    const k = 1348 / box.w;
    const ev = (type: string, x: number, y: number) => fireEvent[type as 'pointerDown'](strip, { pointerId: 9, pointerType: 'pen', button: 0, buttons: type === 'pointerUp' ? 0 : 1, clientX: x, clientY: y, pressure: 0.5, isPrimary: true });
    ev('pointerDown', 1200, 500 + 140);
    ev('pointerMove', 1150, 500 + 140);
    ev('pointerUp', 1100, 500 + 140);
    const ink = s.store.items(s.key).find((i): i is InkItemOf<InkData> => i.kind === 'ink')!;
    const p = ink.data.points[0]!;
    // drawn in the strip at (p.x - box.x)·k across and (p.y - box.y)·AR·k down: under the pen
    expect((p[0] - box.x) * k).toBeCloseTo(1200, 0);
    expect((p[1] - box.y) * AR * k).toBeCloseTo(140, 0);
    await s.store.flush();
  });
});

describe('R6 snapping while a shape is drawn', () => {
  it('the snap targets are collected once per shape, not on every pointer move', async () => {
    const s = setupLayer('rect');
    __setPageRegions((s.anchor as { page_id: string }).page_id, [{ x: 0.6, y: 0.5, w: 0.3, h: 0.2 }]);
    const many = Array.from({ length: 40 }, (_, i) => word(s, 0.05 + (i % 8) * 0.1, 0.1 + (i % 8) * 0.1, 0.05 + Math.floor(i / 8) * 0.1));
    await put(s, many);
    const items = vi.spyOn(s.store, 'items');
    const id = 555;
    pointer(s.root, 'pointerdown', ...px(0.2, 0.6), { pointerId: id });
    for (let i = 1; i <= 30; i++) pointer(s.root, 'pointermove', ...px(0.2 + i * 0.01, 0.6 + i * 0.005), { pointerId: id });
    pointer(s.root, 'pointerup', ...px(0.5, 0.75), { pointerId: id });
    expect(items.mock.calls.length).toBeLessThanOrEqual(3);
    expect(s.store.items(s.key).filter((i) => i.kind === 'shape')).toHaveLength(1);
    await s.store.flush();
  });
});

describe('R7 / R8 keyboard and screen reader', () => {
  it('closing the page menu with Escape gives the focus back to where it was', async () => {
    const s = setupLayer('lasso', { wrap: (n) => <div className="wk-sheet wk-page"><button type="button">قبل القائمة</button>{n}</div> });
    await s.store.whenLoaded(s.key);
    act(() => s.store.markActive(s.key));
    const before = screen.getByRole('button', { name: 'قبل القائمة' });
    before.focus();
    fireEvent.keyDown(before, { key: 'ContextMenu' });
    const menu = await screen.findByRole('menu', { name: 'قائمة الصفحة' });
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'قائمة الصفحة' })).toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it('the page summary read by screen readers says what each connector of a diagram connects', async () => {
    const s = setupLayer('pen');
    const a = rect(s, [0.1, 0.1], [0.3, 0.2], { label: richTextFromPlain('Insulin') });
    const b = rect(s, [0.6, 0.1], [0.8, 0.2], { label: richTextFromPlain('GLUT4') });
    const c = makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'arrow', from: [0.306, 0.15], to: [0.594, 0.15], style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra: { attach: { from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } }, relation: 'causes' } });
    await put(s, [a, b, c]);
    await waitFor(() => expect(s.root.querySelector('.ml-visually-hidden')?.textContent).toContain('«Insulin» يسبّب «GLUT4»'));
  });
});

describe('guard: e-ink draws every new kind in greys', () => {
  it('pencil, dashes, fill and pathway heads resolve to greys under data-eink', () => {
    document.documentElement.setAttribute('data-eink', 'on');
    // jsdom has no Path2D: a stand-in (only the colours set on the context are checked here)
    vi.stubGlobal(
      'Path2D',
      class {
        moveTo() {}
        lineTo() {}
        closePath() {}
        arc() {}
      },
    );
    const ctx = stubContext();
    const seen: string[] = [];
    for (const key of ['strokeStyle', 'fillStyle'] as const) {
      let v = '#000';
      Object.defineProperty(ctx, key, {
        get: () => v,
        set: (x: unknown) => {
          v = String(x);
          seen.push(v);
        },
      });
    }
    const anchor = { type: 'note_page' as const, note_page_id: 'NP', space: 'page_norm' as const };
    const env = { W: 600, H: 800, tone: 'light' as const, css: null };
    const pencil = makeInkItem({ id: 'p', anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.004, texture: 'graphite', dash: 'dash' }, points: [[0.1, 0.1, 0, 0.3], [0.2, 0.12, 10, 0.6], [0.3, 0.1, 20, 0.9]], pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
    const box = makeShapeItem({ id: 'r', anchor, now: 1, z: 2, shape: 'rect', from: [0.1, 0.3], to: [0.4, 0.4], style: { tool: 'pen', color: 'ink-red', width: 0.003, dash: 'dot' }, extra: { fill: 'hl-yellow', corner: 0.01 } });
    const head = makeShapeItem({ id: 'h', anchor, now: 1, z: 3, shape: 'arrow', from: [0.1, 0.6], to: [0.5, 0.6], style: { tool: 'pen', color: 'ink-green', width: 0.003 }, extra: { head: 'activation' } });
    const conv = makeShapeItem({ id: 'c', anchor, now: 1, z: 4, shape: 'curved_arrow', from: [0.1, 0.7], to: [0.5, 0.8], style: { tool: 'pen', color: '#c62828', width: 0.003 }, extra: { head: 'conversion' } });
    for (const it of [pencil, box, head, conv]) drawItem(ctx, it, env);
    const colours = seen.filter((c) => c.startsWith('#') || c.startsWith('rgb'));
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) {
      const hex = c.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(r === g && g === b, `not grey under e-ink: ${c}`).toBe(true);
    }
  });
});

describe('guard: a pencil / dashed stroke through ink v2 on the wire', () => {
  it('packs and unpacks with its style byte for byte (the pencil stays a points-only pen stroke)', () => {
    __setServerSpeaksInkV2(true);
    try {
      const anchor = { type: 'note_page' as const, note_page_id: 'NP', space: 'page_norm' as const };
      const it = makeInkItem({ id: 'p', anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-blue', width: 0.004, texture: 'graphite', dash: 'dot', meaning: 'بنى عميقة' }, points: [[0.1, 0.1, 0, 0.3], [0.2, 0.12, 10, 0.6], [0.3, 0.1, 20, 0.9]], pressureAvailable: true, tiltAvailable: false, pointerType: 'pen' });
      const wire = inkToWire('ink', it.data) as unknown as { v: number; style: unknown };
      expect(wire.v).toBe(2);
      expect(wire.style).toEqual(it.data.style);
      expect(inkFromWire('ink', wire)).toEqual(it.data);
    } finally {
      __setServerSpeaksInkV2(false);
    }
  });
});
