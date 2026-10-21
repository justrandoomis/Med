// Parity N1 Wave 0 — the seams other tracks build on (docs/research/NOTE_APP_FEATURE_PARITY.md B.3). Acceptance: a kind
// and a tool registered from a TEST FILE render, hit-test, erase, undo and sync; the visibility predicate composes the
// layers' predicate with named view filters; host lasso actions («extra») appear in the selection menu; a text editor
// mounted in <InkProvider>'s slot edits text boxes without touching InkLayer.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { newId, richTextToPlain, type AnnotationAnchor, type AnnotationDTO, type NormBox, type RichText } from '@medlevo/shared';
import { InkSelectionActionsProvider } from '../../src/features/workspace/ink';
import { registerInkKind } from '../../src/features/workspace/ink/kinds';
import { PageInkController } from '../../src/features/workspace/ink/layerController';
import { makeInkItem, type InkItem } from '../../src/features/workspace/ink/model';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { registerInkTool } from '../../src/features/workspace/ink/tools';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import type { InkTextEditorProps } from '../../src/features/workspace/ink/types';
import { getDb } from '../../src/lib/localdb';
import { installSettings, pointer, setupLayer, stroke, stubContext } from './n1-helpers';

// a real layer and toolbar in jsdom: slow on a loaded machine, never hanging
vi.setConfig({ testTimeout: 20_000 });

/** A «stamp» kind: a small square box on the page (stands for N4's tape or N2's board node). */
interface StampData {
  v: 1;
  box: NormBox;
}
const drawn: string[] = [];
let unregister: Array<() => void> = [];

function registerStamp() {
  unregister.push(
    registerInkKind({
      // a kind the server already accepts as free JSON, so the round trip is real
      kind: 'highlight',
      label_ar: 'ختم',
      plural_ar: 'أختام',
      engine: true,
      selectable: true,
      erasable: true,
      exportable: true,
      draw: (_ctx, item) => {
        drawn.push(item.id);
      },
      geometry: (item, ar) => {
        const b = (item.data as unknown as StampData).box;
        const poly: Array<[number, number]> = [
          [b.x, b.y * ar],
          [b.x + b.w, b.y * ar],
          [b.x + b.w, (b.y + b.h) * ar],
          [b.x, (b.y + b.h) * ar],
        ];
        return { lines: [[...poly, poly[0]!]], halfWidth: 0, area: poly };
      },
      bounds: (item) => ({ ...(item.data as unknown as StampData).box }),
      transform: (item, m, ar, now) => {
        const b = (item.data as unknown as StampData).box;
        const x = m[0] * b.x + m[2] * b.y * ar + m[4];
        const y = (m[1] * b.x + m[3] * b.y * ar + m[5]) / ar;
        return { ...item, data: { v: 1, box: { ...b, x, y } } as unknown as AnnotationDTO['data'], updated_at: now };
      },
    }),
  );
  unregister.push(
    registerInkTool({
      id: 'x:stamp',
      label_ar: 'ختم',
      icon: <span>S</span>,
      shortcut: { code: 'KeyK', label: 'K' },
      pointerDown: (ctx, at) => ({
        up: () => {
          const now = Date.now();
          const item: InkItem = {
            id: newId(),
            kind: 'highlight',
            tool: 'x:stamp',
            anchor: ctx.anchor,
            data: { v: 1, box: { x: at[0] - 0.02, y: at[1] - 0.02, w: 0.04, h: 0.04 } } as unknown as AnnotationDTO['data'],
            layer: 'ink',
            z: ctx.nextZ(),
            locked: false,
            anchor_status: 'ok',
            previous_anchor: null,
            input: null,
            device_id: null,
            rev: 0,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          };
          ctx.commit('ختم', [{ id: item.id, targetKey: ctx.targetKey, before: null, after: item }]);
        },
      }),
    }),
  );
}

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  installSettings();
  drawn.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  unregister.forEach((u) => u());
  unregister = [];
  setInkSettingsBackend(null);
  __resetStores();
});

describe('registered kind + tool (from a test file)', () => {
  it('the tool creates the kind (one undo step, saved and queued for sync); the eraser removes it; undo brings it back', async () => {
    registerStamp();
    const { root, store, key } = setupLayer('x:stamp');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('x:stamp'));
    pointer(root, 'pointerdown', 300, 400);
    pointer(root, 'pointerup', 300, 400);
    const items = store.items(key);
    expect(items).toHaveLength(1);
    const stamp = items[0]!;
    expect(stamp.kind).toBe('highlight');
    // sync: written to this device with its outbox op, in the wire shape
    await store.flush();
    expect((await getDb().annotations.get(stamp.id))?.kind).toBe('highlight');
    const ops = await getDb().outbox.where('entity_id').equals(stamp.id).toArray();
    expect(ops.map((o) => o.op)).toEqual(['append']);
    expect((ops[0]!.payload as { kind: string }).kind).toBe('highlight');
    // hit-test: a lasso tap selects it
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    pointer(root, 'pointerdown', 300, 400);
    pointer(root, 'pointerup', 300, 400);
    expect(store.getSelection()?.ids).toEqual([stamp.id]);
    // erase: the stroke eraser crosses it
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyE', key: 'e' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('eraser_stroke'));
    stroke(root, [
      [250, 400],
      [300, 400],
      [350, 400],
    ]);
    expect(store.items(key)).toHaveLength(0);
    await act(async () => {
      store.undo();
      await store.stepSettled();
    });
    expect(store.items(key).map((i) => i.id)).toEqual([stamp.id]);
    await store.flush();
  });

  it('the tool has its own shortcut (KeyboardEvent.code) and a toolbar button', async () => {
    registerStamp();
    const { root } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyK', key: 'ن' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('x:stamp'));
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    expect(within(bar).getByRole('button', { name: 'ختم' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the kind is drawn by its own draw() on the committed-ink canvas (with strokes, in paint order)', async () => {
    registerStamp();
    const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NPSEAM', space: 'page_norm' };
    const store = getDocumentStore('doc-seam-render');
    const key = 'note_page:NPSEAM';
    store.attachPage(key, anchor, 800 / 600);
    await store.whenLoaded(key);
    const stamp = { ...makeInkItem({ id: 'STAMP1', anchor, now: 1, z: 2, style: { tool: 'pen', color: 'ink-black', width: 0.002 }, points: [[0.1, 0.1, 0], [0.2, 0.2, 5]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' }), kind: 'highlight' as const, data: { v: 1, box: { x: 0.4, y: 0.4, w: 0.05, h: 0.05 } } as unknown as AnnotationDTO['data'] };
    store.commit('ختم', [{ id: stamp.id, targetKey: key, before: null, after: stamp as unknown as InkItem }]);
    // one context per canvas (highlights, ink, live)
    (HTMLCanvasElement.prototype.getContext as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => stubContext());
    const root = document.createElement('div');
    document.body.appendChild(root);
    const c = new PageInkController({
      store,
      targetKey: key,
      root,
      highlightCanvas: document.createElement('canvas'),
      inkCanvas: document.createElement('canvas'),
      liveCanvas: document.createElement('canvas'),
      getAnchor: () => anchor,
      getView: () => ({ pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 }),
      getTool: () => ({ tool: 'pen', color: 'ink-black', width: 0.002, penOnly: false, shapeRecognition: false }),
      getInteractive: () => true,
      onStrokeActive: () => undefined,
      onTextRequest: () => undefined,
    });
    c.setView();
    c.paintCommitted();
    expect(drawn).toContain('STAMP1');
    // the view filter (N1) hides it from drawing too
    drawn.length = 0;
    store.setViewFilter('test', (it) => it.kind !== 'highlight', 'no-stamps');
    c.paintCommitted();
    expect(drawn).toEqual([]);
    c.destroy();
    root.remove();
  });
});

describe('visibility: the layers predicate and named view filters compose', () => {
  it('an item is visible only when the layers AND every view filter let it through; keys name the visible set', async () => {
    const store = getDocumentStore('doc-vis');
    const a = { layer_id: 'L1' } as unknown as InkItem;
    const b = { layer_id: 'L2' } as unknown as InkItem;
    store.setVisibility((it) => it.layer_id !== 'L2', 'layers:hideL2');
    expect([store.isVisible(a), store.isVisible(b)]).toEqual([true, false]);
    store.setViewFilter('legend', (it) => it.layer_id === 'L2', 'legend:x');
    expect([store.isVisible(a), store.isVisible(b)]).toEqual([false, false]);
    expect(store.visibilityKey).toBe('layers:hideL2|legend=legend:x');
    store.setVisibility(null);
    expect([store.isVisible(a), store.isVisible(b)]).toEqual([false, true]);
    store.setViewFilter('legend', null);
    expect(store.visibilityKey).toBe('');
    expect(store.viewFilterNames()).toEqual([]);
  });

  it('new writing a view filter would hide lifts that filter (the owner always sees what they write)', async () => {
    const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NPVF', space: 'page_norm' };
    const store = getDocumentStore('doc-vf');
    store.attachPage('note_page:NPVF', anchor, 1.4);
    await store.whenLoaded('note_page:NPVF');
    const cleared = vi.fn();
    store.setViewFilter('legend', (it) => (it.data as { style?: { meaning?: string } }).style?.meaning === 'آلية', 'legend:آلية', { onCleared: cleared });
    const s = makeInkItem({ id: newId(), anchor, now: 1, z: 1, style: { tool: 'pen', color: 'ink-red', width: 0.002, meaning: 'موانع استعمال' }, points: [[0.1, 0.1, 0], [0.2, 0.2, 5]], pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' });
    store.commit('كتابة', [{ id: s.id, targetKey: 'note_page:NPVF', before: null, after: s }]);
    expect(cleared).toHaveBeenCalledOnce();
    expect(store.viewFilterNames()).toEqual([]);
    expect(store.isVisible(s)).toBe(true);
    await store.flush();
  });
});

describe('host lasso actions («extra»)', () => {
  it('appear in the selection menu, enabled or disabled with their reason, and receive the selection', async () => {
    const run = vi.fn();
    const outer = { extra: [{ id: 'n2.element', label_ar: 'احفظ كعنصر', reason: null, run }] };
    const inner = { extra: [{ id: 'n4.card', label_ar: 'أنشئ بطاقة', reason: 'تحتاج قراءة الخط أولًا.', run: vi.fn() }] };
    const { root, store, key } = setupLayer('pen', {
      wrap: (n) => (
        <InkSelectionActionsProvider value={outer}>
          <InkSelectionActionsProvider value={inner}>{n}</InkSelectionActionsProvider>
        </InkSelectionActionsProvider>
      ),
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, [
      [100, 100],
      [200, 120],
      [300, 140],
    ]);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    act(() => store.setSelection({ targetKey: key, ids: store.items(key).map((i) => i.id) }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    const save = await screen.findByRole('menuitem', { name: /احفظ كعنصر/ });
    const card = screen.getByRole('menuitem', { name: /أنشئ بطاقة/ });
    expect(card.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(save);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].items).toHaveLength(1);
    await store.flush();
  });
});

describe('the text-editor slot', () => {
  it('a mounted editor edits text boxes (rich text saved as given); typed text is saved when it goes away', async () => {
    function UpperEditor({ initial, style, ariaLabel, onChange, onFinish }: InkTextEditorProps) {
      const [v, setV] = useState(richTextToPlain(initial));
      return (
        <div style={style}>
          <input
            aria-label={ariaLabel}
            value={v}
            onChange={(e) => {
              setV(e.target.value);
              const rt: RichText = { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: e.target.value.toUpperCase() }] }] } as RichText;
              onChange(rt, 30);
            }}
          />
          <button type="button" onClick={() => onFinish(30)}>
            تم
          </button>
        </div>
      );
    }
    const { root, store, key } = setupLayer('text', { textEditor: UpperEditor });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('text'));
    pointer(root, 'pointerdown', 120, 200);
    pointer(root, 'pointerup', 120, 200);
    const input = await screen.findByRole('textbox', { name: 'مربع نص جديد' });
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'تم' }));
    const box = store.items(key).find((i) => i.kind === 'text')!;
    expect(richTextToPlain((box.data as { text: RichText }).text)).toBe('ABC');
    await store.flush();
  });

  it('without a mounted editor, the engine keeps its plain-text area', async () => {
    const r = render(<div />);
    r.unmount();
    const { root, store, key } = setupLayer('text');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('text'));
    pointer(root, 'pointerdown', 120, 200);
    pointer(root, 'pointerup', 120, 200);
    const area = await screen.findByRole('textbox', { name: 'مربع نص جديد' });
    expect(area.tagName).toBe('TEXTAREA');
    fireEvent.change(area, { target: { value: 'نص عادي' } });
    fireEvent.blur(area);
    expect(richTextToPlain((store.items(key)[0]!.data as { text: RichText }).text)).toBe('نص عادي');
    await store.flush();
  });
});
