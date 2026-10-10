// Split Study (§26): the lecture next to another source (reference, question source, another lecture).
// Each side keeps its own page and zoom; changing one never resets the other.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, Minus, NotebookPen, Plus, X } from 'lucide-react';
import { detectDir, SOURCE_TYPE_LABELS_AR, type AnnotationAnchor, type ContinueStudyingItem, type SourceDetail } from '@medlevo/shared';
import { Button, Dialog, EmptyState, ErrorState, IconButton, LoadingState, Tooltip, cx } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { getDb } from '../../../lib/localdb';
import { useInk } from '../ink';
import { fetchNotes, fetchRecentSessions, fetchSourceAnnotations } from '../data/api';
import { useNotes } from '../data/hooks';
import { mergeServerAnnotations, mergeServerNotes } from '../data/local';
import { mergeServerNotePages, useNotePagesOfSource } from '../data/notePages';
import { useSourceDocument, type SourceDocument } from '../data/useSourceDocument';
import { buildSequence, indexSequence } from '../model/sequence';
import { fullPageLabel } from '../model/pages';
import { NoteCard, NoteEditor } from '../panels/MineTab';
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

export interface SecondaryPaneProps {
  sourceId: string;
  initialPage: number;
  /** the zoom this pane had (kept in the split state, so switching views never resets it) */
  initialZoom?: number | null;
  onPage: (i: number) => void;
  onZoom?: (z: number | null) => void;
  onClose: () => void;
  online?: boolean;
}

/**
 * The second source in Split Study (§26): its own page and zoom, and WRITABLE — the same ink engine and tools as the
 * main pane (one toolbar; undo covers both), its inserted note pages, and notes on its pages. Neither pane's state is
 * lost when the other changes: this pane keeps its page / zoom in the split state; ink and notes are local-first rows.
 */
export function SecondaryPane({ sourceId, initialPage, initialZoom, onPage, onZoom, onClose, online = true }: SecondaryPaneProps) {
  const { state, retry } = useSourceDocument(sourceId, null);
  const caps = useCapabilities();
  const ink = useInk();
  const canvas = useRef<BookCanvasHandle>(null);
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [notePageId, setNotePageId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(initialZoom ?? 1);
  const [fit, setFit] = useState<'width' | null>(initialZoom ? null : 'width');
  const [effective, setEffective] = useState(1);
  const [notesOpen, setNotesOpen] = useState(false);
  const roots = useRef(new Map<number, HTMLElement>());
  const [measured, setMeasured] = useState<ReadonlyMap<number, MeasuredSize>>(() => new Map());
  const strokeActive = useRef(false);
  const doc = state.status === 'ready' ? state.doc : null;
  const versionId = doc?.version.id ?? null;
  const noteRows = useNotePagesOfSource(sourceId);
  const sheets = useMemo(() => (doc ? buildSequence(doc.pages, noteRows) : []), [doc, noteRows]);
  const seq = useMemo(() => indexSequence(sheets), [sheets]);
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const inkCap = caps.feature('workspace.ink').available;
  const inkOnPages = inkCap && !!doc && doc.mode !== 'text';
  const writing = (inkOnPages || (inkCap && sheets.some((x) => x.kind === 'note'))) && ink.isWritingTool;

  // this device gets what the owner wrote on the second source (rows with local edits are never overwritten)
  useEffect(() => {
    if (!versionId || !online) return;
    void fetchSourceAnnotations(sourceId, versionId)
      .then(async (r) => {
        await mergeServerNotePages(getDb(), r.note_pages);
        await mergeServerAnnotations(getDb(), r.annotations);
      })
      .catch(() => undefined);
  }, [sourceId, versionId, online]);

  const onLocation = useCallback(
    (l: { pageIndex: number }) => {
      const sh = sheetsRef.current[l.pageIndex];
      if (sh?.kind === 'note') {
        setNotePageId(sh.note.id);
        return;
      }
      setNotePageId(null);
      const i = sh ? sh.page.page_index : l.pageIndex;
      setPageIndex((p) => (p === i ? p : i));
      onPage(i);
    },
    [onPage],
  );
  const anchorFor = useCallback(
    (i: number): AnnotationAnchor | null => {
      const pg = doc?.pages[i];
      return doc && pg ? { type: 'page', source_id: sourceId, version_id: doc.version.id, page_id: pg.id, page_index: pg.page_index, space: 'page_norm' } : null;
    },
    [doc, sourceId],
  );
  const ctx = useMemo<ReaderPageContextValue | null>(
    () =>
      doc
        ? {
            sourceId,
            versionId: doc.version.id,
            mode: doc.mode,
            pdf: doc.pdf,
            textInteractive: !writing,
            inkInteractive: writing,
            inkEnabled: inkOnPages,
            onStrokeActiveChange: (a) => {
              strokeActive.current = a;
            },
            highlight: null,
            searchResults: [],
            currentResult: null,
            registerTextRoot: (i, el) => {
              if (el) roots.current.set(i, el);
              else roots.current.delete(i);
            },
            anchorFor,
            textLang: doc.detail.language === 'en' || doc.detail.language === 'ar' ? doc.detail.language : null,
            reportPageSize: (i, m) =>
              setMeasured((prev) => {
                const cur = prev.get(i);
                if (cur && Math.abs(cur.w - m.w) < 0.5 && Math.abs(cur.h - m.h) < 0.5 && cur.rotate === m.rotate) return prev;
                return new Map(prev).set(i, m);
              }),
            notePageInk: inkCap,
            notePageActions: null,
            paperRtl: doc.detail.language !== 'en',
          }
        : null,
    [doc, sourceId, writing, inkOnPages, inkCap, anchorFor],
  );
  const current = notePageId && seq.ofNote(notePageId) >= 0 ? seq.ofNote(notePageId) : seq.ofSource(pageIndex);
  const setZoomBoth = (z: number | null) => {
    if (z == null) setFit('width');
    else {
      setFit(null);
      setZoom(z);
    }
    onZoom?.(z);
  };

  return (
    <section className="wk-split" aria-label="المصدر الثاني">
      <header className="wk-split__bar">
        <p className="wk-split__title" dir={detectDir(doc?.detail.title ?? 'المصدر الثاني')}>
          {doc?.detail.title ?? 'المصدر الثاني'}
        </p>
        {doc && (
          <GoToPage
            pages={doc.pages}
            pageIndex={pageIndex}
            onGo={(i) => {
              setNotePageId(null);
              setPageIndex(i);
              canvas.current?.goTo(seq.ofSource(i), 0);
            }}
            compact
          />
        )}
        <Tooltip content="تصغير" describe={false}>
          <IconButton label="تصغير المصدر الثاني" icon={<Minus size={16} />} size="sm" onClick={() => setZoomBoth(zoomOut(effective))} />
        </Tooltip>
        <span className="wk-split__zoom">
          <bdi dir="ltr">{zoomPercent(effective)}</bdi>
        </span>
        <Tooltip content="تكبير" describe={false}>
          <IconButton label="تكبير المصدر الثاني" icon={<Plus size={16} />} size="sm" onClick={() => setZoomBoth(zoomIn(effective))} />
        </Tooltip>
        {doc && (
          <Tooltip content="ملاحظات على هذه الصفحة" describe={false}>
            <IconButton label="ملاحظات على صفحة المصدر الثاني" icon={<NotebookPen size={16} />} size="sm" pressed={notesOpen} onClick={() => setNotesOpen((o) => !o)} />
          </Tooltip>
        )}
        <Tooltip content="إغلاق العرض جنبًا إلى جنب" describe={false}>
          <IconButton label="إغلاق المصدر الثاني" icon={<X size={16} />} size="sm" onClick={onClose} />
        </Tooltip>
      </header>
      {doc && notesOpen && <SecondaryNotes doc={doc} pageIndex={pageIndex} anchorFor={anchorFor} online={online} />}
      {state.status === 'loading' && <LoadingState stage={state.stage} />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={retry} actions={<Button onClick={onClose}>إغلاق</Button>} />}
      {doc && ctx && (
        <ReaderPageContext.Provider value={ctx}>
          <BookCanvas
            ref={canvas}
            sheets={sheets}
            fallbackSize={null}
            measured={measured}
            pageIndex={current}
            initialFrac={0}
            zoom={zoom}
            fit={fit}
            viewRotation={0}
            layout="continuous"
            spreadRtl={doc.detail.language === 'ar'}
            flipAnimation={false}
            label={`صفحات ${doc.detail.title}`}
            onLocation={onLocation}
            onEffectiveZoom={setEffective}
            onZoomGesture={(z) => setZoomBoth(clampZoom(z))}
            onViewed={() => undefined}
            strokeActive={() => strokeActive.current}
            className={cx(writing && 'wk-canvas--writing')}
          />
        </ReaderPageContext.Provider>
      )}
    </section>
  );
}

/** Notes on the second source's current page (local-first, like «ملاحظاتي» in the rail). */
function SecondaryNotes({ doc, pageIndex, anchorFor, online }: { doc: SourceDocument; pageIndex: number; anchorFor: (i: number) => AnnotationAnchor | null; online: boolean }) {
  const page = doc.pages[pageIndex];
  const key = page ? `source_page:${page.id}` : null;
  const keys = useMemo(() => (key ? [key] : []), [key]);
  const notes = useNotes(keys);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  useEffect(() => {
    if (!online) return;
    void fetchNotes(doc.detail.id)
      .then((r) => mergeServerNotes(getDb(), r.notes))
      .catch(() => undefined);
  }, [doc.detail.id, online]);
  useEffect(() => setEditing(null), [pageIndex]);
  const label = page ? fullPageLabel(page) : '';
  return (
    <div className="wk-split__notes" role="region" aria-label={`ملاحظات ${label}`}>
      <div className="wk-rail-actions">
        <Button size="sm" variant="secondary" icon={<NotebookPen size={16} />} onClick={() => setEditing('new')} disabled={editing === 'new'}>
          ملاحظة على {label}
        </Button>
      </div>
      {editing && (
        <NoteEditor
          key={`${editing}:${pageIndex}`}
          existing={editing === 'new' ? null : (notes.find((n) => n.id === editing) ?? null)}
          anchor={anchorFor(pageIndex)}
          quote={null}
          pageLabel={label}
          onClose={() => setEditing(null)}
        />
      )}
      {notes.length === 0 ? (
        <p className="wk-muted">لا ملاحظات على هذه الصفحة بعد.</p>
      ) : (
        <ul className="wk-notes" role="list">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} pageLabel={null} onEdit={() => setEditing(n.id)} onGo={null} />
          ))}
        </ul>
      )}
    </div>
  );
}
