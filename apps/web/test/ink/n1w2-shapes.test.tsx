// Parity N1 wave 2 — shapes and diagrams through the real layer and selection menu:
//  * G20: the arrow tool with a pathway head (inhibition ⊣) and the rectangle with a fill and rounded corners save those
//    fields; the polygon is tapped corner by corner and closed with Enter; text written inside a shape is RichText, one
//    undo step;
//  * G21: a shape bound to a Course Brain concept (search → choose) keeps the concept id and name and gets the name as
//    its label; the relation check reads the knowledge map and says «موجودة» / «غير موجودة (لا يعني أنها خطأ)»;
//  * G07: the eyedropper without the browser API reads the colour drawn under the tap, uses it and keeps it in the slots.
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, richTextToPlain, type ShapeData } from '@medlevo/shared';
import { setFetchImpl } from '../../src/lib/api';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { useInk, useInkInternal } from '../../src/features/workspace/ink/InkProvider';
import { makeShapeItem, type InkItem, type InkItemOf } from '../../src/features/workspace/ink/model';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { installSettings, pointer, setupLayer, stroke, stubContext, type LayerSetup } from './n1-helpers';

vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  setFetchImpl(null);
  __resetStores();
  vi.restoreAllMocks();
});

const px = (x: number, y: number): [number, number] => [x * 600, y * 800];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function shapes(s: LayerSetup) {
  return s.store.items(s.key).filter((i): i is InkItemOf<ShapeData> => i.kind === 'shape');
}
async function put(s: LayerSetup, items: InkItem[]) {
  await s.store.whenLoaded(s.key);
  act(() => {
    s.store.commit('كتابة', items.map((it) => ({ id: it.id, targetKey: s.key, before: null, after: it })));
  });
}
function node(s: LayerSetup, from: [number, number], to: [number, number], extra: Partial<ShapeData> = {}) {
  return makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'rect', from, to, style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra });
}

describe('G20 shapes', () => {
  it('the arrow with an inhibition head and the filled, rounded rectangle save their fields', async () => {
    installSettings();
    const s = setupLayer('arrow', { prefs: { shapeOptions: { head: 'inhibition', fill: 'hl-yellow', corner: true, route: 'straight' } } });
    await s.store.whenLoaded(s.key);
    stroke(s.root, [px(0.1, 0.5), px(0.3, 0.5), px(0.5, 0.5)]);
    const arrow = shapes(s)[0]!;
    expect(arrow.data).toMatchObject({ shape: 'arrow', head: 'inhibition' });
    expect(arrow.data.fill).toBeUndefined(); // a line has no inside
    await s.store.flush();
  });

  it('a polygon is tapped corner by corner and closed with Enter (one item, its corners kept)', async () => {
    installSettings();
    const s = setupLayer('polygon');
    await s.store.whenLoaded(s.key);
    for (const [x, y] of [px(0.2, 0.2), px(0.4, 0.2), px(0.3, 0.4)]) {
      pointer(s.root, 'pointerdown', x, y);
      pointer(s.root, 'pointerup', x, y);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400)); // not a double tap
      });
    }
    expect(shapes(s).length).toBe(0); // nothing is saved while it is being tapped
    fireEvent.keyDown(document, { key: 'Enter' });
    const [poly] = shapes(s);
    expect(poly!.data.shape).toBe('polygon');
    expect(poly!.data.points!.length).toBe(3);
    await s.store.flush();
  });

  it('text written inside a shape is stored as RichText (one undo step)', async () => {
    installSettings();
    const s = setupLayer('lasso');
    const r = node(s, [0.2, 0.2], [0.4, 0.3], { fill: 'hl-blue', corner: 0.02 });
    await put(s, [r]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [r.id] }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /اكتب داخل الشكل/ }));
    const box = await screen.findByLabelText('النص داخل الشكل');
    fireEvent.change(box, { target: { value: 'الإنسولين Insulin' } });
    fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    const saved = s.store.item(s.key, r.id) as InkItemOf<ShapeData>;
    expect(richTextToPlain(saved.data.label!)).toBe('الإنسولين Insulin');
    expect(saved.data.fill).toBe('hl-blue');
    await waitFor(() => expect(document.querySelector('.ml-ink-shape-label')?.textContent).toContain('Insulin'));
    act(() => {
      s.store.undo();
    });
    expect((s.store.item(s.key, r.id) as InkItemOf<ShapeData>).data.label).toBeUndefined();
    await s.store.flush();
  });
});

describe('G20 the rectangle with fill and corners', () => {
  it('saves fill and corner radius from the shape options', async () => {
    installSettings();
    const s = setupLayer('rect', { prefs: { shapeOptions: { head: null, fill: 'hl-yellow', corner: true, route: 'straight' } } });
    await s.store.whenLoaded(s.key);
    stroke(s.root, [px(0.2, 0.2), px(0.3, 0.25), px(0.4, 0.3)]);
    const [r] = shapes(s);
    expect(r!.data.shape).toBe('rect');
    expect(r!.data.fill).toBe('hl-yellow');
    expect(r!.data.corner).toBeGreaterThan(0);
    await s.store.flush();
  });
});

describe('G21 Course Brain concepts and the relation check', () => {
  it('a shape bound to a concept keeps its id and name and is labelled with it; the relation check reads the map', async () => {
    installSettings();
    const calls: string[] = [];
    setFetchImpl(async (url) => {
      calls.push(url);
      if (url.startsWith('/api/brain/concepts')) return json({ items: [{ id: 'c-ins', name: 'Insulin', status: 'accepted' }, { id: 'c-rej', name: 'Rejected', status: 'rejected' }], counts: { suggested: 0, accepted: 1, rejected: 1, merged: 0 }, notes_ar: [] });
      if (url.startsWith('/api/brain/relations')) return json({ items: [{ from: { id: 'c-ins' }, to: { id: 'c-glut' }, relation: 'causes', support: 'stated', status: 'active' }] });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const s = setupLayer('lasso');
    const a = node(s, [0.1, 0.1], [0.3, 0.2]);
    const b = node(s, [0.6, 0.1], [0.8, 0.2], { concept_id: 'c-glut', concept_name: 'GLUT4' });
    const conn = makeShapeItem({ id: newId(), anchor: s.anchor, now: Date.now(), z: s.store.nextZ(s.key), shape: 'arrow', from: [0.3, 0.15], to: [0.6, 0.15], style: { tool: 'pen', color: 'ink-black', width: 0.003 }, extra: { attach: { from: { id: a.id, side: 'e' }, to: { id: b.id, side: 'w' } }, relation: 'causes' } });
    await put(s, [a, b, conn]);
    act(() => s.store.setSelection({ targetKey: s.key, ids: [a.id] }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /اربط بمفهوم من المادة/ }));
    fireEvent.change(await screen.findByLabelText('ابحث عن مفهوم'), { target: { value: 'insulin' } });
    fireEvent.click(screen.getByRole('button', { name: 'ابحث' }));
    const choice = await screen.findByRole('button', { name: /Insulin/ });
    expect(screen.queryByRole('button', { name: /Rejected/ })).toBeNull();
    fireEvent.click(choice);
    const bound = s.store.item(s.key, a.id) as InkItemOf<ShapeData>;
    expect(bound.data).toMatchObject({ concept_id: 'c-ins', concept_name: 'Insulin' });
    expect(richTextToPlain(bound.data.label!)).toBe('Insulin');
    expect(calls.some((u) => u.includes('q=insulin'))).toBe(true);
    // the relation check (a read: nothing changes)
    const before = JSON.stringify(s.store.items(s.key));
    act(() => s.store.setSelection({ targetKey: s.key, ids: [conn.id] }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /تحقّق من العلاقات/ }));
    expect(await screen.findByText(/موجودة في خريطة المعرفة/)).toBeTruthy();
    expect(document.body.textContent).toContain('«Insulin» يسبّب «GLUT4»');
    expect(JSON.stringify(s.store.items(s.key))).toBe(before);
    await s.store.flush();
  });
});

describe('G07 the eyedropper without the browser API', () => {
  it('a tap reads the colour drawn there, becomes the pen colour and is kept in the slots', async () => {
    const backend = installSettings();
    let internal: ReturnType<typeof useInkInternal> | null = null;
    let ink: ReturnType<typeof useInk> | null = null;
    function Probe() {
      const i = useInkInternal();
      const k = useInk();
      useEffect(() => {
        internal = i;
        ink = k;
      });
      return null;
    }
    const s = setupLayer('pen', { toolbar: true, wrap: (n) => <div className="wk-sheet">{n}</div>, around: (n) => <>{n}<Probe /></> });
    await s.store.whenLoaded(s.key);
    // the page canvas under the layer draws an H&E pink at the tapped point
    const page = document.createElement('canvas');
    page.width = 600;
    page.height = 800;
    s.root.parentElement!.parentElement!.insertBefore(page, s.root.parentElement);
    const ctx = Object.assign(stubContext(), { getImageData: () => ({ data: new Uint8ClampedArray([214, 96, 160, 255]) }) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return this === page ? (ctx as unknown as CanvasRenderingContext2D) : null;
    } as never);
    vi.spyOn(page, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 600, height: 800, right: 610, bottom: 820, x: 10, y: 20, toJSON: () => ({}) } as DOMRect);
    // the colour picker's eyedropper (tap mode: no EyeDropper in jsdom)
    fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'التقط لونًا من الصفحة' }));
    await waitFor(() => expect(internal!.colorPick).toBeTruthy());
    expect(s.root.hasAttribute('data-color-pick')).toBe(true);
    pointer(s.root, 'pointerdown', ...px(0.5, 0.5));
    pointer(s.root, 'pointerup', ...px(0.5, 0.5));
    await waitFor(() => expect(ink!.toolState.color).toBe('#d660a0'));
    expect(internal!.colorPick).toBeNull();
    expect(s.store.items(s.key).length).toBe(0); // nothing was written
    await waitFor(() => expect(JSON.stringify(backend.value)).toContain('#d660a0'));
  });
});
