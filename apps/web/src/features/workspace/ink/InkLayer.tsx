// One page's ink layer (contract in ./types.ts). Three canvases — highlights (multiply, beneath
// the text visually), committed ink, and a live layer for the stroke in progress — plus DOM for
// text boxes, sticky notes and the lasso selection. Pointer input is handled imperatively by
// PageInkController: a pointermove never causes a React render.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { StickyNote as StickyIcon } from 'lucide-react';
import { newId, normToView, richTextFromPlain, richTextToPlain, viewSize, type NormBox, type StickyData, type TextBoxData } from '@medlevo/shared';
import { cx, RichTextView } from '../../../design';
import { useInk, useInkInternal } from './InkProvider';
import { PageInkController } from './layerController';
import { isSticky, isTextBox, makeStickyItem, makeTextItem, type InkItem, type InkItemOf } from './model';
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
        if (e.ids.some((id) => objectIds.current.has(id) || (page?.items.get(id) && (isTextBox(page.items.get(id)!) || isSticky(page.items.get(id)!))))) setObjectsVersion((v) => v + 1);
      } else if (e.kind === 'hidden' && e.ids.some((id) => objectIds.current.has(id))) setObjectsVersion((v) => v + 1);
    });
  }, [store, targetKey]);

  const objects = useMemo(() => {
    const list = store.items(targetKey).filter((i): i is InkItemOf<TextBoxData> | InkItemOf<StickyData> => isTextBox(i) || isSticky(i));
    objectIds.current = new Set(list.map((i) => i.id));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, targetKey, objectsVersion]);

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
      {editingHere && (
        <ObjectEditor
          key={`${editingHere.id ?? 'draft'}:${editingHere.at.join(',')}`}
          editing={editingHere}
          view={view}
          onDone={() => setEditing(null)}
          getAnchor={() => anchorRef.current}
        />
      )}
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
  for (const i of items) {
    if (i.kind === 'ink') {
      if ((i.data as { style?: { tool?: string } }).style?.tool === 'highlighter') hl++;
      else ink++;
    } else if (i.kind === 'shape') shapes++;
    else if (i.kind === 'text') text++;
    else if (i.kind === 'sticky') sticky++;
  }
  if (!ink && !hl && !shapes && !text && !sticky) return 'لا توجد كتابة على هذه الصفحة.';
  return `على هذه الصفحة: خطوط بالقلم ${ink}، تظليل ${hl}، أشكال ${shapes}، مربعات نص ${text}، ملاحظات لاصقة ${sticky}.`;
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
