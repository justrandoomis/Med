// Image tool and page links of the ink engine (track F1, §26): where a picture goes (geometry), what is refused,
// that it is stored on this device first and queued for upload (offline), moved / resized with the lasso without
// changing its aspect, removed with undo — never touching the page; and links drawn with the link tool that ask the
// host where they lead and open it when followed.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { newId, type AnnotationAnchor, type ImageAnnotationData, type LinkData } from '@medlevo/shared';
import { InkHost, InkLayer, InkProvider, InkToolbar, useInk, type InkLinkHost } from '../../src/features/workspace/ink';
import { checkImageFile, imageBlobId, imageBoxAt, insertImage, kickImageUploads, type ImageBlobRecord } from '../../src/features/workspace/ink/images';
import { scaleAbout, translate } from '../../src/features/workspace/ink/math';
import { isImage, isLink, transformItem } from '../../src/features/workspace/ink/model';
import { __resetStores, getDocumentStore } from '../../src/features/workspace/ink/store';
import type { InkToolId } from '../../src/features/workspace/ink/types';
import { ApiError } from '../../src/lib/api';
import { getDb, type MedLevoDB } from '../../src/lib/localdb';

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => __resetStores());

const AR = 842 / 595;
const fakeSize = (w: number, h: number) => async () => ({ w, h });
const pngFile = (bytes = 2048, name = 'x.png') => new File([new Uint8Array(bytes)], name, { type: 'image/png' });

describe('image geometry and limits', () => {
  it('centres the picture on the tapped point, keeps its aspect ratio in page units, stays inside the page', () => {
    const b = imageBoxAt([0.5, 0.5], { w: 200, h: 100 }, AR);
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 6);
    expect(b.y + b.h / 2).toBeCloseTo(0.5, 6);
    // aspect: (h · pageH) / (w · pageW) = 100 / 200
    expect((b.h * 842) / (b.w * 595)).toBeCloseTo(0.5, 6);
    // natural size at 96 dpi: 200 px = 150 pt of a 595 pt page
    expect(b.w).toBeCloseTo(150 / 595, 6);
    // near an edge it is moved inside, never cut off
    const edge = imageBoxAt([0.99, 0.99], { w: 200, h: 100 }, AR);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(edge.y + edge.h).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('a large picture is capped to 60 % of the page in both directions (aspect kept)', () => {
    const wide = imageBoxAt([0.5, 0.5], { w: 6000, h: 1000 }, AR);
    expect(wide.w).toBeCloseTo(0.6, 6);
    const tall = imageBoxAt([0.5, 0.5], { w: 1000, h: 9000 }, AR);
    expect(tall.h).toBeCloseTo(0.6, 6);
    expect((tall.h * 842) / (tall.w * 595)).toBeCloseTo(9, 4);
  });

  it('refuses what the server would refuse, with a reason (type by content on the server; size on both)', () => {
    expect(checkImageFile({ type: 'image/png', size: 10 })).toEqual({ ok: true, mime: 'image/png' });
    expect(checkImageFile({ type: 'image/svg+xml', size: 10 })).toMatchObject({ ok: false, reason: expect.stringContaining('ليس صورة مدعومة') });
    expect(checkImageFile({ type: 'image/png', size: 11 * 1024 * 1024 })).toMatchObject({ ok: false, reason: expect.stringContaining('10 ميغابايت') });
    expect(checkImageFile({ type: 'image/jpeg', size: 0 })).toMatchObject({ ok: false });
  });
});

describe('inserting a picture (local-first, non-destructive)', () => {
  const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: 'NP1', space: 'page_norm' };
  const key = 'note_page:NP1';

  it('stores the bytes on this device, adds an image annotation (append op), and undo removes only that annotation', async () => {
    const store = getDocumentStore(`doc-img-${newId()}`);
    store.attachPage(key, anchor, AR);
    const r = await insertImage({ store, targetKey: key, anchor, file: pngFile(4096, 'diagram.png'), at: [0.5, 0.4], ar: AR, readSize: fakeSize(300, 150) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blob = (await getDb().blobs.get(imageBlobId(r.imageKey))) as ImageBlobRecord;
    expect(blob).toMatchObject({ kind: 'annotation_image', uploadState: 'pending', mime: 'image/png', size: 4096, name: 'diagram.png' });
    const item = store.items(key).find(isImage)!;
    expect(item.layer).toBe('media');
    expect(item.data).toMatchObject({ image_key: r.imageKey, natural_w: 300, natural_h: 150, bytes: 4096, mime: 'image/png' });
    await store.flush();
    expect((await getDb().outbox.where('entity_id').equals(item.id).toArray()).map((o) => o.op)).toEqual(['append']);
    store.undo();
    expect(store.items(key).some(isImage)).toBe(false);
    await store.flush();
    expect((await getDb().annotations.get(item.id))!.deletedAt).toBeTruthy(); // a tombstone, the bytes stay for redo
    expect(await getDb().blobs.get(imageBlobId(r.imageKey))).toBeTruthy();
  });

  it('refuses an unreadable or oversized picture before anything is stored', async () => {
    const store = getDocumentStore(`doc-img-${newId()}`);
    store.attachPage(key, anchor, AR);
    const broken = await insertImage({ store, targetKey: key, anchor, file: pngFile(), at: [0.5, 0.5], ar: AR, readSize: async () => Promise.reject(new Error('decode')) });
    expect(broken).toMatchObject({ ok: false, reason: expect.stringContaining('تعذّر فتح الصورة') });
    const huge = await insertImage({ store, targetKey: key, anchor, file: pngFile(), at: [0.5, 0.5], ar: AR, readSize: fakeSize(20_000, 100) });
    expect(huge).toMatchObject({ ok: false, reason: expect.stringContaining('12000') });
    expect(store.items(key)).toHaveLength(0);
  });

  it('moves and resizes with the lasso as a whole: centre follows, aspect ratio kept', () => {
    const base = { v: 1 as const, image_key: 'K', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 }, mime: 'image/png' as const, natural_w: 10, natural_h: 7, bytes: 9 };
    const item = { id: 'I', kind: 'image', tool: 'image', anchor, data: base, layer: 'media', z: 0, locked: false, anchor_status: 'ok', previous_anchor: null, input: null, device_id: null, rev: 0, created_at: 0, updated_at: 0, deleted_at: null } as const;
    const moved = transformItem({ ...item }, translate(0.1, 0.05 * AR), AR, 1);
    expect((moved.data as ImageAnnotationData).box).toEqual({ x: 0.3, y: 0.25, w: 0.2, h: 0.1 });
    const scaled = transformItem({ ...item }, scaleAbout(2, 0.3, 0.25 * AR), AR, 1);
    const b = (scaled.data as ImageAnnotationData).box;
    expect(b.w / b.h).toBeCloseTo(2, 6);
    expect(b.w).toBeCloseTo(0.4, 6);
    expect(b.x + b.w / 2).toBeCloseTo(0.3, 6);
  });
});

describe('uploads', () => {
  /** jsdom's Blob does not survive fake-indexeddb's structured clone: the uploader is driven through a minimal table */
  function stubDb(records: ImageBlobRecord[]) {
    const rows = new Map(records.map((r) => [r.id, { ...r }]));
    return {
      rows,
      db: {
        blobs: {
          where: () => ({ equals: () => ({ toArray: async () => [...rows.values()] }) }),
          update: async (id: string, patch: Partial<ImageBlobRecord>) => {
            rows.set(id, { ...rows.get(id)!, ...patch });
            return 1;
          },
        },
      } as unknown as MedLevoDB,
    };
  }
  const rec = (key: string, data: unknown = new Blob([new Uint8Array(3)], { type: 'image/png' })): ImageBlobRecord =>
    ({ id: imageBlobId(key), imageKey: key, kind: 'annotation_image', mime: 'image/png', size: 3, data, storedAt: 1, uploadState: 'pending' }) as ImageBlobRecord;

  it('uploads pending pictures once; a refusal keeps the bytes and the reason; no connection keeps them pending', async () => {
    // order matters: a lost connection stops the run (the pictures after it wait for the next one)
    const { db, rows } = stubDb([rec('OK1'), rec('BAD1'), rec('LOST', { not: 'a blob' }), rec('NET1')]);
    const post = vi.fn(async (form: FormData) => {
      const k = form.get('image_key');
      if (k === 'BAD1') throw new ApiError({ code: 'UNSUPPORTED_FORMAT', message: 'هذا الملف ليس صورة مدعومة.', status: 415 });
      if (k === 'NET1') throw new ApiError({ code: 'NETWORK_ERROR', message: 'لا اتصال', status: 0, offline: true });
    });
    const res = await kickImageUploads(db, { post, online: () => true, now: () => 1000 });
    expect(res).toEqual({ uploaded: 1, rejected: 2, failed: 1 });
    expect(rows.get(imageBlobId('OK1'))).toMatchObject({ uploadState: 'uploaded' });
    expect(rows.get(imageBlobId('BAD1'))).toMatchObject({ uploadState: 'rejected', uploadError: 'هذا الملف ليس صورة مدعومة.' });
    expect(rows.get(imageBlobId('NET1'))).toMatchObject({ uploadState: 'pending', attempts: 1, nextAttemptAt: 3000 });
    // bytes the browser lost are never uploaded as garbage
    expect(rows.get(imageBlobId('LOST'))).toMatchObject({ uploadState: 'rejected' });
    const form = post.mock.calls.find((c) => c[0].get('image_key') === 'OK1')![0];
    expect(form.get('file')).toBeInstanceOf(Blob);
    // retried only after its backoff, and never while offline
    const again = vi.fn(async () => undefined);
    expect(await kickImageUploads(db, { post: again, online: () => true, now: () => 2000 })).toEqual({ uploaded: 0, rejected: 0, failed: 0 });
    expect(await kickImageUploads(db, { post: again, online: () => false, now: () => 9000 })).toEqual({ uploaded: 0, rejected: 0, failed: 0 });
    expect(await kickImageUploads(db, { post: again, online: () => true, now: () => 9000 })).toEqual({ uploaded: 1, rejected: 0, failed: 0 });
  });

  it('only a verdict on the bytes is final: a refused origin (403), a 404 or a server error is retried later (review F1)', async () => {
    const { db, rows } = stubDb([rec('CSRF'), rec('GONE'), rec('BOOM'), rec('BIG')]);
    const post = vi.fn(async (form: FormData) => {
      const k = form.get('image_key');
      if (k === 'CSRF') throw new ApiError({ code: 'CSRF_FAILED', message: 'رُفض الطلب لأنه صادر من أصل غير مسموح.', status: 403 });
      if (k === 'GONE') throw new ApiError({ code: 'NOT_FOUND', message: 'غير موجود', status: 404 });
      if (k === 'BOOM') throw new ApiError({ code: 'INTERNAL', message: 'خطأ', status: 500 });
      if (k === 'BIG') throw new ApiError({ code: 'PAYLOAD_TOO_LARGE', message: 'الصورة أكبر من الحد المسموح.', status: 413 });
    });
    expect(await kickImageUploads(db, { post, online: () => true, now: () => 1000 })).toEqual({ uploaded: 0, rejected: 1, failed: 3 });
    for (const k of ['CSRF', 'GONE', 'BOOM']) expect(rows.get(imageBlobId(k)), k).toMatchObject({ uploadState: 'pending', attempts: 1 });
    expect(rows.get(imageBlobId('BIG'))).toMatchObject({ uploadState: 'rejected', uploadError: 'الصورة أكبر من الحد المسموح.' });
    // once the cause is fixed, the waiting pictures go up
    const ok = vi.fn(async () => undefined);
    expect(await kickImageUploads(db, { post: ok, online: () => true, now: () => 60_000 })).toEqual({ uploaded: 3, rejected: 0, failed: 0 });
  });
});

// ───────────── the tools in a layer ─────────────
function ToolProbe({ set }: { set?: InkToolId }) {
  const ink = useInk();
  useEffect(() => {
    if (set) ink.setTool(set);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set]);
  return <output data-testid="tool">{ink.toolState.tool}</output>;
}

describe('image and link tools in the ink layer', () => {
  let anchor: AnnotationAnchor;
  let key: string;
  beforeEach(() => {
    const id = newId();
    anchor = { type: 'note_page', note_page_id: id, space: 'page_norm' };
    key = `note_page:${id}`;
    window.localStorage.setItem('medlevo.ink.prefs.v1', JSON.stringify({ penOnly: false }));
  });

  function setup(tool: InkToolId, links: InkLinkHost | null) {
    const view = { pageWidth: 595, pageHeight: 842, scale: 1, rotation: 0 as const };
    const docKey = `doc-f1-${newId()}`;
    const r = render(
      <InkProvider documentKey={docKey}>
        <InkHost links={links} currentPage={() => ({ targetKey: key, anchor, ar: AR, pageWidthPt: 595 })}>
          <InkToolbar />
          <ToolProbe set={tool} />
          <div style={{ position: 'relative' }}>
            <InkLayer targetKey={key} anchor={anchor} view={view} interactive onStrokeActiveChange={() => undefined} />
          </div>
        </InkHost>
      </InkProvider>,
    );
    const root = r.container.querySelector('.ml-ink-layer') as HTMLElement;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 595, height: 842, right: 595, bottom: 842, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    return { root, store: getDocumentStore(docKey) };
  }
  const pointer = (root: HTMLElement, type: string, x: number, y: number) =>
    act(() => {
      root.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, isPrimary: true }));
    });

  it('the toolbar offers the picture tool; the link tool only where a host knows the pages it can open', () => {
    setup('hand', null);
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    expect(within(bar).getByRole('button', { name: 'إدراج صورة' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: 'رابط إلى صفحة' })).toBeNull();
  });

  it('image tool: a tap opens «إدراج صورة هنا»; the chosen file becomes a picture on the page; the lasso selects it by a tap', async () => {
    const bitmap = vi.fn(async () => ({ width: 400, height: 200, close: () => undefined }));
    vi.stubGlobal('createImageBitmap', bitmap);
    const { root, store } = setup('image', null);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('image'));
    pointer(root, 'pointerdown', 297, 300);
    pointer(root, 'pointerup', 297, 300);
    const card = await screen.findByRole('group', { name: 'إدراج صورة هنا' });
    const input = within(card).getByLabelText('اختر صورة من الجهاز') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [pngFile(1234, 'heart.png')] } });
    });
    await waitFor(() => expect(store.items(key).filter(isImage)).toHaveLength(1));
    const img = store.items(key).find(isImage)!;
    const b = (img.data as ImageAnnotationData).box;
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 2);
    expect(b.y + b.h / 2).toBeCloseTo(300 / 842, 2);
    expect(bitmap).toHaveBeenCalled();
    const fig = await waitFor(() => root.querySelector(`figure.ml-ink-image[data-ink-id="${img.id}"]`) as HTMLElement);
    expect(fig).toBeTruthy();
    // a picture never captures input (the pen writes over it); the lasso picks it by its box
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    pointer(root, 'pointerdown', 297, 300);
    pointer(root, 'pointerup', 297, 300);
    expect(store.getSelection()).toEqual({ targetKey: key, ids: [img.id] });
    act(() => store.deleteSelection());
    expect(store.items(key).some(isImage)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('link tool: a dragged box asks the host for the target; followed with the hand tool, the host opens it', async () => {
    const target = { type: 'note_page' as const, note_page_id: 'NP-TARGET' };
    const host: InkLinkHost = {
      pickTarget: vi.fn(async () => ({ target, label: 'انظر المخطط', targetLabel: 'صفحة 2 من الدفتر' })),
      open: vi.fn(),
    };
    const { root, store } = setup('link', host);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('link'));
    pointer(root, 'pointerdown', 100, 100);
    pointer(root, 'pointermove', 300, 120);
    pointer(root, 'pointerup', 300, 140);
    await waitFor(() => expect(store.items(key).filter(isLink)).toHaveLength(1));
    const link = store.items(key).find(isLink)!;
    expect(host.pickTarget).toHaveBeenCalledWith({ targetKey: key, anchor });
    const d = link.data as LinkData;
    expect(d.target).toEqual(target);
    expect(d.box.x).toBeCloseTo(100 / 595, 4);
    expect(d.box.w).toBeCloseTo(200 / 595, 4);
    expect(d.box.h).toBeCloseTo(40 / 842, 4);
    // while writing, the link lets the pen through: not clickable and out of the accessibility tree
    const el = () => root.querySelector(`.ml-ink-link[data-ink-id="${link.id}"]`) as HTMLElement;
    expect(el().className).not.toContain('ml-ink-link--active');
    expect(el().getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button', { name: /^رابط: انظر المخطط/ })).toBeNull();
    act(() => {
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'أدوات الكتابة' })).getByRole('button', { name: /^اليد/ }));
    });
    // with the hand tool it is a real, labelled button that says where it leads
    const btn = await screen.findByRole('button', { name: 'رابط: انظر المخطط — يفتح صفحة 2 من الدفتر' });
    expect(btn.className).toContain('ml-ink-link--active');
    expect(btn.tabIndex).toBe(0);
    fireEvent.click(btn);
    expect(host.open).toHaveBeenCalledWith(target, { targetKey: key, anchor });
  });

  it('a cancelled choice adds no link', async () => {
    const host: InkLinkHost = { pickTarget: vi.fn(async () => null), open: vi.fn() };
    const { root, store } = setup('link', host);
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('link'));
    pointer(root, 'pointerdown', 100, 100);
    pointer(root, 'pointerup', 260, 140);
    await waitFor(() => expect(host.pickTarget).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(store.items(key).filter(isLink)).toHaveLength(0);
  });
});
