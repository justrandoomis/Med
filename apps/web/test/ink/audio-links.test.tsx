// Track F4 — pen ↔ recording time links (§29) and the lasso actions of the host (§28): a stroke written while an
// in-app recording runs carries an AUTOMATIC link (offset from the recording start) that reaches IndexedDB and the
// outbox with the stroke; strokes outside a recording get none; the lasso offers «استمع من …» (labelled automatic /
// manual) and the link editor; «تحويل إلى نص» / «اسأل عن المحدد» are enabled only through a host and otherwise stay
// disabled with their reason. The ink itself is never changed by a link edit.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { annotationTargetKey, newId, type AnnotationAnchor, type InkData } from '@medlevo/shared';
import { InkLayer, InkProvider, InkSelectionActionsProvider, useInk, type InkSelectionActions } from '../../src/features/workspace/ink';
import { audioLinkOf, formatOffset, parseOffset, setActiveRecording, withAudioLink } from '../../src/features/workspace/ink/audioLink';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import { getDb } from '../../src/lib/localdb';
import type { InkToolId } from '../../src/features/workspace/ink/types';

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setActiveRecording(null);
  __resetStores();
});

function ToolProbe({ set }: { set?: InkToolId }) {
  const ink = useInk();
  useEffect(() => {
    if (set) ink.setTool(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  return null;
}

describe('time formats', () => {
  it('formats and parses moments (Arabic-Indic digits accepted)', () => {
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_727_000)).toBe('1:02:07');
    expect(parseOffset('1:05')).toBe(65_000);
    expect(parseOffset('١:٠٥')).toBe(65_000);
    expect(parseOffset('1:02:07')).toBe(3_727_000);
    expect(parseOffset('90')).toBe(90_000);
    expect(parseOffset('1:75')).toBeNull();
    expect(parseOffset('abc')).toBeNull();
  });
});

describe('strokes written while recording', () => {
  let anchor: AnnotationAnchor;
  let key: string;
  beforeEach(() => {
    anchor = { type: 'page', source_id: 'S', version_id: 'V', page_id: newId(), page_index: 0, space: 'page_norm' };
    key = annotationTargetKey(anchor);
  });

  function setup(tool: InkToolId, wrap: (n: ReactNode) => ReactNode = (n) => n) {
    window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly: false }));
    const docKey = `doc-audio-${newId()}`;
    const r = render(
      <InkProvider documentKey={docKey}>
        <ToolProbe set={tool} />
        {wrap(
          <div style={{ position: 'relative' }}>
            <InkLayer targetKey={key} anchor={anchor} view={{ pageWidth: 600, pageHeight: 800, scale: 1, rotation: 0 }} interactive onStrokeActiveChange={() => {}} />
          </div>,
        )}
      </InkProvider>,
    );
    const root = r.container.querySelector('.ml-ink-layer') as HTMLElement;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 600, height: 800, right: 610, bottom: 820, x: 10, y: 20, toJSON: () => ({}) } as DOMRect);
    return { root, store: getDocumentStore(docKey) };
  }
  function pointer(root: HTMLElement, type: string, x: number, y: number) {
    act(() => {
      root.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x + 10, clientY: y + 20, pressure: 0.5, isPrimary: true }));
    });
  }
  function write(root: HTMLElement, y = 80) {
    pointer(root, 'pointerdown', 60, y);
    pointer(root, 'pointermove', 120, y);
    pointer(root, 'pointermove', 180, y + 40);
    pointer(root, 'pointerup', 180, y + 40);
  }

  it('get an automatic link that is stored and synced with the stroke; other strokes get none', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    write(root, 60);
    // the owner starts a recording 30 s ago (explicit action elsewhere); paused time none
    const started = Date.now() - 30_000;
    setActiveRecording({ recordingId: 'REC1', startedAt: started, pausedBefore: () => 0, isPaused: () => false });
    write(root, 300);
    setActiveRecording(null);
    write(root, 500);
    const items = store.items(key);
    expect(items).toHaveLength(3);
    const links = items.map((i) => (i.data as InkData).audio_link ?? null);
    expect(links[0]).toBeNull();
    expect(links[2]).toBeNull();
    expect(links[1]).toMatchObject({ recording_id: 'REC1', origin: 'auto' });
    expect(links[1]!.offset_ms).toBeGreaterThanOrEqual(29_000);
    expect(links[1]!.offset_ms).toBeLessThanOrEqual(32_000);
    await store.flush();
    const row = await getDb().annotations.get(items[1]!.id);
    expect((row?.data as InkData).audio_link).toEqual(links[1]);
    const op = (await getDb().outbox.where('entity_id').equals(items[1]!.id).toArray())[0]!;
    expect((op.payload as { data: InkData }).data.audio_link).toEqual(links[1]);
  });

  it('(review) a shape drawn while recording (hold to straighten) keeps the time link on the shape itself', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    setActiveRecording({ recordingId: 'REC2', startedAt: Date.now() - 10_000, pausedBefore: () => 0, isPaused: () => false });
    pointer(root, 'pointerdown', 60, 100);
    for (let x = 80; x <= 360; x += 20) pointer(root, 'pointermove', x, 100);
    // hold still: the stroke is straightened into a line
    await act(async () => {
      await new Promise((r) => setTimeout(r, 750));
    });
    pointer(root, 'pointerup', 360, 100);
    const items = store.items(key);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('shape');
    expect(audioLinkOf(items[0]!)).toMatchObject({ recording_id: 'REC2', origin: 'auto' });
    expect(audioLinkOf(items[0]!)!.offset_ms).toBeGreaterThanOrEqual(9_000);
  });

  it('a paused recording links nothing', async () => {
    const { root, store } = setup('pen');
    await waitFor(() => expect(root.hasAttribute('data-writing')).toBe(true));
    setActiveRecording({ recordingId: 'REC1', startedAt: Date.now() - 1000, pausedBefore: () => 0, isPaused: () => true });
    write(root);
    expect((store.items(key)[0]!.data as InkData).audio_link).toBeUndefined();
  });

  it('the lasso offers «استمع من …» (automatic) and the link editor through the host; editing a link never changes the ink', async () => {
    const playAudio = vi.fn();
    const editAudioLink = vi.fn();
    const convertRun = vi.fn();
    const actions: InkSelectionActions = { playAudio, editAudioLink, convert: { reason: null, run: convertRun }, ask: { reason: 'السؤال يحتاج اتصالًا بالخادم.', run: vi.fn() } };
    const { store: penStore } = setup('lasso', (n) => <InkSelectionActionsProvider value={actions}>{n}</InkSelectionActionsProvider>);
    await waitFor(() => expect(penStore.page(key)?.loaded).toBe(true));
    // a linked stroke placed in the page model with the constructor the layer uses (the layer path is tested above)
    const { makeInkItem } = await import('../../src/features/workspace/ink/model');
    const item = makeInkItem({ id: newId(), anchor, now: Date.now(), z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.0025 }, points: [[0.1, 0.1, 0], [0.2, 0.12, 16]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    item.data.audio_link = { recording_id: 'REC9', offset_ms: 65_000, origin: 'auto' };
    act(() => penStore.commit('كتابة', [{ id: item.id, targetKey: key, before: null, after: item }]));
    act(() => penStore.setSelection({ targetKey: key, ids: [item.id] }));
    const play = await screen.findByRole('button', { name: 'استمع من 1:05 في التسجيل (رابط تلقائي)' });
    fireEvent.click(play);
    expect(playAudio).toHaveBeenCalledWith({ recording_id: 'REC9', offset_ms: 65_000, origin: 'auto' });
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /الرابط الزمني \(تلقائي\)/ }));
    expect(editAudioLink).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }), key);
    fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
    const convert = await screen.findByRole('menuitem', { name: /تحويل إلى نص/ });
    expect(convert.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(convert);
    expect(convertRun).toHaveBeenCalledWith(expect.objectContaining({ targetKey: key, anchor, items: [expect.objectContaining({ id: item.id })] }));
    // a manual link: same stroke (points, style), only the link changes
    const manual = withAudioLink(item, { recording_id: 'REC9', offset_ms: 9_000, origin: 'manual' }, Date.now());
    expect((manual.data as InkData).points).toEqual(item.data.points);
    expect((manual.data as InkData).audio_link).toEqual({ recording_id: 'REC9', offset_ms: 9_000, origin: 'manual' });
    expect((withAudioLink(item, null, Date.now()).data as InkData).audio_link).toBeUndefined();
  });

  it('without a host, «تحويل إلى نص» and «اسأل عن المحدد» stay disabled with their reasons', async () => {
    const { store } = setup('lasso');
    await waitFor(() => expect(store.page(key)?.loaded).toBe(true));
    const { makeInkItem } = await import('../../src/features/workspace/ink/model');
    const item = makeInkItem({ id: newId(), anchor, now: Date.now(), z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.0025 }, points: [[0.1, 0.1, 0], [0.2, 0.12, 16]], pressureAvailable: false, tiltAvailable: false, pointerType: 'mouse' });
    act(() => store.commit('كتابة', [{ id: item.id, targetKey: key, before: null, after: item }]));
    act(() => store.setSelection({ targetKey: key, ids: [item.id] }));
    fireEvent.click(await screen.findByRole('button', { name: 'المزيد' }));
    const convert = await screen.findByRole('menuitem', { name: /تحويل إلى نص/ });
    const ask = await screen.findByRole('menuitem', { name: /اسأل عن المحدد/ });
    expect(convert.getAttribute('aria-disabled')).toBe('true');
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: /استمع من/ })).toBeNull();
  });
});
