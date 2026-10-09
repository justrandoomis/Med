// Split Study (§26): the lecture next to another source (reference, question source, another lecture).
// Each side keeps its own page and zoom; changing one never resets the other.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Minus, Plus, X } from 'lucide-react';
import { detectDir, SOURCE_TYPE_LABELS_AR, type AnnotationAnchor, type ContinueStudyingItem, type SourceDetail } from '@medlevo/shared';
import { Button, Dialog, EmptyState, ErrorState, IconButton, LoadingState, Tooltip } from '../../../design';
import { fetchRecentSessions } from '../data/api';
import { useSourceDocument } from '../data/useSourceDocument';
import { clampZoom, zoomIn, zoomOut, zoomPercent } from '../model/zoom';
import { BookCanvas, type BookCanvasHandle } from '../reader/BookCanvas';
import { ReaderPageContext, type MeasuredSize, type ReaderPageContextValue } from '../reader/readerContext';
import { GoToPage } from '../chrome/GoToPage';

export function SplitPicker({ open, onClose, detail, onPick }: { open: boolean; onClose: () => void; detail: SourceDetail; onPick: (sourceId: string) => void }) {
  const [recent, setRecent] = useState<ContinueStudyingItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchRecentSessions(10)
      .then((r) => !cancelled && setRecent(r.items.filter((i) => i.source.id !== detail.id)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [open, detail.id]);
  const linked = detail.links.map((l) => ({ id: l.from_source_id === detail.id ? l.to_source_id : l.from_source_id, title: l.other_title, type: l.other_type }));
  const others = (recent ?? []).filter((r) => !linked.some((l) => l.id === r.source.id)).map((r) => ({ id: r.source.id, title: r.source.title, type: r.source.source_type }));
  const all = [...linked, ...others];
  return (
    <Dialog open={open} onClose={onClose} title="افتح مصدرًا بجانب هذه المحاضرة" description="المراجع المرتبطة بالمحاضرة أولًا، ثم المصادر التي درستها مؤخرًا." size="md">
      {recent === null && !failed && linked.length === 0 ? (
        <LoadingState inline stage="جارٍ تحميل المصادر" />
      ) : all.length === 0 ? (
        <EmptyState headingLevel={3} icon={<Columns2 size={22} />} title="لا توجد مصادر مقترحة" description={failed ? 'تعذّر تحميل المصادر الأخيرة. اربط مرجعًا بالمحاضرة من صفحة المصدر ثم أعد المحاولة.' : 'اربط مرجعًا بالمحاضرة من صفحة المصدر، أو افتح مصدرًا آخر للدراسة أولًا.'} />
      ) : (
        <ul className="wk-marks" role="list">
          {all.map((s) => (
            <li key={s.id}>
              <button type="button" className="wk-mark-row" onClick={() => onPick(s.id)}>
                <Columns2 size={16} aria-hidden="true" />
                <bdi>{s.title}</bdi>
                <span className="wk-muted">{SOURCE_TYPE_LABELS_AR[s.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function SecondaryPane({ sourceId, initialPage, onPage, onClose }: { sourceId: string; initialPage: number; onPage: (i: number) => void; onClose: () => void }) {
  const { state, retry } = useSourceDocument(sourceId, null);
  const canvas = useRef<BookCanvasHandle>(null);
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<'width' | null>('width');
  const [effective, setEffective] = useState(1);
  const roots = useRef(new Map<number, HTMLElement>());
  const [measured, setMeasured] = useState<ReadonlyMap<number, MeasuredSize>>(() => new Map());
  const doc = state.status === 'ready' ? state.doc : null;

  const onLocation = useCallback(
    (l: { pageIndex: number }) => {
      setPageIndex((p) => (p === l.pageIndex ? p : l.pageIndex));
      onPage(l.pageIndex);
    },
    [onPage],
  );
  const ctx = useMemo<ReaderPageContextValue | null>(
    () =>
      doc
        ? {
            sourceId,
            versionId: doc.version.id,
            mode: doc.mode,
            pdf: doc.pdf,
            textInteractive: true,
            inkInteractive: false,
            inkEnabled: false,
            onStrokeActiveChange: () => undefined,
            highlight: null,
            searchResults: [],
            currentResult: null,
            registerTextRoot: (i, el) => {
              if (el) roots.current.set(i, el);
              else roots.current.delete(i);
            },
            anchorFor: (i): AnnotationAnchor | null => {
              const pg = doc.pages[i];
              return pg ? { type: 'page', source_id: sourceId, version_id: doc.version.id, page_id: pg.id, page_index: pg.page_index, space: 'page_norm' } : null;
            },
            textLang: doc.detail.language === 'en' || doc.detail.language === 'ar' ? doc.detail.language : null,
            reportPageSize: (i, m) =>
              setMeasured((prev) => {
                const cur = prev.get(i);
                if (cur && Math.abs(cur.w - m.w) < 0.5 && Math.abs(cur.h - m.h) < 0.5 && cur.rotate === m.rotate) return prev;
                return new Map(prev).set(i, m);
              }),
          }
        : null,
    [doc, sourceId],
  );

  return (
    <section className="wk-split" aria-label="المصدر الثاني">
      <header className="wk-split__bar">
        <p className="wk-split__title" dir={detectDir(doc?.detail.title ?? 'المصدر الثاني')}>
          {doc?.detail.title ?? 'المصدر الثاني'}
        </p>
        {doc && <GoToPage pages={doc.pages} pageIndex={pageIndex} onGo={(i) => { setPageIndex(i); canvas.current?.goTo(i, 0); }} compact />}
        <Tooltip content="تصغير" describe={false}>
          <IconButton label="تصغير المصدر الثاني" icon={<Minus size={16} />} size="sm" onClick={() => { setFit(null); setZoom(zoomOut(effective)); }} />
        </Tooltip>
        <span className="wk-split__zoom">
          <bdi dir="ltr">{zoomPercent(effective)}</bdi>
        </span>
        <Tooltip content="تكبير" describe={false}>
          <IconButton label="تكبير المصدر الثاني" icon={<Plus size={16} />} size="sm" onClick={() => { setFit(null); setZoom(zoomIn(effective)); }} />
        </Tooltip>
        <Tooltip content="إغلاق العرض جنبًا إلى جنب" describe={false}>
          <IconButton label="إغلاق المصدر الثاني" icon={<X size={16} />} size="sm" onClick={onClose} />
        </Tooltip>
      </header>
      {state.status === 'loading' && <LoadingState stage={state.stage} />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={retry} actions={<Button onClick={onClose}>إغلاق</Button>} />}
      {doc && ctx && (
        <ReaderPageContext.Provider value={ctx}>
          <BookCanvas
            ref={canvas}
            pages={doc.pages}
            fallbackSize={null}
            measured={measured}
            pageIndex={pageIndex}
            zoom={zoom}
            fit={fit}
            viewRotation={0}
            layout="continuous"
            spreadRtl={doc.detail.language === 'ar'}
            flipAnimation={false}
            label={`صفحات ${doc.detail.title}`}
            onLocation={onLocation}
            onEffectiveZoom={setEffective}
            onZoomGesture={(z) => {
              setFit(null);
              setZoom(clampZoom(z));
            }}
            onViewed={() => undefined}
          />
        </ReaderPageContext.Provider>
      )}
    </section>
  );
}
