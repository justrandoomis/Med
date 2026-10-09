// Ink UI in jsdom: toolbar names/shortcuts/overflow, the capability dialog, and the real input path
// of <InkLayer> (synthetic Pointer Events → store → IndexedDB + outbox). Rendering itself (canvas)
// is verified in Chromium by test/ink/e2e/ink-position.pw.ts — jsdom has no 2D canvas.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { annotationTargetKey, newId, normToView, type AnnotationAnchor, type InkData, type QuarterTurn } from '@medlevo/shared';
import { InkLayer, InkProvider, InkToolbar, useInk } from '../../src/features/workspace/ink';
import { visibleSlots } from '../../src/features/workspace/ink/InkToolbar';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { makeInkItem } from '../../src/features/workspace/ink/model';
import { getDb } from '../../src/lib/localdb';
import type { InkToolId } from '../../src/features/workspace/ink/types';

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  // jsdom has no 2D canvas; the layer must keep working (input + persistence) without one
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  __resetStores();
});

function ToolProbe({ set }: { set?: InkToolId }) {
  const ink = useInk();
  useEffect(() => {
    if (set) ink.setTool(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  return <output data-testid="tool">{ink.toolState.tool}</output>;
}

describe('InkToolbar', () => {
  it('names every tool in Arabic and marks the active one', () => {
    render(
      <InkProvider documentKey="doc-toolbar">
        <InkToolbar />
        <ToolProbe />
      </InkProvider>,
    );
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    for (const name of ['اليد (قراءة وتمرير)', 'تحديد النص', 'القلم', 'قلم التظليل', 'الممحاة', 'التحديد الحر (Lasso)', 'الأشكال', 'مربع نص', 'ملاحظة لاصقة', 'مؤشر الليزر', 'تراجع', 'إعادة', 'المزيد من أدوات الكتابة']) {
      expect(within(bar).getByRole('button', { name })).toBeTruthy();
    }
    fireEvent.click(within(bar).getByRole('button', { name: 'القلم' }));
    expect(screen.getByTestId('tool').textContent).toBe('pen');
    expect(within(bar).getByRole('button', { name: 'القلم: قلم' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(bar).getByRole('button', { name: 'تراجع' })).toHaveProperty('disabled', true);
  });

  it('keyboard shortcuts work on any keyboard layout (KeyboardEvent.code) and never while typing', () => {
    render(
      <InkProvider documentKey="doc-keys">
        <InkToolbar />
        <ToolProbe />
        <input aria-label="حقل" />
      </InkProvider>,
    );
    const tool = () => screen.getByTestId('tool').textContent;
    fireEvent.keyDown(document, { code: 'KeyP', key: 'ح' }); // P on an Arabic layout
    expect(tool()).toBe('pen');
    fireEvent.keyDown(document, { code: 'KeyH', key: 'ا' });
    expect(tool()).toBe('highlighter');
    fireEvent.keyDown(document, { code: 'KeyE', key: 'ث' });
    expect(tool()).toBe('eraser_stroke');
    fireEvent.keyDown(document, { code: 'KeyE', key: 'ث' });
    expect(tool()).toBe('eraser_point');
    fireEvent.keyDown(document, { code: 'KeyL', key: 'م' });
    expect(tool()).toBe('lasso');
    fireEvent.keyDown(document, { code: 'KeyT', key: 'ف' });
    expect(tool()).toBe('text');
    fireEvent.keyDown(document, { code: 'KeyS', key: 'س' });
    expect(['line', 'arrow', 'rect', 'ellipse']).toContain(tool());
    const input = screen.getByRole('textbox', { name: 'حقل' });
    fireEvent.keyDown(input, { code: 'KeyP', key: 'p' });
    expect(['line', 'arrow', 'rect', 'ellipse']).toContain(tool());
  });

  it('Ctrl/⌘+Z undoes and Shift+Ctrl/⌘+Z redoes the last ink command', async () => {
    const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NPK', space: 'page_norm' };
    const key = annotationTargetKey(anchor);
    render(
      <InkProvider documentKey="doc-undo">
        <InkToolbar />
      </InkProvider>,
    );
    const store = getDocumentStore('doc-undo');
    store.attachPage(key, anchor, 1.3);
    await store.whenLoaded(key);
    const s = makeInkItem({ id: newId(), anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: [[0.1, 0.1, 0], [0.2, 0.2, 5]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    act(() => store.commit('كتابة', [{ id: s.id, targetKey: key, before: null, after: s }]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'تراجع' })).toHaveProperty('disabled', false));
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyZ', key: 'z', ctrlKey: true });
    });
    expect(store.item(key, s.id)).toBeUndefined();
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyZ', key: 'z', metaKey: true, shiftKey: true });
    });
    expect(store.item(key, s.id)).toBeDefined();
    await store.flush();
  });

  it('fits narrow widths: the most important tools stay, the rest move to «المزيد»', () => {
    for (const width of [300, 390, 768, 1280]) {
      for (const btn of [40, 44]) {
        const shown = visibleSlots(width, btn);
        const used = (shown.size + 1) * (btn + 4) + 12; // + overflow button + separator
        expect(used).toBeLessThanOrEqual(width + 4);
        expect(shown.has('pen')).toBe(true);
      }
    }
    expect(visibleSlots(390, 44).has('laser')).toBe(false);
    expect(visibleSlots(1280, 40).has('laser')).toBe(true);
  });

  it('opens an honest «قدرات القلم على هذا الجهاز» panel from the overflow menu', async () => {
    render(
      <InkProvider documentKey="doc-caps">
        <InkToolbar />
      </InkProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /قدرات القلم على هذا الجهاز/ }));
    const dialog = await screen.findByRole('dialog', { name: 'قدرات القلم على هذا الجهاز' });
    expect(within(dialog).getByText('النقر المزدوج على القلم')).toBeTruthy();
    expect(within(dialog).getAllByText('يتطلب تطبيق iPad أصليًا').length).toBeGreaterThanOrEqual(4);
    expect(within(dialog).getByText(/لا يثبت جودة الكتابة/)).toBeTruthy();
    // no pen was used in this test: pressure is "not observed", never "supported"
    const pressureRow = within(dialog).getAllByText('الضغط').map((n) => n.closest('li')).find(Boolean)!;
    expect(within(pressureRow as HTMLElement).getByText('لم يُرصد بعد')).toBeTruthy();
  });
});

describe('InkLayer input path (synthetic Pointer Events)', () => {
  // a fresh page per test: the app-wide IndexedDB persists across tests of this file
  let anchor: AnnotationAnchor;
  let key: string;
  beforeEach(() => {
    anchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 0, space: 'page_norm' };
    key = annotationTargetKey(anchor);
  });

  function setup(tool: InkToolId, rotation: QuarterTurn = 0, scale = 1, penOnly = true) {
    window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly }));
    const view = { pageWidth: 600, pageHeight: 800, scale, rotation };
    const active = vi.fn();
    const docKey = `doc-layer-${newId()}`;
    const r = render(
      <InkProvider documentKey={docKey}>
        <ToolProbe set={tool} />
        <div style={{ position: 'relative' }}>
          <InkLayer targetKey={key} anchor={anchor} view={view} interactive onStrokeActiveChange={active} />
        </div>
      </InkProvider>,
    );
    const root = r.container.querySelector('.ml-ink-layer') as HTMLElement;
    const w = rotation % 180 ? 800 * scale : 600 * scale;
    const h = rotation % 180 ? 600 * scale : 800 * scale;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: w, height: h, right: 10 + w, bottom: 20 + h, x: 10, y: 20, toJSON: () => ({}) } as DOMRect);
    return { root, active, store: getDocumentStore(docKey), view };
  }

  function pointer(root: HTMLElement, type: string, x: number, y: number, init: PointerEventInit = {}) {
    act(() => {
      root.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + 10, clientY: y + 20, pressure: type === 'pointerup' ? 0 : 0.5, isPrimary: true, ...init }));
    });
  }

  it('a mouse stroke is committed with a client id, normalized points, and reaches IndexedDB + outbox', async () => {
    const { root, active, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, 'pointerdown', 60, 80);
    expect(active).toHaveBeenLastCalledWith(true); // the reader stops page flips immediately
    pointer(root, 'pointermove', 120, 80);
    pointer(root, 'pointermove', 180, 160);
    pointer(root, 'pointerup', 180, 160);
    expect(active).toHaveBeenLastCalledWith(false);
    const items = store.items(key);
    expect(items).toHaveLength(1);
    const data = items[0]!.data as InkData;
    expect(data.points.map((p) => [p[0], p[1]])).toEqual([
      [0.1, 0.1],
      [0.2, 0.1],
      [0.3, 0.2],
    ]);
    expect(data.pressure_available).toBe(false); // a mouse never claims pressure
    expect(items[0]!.input).toEqual({ pointer_type: 'mouse', pressure: false, tilt: false });
    await store.flush();
    const row = await getDb().annotations.get(items[0]!.id);
    expect(row?.targetKey).toBe(key);
    const ops = await getDb().outbox.where('entity_id').equals(items[0]!.id).toArray();
    expect(ops.map((o) => o.op)).toEqual(['append']);
  });

  it('rotated and zoomed view: the stored point is the same page spot (AC-21 logic)', async () => {
    const { root, store, view } = setup('pen', 90, 2);
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    const [vx, vy] = normToView(0.25, 0.4, view);
    const [vx2, vy2] = normToView(0.3, 0.45, view);
    pointer(root, 'pointerdown', vx, vy);
    pointer(root, 'pointerup', vx2, vy2);
    const pts = (store.items(key)[0]!.data as InkData).points;
    expect(pts[0]![0]).toBeCloseTo(0.25, 5);
    expect(pts[0]![1]).toBeCloseTo(0.4, 5);
    expect(pts[1]![0]).toBeCloseTo(0.3, 5);
    expect(pts[1]![1]).toBeCloseTo(0.45, 5);
    await store.flush();
  });

  it('pen-only mode: a finger does not write (and does not block scrolling); a pen does', async () => {
    const { root, active, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, 'pointerdown', 60, 80, { pointerType: 'touch', width: 12, height: 12 });
    pointer(root, 'pointermove', 90, 120, { pointerType: 'touch', width: 12, height: 12 });
    pointer(root, 'pointerup', 90, 120, { pointerType: 'touch' });
    expect(active).not.toHaveBeenCalled();
    expect(store.items(key)).toHaveLength(0);
    pointer(root, 'pointerdown', 60, 80, { pointerType: 'pen', pressure: 0.2 });
    pointer(root, 'pointermove', 90, 80, { pointerType: 'pen', pressure: 0.7 });
    pointer(root, 'pointerup', 120, 80, { pointerType: 'pen', pressure: 0 });
    const ink = store.items(key)[0]!;
    expect((ink.data as InkData).pressure_available).toBe(true);
    expect(ink.input?.pointer_type).toBe('pen');
    await store.flush();
  });

  it('stroke eraser removes what it crosses as one undoable step; undo brings it back', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, 'pointerdown', 60, 200);
    pointer(root, 'pointermove', 300, 200);
    pointer(root, 'pointerup', 540, 200);
    expect(store.items(key)).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_stroke'));
    pointer(root, 'pointerdown', 300, 150);
    pointer(root, 'pointermove', 300, 250);
    pointer(root, 'pointerup', 300, 260);
    expect(store.items(key)).toHaveLength(0);
    act(() => {
      store.undo();
    });
    expect(store.items(key)).toHaveLength(1);
    await store.flush();
  });

  it('point eraser splits a stroke into new strokes with new ids', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, 'pointerdown', 60, 400);
    for (let x = 90; x <= 540; x += 30) pointer(root, 'pointermove', x, 400);
    pointer(root, 'pointerup', 540, 400);
    const original = store.items(key)[0]!;
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_point'));
    pointer(root, 'pointerdown', 300, 350);
    pointer(root, 'pointermove', 300, 450);
    pointer(root, 'pointerup', 300, 450);
    const pieces = store.items(key);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => p.id)).not.toContain(original.id);
    await store.flush();
    expect((await getDb().annotations.get(original.id))!.deletedAt).not.toBeNull();
  });

  it('lasso tap selects the stroke under the pointer; Delete removes it', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    pointer(root, 'pointerdown', 60, 600);
    pointer(root, 'pointermove', 200, 600);
    pointer(root, 'pointerup', 300, 600);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    pointer(root, 'pointerdown', 150, 601);
    pointer(root, 'pointerup', 150, 601);
    expect(store.getSelection()?.ids).toHaveLength(1);
    expect(await screen.findByRole('toolbar', { name: /إجراءات التحديد/ })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document, { key: 'Delete', code: 'Delete' });
    });
    expect(store.items(key)).toHaveLength(0);
    await store.flush();
  });

  it('text tool: typed text is saved even when the next tap replaces the editor without a blur', async () => {
    const { root, store } = setup('text');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('text'));
    pointer(root, 'pointerdown', 60, 100);
    pointer(root, 'pointerup', 60, 100);
    const box = await screen.findByRole('textbox', { name: 'مربع نص جديد' });
    fireEvent.change(box, { target: { value: 'ليش؟ راجع CT abdomen' } });
    // a second tap elsewhere opens a new draft (pointerdown default is prevented → no blur)
    pointer(root, 'pointerdown', 300, 500);
    pointer(root, 'pointerup', 300, 500);
    await waitFor(() => expect(store.items(key).filter((i) => i.kind === 'text')).toHaveLength(1));
    const text = store.items(key).find((i) => i.kind === 'text')!;
    expect(JSON.stringify(text.data)).toContain('CT abdomen');
    // the empty new draft is discarded when closed with Escape
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'مربع نص جديد' }), { key: 'Escape' });
    expect(store.items(key)).toHaveLength(1);
    await store.flush();
  });

  it('sticky note: created from a tap, opened again by its button, never saved empty', async () => {
    const { root, store } = setup('sticky');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('sticky'));
    pointer(root, 'pointerdown', 120, 120);
    pointer(root, 'pointerup', 120, 120);
    const input = await screen.findByLabelText('نص الملاحظة اللاصقة');
    fireEvent.change(input, { target: { value: 'سؤال للمراجعة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    await waitFor(() => expect(store.items(key).filter((i) => i.kind === 'sticky')).toHaveLength(1));
    expect(await screen.findByRole('button', { name: 'ملاحظة لاصقة: سؤال للمراجعة' })).toBeTruthy();
    pointer(root, 'pointerdown', 400, 400);
    pointer(root, 'pointerup', 400, 400);
    fireEvent.click(await screen.findByRole('button', { name: 'تم' }));
    expect(store.items(key).filter((i) => i.kind === 'sticky')).toHaveLength(1);
    await store.flush();
  });
});
