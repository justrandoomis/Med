// «دفتر ملاحظات» — the note pages of a notebook / folder as a book (§26, §5, track F1). Route: /notebook/:nodeId
// (?page=<notePageId> opens a page). The notebook's cover (its library cover tokens) heads the screen; dividers start
// sections that show as tabs; every page is paper (blank / ruled / dotted / grid) with the same ink engine as the
// reader (pens, shapes, text, pictures, page links, lasso …). Local-first: pages and writing are created on this
// device and synced; the screen works offline from IndexedDB.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, FilePlus2, NotebookTabs, PanelLeft, Undo2 } from 'lucide-react';
import { type AnnotationAnchor, type LinkTarget } from '@medlevo/shared';
import { Button, EmptyState, IconButton, SaveStatus, Sheet, Tooltip, buttonClass, cx, useToast } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { getDb } from '../../../lib/localdb';
import { describeSyncSnapshot, getSyncEngine, useSyncSnapshot } from '../../../lib/sync';
import { useOnline } from '../../../lib/useOnline';
import { usePageTitle } from '../../../lib/usePageTitle';
import { Cover, coverOf } from '../../library/components/Cover';
import { sourcesInSubtree } from '../../library/model';
import { useLibrary } from '../../library/useLibrary';
import { InkHost, InkProvider, InkToolbar, useInk, type InkLinkHost, type LinkChoice } from '../ink';
import { registerWorkspaceAppliers, type WorkspaceNotePageRow } from '../data/local';
import { createNotePage, seedNotebook, sortOrderAtEnd, sortOrderBetween, updateNotePage, trashNotePage, restoreNotePage, movedSortOrder, useNotePagesOfNode, useSplitTrash, byOrder } from '../data/notePages';
import { loadBackStack, popBack, pushBack, saveBackStack, type BackEntry } from '../model/backStack';
import type { ReaderSheet } from '../model/sequence';
import { studyUrl } from '../nav/SourceNavigation';
import { LinkTargetDialog, NewNotePageDialog, RenameNotePageDialog, type NewNotePageChoice } from '../notes/NotePageDialogs';
import { BookCanvas, type BookCanvasHandle, type BookLocation } from '../reader/BookCanvas';
import { ReaderPageContext, type NotePageActions, type ReaderPageContextValue } from '../reader/readerContext';
import { NotePagesList, pageNumbers, sectionsOf } from './NotePagesList';
import '../../library/library.css';
import '../workspace.css';
import './notebook.css';

const LAST_PAGE_KEY = (nodeId: string) => `medlevo.notebook.last.${nodeId}`;
function readLast(nodeId: string): string | null {
  try {
    return window.localStorage.getItem(LAST_PAGE_KEY(nodeId));
  } catch {
    return null;
  }
}
function writeLast(nodeId: string, id: string): void {
  try {
    window.localStorage.setItem(LAST_PAGE_KEY(nodeId), id);
  } catch {
    // per-device convenience only
  }
}

export function NotebookScreen() {
  const { nodeId = '' } = useParams();
  return (
    <InkProvider documentKey={`notebook:${nodeId}`}>
      <Notebook key={nodeId} nodeId={nodeId} />
    </InkProvider>
  );
}

function useWide(): boolean {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w >= 1024;
}

function Notebook({ nodeId }: { nodeId: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const online = useOnline();
  const toast = useToast();
  const caps = useCapabilities();
  const ink = useInk();
  const sync = useSyncSnapshot();
  const lib = useLibrary();
  const node = lib.index?.nodes.get(nodeId) ?? null;
  const title = node?.title ?? 'دفتر الملاحظات';
  usePageTitle(title);
  const wide = useWide();
  const rows = useNotePagesOfNode(nodeId);
  const { live, trashed } = useSplitTrash(rows);
  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(wide);
  const [newOpen, setNewOpen] = useState<null | { kind: 'page' | 'divider'; afterId: string | null }>(null);
  const [renaming, setRenaming] = useState<WorkspaceNotePageRow | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [linkPick, setLinkPick] = useState<{ resolve: (c: LinkChoice | null) => void } | null>(null);
  const [backStack, setBackStack] = useState<BackEntry[]>(() => loadBackStack());
  useEffect(() => saveBackStack(backStack), [backStack]);

  useEffect(() => {
    registerWorkspaceAppliers(getSyncEngine());
    // IndexedDB answers first (offline); the server copy merges in without overwriting local edits
    const t = window.setTimeout(() => setLoaded(true), 300);
    if (online) {
      void seedNotebook(nodeId)
        .catch(() => undefined)
        .finally(() => setLoaded(true));
    }
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // ── the book: every live page (dividers included) as paper ──
  const sheets = useMemo<ReaderSheet[]>(() => live.map((n) => ({ kind: 'note', key: `note_page:${n.id}`, note: n, after: -1, placedByIndex: false })), [live]);
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const numbers = useMemo(() => pageNumbers(live), [live]);
  const sections = useMemo(() => sectionsOf(live), [live]);
  const [currentId, setCurrentId] = useState<string | null>(() => params.get('page') ?? readLast(nodeId));
  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  const currentIndex = Math.max(0, sheets.findIndex((s) => s.kind === 'note' && s.note.id === currentId));
  const canvasRef = useRef<BookCanvasHandle>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<'width' | null>('width');
  const [, setEffective] = useState(1);
  const strokeActive = useRef(false);
  const inkCap = caps.feature('workspace.ink').available;
  const writing = inkCap && ink.isWritingTool;

  // ?page= is applied once (then removed, so a reload resumes the last page on this device)
  const pendingPage = useRef<string | null>(params.get('page'));
  useEffect(() => {
    const want = pendingPage.current;
    if (!want) return;
    const i = sheets.findIndex((s) => s.kind === 'note' && s.note.id === want);
    if (i >= 0) {
      pendingPage.current = null;
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.delete('page');
        return n;
      }, { replace: true });
      requestAnimationFrame(() => canvasRef.current?.goTo(i, 0));
      setCurrentId(want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets]);

  const goTo = useCallback(
    (id: string, frac = 0) => {
      const i = sheetsRef.current.findIndex((s) => s.kind === 'note' && s.note.id === id);
      if (i < 0) return false;
      setCurrentId(id);
      writeLast(nodeId, id);
      canvasRef.current?.goTo(i, frac);
      return true;
    },
    [nodeId],
  );

  const onLocation = useCallback(
    (l: BookLocation) => {
      const sh = sheetsRef.current[l.pageIndex];
      if (sh?.kind !== 'note' || sh.note.id === currentRef.current) return;
      setCurrentId(sh.note.id);
      writeLast(nodeId, sh.note.id);
    },
    [nodeId],
  );

  // ── actions ──
  const fail = useCallback((e: unknown) => toast.show({ title: 'تعذّر حفظ التغيير على هذا الجهاز', description: e instanceof Error ? e.message : undefined, tone: 'danger' }), [toast]);
  const rowOf = useCallback((id: string) => rows.find((r) => r.id === id) ?? null, [rows]);
  const actions = useMemo<NotePageActions>(
    () => ({
      rename: (id) => setRenaming(rowOf(id)),
      setTemplate: (id, template) => {
        const r = rowOf(id);
        if (r) void updateNotePage(getDb(), r, { template }).then(() => setAnnouncement('غُيّر نوع الورق.'), fail);
      },
      move: (id, dir) => {
        const r = rowOf(id);
        const order = movedSortOrder(live, id, dir);
        if (r && order != null) void updateNotePage(getDb(), r, { sortOrder: order }).then(() => setAnnouncement(dir < 0 ? 'نُقلت الصفحة إلى الأمام.' : 'نُقلت الصفحة إلى الخلف.'), fail);
      },
      canMove: (id, dir) => movedSortOrder(live, id, dir) != null,
      trash: (id) => {
        const r = rowOf(id);
        if (!r) return;
        void trashNotePage(getDb(), r)
          .then(() =>
            toast.show({
              title: 'نُقلت الصفحة إلى المحذوفات',
              description: 'كتابتها محفوظة؛ تستعيدها من «المحذوفة» في قائمة الصفحات.',
              duration: 10_000,
              action: { label: 'تراجع', onClick: () => void restoreNotePage(getDb(), r).catch(fail) },
            }),
          )
          .catch(fail);
      },
      insertAfter: (id) => setNewOpen({ kind: 'page', afterId: id }),
    }),
    [rowOf, live, toast, fail],
  );

  const create = async (c: NewNotePageChoice) => {
    const after = newOpen?.afterId ? live.findIndex((r) => r.id === newOpen.afterId) : -1;
    const sorted = [...live].sort(byOrder);
    const sortOrder = after >= 0 ? sortOrderBetween(sorted[after]?.sortOrder, sorted[after + 1]?.sortOrder) : sortOrderAtEnd(sorted);
    try {
      const row = await createNotePage(getDb(), { nodeId, template: c.template, title: c.title, kind: c.kind, color: c.color, sortOrder });
      setNewOpen(null);
      setAnnouncement(c.kind === 'divider' ? `أُضيف القسم «${c.title ?? ''}».` : 'أُضيفت صفحة جديدة. اختر القلم للكتابة.');
      pendingPage.current = row.id;
      setCurrentId(row.id);
    } catch (e) {
      fail(e);
    }
  };

  // ── links & back ──
  const position = useCallback((): BackEntry => {
    const id = currentRef.current;
    const n = id ? numbers.get(id) : undefined;
    return {
      position: { sourceId: '', versionId: '', pageIndex: Math.max(0, n ?? 0), pageOffset: 0, zoom: 1, fit: 'width', rotation: 0, layout: 'continuous', notePageId: id },
      label: `${n ? `صفحة ${n}` : 'صفحة'} — ${title}`,
      createdAt: Date.now(),
      route: `/notebook/${encodeURIComponent(nodeId)}${id ? `?page=${encodeURIComponent(id)}` : ''}`,
    };
  }, [numbers, title, nodeId]);
  const pushHere = useCallback(() => setBackStack((s) => pushBack(s, position())), [position]);

  const follow = useCallback(
    async (t: LinkTarget) => {
      if (t.type === 'note_page') {
        if (sheetsRef.current.some((s) => s.kind === 'note' && s.note.id === t.note_page_id)) {
          pushHere();
          goTo(t.note_page_id);
          setAnnouncement('فُتحت الصفحة المرتبطة. «العودة إلى موضعك» يرجعك.');
          return;
        }
        const row = await getDb().notePages.get(t.note_page_id);
        if (!row || row.deletedAt) {
          toast.show({ title: row ? 'الصفحة المرتبطة في المحذوفات' : 'الصفحة المرتبطة غير موجودة على هذا الجهاز', tone: 'warning' });
          return;
        }
        pushHere();
        if (row.nodeId) navigate(`/notebook/${encodeURIComponent(row.nodeId)}?page=${encodeURIComponent(row.id)}`);
        else if (row.sourceId) navigate(`${studyUrl({ sourceId: row.sourceId })}?note=${encodeURIComponent(row.id)}`);
        return;
      }
      pushHere();
      navigate(studyUrl({ sourceId: t.source_id, versionId: t.version_id, pageIndex: t.page_id ? null : t.page_index, pageId: t.page_id, bbox: t.bbox ?? null, regionId: t.region_id ?? null }));
    },
    [pushHere, goTo, navigate, toast],
  );
  const top = backStack[backStack.length - 1];
  const goBack = () => {
    const { entry, stack } = popBack(backStack);
    if (!entry) return;
    setBackStack(stack);
    const here = `/notebook/${encodeURIComponent(nodeId)}`;
    if (entry.route && entry.route.startsWith(here) && entry.position.notePageId) {
      goTo(entry.position.notePageId);
      setAnnouncement(`عدت إلى ${entry.label}.`);
    } else if (entry.route) navigate(entry.route);
    else navigate(studyUrl({ sourceId: entry.position.sourceId, versionId: entry.position.versionId, pageIndex: entry.position.pageIndex, offset: entry.position.pageOffset }));
  };

  const linkSources = useMemo(() => (lib.index && node ? sourcesInSubtree(lib.index, node.id).filter((s) => s.deleted_at == null) : []), [lib.index, node]);
  const linkHost = useMemo<InkLinkHost>(
    () => ({
      pickTarget: () => new Promise<LinkChoice | null>((resolve) => setLinkPick({ resolve })),
      open: (t) => void follow(t),
      describe: (t) => {
        if (t.type !== 'note_page') return null;
        const r = sheetsRef.current.find((s) => s.kind === 'note' && s.note.id === t.note_page_id);
        if (r?.kind !== 'note') return null;
        const n = numbers.get(r.note.id);
        return r.note.title ?? (n ? `صفحة ${n} من الدفتر` : null);
      },
    }),
    [follow, numbers],
  );
  const currentPage = useCallback(() => {
    const id = currentRef.current ?? sheetsRef.current[0]?.key.slice('note_page:'.length) ?? null;
    const sh = sheetsRef.current.find((s) => s.kind === 'note' && s.note.id === id);
    if (sh?.kind !== 'note') return null;
    const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: sh.note.id, space: 'page_norm' };
    return { targetKey: `note_page:${sh.note.id}`, anchor, ar: sh.note.height / sh.note.width, pageWidthPt: sh.note.width };
  }, []);

  const ctx = useMemo<ReaderPageContextValue>(
    () => ({
      sourceId: '',
      versionId: '',
      // only paper sheets here (no source pages): the canvas lays them out as fixed pages
      mode: 'image',
      pdf: null,
      textInteractive: !writing,
      inkInteractive: writing,
      inkEnabled: false,
      onStrokeActiveChange: (a) => {
        strokeActive.current = a;
      },
      highlight: null,
      searchResults: [],
      currentResult: null,
      registerTextRoot: () => undefined,
      anchorFor: () => null,
      textLang: null,
      reportPageSize: () => undefined,
      notePageInk: inkCap,
      notePageActions: actions,
      paperRtl: true,
    }),
    [writing, inkCap, actions],
  );

  const currentRow = currentId ? rowOf(currentId) : null;
  const currentSection = useMemo(() => {
    const id = currentId;
    for (let i = sections.length - 1; i >= 0; i--) {
      const sec = sections[i]!;
      if (sec.divider?.id === id || sec.pages.some((p) => p.id === id)) return sec.divider?.id ?? null;
    }
    return null;
  }, [sections, currentId]);
  const dividers = sections.filter((s) => s.divider).map((s) => s.divider!);
  const pageCount = numbers.size;
  const currentNo = currentRow && (currentRow.kind ?? 'page') === 'page' ? numbers.get(currentRow.id) : undefined;

  const list = <NotePagesList live={live} trashed={trashed} currentId={currentId} onOpen={(id) => goTo(id)} announce={setAnnouncement} />;

  return (
    <InkHost links={linkHost} currentPage={currentPage} notify={(m) => toast.show({ title: m, tone: 'warning' })}>
      <ReaderPageContext.Provider value={ctx}>
        <div className={cx('wk-root nb-root', !wide && 'wk-root--phone')} data-tool={ink.toolState.tool}>
          <p className="ml-visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          <header className="wk-topbar nb-bar">
            <div className="wk-topbar__row">
              <Link to={node ? `/library/${encodeURIComponent(node.id)}` : '/library'} className={buttonClass({ variant: 'plain', size: 'sm', className: 'wk-back' })} aria-label="العودة إلى المكتبة">
                <ArrowRight size={20} aria-hidden="true" />
              </Link>
              {node && <Cover cover={coverOf(node)} title={node.title} size="mini" />}
              <div className="wk-topbar__title">
                <h1 className="wk-title">
                  <bdi>{title}</bdi>
                </h1>
                <span className="nb-bar__where">
                  {pageCount === 0 ? 'لا صفحات بعد' : currentNo ? `صفحة ${currentNo} من ${pageCount}` : currentRow ? `قسم: ${currentRow.title ?? ''}` : `${pageCount} صفحة`}
                </span>
              </div>
              {top && (
                <Button size="sm" variant="secondary" icon={<Undo2 size={16} />} onClick={goBack} title={top.label}>
                  العودة إلى موضعك
                </Button>
              )}
              <SaveStatus state={sync.state} detail={describeSyncSnapshot(sync)} compact={!wide} />
              <Tooltip content="صفحة جديدة بعد الصفحة الحالية" describe={false}>
                <IconButton label="صفحة جديدة" icon={<FilePlus2 size={20} />} onClick={() => setNewOpen({ kind: 'page', afterId: currentId })} />
              </Tooltip>
              <Tooltip content="صفحات الدفتر" describe={false}>
                <IconButton label="صفحات الدفتر" icon={<PanelLeft size={20} />} pressed={panelOpen} onClick={() => setPanelOpen((o) => !o)} />
              </Tooltip>
            </div>
            {dividers.length > 0 && (
              <nav className="nb-tabs" aria-label="أقسام الدفتر">
                {dividers.map((d) => (
                  <button key={d.id} type="button" className={cx('nb-tab', currentSection === d.id && 'is-current')} data-color={d.color ?? undefined} aria-current={currentSection === d.id ? 'true' : undefined} onClick={() => goTo(d.id)}>
                    <span className="nb-tab__chip" aria-hidden="true" />
                    <bdi>{d.title ?? 'قسم'}</bdi>
                  </button>
                ))}
                <button type="button" className="nb-tab nb-tab--add" onClick={() => setNewOpen({ kind: 'divider', afterId: currentId })}>
                  + قسم
                </button>
              </nav>
            )}
            {inkCap && live.length > 0 && (
              <div className="wk-topbar__ink nb-bar__ink" role="group" aria-label="أدوات الكتابة">
                <InkToolbar />
              </div>
            )}
          </header>

          <div className={cx('wk-body', wide && panelOpen && 'wk-body--left')}>
            <main className="wk-main" aria-label="صفحات الدفتر">
              {live.length === 0 ? (
                <div className="nb-empty">
                  {loaded && (
                    <EmptyState
                      icon={<NotebookTabs size={28} />}
                      title="دفتر بلا صفحات بعد"
                      description="أضف صفحة فارغة أو مسطّرة أو منقّطة أو مربعات واكتب عليها بالقلم. تُحفظ على هذا الجهاز فورًا وتُزامَن عند الاتصال."
                      actions={
                        <>
                          <Button variant="primary" icon={<FilePlus2 size={18} />} onClick={() => setNewOpen({ kind: 'page', afterId: null })}>
                            أضف أول صفحة
                          </Button>
                          <Button onClick={() => setNewOpen({ kind: 'divider', afterId: null })}>أضف قسمًا</Button>
                        </>
                      }
                    />
                  )}
                </div>
              ) : (
                <div className="wk-panes">
                  <BookCanvas
                    ref={canvasRef}
                    id="nb-book"
                    sheets={sheets}
                    fallbackSize={null}
                    pageIndex={currentIndex}
                    zoom={zoom}
                    fit={fit}
                    viewRotation={0}
                    layout="continuous"
                    spreadRtl
                    flipAnimation={false}
                    label={`صفحات ${title}`}
                    onLocation={onLocation}
                    onEffectiveZoom={setEffective}
                    onZoomGesture={(z) => {
                      setFit(null);
                      setZoom(z);
                    }}
                    onViewed={() => undefined}
                    strokeActive={() => strokeActive.current}
                    className={cx(writing && 'wk-canvas--writing')}
                  />
                </div>
              )}
            </main>
            {wide && panelOpen && (
              <nav className="wk-left nb-panel" aria-label="قائمة صفحات الدفتر">
                <div className="nb-panel__head">
                  <h2 className="nb-panel__title">صفحات الدفتر</h2>
                  <Button size="sm" variant="secondary" onClick={() => setNewOpen({ kind: 'divider', afterId: currentId })}>
                    قسم جديد
                  </Button>
                </div>
                {list}
              </nav>
            )}
          </div>
          <Sheet open={!wide && panelOpen} onClose={() => setPanelOpen(false)} title="صفحات الدفتر" side="end" width="min(22rem, 92vw)">
            <div className="nb-panel nb-panel--sheet">
              <Button size="sm" variant="secondary" onClick={() => setNewOpen({ kind: 'divider', afterId: currentId })}>
                قسم جديد
              </Button>
              {list}
            </div>
          </Sheet>

          <NewNotePageDialog
            open={!!newOpen}
            where={newOpen?.afterId && rowOf(newOpen.afterId) ? 'تُضاف بعد الصفحة الحالية' : 'تُضاف في نهاية الدفتر'}
            allowDivider
            defaultKind={newOpen?.kind ?? 'page'}
            onClose={() => setNewOpen(null)}
            onCreate={create}
          />
          <RenameNotePageDialog
            open={!!renaming}
            initial={renaming?.title ?? ''}
            onClose={() => setRenaming(null)}
            onSave={async (t) => {
              if (renaming) await updateNotePage(getDb(), renaming, { title: t }).then(() => setAnnouncement('حُفظ العنوان.'), fail);
              setRenaming(null);
            }}
          />
          <LinkTargetDialog
            open={!!linkPick}
            sources={linkSources.map((s) => ({ sourceId: s.id, versionId: null, title: s.title, pages: null }))}
            notePages={live.map((r) => ({ id: r.id, label: r.title ?? ((r.kind ?? 'page') === 'divider' ? 'قسم' : `صفحة ${numbers.get(r.id) ?? ''} من الدفتر`) }))}
            onCancel={() => {
              linkPick?.resolve(null);
              setLinkPick(null);
            }}
            onChoose={(c) => {
              linkPick?.resolve(c);
              setLinkPick(null);
            }}
          />
        </div>
      </ReaderPageContext.Provider>
    </InkHost>
  );
}
