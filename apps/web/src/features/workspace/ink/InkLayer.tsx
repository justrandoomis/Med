// One page's ink layer (contract in ./types.ts). Three canvases — highlights (multiply, beneath
// the text visually), committed ink, and a live layer for the stroke in progress — plus DOM for
// text boxes, sticky notes and the lasso selection. Pointer input is handled imperatively by
// PageInkController: a pointermove never causes a React render.
import { memo, useContext, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ImageOff, Link2, StickyNote as StickyIcon } from 'lucide-react';
import { newId, normToView, richTextFromPlain, richTextToPlain, stableStringify, viewSize, viewToNorm, type ImageAnnotationData, type LinkData, type NormBox, type RichText, type ShapeData, type StickyData, type TextBoxData } from '@medlevo/shared';
import { cx, RichTextView } from '../../../design';
import { useInkHost, type InkLinkHost } from './host';
import { insertImage, useImageSource } from './images';
import { isWritingToolId, useInk, useInkInternal } from './InkProvider';
import { PageInkController } from './layerController';
import { isImage, isLink, isSticky, isTextBox, makeLinkItem, makeStickyItem, makeTextItem, type InkItem, type InkItemOf } from './model';
import { resolveInkColor } from './palette';
import { usePaperTone } from './usePaperTone';
import { SelectionOverlay } from './SelectionOverlay';
import type { InkLayerProps, InkPageView, InkTextEditorProps } from './types';
import './ink.css';
// (parity N1 wave 2)
import { ReaderPageContext } from '../reader/readerContext';
import { getClipboard } from './store';
import { isShape } from './model';
import { connectorSentence, isConnector, nodeName } from './connectors';
import { addSegment, imagesOf, MeasureOverlay, NeatCopyBanner, NeatCopyCanvas, PageMenu, printedTextAt, RulerOverlay, ShapeLabelEditor, ShapeLabels, snapTargetsFor, useLabelledShapes, ZoomTargetBox, type MeasureSession } from './pageOverlays';
import { boxAt, boxSize, zoomDirection } from './zoomGeometry';
import { defaultStripAspect } from './zoomWindow';

/** (N1 wave 2, G67) a finger held still this long opens the page menu */
const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 10;

const DRAFT_TEXT_WIDTH = 0.32;
const STICKY_DEFAULT_COLOR = 'hl-yellow';
/** the server accepts sticky text up to 20 000 characters (annotations/schemas.ts) */
const STICKY_MAX_CHARS = 20_000;

export function InkLayer({ targetKey, anchor, view, interactive, onStrokeActiveChange }: InkLayerProps) {
  const ink = useInk();
  const internal = useInkInternal();
  const { store, toolRef, editing, setEditing } = internal;
  // (N1) callbacks of the controller that must always reach the latest provider state
  const n1 = useRef({ announce: internal.announce, gestureSelect: internal.gestureSelect, afterInsert: internal.afterInsert, undo: ink.undo, redo: ink.redo });
  useInsertionEffect(() => {
    n1.current = { announce: internal.announce, gestureSelect: internal.gestureSelect, afterInsert: internal.afterInsert, undo: ink.undo, redo: ink.redo };
  });
  // (N1 wave 2) the session state of the page tools, for the controller's callbacks (written at commit)
  const reader = useContext(ReaderPageContext);
  const neat = internal.neatPages.has(targetKey);
  const w2 = useRef({ ruler: internal.ruler, colorPick: internal.colorPick, setZoom: internal.setZoom, setMeasurePage: internal.setMeasurePage, inkSettings: internal.inkSettings, textLang: reader?.textLang ?? null, neat });
  useInsertionEffect(() => {
    w2.current = { ruler: internal.ruler, colorPick: internal.colorPick, setZoom: internal.setZoom, setMeasurePage: internal.setMeasurePage, inkSettings: internal.inkSettings, textLang: reader?.textLang ?? null, neat };
  });
  const [measure, setMeasure] = useState<MeasureSession>({ mode: 'length', segments: [] });
  const [labelEdit, setLabelEdit] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<PageInkController | null>(null);
  const viewRef = useRef(view);
  const anchorRef = useRef(anchor);
  const interactiveRef = useRef(interactive);
  const activeCb = useRef(onStrokeActiveChange);
  const ar = view.pageHeight / view.pageWidth;
  const host = useInkHost();
  const hostRef = useRef(host);
  // latest values for the pointer handlers and the controller, written at commit (before any layout effect, so the
  // layout effect below already sees them) rather than during render
  useInsertionEffect(() => {
    viewRef.current = view;
    anchorRef.current = anchor;
    interactiveRef.current = interactive;
    activeCb.current = onStrokeActiveChange;
    hostRef.current = host;
  });
  /** a link box waiting for its target (shown dashed while the host's chooser is open) */
  const [pendingLink, setPendingLink] = useState<NormBox | null>(null);
  const [objectsVersion, setObjectsVersion] = useState(0);
  const [, setSelectionVersion] = useState(0);
  const objectIds = useRef(new Set<string>());

  // the page model must exist before children read it
  useMemo(() => store.attachPage(targetKey, anchor, ar), [store, targetKey, anchor, ar]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const hl = hlRef.current;
    const inkC = inkRef.current;
    const live = liveRef.current;
    if (!root || !hl || !inkC || !live) return;
    store.attachPage(targetKey, anchorRef.current, viewRef.current.pageHeight / viewRef.current.pageWidth);
    const c = new PageInkController({
      store,
      targetKey,
      root,
      highlightCanvas: hl,
      inkCanvas: inkC,
      liveCanvas: live,
      getAnchor: () => anchorRef.current,
      getView: () => viewRef.current,
      getTool: () => toolRef.current,
      // (N1 wave 2, G11) the neat copy is a view: nothing is written while it is shown
      getInteractive: () => interactiveRef.current && !w2.current.neat,
      onStrokeActive: (a) => activeCb.current?.(a),
      onTextRequest: ({ kind, at }) => setEditing({ targetKey, kind, id: null, at }),
      onLinkRequest: ({ box }) => {
        const links = hostRef.current?.links;
        if (!links) return;
        setPendingLink(box);
        const from = { targetKey, anchor: anchorRef.current };
        void links
          .pickTarget(from)
          .then((choice) => {
            if (!choice) return;
            const item = makeLinkItem({ id: newId(), anchor: from.anchor, now: Date.now(), z: store.nextZ(targetKey), box, target: choice.target, label: choice.label, targetLabel: choice.targetLabel });
            store.commit('رابط إلى صفحة', [{ id: item.id, targetKey, before: null, after: item }]);
            n1.current.afterInsert(targetKey, [item.id]);
          })
          .catch(() => undefined)
          .finally(() => setPendingLink(null));
      },
      onSelectionChanged: () => setSelectionVersion((v) => v + 1),
      // (parity N1)
      announce: (m) => n1.current.announce(m),
      onFingerTap: (dir) => {
        if (dir === 'undo') n1.current.undo();
        else n1.current.redo();
      },
      onGestureSelect: (ids) => n1.current.gestureSelect(targetKey, ids),
      onInserted: (ids) => n1.current.afterInsert(targetKey, ids),
      // (parity N1 wave 2)
      getRuler: () => w2.current.ruler,
      getColorPick: () => w2.current.colorPick,
      onZoomPlace: (at) => {
        const z = w2.current.inkSettings.zoom;
        const v = viewRef.current;
        const ar = v.pageHeight / v.pageWidth;
        const dir = zoomDirection(z.direction, w2.current.textLang);
        const size = boxSize(z.line_height, defaultStripAspect(z.strip), ar);
        w2.current.setZoom({ targetKey, anchor: anchorRef.current, ar, pageW: v.pageWidth, box: boxAt(at, size, dir, z), dir });
        n1.current.announce('ظهرت نافذة الكتابة المكبّرة في أسفل الشاشة: اكتب فيها، ويُحفظ ما تكتبه في المربع المحدد على الصفحة.');
      },
      onMeasureSegment: (a, b) => {
        setMeasure((m) => addSegment(m, a, b));
        // one panel on screen: the page measured last
        w2.current.setMeasurePage(targetKey);
      },
      getSnapTargets: () => snapTargetsFor(store, targetKey, anchorRef.current, rootRef.current, viewRef.current, toolRef.current.snap),
    });
    ctrlRef.current = c;
    c.setView();
    return () => {
      c.destroy();
      ctrlRef.current = null;
    };
  }, [store, targetKey, toolRef, setEditing]);

  // zoom / rotation / page size → exact re-render from normalized data
  useLayoutEffect(() => {
    ctrlRef.current?.setView();
  }, [view.pageWidth, view.pageHeight, view.scale, view.rotation]);

  // device pixel ratio changes (moving the window to another screen, browser zoom)
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const listen = () => {
      try {
        mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        mq.addEventListener('change', onChange, { once: true });
      } catch {
        mq = null;
      }
    };
    const onChange = () => {
      ctrlRef.current?.setView();
      listen();
    };
    listen();
    return () => mq?.removeEventListener('change', onChange);
  }, []);

  // DOM objects (text boxes, sticky notes) re-render only when one of them changed
  useEffect(() => {
    return store.subscribePage(targetKey, (e) => {
      if (e.kind === 'loaded' || (e.kind === 'items' && e.dirty === 'all')) setObjectsVersion((v) => v + 1);
      else if (e.kind === 'items') {
        const page = store.page(targetKey);
        if (e.ids.some((id) => objectIds.current.has(id) || (page?.items.get(id) && isDomObject(page.items.get(id)!)))) setObjectsVersion((v) => v + 1);
      } else if (e.kind === 'hidden' && e.ids.some((id) => objectIds.current.has(id))) setObjectsVersion((v) => v + 1);
    });
  }, [store, targetKey]);

  // (P1-T2) re-render the DOM objects when the layers shown change
  const layerView = useSyncExternalStore(store.subscribeLayerView, store.getLayerViewVersion, store.getLayerViewVersion);
  const all = useMemo(
    () => store.items(targetKey).filter((i) => isDomObject(i) && store.isVisible(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, targetKey, objectsVersion, layerView],
  );
  // the ids the page subscription above checks, kept with the commit (not written during render)
  useInsertionEffect(() => {
    objectIds.current = new Set(all.map((i) => i.id));
  }, [all]);
  const objects = useMemo(() => all.filter((i): i is InkItemOf<TextBoxData> | InkItemOf<StickyData> => isTextBox(i) || isSticky(i)), [all]);
  // pictures sit under the ink (rendered before the canvases), links above it; both in paint order
  const images = useMemo(() => all.filter((i): i is InkItemOf<ImageAnnotationData> => isImage(i)).sort((a, b) => a.z - b.z || a.created_at - b.created_at), [all]);
  const links = useMemo(() => all.filter((i): i is InkItemOf<LinkData> => isLink(i)), [all]);

  const { width, height } = viewSize(view);
  const writing = ink.isWritingTool && interactive && !neat;
  const selection = store.getSelection();
  const selectionHere = selection?.targetKey === targetKey ? selection : null;
  const editingHere = editing?.targetKey === targetKey ? editing : null;

  // ── (parity N1 wave 2) shapes with a label (G20): re-rendered when a shape of the page changes ──
  const [shapesVersion, setShapesVersion] = useState(0);
  const labelled = useRef(new Set<string>());
  useEffect(
    () =>
      store.subscribePage(targetKey, (e) => {
        if (e.kind === 'loaded' || e.kind === 'view' || (e.kind === 'items' && (e.dirty === 'all' || e.ids.some((id) => store.item(targetKey, id)?.kind === 'shape' || labelled.current.has(id))))) setShapesVersion((v) => v + 1);
        else if (e.kind === 'hidden' && e.ids.some((id) => labelled.current.has(id))) setShapesVersion((v) => v + 1);
      }),
    [store, targetKey],
  );
  const pageItems = useMemo(
    () => store.items(targetKey).filter((i) => store.isVisible(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shapesVersion` / `layerView` are the page's change counters (the store is mutable)
    [store, targetKey, shapesVersion, layerView],
  );
  const labelledShapes = useLabelledShapes(pageItems);
  useInsertionEffect(() => {
    labelled.current = new Set(labelledShapes.map((i) => i.id));
  }, [labelledShapes]);
  const labelItem = labelEdit ? store.item(targetKey, labelEdit) : undefined;

  // ── (G67) the long-press page menu: a finger held still on blank space (or printed text, when a host can define it),
  // a right click, or the context-menu key on the page in view ──
  const pageMenuHere = internal.pageMenu?.targetKey === targetKey ? internal.pageMenu : null;
  const { setPageMenu, toggleNeat, announce } = internal;
  const openMenuAt = useRef<(clientX: number, clientY: number, target: EventTarget | null) => boolean>(() => false);
  // the click a lifted long press may still fire is swallowed — only that one (until shortly after the finger lifts)
  const suppressClick = useRef<{ id: number | null; until: number }>({ id: null, until: 0 });
  useInsertionEffect(() => {
    openMenuAt.current = (clientX, clientY, target) => {
      const root = rootRef.current;
      const c = ctrlRef.current;
      if (!root) return false;
      const r = root.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
      const v = viewRef.current;
      const { width: vw, height: vh } = viewSize(v);
      const at = viewToNormLocal(((clientX - r.left) * vw) / (r.width || vw), ((clientY - r.top) * vh) / (r.height || vh), v);
      const text = printedTextAt(target);
      // on the owner's ink the press belongs to the lasso; on printed text only the host's entries make a menu
      if (c?.hitTest(at)) return false;
      if (text && !host?.pageMenu?.define && !host?.pageMenu?.addToReview) return false;
      setPageMenu({ targetKey, at, printed: !!text, text });
      return true;
    };
  });
  useEffect(() => {
    const root = rootRef.current;
    const sheet = (root?.closest('.wk-sheet') as HTMLElement | null) ?? root?.parentElement?.parentElement ?? null;
    if (!sheet) return;
    let press: { id: number; x: number; y: number; timer: number; target: EventTarget | null } | null = null;
    const clear = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    const onDown = (e: PointerEvent) => {
      clear();
      if (suppressClick.current.id !== e.pointerId) suppressClick.current = { id: null, until: 0 };
      // a finger: with «القلم فقط» off and a writing tool, the finger IS the pen (no menu)
      const t = toolRef.current;
      if (e.pointerType !== 'touch' || (isWritingToolId(t.tool) && !t.penOnly)) return;
      const target = e.target;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, target, timer: window.setTimeout(() => {
        const p = press;
        press = null;
        if (p && openMenuAt.current(p.x, p.y, p.target)) suppressClick.current = { id: p.id, until: Infinity };
      }, LONG_PRESS_MS) };
    };
    const onMove = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) clear();
    };
    const onEnd = (e: PointerEvent) => {
      if (press && e.pointerId === press.id) clear();
      if (suppressClick.current.id === e.pointerId) suppressClick.current = { id: null, until: performance.now() + 400 };
    };
    const onContext = (e: MouseEvent) => {
      // a right click (or the long-press callout of a touch browser) on blank space: our menu instead of the browser's
      if ((window.getSelection?.()?.toString() ?? '') !== '') return;
      if (openMenuAt.current(e.clientX, e.clientY, e.target)) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() < suppressClick.current.until) {
        suppressClick.current = { id: null, until: 0 };
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const opts = { capture: true } as AddEventListenerOptions;
    sheet.addEventListener('pointerdown', onDown, opts);
    sheet.addEventListener('pointermove', onMove, opts);
    sheet.addEventListener('pointerup', onEnd, opts);
    sheet.addEventListener('pointercancel', onEnd, opts);
    sheet.addEventListener('contextmenu', onContext);
    sheet.addEventListener('click', onClick, opts);
    return () => {
      clear();
      sheet.removeEventListener('pointerdown', onDown, opts);
      sheet.removeEventListener('pointermove', onMove, opts);
      sheet.removeEventListener('pointerup', onEnd, opts);
      sheet.removeEventListener('pointercancel', onEnd, opts);
      sheet.removeEventListener('contextmenu', onContext);
      sheet.removeEventListener('click', onClick, opts);
    };
  }, [toolRef]);
  // the context-menu key (or Shift+F10) opens the menu of the page in view, at its centre
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
      const a = document.activeElement;
      if (a && a !== document.body && !a.closest('.ml-ink-layer, .wk-page, .wk-canvas')) return;
      const here = hostRef.current?.currentPage()?.targetKey ?? store.activeTargetKey;
      if (here !== targetKey) return;
      e.preventDefault();
      setPageMenu({ targetKey, at: [0.5, 0.4], printed: false });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [store, targetKey, setPageMenu]);
  const notePageAfter =
    anchor.type === 'note_page' && reader?.notePageActions
      ? () => reader.notePageActions!.insertAfter(anchor.note_page_id)
      : anchor.type === 'page' && host?.pageMenu?.newNotePageAfter
        ? () => host.pageMenu!.newNotePageAfter!(anchor)
        : null;
  const menuActions = pageMenuHere
    ? {
        paste: getClipboard()
          ? () => {
              const n = store.paste(targetKey, { at: pageMenuHere.at });
              announce(n ? `أُلصق ${n.toLocaleString('ar-EG')} عنصر هنا.` : 'تعذّر اللصق هنا.');
            }
          : null,
        pasteReason: 'لا يوجد ما يُلصق: انسخ كتابة بالتحديد الحر أولًا (الصور: Ctrl/⌘ V).',
        text: () => setEditing({ targetKey, kind: 'text', id: null, at: pageMenuHere.at }),
        sticky: () => setEditing({ targetKey, kind: 'sticky', id: null, at: pageMenuHere.at }),
        notePageAfter,
        define: pageMenuHere.text && host?.pageMenu?.define ? () => host.pageMenu!.define!({ text: pageMenuHere.text!, anchor: anchorRef.current, at: pageMenuHere.at }) : null,
        review: pageMenuHere.text && host?.pageMenu?.addToReview ? () => host.pageMenu!.addToReview!({ text: pageMenuHere.text!, anchor: anchorRef.current, at: pageMenuHere.at }) : null,
        neat: { on: neat, toggle: () => toggleNeat(targetKey) },
      }
    : null;

  return (
    <div
      ref={rootRef}
      className="ml-ink-layer"
      style={{ width, height }}
      data-tool={ink.toolState.tool}
      data-writing={writing ? '' : undefined}
      data-pen-only={ink.toolState.penOnly ? '' : undefined}
      data-ink-target={targetKey}
      data-neat={neat ? '' : undefined}
      data-color-pick={internal.colorPick ? '' : undefined}
      dir="ltr"
    >
      {images.map((o) => (
        <ImageView key={o.id} item={o} view={view} hidden={store.isHidden(o.id)} />
      ))}
      <canvas ref={hlRef} className="ml-ink-layer__canvas ml-ink-layer__canvas--highlight" aria-hidden="true" />
      <canvas ref={inkRef} className="ml-ink-layer__canvas" aria-hidden="true" />
      <canvas ref={liveRef} className="ml-ink-layer__canvas ml-ink-layer__canvas--live" aria-hidden="true" />
      {/* (N1 wave 2, G11) the neat copy: a derived drawing over the hidden ink canvases; nothing is written */}
      {neat && <NeatCopyCanvas store={store} targetKey={targetKey} view={view} dir={reader?.textLang === 'en' ? 'ltr' : 'rtl'} />}
      {neat && <NeatCopyBanner onOff={() => toggleNeat(targetKey)} />}
      <ShapeLabels items={labelledShapes} view={view} hidden={(id) => store.isHidden(id) || labelEdit === id} />
      <PageSummary store={store} targetKey={targetKey} />
      {objects.map((o) =>
        isTextBox(o) ? (
          <TextBoxView
            key={o.id}
            item={o}
            view={view}
            hidden={store.isHidden(o.id) || editingHere?.id === o.id}
            editable={ink.toolState.tool === 'text' && store.isEditable(o)}
            onEdit={() => setEditing({ targetKey, kind: 'text', id: o.id, at: [o.data.box.x, o.data.box.y] })}
          />
        ) : (
          <StickyView
            key={o.id}
            item={o}
            view={view}
            hidden={store.isHidden(o.id)}
            open={editingHere?.id === o.id && store.isEditable(o)}
            onOpen={() => (store.isEditable(o) ? setEditing({ targetKey, kind: 'sticky', id: o.id, at: o.data.at }) : undefined)}
          />
        ),
      )}
      {links.map((o) => (
        <LinkView
          key={o.id}
          item={o}
          view={view}
          hidden={store.isHidden(o.id)}
          host={host?.links ?? null}
          followable={!ink.isWritingTool || !interactive}
          onFollow={() => host?.links?.open(o.data.target, { targetKey, anchor: anchorRef.current })}
        />
      ))}
      {pendingLink && <span className="ml-ink-link ml-ink-link--pending" style={boxStyle(pendingLink, view)} aria-hidden="true" />}
      {editingHere && editingHere.kind === 'image' ? (
        <ImageInsertCard key={`img:${editingHere.at.join(',')}`} at={editingHere.at} view={view} targetKey={targetKey} getAnchor={() => anchorRef.current} onDone={() => setEditing(null)} />
      ) : editingHere ? (
        <ObjectEditor
          key={`${editingHere.id ?? 'draft'}:${editingHere.at.join(',')}`}
          editing={editingHere}
          view={view}
          onDone={() => setEditing(null)}
          getAnchor={() => anchorRef.current}
        />
      ) : null}
      {selectionHere && ink.toolState.tool === 'lasso' && (
        <SelectionOverlay targetKey={targetKey} view={view} controller={ctrlRef} onStrokeActiveChange={(a) => activeCb.current?.(a)} onEditLabel={setLabelEdit} />
      )}
      {/* ── (parity N1 wave 2) ── */}
      {labelItem && isShape(labelItem) && (
        <ShapeLabelEditor
          key={labelItem.id}
          item={labelItem as InkItemOf<ShapeData>}
          view={view}
          onCancel={() => setLabelEdit(null)}
          onSave={(text) => {
            const it = labelItem as InkItemOf<ShapeData>;
            const clean = text.trim();
            const data: ShapeData = { ...it.data };
            if (clean) data.label = richTextFromPlain(clean);
            else delete data.label;
            store.commit(clean ? 'نص داخل الشكل' : 'حذف النص داخل الشكل', [{ id: it.id, targetKey, before: it, after: { ...it, data, updated_at: Date.now() } }]);
            setLabelEdit(null);
          }}
        />
      )}
      {internal.ruler?.targetKey === targetKey && (
        <RulerOverlay
          ruler={internal.ruler}
          view={view}
          layerRoot={() => rootRef.current}
          onChange={internal.setRuler}
          onClose={() => {
            internal.setRuler(null);
            announce('أُخفيت المسطرة.');
          }}
        />
      )}
      {internal.zoom?.targetKey === targetKey && <ZoomTargetBox box={internal.zoom.box} view={view} onMove={(box) => internal.setZoom({ ...internal.zoom!, box })} />}
      {internal.measurePage === targetKey && (
        <MeasureOverlay
          targetKey={targetKey}
          view={view}
          session={measure}
          setSession={setMeasure}
          images={imagesOf(pageItems)}
          onClose={() => {
            setMeasure({ mode: 'length', segments: [] });
            internal.setMeasurePage(null);
            ink.setTool('hand');
          }}
        />
      )}
      {pageMenuHere && menuActions && <PageMenu req={pageMenuHere} view={view} actions={menuActions} onClose={() => setPageMenu(null)} />}
    </div>
  );
}

/** The local view point of a layer → normalized page point (the shared inverse of normToView). */
function viewToNormLocal(x: number, y: number, view: InkPageView): [number, number] {
  return viewToNorm(x, y, view);
}

/**
 * What a screen reader is told about the page's writing. Re-renders on committed changes only
 * (a stroke, an erase, an undo) — never per pointermove.
 */
function PageSummary({ store, targetKey }: { store: ReturnType<typeof useInkInternal>['store']; targetKey: string }) {
  const [version, setVersion] = useState(0);
  // (P1-T2) a layer shown / hidden in this session changes what is on the page too ('view')
  useEffect(() => store.subscribePage(targetKey, (e) => (e.kind === 'items' || e.kind === 'loaded' || e.kind === 'view') && setVersion((v) => v + 1)), [store, targetKey]);
  const text = useMemo(() => {
    const all = store.items(targetKey);
    const shown = all.filter((i) => store.isVisible(i));
    const hidden = all.length - shown.length;
    return summarize(shown, all) + (hidden > 0 ? ` وفي طبقات مخفية ${hidden} عنصرًا.` : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the page's change counter: the store is mutable, so it is what invalidates the summary
  }, [store, targetKey, version]);
  return (
    <p className="ml-visually-hidden" dir="rtl">
      {text}
    </p>
  );
}

function summarize(items: readonly InkItem[], all: readonly InkItem[] = items): string {
  let ink = 0;
  let hl = 0;
  let shapes = 0;
  let text = 0;
  let sticky = 0;
  let images = 0;
  let links = 0;
  // (N1, G03) what the colours mean, read out with the counts (never colour alone)
  const meanings = new Map<string, number>();
  for (const i of items) {
    const m = (i.kind === 'ink' || i.kind === 'shape' ? (i.data as { style?: { meaning?: string } }).style?.meaning : undefined) ?? null;
    if (m) meanings.set(m, (meanings.get(m) ?? 0) + 1);
    if (i.kind === 'ink') {
      if ((i.data as { style?: { tool?: string } }).style?.tool === 'highlighter') hl++;
      else ink++;
    } else if (i.kind === 'shape') shapes++;
    else if (i.kind === 'text') text++;
    else if (i.kind === 'sticky') sticky++;
    else if (i.kind === 'image') images++;
    else if (i.kind === 'link') links++;
  }
  if (!ink && !hl && !shapes && !text && !sticky && !images && !links) return 'لا توجد كتابة على هذه الصفحة.';
  const extra = `${images ? `، صور ${images}` : ''}${links ? `، روابط ${links}` : ''}`;
  const legend = meanings.size ? ` بحسب معنى اللون: ${[...meanings].map(([m, n]) => `«${m}» ${n}`).join('، ')}.` : '';
  return `على هذه الصفحة: خطوط بالقلم ${ink}، تظليل ${hl}، أشكال ${shapes}، مربعات نص ${text}، ملاحظات لاصقة ${sticky}${extra}.${legend}${diagramSentences(items, all)}`;
}

/**
 * (review of N1 wave 2, G21) What the diagrams of the page connect, in words («Insulin» يسبّب «GLUT4») — the arrows and
 * their heads are canvas paths, so without this a screen reader heard a connection only once, when it was drawn.
 */
function diagramSentences(items: readonly InkItem[], all: readonly InkItem[]): string {
  const connectors = items.filter(isConnector);
  if (connectors.length === 0) return '';
  const byId = new Map(all.map((i) => [i.id, i]));
  const name = (id: string) => {
    const it = byId.get(id);
    return it && isShape(it) ? nodeName(it.data) : null;
  };
  const MAX = 20;
  const said = connectors.slice(0, MAX).map((c) => connectorSentence(c.data, name));
  const more = connectors.length > MAX ? `، و${(connectors.length - MAX).toLocaleString('ar-EG')} موصِّلات أخرى` : '';
  return ` المخطط: ${said.join('؛ ')}${more}.`;
}

/** Text boxes, sticky notes, pictures and links are DOM objects of the layer (not canvas paths). */
function isDomObject(i: InkItem): boolean {
  return isTextBox(i) || isSticky(i) || isImage(i) || isLink(i);
}

/** CSS rotation of a box: the page's quarter turn and (N1, G19) the item's own rotation in page space. */
function boxTransform(view: InkPageView, rotation: number | undefined): string | undefined {
  const parts: string[] = [];
  if (view.rotation) parts.push(`rotate(${view.rotation}deg)`);
  if (rotation) parts.push(`rotate(${Math.round(rotation * 1e6) / 1e6}rad)`);
  return parts.length ? parts.join(' ') : undefined;
}

/** A normalized box placed in the (rotated) view: centred where the box's centre lands, rotated with the page. */
export function boxStyle(box: NormBox, view: InkPageView, rotation?: number): CSSProperties {
  const w = box.w * view.pageWidth * view.scale;
  const h = box.h * view.pageHeight * view.scale;
  const [cx, cy] = normToView(box.x + box.w / 2, box.y + box.h / 2, view);
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: boxTransform(view, rotation) };
}

function textBoxStyle(box: NormBox, fontScale: number, view: InkPageView, rotation?: number): CSSProperties {
  const w = box.w * view.pageWidth * view.scale;
  const h = box.h * view.pageHeight * view.scale;
  const [cx, cy] = normToView(box.x + box.w / 2, box.y + box.h / 2, view);
  return {
    left: cx - w / 2,
    top: cy - h / 2,
    width: w,
    minHeight: h,
    fontSize: Math.max(4, fontScale * view.pageWidth * view.scale),
    transform: boxTransform(view, rotation),
  };
}

const TextBoxView = memo(function TextBoxView({ item, view, hidden, editable, onEdit }: { item: InkItemOf<TextBoxData>; view: InkPageView; hidden: boolean; editable: boolean; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tone = usePaperTone(ref);
  const style: CSSProperties = { ...textBoxStyle(item.data.box, item.data.font_scale, view, item.data.rotation), color: resolveInkColor(item.data.color, tone, null), visibility: hidden ? 'hidden' : undefined };
  return (
    <div
      ref={ref}
      className={cx('ml-ink-text', editable && 'ml-ink-text--editable')}
      style={style}
      dir="rtl"
      data-ink-ui={editable ? '' : undefined}
      onClick={editable ? onEdit : undefined}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? `تحرير مربع النص: ${richTextToPlain(item.data.text).slice(0, 60)}` : undefined}
      onKeyDown={
        editable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onEdit();
              }
            }
          : undefined
      }
    >
      <RichTextView value={item.data.text} />
    </div>
  );
});

const StickyView = memo(function StickyView({ item, view, hidden, open, onOpen }: { item: InkItemOf<StickyData>; view: InkPageView; hidden: boolean; open: boolean; onOpen: () => void }) {
  const [x, y] = normToView(item.data.at[0], item.data.at[1], view);
  const ref = useRef<HTMLButtonElement>(null);
  const tone = usePaperTone(ref);
  const color = resolveInkColor(item.data.color, tone, null);
  const preview = item.data.text.trim().split(/\s+/).slice(0, 8).join(' ');
  if (open) return null;
  return (
    <button
      ref={ref}
      type="button"
      className="ml-ink-sticky"
      style={{ left: x, top: y, visibility: hidden ? 'hidden' : undefined, '--ml-ink-sticky-color': color } as CSSProperties}
      data-ink-ui=""
      onClick={onOpen}
      aria-label={`ملاحظة لاصقة: ${preview || 'فارغة'}`}
      title={preview}
    >
      <StickyIcon size={16} aria-hidden="true" />
    </button>
  );
});

// ───────────────────────────── pictures (track F1) ─────────────────────────────
/** Why a picture cannot be shown — honest about the two cases (no connection / not uploaded by its device yet). */
function missingReason(): string {
  return typeof navigator !== 'undefined' && navigator.onLine === false
    ? 'الصورة غير محمّلة على هذا الجهاز؛ تظهر عند عودة الاتصال.'
    : 'لم تصل الصورة إلى الخادم بعد؛ تُرفع من الجهاز الذي أُضيفت منه عند اتصاله.';
}

const ImageView = memo(function ImageView({ item, view, hidden }: { item: InkItemOf<ImageAnnotationData>; view: InkPageView; hidden: boolean }) {
  const src = useImageSource(item.data.image_key);
  const [failed, setFailed] = useState(false);
  // another picture source gets another try (adjusted while rendering instead of in an effect)
  const [triedSrc, setTriedSrc] = useState(src.src);
  if (triedSrc !== src.src) {
    setTriedSrc(src.src);
    setFailed(false);
  }
  const alt = item.data.alt || (item.data.name ? `صورة أضفتها: ${item.data.name}` : 'صورة أضفتها إلى الصفحة');
  const style: CSSProperties = { ...boxStyle(item.data.box, view, item.data.rotation), visibility: hidden ? 'hidden' : undefined };
  return (
    <figure className={cx('ml-ink-image', failed && 'ml-ink-image--missing')} style={style} data-image-key={item.data.image_key} data-ink-id={item.id}>
      {src.src && !failed ? (
        <img src={src.src} alt={alt} draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="ml-ink-image__missing" role="img" aria-label={`${alt} — ${missingReason()}`}>
          <ImageOff size={18} aria-hidden="true" />
          <span>{missingReason()}</span>
        </span>
      )}
      {src.upload === 'pending' && <figcaption className="ml-ink-image__badge">محفوظة على هذا الجهاز — بانتظار الرفع</figcaption>}
      {src.upload === 'rejected' && <figcaption className="ml-ink-image__badge ml-ink-image__badge--error">لم يقبلها الخادم: {src.uploadError ?? 'سبب غير معروف'} (ما زالت على هذا الجهاز)</figcaption>}
    </figure>
  );
});

/** «إدراج صورة هنا»: choose a file (or paste) — placed centred on the tapped point. */
function ImageInsertCard({ at, view, targetKey, getAnchor, onDone }: { at: [number, number]; view: InkPageView; targetKey: string; getAnchor: () => InkLayerProps['anchor']; onDone: () => void }) {
  const { store, announce, afterInsert } = useInkInternal();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [x, y] = normToView(at[0], at[1], view);
  const { width } = viewSize(view);
  const left = Math.min(Math.max(0, x - 12), Math.max(0, width - 260));
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const r = await insertImage({ store, targetKey, anchor: getAnchor(), file, at, ar: view.pageHeight / view.pageWidth, pageWidthPt: view.pageWidth });
    setBusy(false);
    if (!r.ok) {
      setError(r.reason);
      return;
    }
    announce('أُدرجت الصورة. حرّكها أو غيّر حجمها بأداة التحديد الحر.');
    onDone();
    afterInsert(targetKey, [r.id]);
  };
  return (
    <div className="ml-ink-sticky-card ml-ink-image-card" style={{ left, top: y + 12 }} data-ink-ui="" dir="rtl" role="group" aria-label="إدراج صورة هنا">
      <p className="ml-ink-image-card__title">إدراج صورة هنا</p>
      <label className="ml-ink-linkbtn ml-ink-image-card__pick">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="ml-visually-hidden"
          aria-label="اختر صورة من الجهاز"
          disabled={busy}
          onChange={(e) => void choose(e.target.files?.[0])}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onDone();
          }}
        />
        {busy ? 'جارٍ الإدراج…' : 'اختر صورة من الجهاز…'}
      </label>
      <p className="ml-ink-options__note">أو الصق صورة (Ctrl/⌘ V). PNG أو JPEG أو WebP أو GIF، حتى 10 ميغابايت. لا تُغيَّر الصفحة نفسها.</p>
      {error && (
        <p className="ml-ink-image-card__error" role="alert">
          {error}
        </p>
      )}
      <div className="ml-ink-sticky-card__actions">
        <button type="button" className="ml-ink-linkbtn" onClick={onDone}>
          إلغاء
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────── page links (track F1) ─────────────────────────────
const LinkView = memo(function LinkView({ item, view, hidden, host, followable, onFollow }: { item: InkItemOf<LinkData>; view: InkPageView; hidden: boolean; host: InkLinkHost | null; followable: boolean; onFollow: () => void }) {
  const d = item.data;
  const where = host?.describe?.(d.target) ?? d.target_label ?? (d.target.type === 'note_page' ? 'صفحة ملاحظات' : `الصفحة ${d.target.page_index + 1} في الملف`);
  const text = d.label?.trim() || where;
  const style: CSSProperties = { ...boxStyle(d.box, view), visibility: hidden ? 'hidden' : undefined };
  const active = followable && !!host;
  return (
    <button
      type="button"
      className={cx('ml-ink-link', active && 'ml-ink-link--active')}
      style={style}
      data-ink-ui={active ? '' : undefined}
      data-ink-id={item.id}
      tabIndex={active ? 0 : -1}
      aria-hidden={active ? undefined : true}
      aria-label={`رابط: ${d.label?.trim() ? `${d.label.trim()} — ` : ''}يفتح ${where}`}
      title={`يفتح ${where}`}
      onClick={active ? onFollow : undefined}
    >
      <Link2 size={14} aria-hidden="true" />
      <span className="ml-ink-link__text" dir="auto">
        {text}
      </span>
    </button>
  );
});

/**
 * (N1 Wave 0) The engine's own text-box editor: a plain-text area (the default of the text-editor slot of
 * <InkProvider>; N3 mounts a rich editor in its place).
 */
export function PlainTextBoxEditor({ initial, style, ariaLabel, placeholder, onChange, onFinish }: InkTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => richTextToPlain(initial));
  const report = useRef(onChange);
  useInsertionEffect(() => {
    report.current = onChange;
  });
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    if (el) report.current(initial, el.scrollHeight);
    // the editor opens once per text box: the first height is reported once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <textarea
      ref={ref}
      className="ml-ink-text-editor"
      style={style}
      value={value}
      dir="auto"
      aria-label={ariaLabel}
      placeholder={placeholder}
      data-ink-ui=""
      onChange={(e) => {
        setValue(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = `${e.target.scrollHeight}px`;
        report.current(richTextFromPlain(e.target.value), e.target.scrollHeight);
      }}
      onBlur={(e) => onFinish(e.currentTarget.scrollHeight)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
          e.preventDefault();
          onFinish(e.currentTarget.scrollHeight);
        }
      }}
    />
  );
}

const EMPTY_TEXT: RichText = { v: 1, paragraphs: [] } as unknown as RichText;

/**
 * Editor for a text box or a sticky note (draft or existing). Saves on blur / Ctrl+Enter / Escape,
 * AND when it is replaced or unmounted without a blur (e.g. another tap on the page with the text
 * tool, a tool switch): typed text is never lost. Text boxes use the editor of the provider's text-editor slot.
 */
function ObjectEditor({ editing, view, onDone, getAnchor }: { editing: NonNullable<ReturnType<typeof useInkInternal>['editing']>; view: InkPageView; onDone: () => void; getAnchor: () => InkLayerProps['anchor'] }) {
  const { store, prefs, textEditor, afterInsert } = useInkInternal();
  const existing = editing.id ? store.item(editing.targetKey, editing.id) : undefined;
  const initial = existing ? (isTextBox(existing) ? richTextToPlain(existing.data.text) : isSticky(existing) ? existing.data.text : '') : '';
  const initialRich = useMemo<RichText>(() => (existing && isTextBox(existing) ? existing.data.text : EMPTY_TEXT), [existing]);
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const valueRef = useRef(initial);
  /** (N1) the text box's content as the slot's editor reports it */
  const richRef = useRef<RichText | null>(null);
  const heightRef = useRef(0);
  const custom = !!textEditor;

  /** Writes the edit (if any). Pure data: no DOM reads, so it also works during unmount. */
  const commitRef = useRef<() => void>(() => {});
  // rebuilt with each commit (not during render), so a save on blur / unmount always uses the latest values
  useInsertionEffect(() => {
    commitRef.current = () => {
      if (done.current) return;
      const now = Date.now();
      if (editing.kind === 'text') {
        const rich = richRef.current;
        if (!rich) return; // the editor reported nothing (never changed)
        const text = richTextToPlain(rich).trim();
        // nothing changed (also: StrictMode's simulated unmount)
        if (custom ? stableStringify(rich) === stableStringify(initialRich) : text === initial.trim()) return;
        done.current = true;
        const stored = custom ? rich : richTextFromPlain(text);
        const hNorm = Math.max(0.02, heightRef.current / (view.pageHeight * view.scale));
        if (existing && isTextBox(existing)) {
          if (!text) store.commit('حذف مربع نص', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after: null }]);
          else {
            const after = { ...existing, data: { ...existing.data, text: stored, box: { ...existing.data.box, h: hNorm } }, updated_at: now };
            store.commit('تحرير نص', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after }]);
          }
        } else if (text) {
          const preset = prefs.presets.text;
          const w = Math.min(DRAFT_TEXT_WIDTH, 1 - editing.at[0]);
          const item = makeTextItem({ id: newId(), anchor: getAnchor(), now, z: store.nextZ(editing.targetKey), box: { x: editing.at[0], y: editing.at[1], w: Math.max(0.08, w), h: hNorm }, text: stored, color: preset.color, fontScale: preset.width });
          store.commit('مربع نص', [{ id: item.id, targetKey: editing.targetKey, before: null, after: item }]);
          afterInsert(editing.targetKey, [item.id]);
        }
        return;
      }
      const text = valueRef.current.trim();
      if (text === initial.trim()) return; // nothing changed (also: StrictMode's simulated unmount)
      done.current = true;
      if (existing && isSticky(existing)) {
        const after = { ...existing, data: { ...existing.data, text }, updated_at: now };
        store.commit('تحرير ملاحظة لاصقة', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after }]);
      } else if (text) {
        const item = makeStickyItem({ id: newId(), anchor: getAnchor(), now, z: store.nextZ(editing.targetKey), at: editing.at, text, color: STICKY_DEFAULT_COLOR });
        store.commit('ملاحظة لاصقة', [{ id: item.id, targetKey: editing.targetKey, before: null, after: item }]);
        afterInsert(editing.targetKey, [item.id]);
      }
    };
  });

  useEffect(() => {
    ref.current?.focus();
    if (ref.current) heightRef.current = ref.current.scrollHeight;
    return () => commitRef.current();
  }, []);

  const finish = () => {
    if (ref.current) heightRef.current = ref.current.scrollHeight;
    commitRef.current();
    done.current = true;
    onDone();
  };

  const remove = () => {
    if (existing) store.commit('حذف', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after: null }]);
    done.current = true;
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      finish();
    }
  };

  if (editing.kind === 'text') {
    const box = existing && isTextBox(existing) ? existing.data.box : { x: editing.at[0], y: editing.at[1], w: Math.max(0.08, Math.min(DRAFT_TEXT_WIDTH, 1 - editing.at[0])), h: 0.04 };
    const fontScale = existing && isTextBox(existing) ? existing.data.font_scale : prefs.presets.text.width;
    const rotation = existing && isTextBox(existing) ? existing.data.rotation : undefined;
    const Editor = textEditor ?? PlainTextBoxEditor;
    return (
      <Editor
        initial={initialRich.paragraphs.length ? initialRich : richTextFromPlain(initial)}
        style={textBoxStyle(box, fontScale, view, rotation)}
        ariaLabel={existing ? 'تحرير مربع النص' : 'مربع نص جديد'}
        placeholder="اكتب هنا…"
        onChange={(text, h) => {
          richRef.current = text;
          heightRef.current = h;
        }}
        onFinish={(h) => {
          heightRef.current = h;
          commitRef.current();
          done.current = true;
          onDone();
        }}
      />
    );
  }
  const [x, y] = normToView(editing.at[0], editing.at[1], view);
  const { width } = viewSize(view);
  const left = Math.min(Math.max(0, x - 12), Math.max(0, width - 240));
  return (
    <div className="ml-ink-sticky-card" style={{ left, top: y + 18 }} data-ink-ui="" dir="rtl">
      <label className="ml-visually-hidden" htmlFor={`sticky-${editing.id ?? 'draft'}`}>
        نص الملاحظة اللاصقة
      </label>
      <textarea
        id={`sticky-${editing.id ?? 'draft'}`}
        ref={ref}
        className="ml-ink-sticky-card__input"
        value={value}
        maxLength={STICKY_MAX_CHARS}
        dir="auto"
        rows={4}
        placeholder="ملاحظة…"
        onChange={(e) => {
          setValue(e.target.value);
          valueRef.current = e.target.value;
        }}
        onBlur={(e) => {
          // moving focus to the card's own delete button is not "done"
          if (e.relatedTarget && (e.currentTarget.parentElement?.contains(e.relatedTarget as Node) ?? false)) return;
          finish();
        }}
        onKeyDown={onKeyDown}
      />
      <div className="ml-ink-sticky-card__actions">
        {existing && (
          <button type="button" className="ml-ink-linkbtn ml-ink-linkbtn--danger" onMouseDown={(e) => e.preventDefault()} onClick={remove}>
            حذف الملاحظة
          </button>
        )}
        <button type="button" className="ml-ink-linkbtn" onMouseDown={(e) => e.preventDefault()} onClick={finish}>
          تم
        </button>
      </div>
    </div>
  );
}
