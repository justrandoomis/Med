// Page panel (§23, §26): thumbnails (rendered lazily as they scroll into view), the document outline and
// bookmarks. Opens on the end side (left in Arabic) and only when there is room for it next to the book.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import type { AnnotationAnchor, SourcePageView } from '@medlevo/shared';
import { EmptyState, LoadingState, Tab, TabList, TabPanel, Tabs, cx } from '../../../design';
import { fetchRegions, fileUrl } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { folio, fullPageLabel } from '../model/pages';
import { BookmarksSection } from './MineTab';

export type LeftTab = 'thumbnails' | 'outline' | 'bookmarks';

export interface LeftPanelProps {
  doc: SourceDocument;
  pageIndex: number;
  tab: LeftTab;
  onTab: (t: LeftTab) => void;
  onGoToPage: (i: number, frac?: number) => void;
  anchorFor: (i: number) => AnnotationAnchor | null;
}

export function LeftPanel(p: LeftPanelProps) {
  const pageKeys = useMemo(() => p.doc.pages.map((pg) => `source_page:${pg.id}`), [p.doc.pages]);
  return (
    <Tabs value={p.tab} onValueChange={(v) => p.onTab(v as LeftTab)} className="wk-left-tabs">
      <TabList label="تنقّل في المصدر" className="wk-rail-tablist">
        <Tab value="thumbnails">الصفحات</Tab>
        <Tab value="outline">الفهرس</Tab>
        <Tab value="bookmarks">العلامات</Tab>
      </TabList>
      <TabPanel value="thumbnails" className="wk-left-panel">
        <Thumbnails {...p} />
      </TabPanel>
      <TabPanel value="outline" className="wk-left-panel">
        <Outline {...p} />
      </TabPanel>
      <TabPanel value="bookmarks" className="wk-left-panel">
        <BookmarksSection doc={p.doc} pageIndex={p.pageIndex} pageKeys={pageKeys} anchorFor={p.anchorFor} onGoToPage={(i) => p.onGoToPage(i)} />
      </TabPanel>
    </Tabs>
  );
}

// ───────────────────────────── thumbnails ─────────────────────────────
function Thumbnails({ doc, pageIndex, onGoToPage }: LeftPanelProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const [visible, setVisible] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    const root = listRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(doc.pages.slice(0, 12).map((p) => p.page_index)));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.thumb);
            if (e.isIntersecting) next.add(i);
          }
          return next;
        });
      },
      { root: root.closest('.wk-left-panel') ?? null, rootMargin: '300px 0px' },
    );
    root.querySelectorAll('[data-thumb]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [doc.pages]);

  // keep the current page's thumbnail in view
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-thumb="${pageIndex}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [pageIndex]);

  if (doc.mode === 'text') {
    return (
      <ol ref={listRef} className="wk-thumbs wk-thumbs--text" role="list">
        {doc.pages.map((p) => (
          <li key={p.id} data-thumb={p.page_index}>
            <button type="button" className={cx('wk-mark-row', p.page_index === pageIndex && 'wk-mark-row--current')} aria-current={p.page_index === pageIndex ? 'page' : undefined} onClick={() => onGoToPage(p.page_index)}>
              {fullPageLabel(p)}
            </button>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <ol ref={listRef} className="wk-thumbs" role="list">
      {doc.pages.map((p) => (
        <li key={p.id} data-thumb={p.page_index}>
          <button type="button" className={cx('wk-thumb', p.page_index === pageIndex && 'wk-thumb--current')} aria-current={p.page_index === pageIndex ? 'page' : undefined} aria-label={fullPageLabel(p)} onClick={() => onGoToPage(p.page_index)}>
            <ThumbImage doc={doc} page={p} show={visible.has(p.page_index)} />
            <span className="wk-thumb__label" aria-hidden="true">
              {folio(p).primary}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function ThumbImage({ doc, page, show }: { doc: SourceDocument; page: SourcePageView; show: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const ratio = page.width && page.height ? page.height / page.width : 1.414;
  const imgId = page.thumbnail_file_id ?? (doc.mode === 'image' ? page.render_file_id : null);
  useEffect(() => {
    if (!show || imgId || !doc.pdf) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    (async () => {
      const pg = await doc.pdf!.page(page.page_index);
      if (cancelled || !canvasRef.current) return;
      const base = pg.getViewport({ scale: 1 });
      const scale = (112 * Math.min(2, window.devicePixelRatio || 1)) / base.width;
      const vp = pg.getViewport({ scale });
      const c = canvasRef.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = pg.render({ canvas: c, viewport: vp });
      await task.promise;
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [show, imgId, doc.pdf, page.page_index]);
  return (
    <span className="wk-thumb__frame" style={{ aspectRatio: `1 / ${ratio}` }}>
      {!show ? null : imgId && !failed ? (
        <img src={fileUrl(imgId)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : doc.pdf && !failed ? (
        <canvas ref={canvasRef} aria-hidden="true" />
      ) : null}
    </span>
  );
}

// ───────────────────────────── outline ─────────────────────────────
interface OutlineNode {
  title: string;
  pageIndex: number | null;
  children: OutlineNode[];
}

const MAX_HEADING_SCAN = 200;

function Outline({ doc, pageIndex, onGoToPage }: LeftPanelProps) {
  const [state, setState] = useState<{ status: 'loading'; done: number; total: number | null } | { status: 'ready'; nodes: OutlineNode[]; from: 'pdf' | 'headings' } | { status: 'empty'; reason: string }>({ status: 'loading', done: 0, total: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. the PDF's own outline
      if (doc.pdf) {
        try {
          const outline = await doc.pdf.doc.getOutline();
          if (outline && outline.length > 0) {
            const resolve = async (items: typeof outline): Promise<OutlineNode[]> =>
              Promise.all(
                items.map(async (it) => {
                  let idx: number | null = null;
                  try {
                    const dest = typeof it.dest === 'string' ? await doc.pdf!.doc.getDestination(it.dest) : it.dest;
                    const ref = Array.isArray(dest) ? dest[0] : null;
                    if (ref && typeof ref === 'object') idx = await doc.pdf!.doc.getPageIndex(ref as Parameters<typeof doc.pdf.doc.getPageIndex>[0]);
                    else if (typeof ref === 'number') idx = ref;
                  } catch {
                    idx = null;
                  }
                  return { title: it.title, pageIndex: idx, children: it.items?.length ? await resolve(it.items) : [] };
                }),
              );
            const nodes = await resolve(outline);
            if (!cancelled) setState({ status: 'ready', nodes, from: 'pdf' });
            return;
          }
        } catch {
          // fall through to headings
        }
      }
      // 2. heading regions found by processing
      const pages = doc.pages.slice(0, MAX_HEADING_SCAN);
      const nodes: OutlineNode[] = [];
      let done = 0;
      for (const p of pages) {
        if (cancelled) return;
        try {
          const r = await fetchRegions(p.id);
          for (const reg of r.regions.filter((x) => x.kind === 'heading' && x.text).sort((a, b) => a.reading_order - b.reading_order)) {
            nodes.push({ title: reg.text!.replace(/\s+/g, ' ').trim().slice(0, 140), pageIndex: p.page_index, children: [] });
          }
        } catch {
          // a page without regions does not stop the outline
        }
        done++;
        if (!cancelled && done % 5 === 0) setState({ status: 'loading', done, total: pages.length });
      }
      if (cancelled) return;
      if (nodes.length > 0) setState({ status: 'ready', nodes, from: 'headings' });
      else setState({ status: 'empty', reason: doc.pdf ? 'لا يحتوي الملف على فهرس، ولم تُكتشف عناوين في صفحاته.' : 'لم تُكتشف عناوين في هذا المصدر بعد.' });
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (state.status === 'loading') return <LoadingState inline stage="جارٍ جمع الفهرس" done={state.done || undefined} total={state.total ?? undefined} unit="صفحة" />;
  if (state.status === 'empty') return <EmptyState headingLevel={3} icon={<ListTree size={22} />} title="لا يوجد فهرس" description={state.reason} />;
  return (
    <>
      {state.from === 'headings' && <p className="wk-muted">فهرس مبني من العناوين التي اكتشفتها المعالجة (ليس فهرس الملف نفسه).</p>}
      <OutlineList nodes={state.nodes} pageIndex={pageIndex} onGoToPage={onGoToPage} depth={0} />
    </>
  );
}

function OutlineList({ nodes, pageIndex, onGoToPage, depth }: { nodes: OutlineNode[]; pageIndex: number; onGoToPage: (i: number) => void; depth: number }) {
  return (
    <ul className={cx('wk-outline', depth > 0 && 'wk-outline--nested')} role="list">
      {nodes.map((n, i) => (
        <li key={i}>
          <button type="button" className={cx('wk-mark-row', n.pageIndex === pageIndex && 'wk-mark-row--current')} disabled={n.pageIndex == null} onClick={() => n.pageIndex != null && onGoToPage(n.pageIndex)}>
            <bdi>{n.title}</bdi>
          </button>
          {n.children.length > 0 && <OutlineList nodes={n.children} pageIndex={pageIndex} onGoToPage={onGoToPage} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
