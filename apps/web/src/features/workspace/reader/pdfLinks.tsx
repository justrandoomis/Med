// PDF link annotations (§26 «روابط داخلية», track F1). pdf.js reports a page's Link annotations; internal ones
// (named / explicit destinations, Next/Previous/First/Last page actions) open that page of the SAME version through the
// reader's Source Jump (a Back entry is recorded, §11). External URLs are never fetched by the server: the reader asks
// for an explicit confirmation and only then opens the URL in a new browser window (http / https / mailto only).
import { memo, useEffect, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { NormBox } from '@medlevo/shared';
import { cx } from '../../../design';
import { useReaderPage } from './readerContext';

export interface PdfLinkItem {
  box: NormBox;
  kind: 'internal' | 'external' | 'unsupported';
  /** internal: the target page (0-based) */
  pageIndex?: number;
  /** external: the URL as written in the file */
  url?: string;
  label: string;
}

/** A PDF rect [x1, y1, x2, y2] (user space, y up) → normalized box of the unrotated page (origin top-left). */
export function linkRectToNorm(rect: readonly number[], view: readonly number[]): NormBox | null {
  if (rect.length < 4 || view.length < 4) return null;
  const [vx0, vy0, vx1, vy1] = view as [number, number, number, number];
  const W = vx1 - vx0;
  const H = vy1 - vy0;
  if (!(W > 0 && H > 0)) return null;
  const x0 = Math.min(rect[0]!, rect[2]!);
  const x1 = Math.max(rect[0]!, rect[2]!);
  const y0 = Math.min(rect[1]!, rect[3]!);
  const y1 = Math.max(rect[1]!, rect[3]!);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp((x0 - vx0) / W);
  const y = clamp((vy1 - y1) / H);
  const w = clamp((x1 - vx0) / W) - x;
  const h = clamp((vy1 - y0) / H) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

type DestDoc = Pick<PDFDocumentProxy, 'getDestination' | 'getPageIndex'>;

/** Resolve a link destination (named or explicit) to a page index of the document; null when it cannot be resolved. */
export async function resolveDest(doc: DestDoc, dest: unknown, numPages: number): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    let idx: number | null = null;
    if (typeof ref === 'number' && Number.isInteger(ref)) idx = ref;
    else if (ref && typeof ref === 'object' && 'num' in (ref as object)) idx = await doc.getPageIndex(ref as Parameters<DestDoc['getPageIndex']>[0]);
    return idx != null && idx >= 0 && idx < numPages ? idx : null;
  } catch {
    return null;
  }
}

interface RawLink {
  subtype?: string;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: unknown;
  action?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The Link annotations of one page, resolved (internal → page index, external → URL). */
export async function pageLinks(doc: DestDoc, page: Pick<PDFPageProxy, 'getAnnotations' | 'view'>, pageIndex: number, numPages: number): Promise<PdfLinkItem[]> {
  const anns = (await page.getAnnotations({ intent: 'display' })) as RawLink[];
  const out: PdfLinkItem[] = [];
  for (const a of anns) {
    if (a.subtype !== 'Link' || !a.rect) continue;
    const box = linkRectToNorm(a.rect, page.view);
    if (!box) continue;
    const url = a.url ?? a.unsafeUrl;
    if (url) {
      out.push({ box, kind: 'external', url, label: `رابط خارجي: ${hostOf(url)}` });
      continue;
    }
    let target: number | null = null;
    if (a.dest != null) target = await resolveDest(doc, a.dest, numPages);
    else if (a.action === 'NextPage') target = pageIndex + 1 < numPages ? pageIndex + 1 : null;
    else if (a.action === 'PrevPage') target = pageIndex > 0 ? pageIndex - 1 : null;
    else if (a.action === 'FirstPage') target = 0;
    else if (a.action === 'LastPage') target = numPages - 1;
    if (target != null) out.push({ box, kind: 'internal', pageIndex: target, label: `رابط داخلي إلى الصفحة ${target + 1} في الملف` });
    else out.push({ box, kind: 'unsupported', label: 'رابط في الملف لا يُفتح هنا (وجهته غير معروفة)' });
  }
  return out;
}

/** Link areas over a PDF page (unrotated page space; rotated with the page by `.wk-layers`). */
export const PdfLinkLayer = memo(function PdfLinkLayer({ pageIndex }: { pageIndex: number }) {
  const { pdf, pdfLinks, textInteractive } = useReaderPage();
  const [links, setLinks] = useState<PdfLinkItem[]>([]);
  useEffect(() => {
    if (!pdf || !pdfLinks) return;
    let cancelled = false;
    void pdf
      .page(pageIndex)
      .then((page) => pageLinks(pdf.doc, page, pageIndex, pdf.numPages))
      .then((l) => !cancelled && setLinks(l))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
  }, [pdf, pdfLinks, pageIndex]);
  if (!pdfLinks || links.length === 0) return null;
  return (
    <div className={cx('wk-pdflinks', !textInteractive && 'wk-pdflinks--inert')}>
      {links.map((l, i) =>
        l.kind === 'unsupported' ? null : (
          <button
            key={i}
            type="button"
            className="wk-pdflink"
            style={{ left: `${l.box.x * 100}%`, top: `${l.box.y * 100}%`, width: `${l.box.w * 100}%`, height: `${l.box.h * 100}%` }}
            aria-label={l.label}
            title={l.kind === 'external' ? `${l.label} — يُطلب تأكيدك قبل فتحه` : l.label}
            tabIndex={textInteractive ? 0 : -1}
            onClick={() => {
              if (l.kind === 'internal' && l.pageIndex != null) pdfLinks.goToPage(l.pageIndex, l.label);
              else if (l.kind === 'external' && l.url) pdfLinks.openExternal(l.url);
            }}
          />
        ),
      )}
    </div>
  );
});
