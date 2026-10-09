// Toolbar over a text selection (§26, §30): highlight, underline, copy, add a note — all local-first — and the
// explanation actions (Explain / Simplify / Translate / Ask / Compare / Explain Image), which hand the selection
// anchor to the «الشرح والسؤال» rail tab. Learning actions that belong to later tracks stay disabled with reasons.
import { useLayoutEffect, useRef, useState } from 'react';
import { BookOpenText, Copy, Highlighter, NotebookPen, Sparkles, Underline, Eraser } from 'lucide-react';
import { boxesIntersect, normalizeRotation, type AnnotationAnchor, type NormBox, type TextHighlightData, type TextQuote } from '@medlevo/shared';
import { Button, Menu, MenuItem, Toolbar, Term, useToast, cx } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { getDb, type AnnotationRow } from '../../../lib/localdb';
import { createAnnotation, deleteAnnotation } from '../data/local';
import { actionDisabledReason, aiRequestStore, SELECTION_AI_ACTIONS, type ExplainActionId } from '../model/aiActions';
import { clientRectsToNorm, quoteFromText, rangeOffsetsWithin, roundBox } from '../model/textQuote';
import type { BookSelection } from './useBookSelection';

export interface SelectionToolbarProps {
  selection: BookSelection;
  /** the book canvas element (to find the page sheet) */
  canvas: HTMLElement | null;
  textRoot: (pageIndex: number) => HTMLElement | null;
  anchorFor: (pageIndex: number) => AnnotationAnchor | null;
  /** fixed-page sources only: DOCX paragraphs have no page geometry for highlight rects */
  fixedPages: boolean;
  onAddNote: (pageIndex: number, quote: TextQuote | null) => void;
  onDone: () => void;
}

/** Selection → {quote, rects} on one page (exported for tests). */
export function selectionToHighlight(sel: Pick<BookSelection, 'range'>, textRoot: HTMLElement, sheet: HTMLElement): { quote: TextQuote; rects: NormBox[] } | null {
  const offsets = rangeOffsetsWithin(textRoot, sel.range);
  if (!offsets) return null;
  const quote = quoteFromText(textRoot.textContent ?? '', offsets.start, offsets.end);
  if (!quote) return null;
  const pw = Number(sheet.dataset.pw);
  const ph = Number(sheet.dataset.ph);
  const scale = Number(sheet.dataset.scale);
  const rot = normalizeRotation(Number(sheet.dataset.rot ?? 0));
  if (!(pw > 0 && ph > 0 && scale > 0)) return null;
  const box = sheet.getBoundingClientRect();
  const rects = clientRectsToNorm(Array.from(sel.range.getClientRects()), box, { pageWidth: pw, pageHeight: ph, scale, rotation: rot }).map(roundBox);
  if (rects.length === 0) return null;
  return { quote, rects };
}

export function SelectionToolbar({ selection, canvas, textRoot, anchorFor, fixedPages, onAddNote, onDone }: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const caps = useCapabilities();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [overlapping, setOverlapping] = useState<AnnotationRow[]>([]);
  const page = canvas?.querySelector<HTMLElement>(`[data-page-index="${selection.pageIndex}"]`) ?? null;
  const sheet = page?.querySelector<HTMLElement>('.wk-sheet') ?? null;
  const root = textRoot(selection.pageIndex);
  const anchor = anchorFor(selection.pageIndex);
  const highlight = fixedPages && !selection.multiPage && root && sheet && anchor ? selectionToHighlight(selection, root, sheet) : null;
  const highlightReason = !fixedPages
    ? 'التظليل في ملفات DOCX وشرائح النص يصل لاحقًا (لا توجد صفحات ثابتة لربطه بها).'
    : selection.multiPage
      ? 'حدّد نصًا داخل صفحة واحدة لتظليله.'
      : !highlight
        ? 'تعذّر تحديد موضع النص على الصفحة.'
        : null;

  // place above the selection (below on touch, where the system menu sits above)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = selection.rect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    let top = coarse ? r.bottom + 12 : r.top - h - 10;
    if (top < 8) top = r.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 10);
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - h - 8)); // never off-screen
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    setPos({ top, left });
  }, [selection.rect]);

  // existing highlights under the selection can be removed from here
  useLayoutEffect(() => {
    let cancelled = false;
    if (!anchor || !highlight) {
      setOverlapping([]);
      return;
    }
    const key = anchor.type === 'page' ? `source_page:${anchor.page_id}` : null;
    if (!key) return;
    void getDb()
      .annotations.where('targetKey')
      .equals(key)
      .filter((a) => a.kind === 'text_highlight' && !a.deletedAt)
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        setOverlapping(rows.filter((a) => ((a.data as TextHighlightData)?.rects ?? []).some((b) => highlight.rects.some((s) => boxesIntersect(b, s)))));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const save = async (style: 'highlight' | 'underline') => {
    if (!highlight || !anchor) return;
    const data: TextHighlightData = { v: 1, style, color: style === 'highlight' ? 'marker-yellow' : 'ink-accent', rects: highlight.rects, quote: highlight.quote };
    try {
      await createAnnotation(getDb(), { kind: 'text_highlight', anchor, data, layer: 'highlight', tool: style });
      toast.show({ title: style === 'highlight' ? 'ظُلّل النص وحُفظ على هذا الجهاز.' : 'سُطّر النص وحُفظ على هذا الجهاز.', tone: 'success' });
      onDone();
    } catch {
      toast.show({ title: 'تعذّر حفظ التظليل على هذا الجهاز. تحقق من مساحة التخزين ثم أعد المحاولة.', tone: 'danger' });
    }
  };

  const remove = async () => {
    for (const row of overlapping) await deleteAnnotation(getDb(), row);
    toast.show({ title: overlapping.length > 1 ? 'أُزيلت التظليلات المحددة.' : 'أُزيل التظليل.', tone: 'success' });
    onDone();
  };

  /** explanation family → the rail («الشرح والسؤال») with this selection as the anchor */
  const askRail = (action: ExplainActionId) => {
    const pageAnchor = anchorFor(selection.pageIndex);
    if (!pageAnchor || pageAnchor.type !== 'page') return;
    const text = (highlight?.quote.exact ?? selection.text).trim().slice(0, 6000);
    aiRequestStore.request({
      action,
      anchor: {
        source_id: pageAnchor.source_id,
        version_id: pageAnchor.version_id,
        page_id: pageAnchor.page_id,
        region_ids: [],
        // the server accepts a quote of at most 6000 characters: a longer selection is sent as its first 6000
        quote: text ? (highlight?.quote && highlight.quote.exact.length <= 6000 ? highlight.quote : { exact: text }) : null,
      },
      text,
      pageIndex: selection.pageIndex,
      rects: highlight?.rects ?? [],
    });
    onDone();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(selection.text);
      toast.show({ title: 'نُسخ النص.', tone: 'success' });
    } catch {
      toast.show({ title: 'لم يسمح المتصفح بالنسخ. استخدم اختصار النسخ في لوحة المفاتيح.', tone: 'warning' });
    }
  };

  return (
    <div ref={ref} className={cx('wk-seltoolbar', !pos && 'wk-seltoolbar--measuring')} style={pos ? { top: pos.top, left: pos.left } : undefined} onPointerDown={(e) => e.preventDefault()}>
      <Toolbar label="أدوات النص المحدد">
        <Button size="sm" variant="plain" icon={<Highlighter size={16} />} disabled={!!highlightReason} title={highlightReason ?? undefined} onClick={() => void save('highlight')}>
          تظليل
        </Button>
        <Button size="sm" variant="plain" icon={<Underline size={16} />} disabled={!!highlightReason} title={highlightReason ?? undefined} onClick={() => void save('underline')}>
          تسطير
        </Button>
        {overlapping.length > 0 && (
          <Button size="sm" variant="plain" icon={<Eraser size={16} />} onClick={() => void remove()}>
            إزالة التظليل
          </Button>
        )}
        <Button size="sm" variant="plain" icon={<Copy size={16} />} onClick={() => void copy()}>
          نسخ
        </Button>
        <Button size="sm" variant="plain" icon={<NotebookPen size={16} />} onClick={() => onAddNote(selection.pageIndex, highlight?.quote ?? (selection.text.trim() ? { exact: selection.text.trim().slice(0, 2000) } : null))}>
          ملاحظة
        </Button>
        {/* always reachable: when explanations are unavailable the rail says exactly why (never a dead button) */}
        <Button size="sm" variant="plain" icon={<BookOpenText size={16} />} onClick={() => askRail('explain')}>
          اشرح
        </Button>
        <Menu
          label="أدوات الشرح والتعلّم"
          trigger={
            <Button size="sm" variant="plain" icon={<Sparkles size={16} />}>
              المزيد
            </Button>
          }
        >
          {SELECTION_AI_ACTIONS.map((a) => {
            const reason = actionDisabledReason(a, caps.feature(a.feature));
            return (
              <MenuItem key={a.id} onSelect={() => askRail(a.id as ExplainActionId)} disabled={!!reason} disabledReason={reason ?? undefined}>
                {a.label} <Term>{a.term}</Term>
              </MenuItem>
            );
          })}
        </Menu>
      </Toolbar>
      {highlightReason && fixedPages === false && <p className="ml-visually-hidden">{highlightReason}</p>}
    </div>
  );
}
