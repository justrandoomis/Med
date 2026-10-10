// One page's ink layer (contract in ./types.ts). Three canvases — highlights (multiply, beneath
// the text visually), committed ink, and a live layer for the stroke in progress — plus DOM for
// text boxes, sticky notes and the lasso selection. Pointer input is handled imperatively by
// PageInkController: a pointermove never causes a React render.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ImageOff, Link2, StickyNote as StickyIcon } from 'lucide-react';
import { newId, normToView, richTextFromPlain, richTextToPlain, viewSize, type ImageAnnotationData, type LinkData, type NormBox, type StickyData, type TextBoxData } from '@medlevo/shared';
import { cx, RichTextView } from '../../../design';
import { useInkHost, type InkLinkHost } from './host';
import { insertImage, useImageSource } from './images';
import { useInk, useInkInternal } from './InkProvider';
import { PageInkController } from './layerController';
import { isImage, isLink, isSticky, isTextBox, makeLinkItem, makeStickyItem, makeTextItem, type InkItem, type InkItemOf } from './model';
import { resolveInkColor } from './palette';
import { paperToneOf } from './render';
import { SelectionOverlay } from './SelectionOverlay';
import type { InkLayerProps, InkPageView } from './types';
import './ink.css';

const DRAFT_TEXT_WIDTH = 0.32;
const STICKY_DEFAULT_COLOR = 'hl-yellow';
/** the server accepts sticky text up to 20 000 characters (annotations/schemas.ts) */
const STICKY_MAX_CHARS = 20_000;

export function InkLayer({ targetKey, anchor, view, interactive, onStrokeActiveChange }: InkLayerProps) {
  const ink = useInk();
  const { store, toolRef, editing, setEditing } = useInkInternal();
  const rootRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<PageInkController | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const activeCb = useRef(onStrokeActiveChange);
  activeCb.current = onStrokeActiveChange;
  const ar = view.pageHeight / view.pageWidth;
  const host = useInkHost();
  const hostRef = useRef(host);
  hostRef.current = host;
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
      getInteractive: () => interactiveRef.current,
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
          })
          .catch(() => undefined)
          .finally(() => setPendingLink(null));
      },
      onSelectionChanged: () => setSelectionVersion((v) => v + 1),
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

  const all = useMemo(() => {
    const list = store.items(targetKey).filter(isDomObject);
    objectIds.current = new Set(list.map((i) => i.id));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, targetKey, objectsVersion]);
  const objects = useMemo(() => all.filter((i): i is InkItemOf<TextBoxData> | InkItemOf<StickyData> => isTextBox(i) || isSticky(i)), [all]);
  // pictures sit under the ink (rendered before the canvases), links above it; both in paint order
  const images = useMemo(() => all.filter((i): i is InkItemOf<ImageAnnotationData> => isImage(i)).sort((a, b) => a.z - b.z || a.created_at - b.created_at), [all]);
  const links = useMemo(() => all.filter((i): i is InkItemOf<LinkData> => isLink(i)), [all]);

  const { width, height } = viewSize(view);
  const writing = ink.isWritingTool && interactive;
  const selection = store.getSelection();
  const selectionHere = selection?.targetKey === targetKey ? selection : null;
  const editingHere = editing?.targetKey === targetKey ? editing : null;

  return (
    <div
      ref={rootRef}
      className="ml-ink-layer"
      style={{ width, height }}
      data-tool={ink.toolState.tool}
      data-writing={writing ? '' : undefined}
      data-pen-only={ink.toolState.penOnly ? '' : undefined}
      dir="ltr"
    >
      {images.map((o) => (
        <ImageView key={o.id} item={o} view={view} hidden={store.isHidden(o.id)} />
      ))}
      <canvas ref={hlRef} className="ml-ink-layer__canvas ml-ink-layer__canvas--highlight" aria-hidden="true" />
      <canvas ref={inkRef} className="ml-ink-layer__canvas" aria-hidden="true" />
      <canvas ref={liveRef} className="ml-ink-layer__canvas ml-ink-layer__canvas--live" aria-hidden="true" />
      <PageSummary store={store} targetKey={targetKey} />
      {objects.map((o) =>
        isTextBox(o) ? (
          <TextBoxView
            key={o.id}
            item={o}
            view={view}
            hidden={store.isHidden(o.id) || editingHere?.id === o.id}
            editable={ink.toolState.tool === 'text'}
            onEdit={() => setEditing({ targetKey, kind: 'text', id: o.id, at: [o.data.box.x, o.data.box.y] })}
          />
        ) : (
          <StickyView
            key={o.id}
            item={o}
            view={view}
            hidden={store.isHidden(o.id)}
            open={editingHere?.id === o.id}
            onOpen={() => setEditing({ targetKey, kind: 'sticky', id: o.id, at: o.data.at })}
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
        <SelectionOverlay targetKey={targetKey} view={view} controller={ctrlRef} onStrokeActiveChange={(a) => activeCb.current?.(a)} />
      )}
    </div>
  );
}

/**
 * What a screen reader is told about the page's writing. Re-renders on committed changes only
 * (a stroke, an erase, an undo) — never per pointermove.
 */
function PageSummary({ store, targetKey }: { store: ReturnType<typeof useInkInternal>['store']; targetKey: string }) {
  const [version, setVersion] = useState(0);
  useEffect(() => store.subscribePage(targetKey, (e) => (e.kind === 'items' || e.kind === 'loaded') && setVersion((v) => v + 1)), [store, targetKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the page's change counter: the store is mutable, so it is what invalidates the summary
  const text = useMemo(() => summarize(store.items(targetKey)), [store, targetKey, version]);
  return (
    <p className="ml-visually-hidden" dir="rtl">
      {text}
    </p>
  );
}

function summarize(items: readonly InkItem[]): string {
  let ink = 0;
  let hl = 0;
  let shapes = 0;
  let text = 0;
  let sticky = 0;
  let images = 0;
  let links = 0;
  for (const i of items) {
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
  return `على هذه الصفحة: خطوط بالقلم ${ink}، تظليل ${hl}، أشكال ${shapes}، مربعات نص ${text}، ملاحظات لاصقة ${sticky}${extra}.`;
}

/** Text boxes, sticky notes, pictures and links are DOM objects of the layer (not canvas paths). */
function isDomObject(i: InkItem): boolean {
  return isTextBox(i) || isSticky(i) || isImage(i) || isLink(i);
}

/** A normalized box placed in the (rotated) view: centred where the box's centre lands, rotated with the page. */
export function boxStyle(box: NormBox, view: InkPageView): CSSProperties {
  const w = box.w * view.pageWidth * view.scale;
  const h = box.h * view.pageHeight * view.scale;
  const [cx, cy] = normToView(box.x + box.w / 2, box.y + box.h / 2, view);
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: view.rotation ? `rotate(${view.rotation}deg)` : undefined };
}

function textBoxStyle(box: NormBox, fontScale: number, view: InkPageView): CSSProperties {
  const w = box.w * view.pageWidth * view.scale;
  const h = box.h * view.pageHeight * view.scale;
  const [cx, cy] = normToView(box.x + box.w / 2, box.y + box.h / 2, view);
  return {
    left: cx - w / 2,
    top: cy - h / 2,
    width: w,
    minHeight: h,
    fontSize: Math.max(4, fontScale * view.pageWidth * view.scale),
    transform: view.rotation ? `rotate(${view.rotation}deg)` : undefined,
  };
}

const TextBoxView = memo(function TextBoxView({ item, view, hidden, editable, onEdit }: { item: InkItemOf<TextBoxData>; view: InkPageView; hidden: boolean; editable: boolean; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const tone = paperToneOf(ref.current);
  const style: CSSProperties = { ...textBoxStyle(item.data.box, item.data.font_scale, view), color: resolveInkColor(item.data.color, tone, null), visibility: hidden ? 'hidden' : undefined };
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
  const color = resolveInkColor(item.data.color, paperToneOf(ref.current), null);
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
  useEffect(() => setFailed(false), [src.src]);
  const alt = item.data.alt || (item.data.name ? `صورة أضفتها: ${item.data.name}` : 'صورة أضفتها إلى الصفحة');
  const style: CSSProperties = { ...boxStyle(item.data.box, view), visibility: hidden ? 'hidden' : undefined };
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
  const { store, announce } = useInkInternal();
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
 * Editor for a text box or a sticky note (draft or existing). Saves on blur / Ctrl+Enter / Escape,
 * AND when it is replaced or unmounted without a blur (e.g. another tap on the page with the text
 * tool, a tool switch): typed text is never lost.
 */
function ObjectEditor({ editing, view, onDone, getAnchor }: { editing: NonNullable<ReturnType<typeof useInkInternal>['editing']>; view: InkPageView; onDone: () => void; getAnchor: () => InkLayerProps['anchor'] }) {
  const { store, prefs } = useInkInternal();
  const existing = editing.id ? store.item(editing.targetKey, editing.id) : undefined;
  const initial = existing ? (isTextBox(existing) ? richTextToPlain(existing.data.text) : isSticky(existing) ? existing.data.text : '') : '';
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const valueRef = useRef(initial);
  const heightRef = useRef(0);

  /** Writes the edit (if any). Pure data: no DOM reads, so it also works during unmount. */
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (done.current) return;
    const text = valueRef.current.trim();
    if (text === initial.trim()) return; // nothing changed (also: StrictMode's simulated unmount)
    done.current = true;
    const now = Date.now();
    if (editing.kind === 'text') {
      const hNorm = Math.max(0.02, heightRef.current / (view.pageHeight * view.scale));
      if (existing && isTextBox(existing)) {
        if (!text) store.commit('حذف مربع نص', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after: null }]);
        else {
          const after = { ...existing, data: { ...existing.data, text: richTextFromPlain(text), box: { ...existing.data.box, h: hNorm } }, updated_at: now };
          store.commit('تحرير نص', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after }]);
        }
      } else if (text) {
        const preset = prefs.presets.text;
        const w = Math.min(DRAFT_TEXT_WIDTH, 1 - editing.at[0]);
        const item = makeTextItem({ id: newId(), anchor: getAnchor(), now, z: store.nextZ(editing.targetKey), box: { x: editing.at[0], y: editing.at[1], w: Math.max(0.08, w), h: hNorm }, text: richTextFromPlain(text), color: preset.color, fontScale: preset.width });
        store.commit('مربع نص', [{ id: item.id, targetKey: editing.targetKey, before: null, after: item }]);
      }
    } else if (existing && isSticky(existing)) {
      const after = { ...existing, data: { ...existing.data, text }, updated_at: now };
      store.commit('تحرير ملاحظة لاصقة', [{ id: existing.id, targetKey: editing.targetKey, before: existing, after }]);
    } else if (text) {
      const item = makeStickyItem({ id: newId(), anchor: getAnchor(), now, z: store.nextZ(editing.targetKey), at: editing.at, text, color: STICKY_DEFAULT_COLOR });
      store.commit('ملاحظة لاصقة', [{ id: item.id, targetKey: editing.targetKey, before: null, after: item }]);
    }
  };

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
    return (
      <textarea
        ref={ref}
        className="ml-ink-text-editor"
        style={textBoxStyle(box, fontScale, view)}
        value={value}
        dir="auto"
        aria-label={existing ? 'تحرير مربع النص' : 'مربع نص جديد'}
        placeholder="اكتب هنا…"
        data-ink-ui=""
        onChange={(e) => {
          setValue(e.target.value);
          valueRef.current = e.target.value;
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
          heightRef.current = e.target.scrollHeight;
        }}
        onBlur={finish}
        onKeyDown={onKeyDown}
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
