// Study workspace (§23–§26, §30, §46): full-bleed book in the middle, reading/writing bar on top, the
// Contextual Study Rail on the right, pages/outline/bookmarks on the left (only when they fit), and the
// owner's session restored and autosaved. Route: /study/:sourceId?v=<versionId>&page=<index>.
// Views (§23, §24, §26): the original lecture · the MedLevo Study Book (Lecture Twin: switching jumps to the
// nearest related block / page) · the lecture next to another source · the lecture next to its Study Book
// (optional synchronized scrolling). Explanation actions from the selection toolbar open the «الشرح والسؤال» tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, FilePlus2, Focus, Link2, X } from 'lucide-react';
import { normalizeRotation, type AnnotationAnchor, type LinkTarget, type SourceDetail, type TextQuote } from '@medlevo/shared';
import { Button, ErrorState, IconButton, LoadingState, MenuItem, Sheet, buttonClass, cx, useResizablePanel, useToast } from '../../design';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { useSettings } from '../../lib/settings';
import { describeSyncSnapshot, getSyncEngine, useSyncSnapshot } from '../../lib/sync';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { InkHost, InkProvider, useInk, type InkLinkHost, type LinkChoice } from './ink';
import { fetchSourceAnnotations, markOpened } from './data/api';
import { mergeServerAnnotations, registerWorkspaceAppliers } from './data/local';
import { activeVersionId, useSourceDetail, useVersionDocument, type SourceDocument } from './data/useSourceDocument';
import { SearchPanel } from './chrome/SearchPanel';
import { TopBar, type WorkspaceView } from './chrome/TopBar';
import { canSplit, decidePanels, defaultLeftOpen, effectiveLayout, canShowSpread, RAIL_MAX, RAIL_MIN } from './model/layout';
import { usePendingAiRequest } from './model/aiActions';
import { loadBackStack, popBack, pushBack, saveBackStack, type BackEntry, type ReaderPosition } from './model/backStack';
import { fullPageLabel } from './model/pages';
import type { SearchResult } from './model/search';
import type { ReaderLocation, StartDecision } from './model/session';
import { clampZoom, zoomIn, zoomOut, zoomPercent } from './model/zoom';
import { SourceNavigationContext, parseBbox, studyUrl, type OpenSourceLocationRequest, type SourceNavigationApi } from './nav/SourceNavigation';
import { LeftPanel, type LeftTab } from './panels/LeftPanel';
import type { MineTabValue, NoteDraft } from './panels/MineTab';
import { StudyRail, type RailTab } from './panels/StudyRail';
import { BookCanvas, type BookCanvasHandle, type BookLocation, type LayoutMode } from './reader/BookCanvas';
import { stepSpread } from './reader/geometry';
import { flipBlocked } from './reader/swipe';
import { ReaderPageContext, type ActiveHighlight, type MeasuredSize, type ReaderPageContextValue } from './reader/readerContext';
import { SelectionToolbar } from './selection/SelectionToolbar';
import { hasBookSelection, useBookSelection } from './selection/useBookSelection';
import { RemoteMoveBanner, SessionConflictDialog } from './session/SessionPrompts';
import { useReadingProgress } from './session/useReadingProgress';
import { useStudySession, type StudySessionApi } from './session/useStudySession';
import { SecondaryPane, SplitPicker } from './split/SplitPane';
import { StudyBookPane } from './studybook/StudyBookPane';
import { useStudyBookAvailability } from './studybook/useStudyBook';
import { useOfflineDownloadAction } from '../offline/OnDevice';
import { ExternalLinkDialog, LinkTargetDialog } from './notes/NotePageDialogs';
import { useReaderNotePages } from './notes/readerNotePages';
import { sheetLabel } from './model/sequence';
import './workspace.css';

// per-device view preferences (UI conveniences, never owner data): the Study Book view per source, sync scrolling
const VIEW_PREF_KEY = (sourceId: string) => `medlevo.workspace.view.${sourceId}`;
const BOOK_SYNC_KEY = 'medlevo.workspace.studybook-sync';
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the preference is simply not remembered */
  }
}

interface UrlPlace {
  versionId: string | null;
  pageIndex: number | null;
  pageId: string | null;
  bbox: ReturnType<typeof parseBbox>;
  regionId: string | null;
  offset: number | null;
  /** an inserted note page to open (a page link from elsewhere, track F1) */
  noteId: string | null;
}

function readUrl(params: URLSearchParams): UrlPlace {
  const n = (v: string | null) => (v != null && /^\d+$/.test(v) ? Number(v) : null);
  const off = params.get('offset');
  return {
    versionId: params.get('v'),
    pageIndex: n(params.get('page')),
    pageId: params.get('page_id'),
    bbox: parseBbox(params.get('bbox')),
    regionId: params.get('region'),
    offset: off != null && Number.isFinite(Number(off)) ? Math.min(1, Math.max(0, Number(off))) : null,
    noteId: params.get('note'),
  };
}

export function WorkspaceScreen() {
  const { sourceId = '' } = useParams();
  const [params] = useSearchParams();
  const v = params.get('v');
  // a new source or an explicit version (citation / back jump) starts a fresh reader
  return <WorkspaceLoader key={`${sourceId}:${v ?? ''}`} sourceId={sourceId} url={readUrl(params)} />;
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function FullBleedState({ children, title }: { children: React.ReactNode; title: string }) {
  usePageTitle(title);
  return (
    <div className="wk-state">
      <Link to="/library" className={buttonClass({ variant: 'plain', size: 'sm', className: 'wk-state__back' })}>
        <ArrowRight size={18} aria-hidden="true" />
        المكتبة
      </Link>
      <main className="wk-state__main">{children}</main>
    </div>
  );
}

function WorkspaceLoader({ sourceId, url }: { sourceId: string; url: UrlPlace }) {
  const online = useOnline();
  const { state: ds, retry: retryDetail } = useSourceDetail(sourceId);
  const detail = ds.status === 'ready' ? ds.detail : null;
  const versionIds = useMemo(() => detail?.versions.map((x) => x.id) ?? null, [detail]);
  const active = detail ? activeVersionId(detail) : null;
  const session = useStudySession({ sourceId, versionIds, activeVersionId: active, url: { versionId: url.versionId, pageIndex: url.pageIndex }, online });
  const { state: vs, retry: retryVersion } = useVersionDocument(detail, session.decision?.versionId ?? null);

  useEffect(() => {
    registerWorkspaceAppliers(getSyncEngine());
  }, []);

  if (ds.status === 'error') {
    return (
      <FullBleedState title="تعذّر فتح المصدر">
        <ErrorState title={ds.notFound ? 'المصدر غير موجود' : 'تعذّر فتح المصدر'} message={ds.message} onRetry={ds.notFound ? undefined : retryDetail} />
      </FullBleedState>
    );
  }
  if (!detail || !session.decision) {
    return (
      <FullBleedState title="جارٍ فتح المصدر">
        <LoadingState stage={!detail ? 'جارٍ فتح المصدر…' : 'جارٍ استعادة موضعك…'} />
      </FullBleedState>
    );
  }
  if (vs.status === 'error') {
    return (
      <FullBleedState title={detail.title}>
        <ErrorState message={vs.message} onRetry={retryVersion} />
      </FullBleedState>
    );
  }
  if (vs.status === 'loading') {
    return (
      <FullBleedState title={detail.title}>
        <LoadingState stage={vs.stage} />
      </FullBleedState>
    );
  }
  return (
    <InkProvider documentKey={`${sourceId}:${vs.doc.version.id}`}>
      <Workspace doc={vs.doc} decision={session.decision} session={session} url={url} online={online} />
    </InkProvider>
  );
}

// ───────────────────────────── the reader ─────────────────────────────
interface WorkspaceProps {
  doc: SourceDocument;
  decision: StartDecision;
  session: StudySessionApi;
  url: UrlPlace;
  online: boolean;
}

function backToFor(detail: SourceDetail): string {
  return detail.node_id ? `/library/${encodeURIComponent(detail.node_id)}` : '/library';
}

function Workspace({ doc, decision, session, url, online }: WorkspaceProps) {
  const { detail, version, pages } = doc;
  const sourceId = detail.id;
  const versionId = version.id;
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const settings = useSettings().settings;
  const updateSettings = useSettings().update;
  const caps = useCapabilities();
  const ink = useInk();
  const width = useWindowWidth();
  const sync = useSyncSnapshot();
  // «نزّل للعمل دون اتصال» / «على هذا الجهاز» in the top bar's overflow menu (Download Manager, features/offline)
  const offlineAction = useOfflineDownloadAction(sourceId, detail.title);
  usePageTitle(detail.title);

  // ── initial place: an explicit page in the URL, else the restored session ──
  // G2 / AC-06: a place the URL names that does not exist in this version (an unknown page id, a page past the end —
  // e.g. a stale citation link) is never replaced by another page presented as if it were the cited one (it used to be
  // clamped to the last page): the reader opens at the first page and says so (the in-app jump refuses it the same
  // way, `openSourceLocation`). The session decision already carries the URL's page number, so it is not used here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const missingPlace = useMemo(() => (url.pageId ? !pages.some((p) => p.id === url.pageId) : url.pageIndex != null && url.pageIndex >= pages.length), []);
  const [placeNoticeOpen, setPlaceNoticeOpen] = useState(missingPlace);
  const initial = useMemo(() => {
    const byId = url.pageId ? pages.findIndex((p) => p.id === url.pageId) : -1;
    const idx = byId >= 0 ? byId : missingPlace ? 0 : (url.pageIndex ?? decision.location.page_index ?? 0);
    const pageIndex = Math.min(Math.max(0, idx), Math.max(0, pages.length - 1));
    const frac = missingPlace ? 0 : url.bbox ? Math.max(0, url.bbox.y - 0.05) : (url.offset ?? (url.pageIndex == null && byId < 0 ? (decision.location.page_offset ?? 0) : 0));
    return { pageIndex, frac };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pageIndex, setPageIndex] = useState(initial.pageIndex);
  const locRef = useRef<BookLocation>(initial);
  // an inserted note page under the reading line (track F1): pageIndex / locRef then name the source page before it
  const [notePageId, setNotePageId] = useState<string | null>(null);
  const noteRef = useRef<string | null>(null);
  const noteFracRef = useRef(0);
  /** a note page to open once the note pages are loaded (URL ?note=, or the restored session) */
  const pendingNote = useRef<{ id: string; frac: number } | null>(
    url.noteId ? { id: url.noteId, frac: 0 } : url.pageIndex == null && !url.pageId && decision.location.note_page_id ? { id: decision.location.note_page_id, frac: decision.location.note_page_offset ?? 0 } : null,
  );
  const loc0 = decision.location;
  const keepZoom = decision.keepZoom && typeof loc0.zoom === 'number' && loc0.fit !== 'width';
  const [zoom, setZoom] = useState(keepZoom ? clampZoom(loc0.zoom!) : 1);
  const [fit, setFit] = useState<'width' | null>(keepZoom ? null : 'width');
  const [effectiveZoom, setEffectiveZoom] = useState(1);
  const [viewRotation, setViewRotation] = useState(normalizeRotation(loc0.rotation ?? 0));
  const [layoutPref, setLayoutPref] = useState<LayoutMode>(loc0.layout ?? settings.page_layout);

  // ── panels ──
  // phones open on the book (§23): sheets are never restored open over it
  const startsOnPhone = width < 768;
  const [railOpen, setRailOpen] = useState(startsOnPhone ? false : (loc0.rail?.open ?? settings.rail_open));
  const [railTab, setRailTab] = useState<RailTab>((['explain', 'questions', 'sources', 'mine'] as const).find((t) => t === loc0.rail?.tab) ?? 'sources');
  const [mineTab, setMineTab] = useState<MineTabValue>('notes');
  const [leftOpen, setLeftOpen] = useState(startsOnPhone ? false : (loc0.left_panel?.open ?? defaultLeftOpen(width)));
  const [leftTab, setLeftTab] = useState<LeftTab>(loc0.left_panel?.tab ?? 'thumbnails');
  const [lastPanel, setLastPanel] = useState<'rail' | 'left'>('rail');
  const rail = useResizablePanel({ initial: loc0.rail?.width ?? settings.rail_width, min: RAIL_MIN, max: RAIL_MAX, side: 'start', onCommit: (w) => void updateSettings({ rail_width: w }) });
  const [focusMode, setFocusMode] = useState(false);
  // focus mode: the book alone (§23) — panels keep their state and come back after
  const panels = decidePanels({ width, railOpen: railOpen && !focusMode, railWidth: rail.width, leftOpen: leftOpen && !focusMode, last: lastPanel });

  // ── split study ──
  const [split, setSplit] = useState<{ sourceId: string; pageIndex: number; zoom?: number | null } | null>(loc0.split?.secondary_source_id ? { sourceId: loc0.split.secondary_source_id, pageIndex: loc0.split.secondary_page_index ?? 0 } : null);
  const [splitPicker, setSplitPicker] = useState(false);
  const splitReason = panels.phone || !canSplit(panels.canvasWidth + (panels.rail === 'docked' ? Math.min(panels.railWidth, 200) : 0)) ? 'العرض جنبًا إلى جنب يحتاج شاشة أعرض (1024 بكسل على الأقل).' : null;

  // ── Study Book views (§24): full view, or the lecture | Study Book split ──
  const studyBook = useStudyBookAvailability(sourceId, online);
  const explicitPlace = url.pageIndex != null || !!url.pageId || !!url.bbox || !!url.regionId;
  // an explicit place in the URL (citation jump) opens the original, where that place is visible
  const [bookView, setBookView] = useState(() => !explicitPlace && readPref(VIEW_PREF_KEY(sourceId)) === 'study_book');
  const [splitBook, setSplitBook] = useState(() => !split && loc0.split?.mode === 'study_book');
  const [bookSync, setBookSync] = useState(() => readPref(BOOK_SYNC_KEY) !== 'off');
  const [bookJump, setBookJump] = useState(0);
  /** the lecture page (index into pages) of the Study Book block on top — where switching back lands */
  const bookTop = useRef<number | null>(null);
  /** when the lecture last moved because the Study Book scrolled (sync without feedback loops) */
  const movedByBook = useRef(0);
  const splitActive = !!split && !splitReason;
  const splitBookActive = !split && splitBook && !splitReason;
  const bookOnly = bookView && !splitActive && !splitBookActive;
  const view: WorkspaceView = splitActive ? 'split' : splitBookActive ? 'split_book' : bookOnly ? 'study_book' : 'original';
  // the canvas start position when it (re)mounts after the Study Book view
  const [canvasStart, setCanvasStart] = useState<{ frac: number }>({ frac: initial.frac });
  const canvasWidth = splitActive || splitBookActive ? panels.canvasWidth / 2 : panels.canvasWidth;
  const layout = effectiveLayout(layoutPref, canvasWidth, panels.phone);
  const spreadReason = canShowSpread(canvasWidth, panels.phone) ? null : 'لا تتسع الشاشة لصفحتين متقابلتين؛ تُعرض صفحة واحدة.';

  // ── modes ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [highlight, setHighlight] = useState<ActiveHighlight | null>(() => {
    const byId = url.pageId ? pages.find((p) => p.id === url.pageId) : url.pageIndex != null ? pages[url.pageIndex] : undefined;
    return byId && (url.bbox || url.regionId) ? { pageId: byId.id, bbox: url.bbox, regionId: url.regionId, label: 'الموضع المطلوب' } : null;
  });
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  // polite announcements for explicit navigation (go to page, jump to a region, back)
  const [announcement, setAnnouncement] = useState('');
  const toast = useToast();

  // ── note pages inserted after source pages (track F1): the canvas shows the sequence ──
  const goToNoteRef = useRef<(id: string, frac?: number) => boolean>(() => false);
  const notes = useReaderNotePages({ sourceId, pages, online, onCreated: (id) => void goToNoteRef.current(id), announce: setAnnouncement });
  const sheetsRef = useRef(notes.sheets);
  sheetsRef.current = notes.sheets;
  const seqRef = useRef(notes.index);
  seqRef.current = notes.index;
  const notePageInk = caps.feature('workspace.ink').available;
  const hasNotePages = notes.sheets.some((sh) => sh.kind === 'note');
  const seqCurrent = notePageId != null && notes.index.ofNote(notePageId) >= 0 ? notes.index.ofNote(notePageId) : notes.index.ofSource(pageIndex);
  const strokeActive = useRef(false);
  /** when the last stroke ended (a swipe right after it is the same hand, not a page turn) */
  const lastStrokeEndAt = useRef<number | null>(null);
  const canvasRef = useRef<BookCanvasHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRoots = useRef(new Map<number, HTMLElement>());
  const [measured, setMeasured] = useState<ReadonlyMap<number, MeasuredSize>>(() => new Map());
  const reportPageSize = useCallback((i: number, m: MeasuredSize) => {
    setMeasured((prev) => {
      const cur = prev.get(i);
      if (cur && Math.abs(cur.w - m.w) < 0.5 && Math.abs(cur.h - m.h) < 0.5 && cur.rotate === m.rotate) return prev;
      return new Map(prev).set(i, m);
    });
  }, []);
  const inkAvailable = caps.feature('workspace.ink').available && doc.mode !== 'text';

  // a place given in the URL is applied once; then the URL is cleaned so a reload resumes the session
  useEffect(() => {
    if (url.pageIndex != null || url.pageId || url.bbox || url.regionId || url.offset != null || url.noteId) {
      setParams((p) => {
        const n = new URLSearchParams(p);
        ['page', 'page_id', 'bbox', 'region', 'offset', 'note'].forEach((k) => n.delete(k));
        return n;
      }, { replace: true });
    }
    if (online) markOpened(sourceId);
    if (online) {
      void fetchSourceAnnotations(sourceId, versionId)
        .then((r) => mergeServerAnnotations(getDb(), r.annotations))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── reading progress ──
  const { markViewed } = useReadingProgress(sourceId, versionId, online);

  // ── autosave the place (debounced in the session hook) ──
  const stateRef = useRef({ zoom, fit, effectiveZoom, viewRotation, layoutPref, railOpen, railWidth: rail.width, railTab, leftOpen, leftTab, split, splitBook });
  stateRef.current = { zoom, fit, effectiveZoom, viewRotation, layoutPref, railOpen, railWidth: rail.width, railTab, leftOpen, leftTab, split, splitBook };
  const buildLocation = useCallback((): ReaderLocation => {
    const s = stateRef.current;
    const l = locRef.current;
    return {
      page_index: l.pageIndex,
      page_id: pages[l.pageIndex]?.id,
      page_offset: Math.round(Math.min(1, Math.max(0, l.frac)) * 1000) / 1000,
      zoom: clampZoom(s.fit === 'width' ? s.effectiveZoom : s.zoom),
      fit: s.fit,
      rotation: s.viewRotation,
      layout: s.layoutPref,
      rail: { open: s.railOpen, width: s.railWidth, tab: s.railTab },
      left_panel: { open: s.leftOpen, tab: s.leftTab },
      split: s.split ? { mode: 'source', secondary_source_id: s.split.sourceId, secondary_page_index: s.split.pageIndex } : s.splitBook ? { mode: 'study_book' } : null,
      ...(noteRef.current ? { note_page_id: noteRef.current, note_page_offset: Math.round(Math.min(1, Math.max(0, noteFracRef.current)) * 1000) / 1000 } : {}),
    };
  }, [pages]);
  const save = useCallback(() => session.save(buildLocation(), versionId, stateRef.current.split || stateRef.current.splitBook ? 'split' : 'original'), [session, buildLocation, versionId]);
  useEffect(() => {
    save();
  }, [save, zoom, fit, viewRotation, layoutPref, railOpen, rail.width, railTab, leftOpen, leftTab, split, splitBook]);

  const onLocation = useCallback(
    (l: BookLocation) => {
      locRef.current = l;
      setPageIndex((p) => (p === l.pageIndex ? p : l.pageIndex));
      save();
    },
    [save],
  );

  /** the canvas reports places in its sheet sequence: source pages → onLocation, note pages → their own place */
  const onCanvasLocation = useCallback(
    (l: BookLocation) => {
      const sh = sheetsRef.current[l.pageIndex];
      if (sh?.kind === 'note') {
        noteFracRef.current = l.frac;
        if (noteRef.current !== sh.note.id) {
          noteRef.current = sh.note.id;
          setNotePageId(sh.note.id);
        }
        const src = Math.max(0, sh.after);
        locRef.current = { pageIndex: src, frac: sh.after >= 0 ? 1 : 0 };
        setPageIndex((p) => (p === src ? p : src));
        save();
        return;
      }
      if (noteRef.current !== null) {
        noteRef.current = null;
        setNotePageId(null);
      }
      onLocation({ pageIndex: sh ? sh.page.page_index : l.pageIndex, frac: l.frac });
    },
    [onLocation, save],
  );

  // ── navigation ──
  const blockFlip = (gesture: 'key' | 'swipe' = 'key') =>
    flipBlocked({ strokeActive: strokeActive.current, lastStrokeEndAt: lastStrokeEndAt.current, now: performance.now(), hasSelection: hasBookSelection(canvasRef.current?.element() ?? null), gesture });
  const goToPage = useCallback(
    (index: number, frac = 0) => {
      const i = Math.min(Math.max(0, index), pages.length - 1);
      noteRef.current = null;
      setNotePageId(null);
      setPageIndex(i);
      locRef.current = { pageIndex: i, frac };
      canvasRef.current?.goTo(seqRef.current.ofSource(i), frac);
      save();
    },
    [pages.length, save],
  );
  /** an inserted note page (false when it is not in this version's sequence) */
  const goToNote = useCallback(
    (id: string, frac = 0) => {
      const seq = seqRef.current.ofNote(id);
      if (seq < 0) return false;
      const sh = sheetsRef.current[seq];
      const src = sh?.kind === 'note' ? Math.max(0, sh.after) : seqRef.current.sourceAtOrBefore(seq);
      noteRef.current = id;
      noteFracRef.current = frac;
      setNotePageId(id);
      setPageIndex(src);
      locRef.current = { pageIndex: src, frac: sh?.kind === 'note' && sh.after >= 0 ? 1 : 0 };
      canvasRef.current?.goTo(seq, frac);
      save();
      return true;
    },
    [save],
  );
  goToNoteRef.current = goToNote;
  const goToSeq = useCallback(
    (seq: number, frac = 0) => {
      const sh = sheetsRef.current[seq];
      if (!sh) return;
      if (sh.kind === 'note') goToNote(sh.note.id, frac);
      else goToPage(sh.page.page_index, frac);
    },
    [goToNote, goToPage],
  );
  const currentSeq = () => (noteRef.current && seqRef.current.ofNote(noteRef.current) >= 0 ? seqRef.current.ofNote(noteRef.current) : seqRef.current.ofSource(locRef.current.pageIndex));
  const step = useCallback(
    (dir: 1 | -1, gesture: 'key' | 'swipe' = 'key') => {
      if (blockFlip(gesture)) return; // never flip during (or from) a pen stroke, or during a text selection (§24)
      const cur = currentSeq();
      const count = sheetsRef.current.length;
      const next = layout === 'continuous' ? cur + dir : stepSpread(cur, dir, layout, count);
      if (next !== cur && next >= 0 && next < count) goToSeq(next, 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, goToSeq],
  );

  // a note page to open (URL / restored session) once the note pages are on this device; a trashed current page → its place
  useEffect(() => {
    const want = pendingNote.current;
    if (want && notes.index.ofNote(want.id) >= 0) {
      pendingNote.current = null;
      requestAnimationFrame(() => goToNote(want.id, want.frac));
    }
    if (noteRef.current && notes.index.ofNote(noteRef.current) < 0 && notes.rows.length > 0) {
      noteRef.current = null;
      setNotePageId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.index]);

  // ── Source Jump & Back (§11) ──
  const [backStack, setBackStack] = useState<BackEntry[]>(() => loadBackStack());
  useEffect(() => saveBackStack(backStack), [backStack]);
  const position = useCallback(
    (): ReaderPosition => ({
      sourceId,
      versionId,
      pageIndex: locRef.current.pageIndex,
      pageOffset: locRef.current.frac,
      zoom: stateRef.current.fit === 'width' ? stateRef.current.effectiveZoom : stateRef.current.zoom,
      fit: stateRef.current.fit,
      rotation: stateRef.current.viewRotation,
      layout: stateRef.current.layoutPref,
      notePageId: noteRef.current,
      ...(noteRef.current ? { pageOffset: noteFracRef.current } : {}),
    }),
    [sourceId, versionId],
  );
  /** back entries pushed while the Study Book view was showing (going back restores that view) */
  const bookBackMarks = useRef(new Set<number>());
  const bookOnlyRef = useRef(bookOnly);
  bookOnlyRef.current = bookOnly;
  const pushHere = useCallback(() => {
    const p = position();
    const page = pages[p.pageIndex];
    const createdAt = Date.now();
    if (bookOnlyRef.current) bookBackMarks.current.add(createdAt);
    const noteSheet = p.notePageId ? sheetsRef.current[seqRef.current.ofNote(p.notePageId)] : undefined;
    const where = noteSheet ? sheetLabel(noteSheet, pages) : page ? fullPageLabel(page) : '';
    setBackStack((s) => pushBack(s, { position: p, label: `${where} — ${detail.title}${bookOnlyRef.current ? ' (كتاب الدراسة)' : ''}`, createdAt }));
  }, [position, pages, detail.title]);

  /** leave the full Study Book view for the original lecture at `index` (Lecture Twin / a citation jump) */
  const showOriginalAt = useCallback(
    (index: number, frac = 0) => {
      if (!bookOnlyRef.current) return false;
      const i = Math.min(Math.max(0, index), pages.length - 1);
      setBookView(false);
      writePref(VIEW_PREF_KEY(sourceId), null);
      setCanvasStart({ frac });
      setPageIndex(i);
      locRef.current = { pageIndex: i, frac };
      return true;
    },
    [pages.length, sourceId],
  );

  const anchorFor = useCallback(
    (i: number): AnnotationAnchor | null => {
      const pg = pages[i];
      return pg ? { type: 'page', source_id: sourceId, version_id: versionId, page_id: pg.id, page_index: pg.page_index, space: 'page_norm' } : null;
    },
    [pages, sourceId, versionId],
  );

  const nav = useMemo<SourceNavigationApi>(() => {
    const top = backStack[backStack.length - 1];
    return {
      async openSourceLocation(req: OpenSourceLocationRequest) {
        if (req.sourceId !== sourceId || (req.versionId && req.versionId !== versionId)) {
          if (req.sourceId === sourceId && req.versionId && !detail.versions.some((x) => x.id === req.versionId)) {
            return { ok: false, reason_ar: 'هذا الإصدار من المصدر لم يعد موجودًا؛ لن يُفتح إصدار آخر مكانه كأنه الدليل نفسه.' };
          }
          pushHere();
          navigate(studyUrl({ sourceId: req.sourceId, versionId: req.versionId, pageIndex: req.pageIndex, pageId: req.pageId, bbox: req.bbox, regionId: req.regionId }));
          return { ok: true };
        }
        const idx = req.pageId ? pages.findIndex((p) => p.id === req.pageId) : (req.pageIndex ?? -1);
        if (idx < 0 || idx >= pages.length) return { ok: false, reason_ar: 'الصفحة المطلوبة غير موجودة في هذا الإصدار.' };
        pushHere();
        setHighlight({ pageId: pages[idx]!.id, bbox: req.bbox ?? null, regionId: req.regionId ?? null, label: req.label ?? null });
        setAnnouncement(`فُتح الموضع: ${req.label ?? fullPageLabel(pages[idx]!)}. للعودة استخدم «العودة إلى موضعك».`);
        if (panels.phone) setRailOpen(false);
        const frac = req.bbox ? Math.max(0, req.bbox.y - 0.05) : 0;
        // from the Study Book: the cited place is shown in the original lecture
        if (!showOriginalAt(idx, frac)) goToPage(idx, frac);
        return { ok: true };
      },
      goBack() {
        const { entry, stack } = popBack(backStack);
        if (!entry) return false;
        setBackStack(stack);
        setHighlight(null);
        const p = entry.position;
        if (entry.route) {
          // a place outside the reader (a notebook page)
          navigate(entry.route);
          return true;
        }
        if (p.sourceId !== sourceId || p.versionId !== versionId) {
          navigate(studyUrl({ sourceId: p.sourceId, versionId: p.versionId, pageIndex: p.pageIndex, offset: p.pageOffset }));
          return true;
        }
        if (bookBackMarks.current.delete(entry.createdAt)) {
          // the jump started in the Study Book: return to it, at the block of that page
          setPageIndex(p.pageIndex);
          locRef.current = { pageIndex: p.pageIndex, frac: p.pageOffset };
          setSplit(null);
          setSplitBook(false);
          setBookView(true);
          writePref(VIEW_PREF_KEY(sourceId), 'study_book');
          setBookJump((n) => n + 1);
          setAnnouncement(`عدت إلى كتاب الدراسة عند ${entry.label}.`);
          return true;
        }
        setFit(p.fit);
        if (p.fit !== 'width') setZoom(clampZoom(p.zoom));
        setViewRotation(normalizeRotation(p.rotation));
        setLayoutPref(p.layout);
        // after the layout settles at the restored zoom
        requestAnimationFrame(() => {
          if (!(p.notePageId && goToNote(p.notePageId, p.pageOffset))) goToPage(p.pageIndex, p.pageOffset);
        });
        setAnnouncement(`عدت إلى ${entry.label}.`);
        return true;
      },
      canGoBack: !!top,
      backLabel: top?.label ?? null,
      clearHighlight: () => setHighlight(null),
    };
  }, [backStack, sourceId, versionId, detail.versions, pages, navigate, pushHere, goToPage, goToNote, panels.phone, showOriginalAt]);

  // ── selection ──
  const canvasEl = useCallback(() => canvasRef.current?.element() ?? null, []);
  const { selection, clear: clearSelection } = useBookSelection(canvasEl);

  // ── search hits → page ──
  const currentResult = results[current] ?? null;
  useEffect(() => {
    if (!currentResult) return;
    if (currentResult.pageIndex !== locRef.current.pageIndex || layout !== 'continuous') goToPage(currentResult.pageIndex, 0.2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentResult]);

  // ── focus mode (Fullscreen API with a CSS fallback) ──
  const toggleFocus = useCallback(() => {
    const el = rootRef.current;
    if (!focusMode) {
      setFocusMode(true);
      if (el?.requestFullscreen && !document.fullscreenElement) void el.requestFullscreen().catch(() => undefined);
    } else {
      setFocusMode(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    }
  }, [focusMode]);
  useEffect(() => {
    const on = () => {
      if (!document.fullscreenElement) setFocusMode(false);
    };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // ── panels ──
  const toggleRail = useCallback(() => {
    setRailOpen((o) => !o);
    setLastPanel('rail');
  }, []);
  const toggleLeft = useCallback(() => {
    setLeftOpen((o) => !o);
    setLastPanel('left');
  }, []);
  // a panel that no longer fits is closed (so it does not reappear unexpectedly later)
  useEffect(() => {
    if (focusMode) return;
    if (panels.closed === 'left') setLeftOpen(false);
    if (panels.closed === 'rail') setRailOpen(false);
  }, [panels.closed, focusMode]);

  // ── keyboard (§55) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.getElementById('root')?.hasAttribute('inert')) return; // a modal owns the keyboard
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      const key = e.key;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setSearchFocus((n) => n + 1);
        return;
      }
      if (typing) return;
      if (key === 'Escape') {
        if (selection) clearSelection();
        else if (searchOpen) setSearchOpen(false);
        else if (highlight) setHighlight(null);
        else if (focusMode) toggleFocus();
        else return;
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // composite widgets handle their own arrows; the Study Book pane scrolls natively
      const inWidget = !!target?.closest('[role="toolbar"],[role="tablist"],[role="radiogroup"],[role="menu"],[role="separator"],[role="dialog"],.wk-rail,.wk-left,.wk-search,.sb-pane');
      const onCanvas = !!target?.closest('.wk-canvas');
      // the Study Book alone: no page flips of a lecture that is not on screen
      if (bookOnly && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(key)) return;
      switch (key) {
        case 'ArrowLeft':
        case 'ArrowRight':
          if (inWidget || e.shiftKey) return;
          if (onCanvas && (canvasRef.current?.element()?.scrollWidth ?? 0) > (canvasRef.current?.element()?.clientWidth ?? 0) + 4) return; // zoomed: arrows pan
          e.preventDefault();
          step(key === 'ArrowLeft' ? 1 : -1); // RTL: left = next in reading order
          return;
        case 'ArrowDown':
        case 'ArrowUp':
          if (inWidget || e.shiftKey || onCanvas) return; // the focused canvas scrolls natively
          e.preventDefault();
          if (layout === 'continuous') canvasRef.current?.scrollByViewport(key === 'ArrowDown' ? 0.15 : -0.15);
          else step(key === 'ArrowDown' ? 1 : -1);
          return;
        case 'PageDown':
        case 'PageUp':
          if (inWidget) return;
          e.preventDefault();
          step(key === 'PageDown' ? 1 : -1);
          return;
        case 'Home':
        case 'End':
          if (inWidget) return;
          e.preventDefault();
          if (!blockFlip()) goToSeq(key === 'Home' ? 0 : sheetsRef.current.length - 1, 0);
          return;
        case '+':
        case '=':
          e.preventDefault();
          setFit(null);
          setZoom(zoomIn(stateRef.current.fit === 'width' ? stateRef.current.effectiveZoom : stateRef.current.zoom));
          return;
        case '-':
        case '_':
          e.preventDefault();
          setFit(null);
          setZoom(zoomOut(stateRef.current.fit === 'width' ? stateRef.current.effectiveZoom : stateRef.current.zoom));
          return;
        case '[':
          e.preventDefault();
          toggleLeft();
          return;
        case ']':
          e.preventDefault();
          toggleRail();
          return;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFocus();
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, searchOpen, highlight, focusMode, layout, step, goToPage, goToSeq, toggleLeft, toggleRail, toggleFocus, pages.length, bookOnly]);

  // ── explanation actions from the selection toolbar → the «الشرح والسؤال» tab (it consumes the request) ──
  const pendingAi = usePendingAiRequest();
  useEffect(() => {
    if (!pendingAi) return;
    setRailTab('explain');
    setRailOpen(true);
    setLastPanel('rail');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAi?.id]);

  // ── views ──
  const changeView = useCallback(
    (v: WorkspaceView) => {
      if (v === 'split') {
        setSplitBook(false);
        setBookView(false);
        writePref(VIEW_PREF_KEY(sourceId), null);
        if (!split) setSplitPicker(true);
        return;
      }
      if (v === 'split_book') {
        if (bookOnlyRef.current && bookTop.current != null) showOriginalAt(bookTop.current);
        setSplit(null);
        setBookView(false);
        writePref(VIEW_PREF_KEY(sourceId), null);
        setSplitBook(true);
        setBookJump((n) => n + 1);
        return;
      }
      if (v === 'study_book') {
        setSplit(null);
        setSplitBook(false);
        setBookView(true);
        writePref(VIEW_PREF_KEY(sourceId), 'study_book');
        bookTop.current = null;
        setBookJump((n) => n + 1); // Lecture Twin: the block nearest the current lecture page
        const here = pages[locRef.current.pageIndex];
        setAnnouncement(`كتاب الدراسة: يُعرض أقرب جزء إلى ${here ? fullPageLabel(here) : 'الصفحة الحالية'}.`);
        return;
      }
      // original
      setSplit(null);
      setSplitBook(false);
      if (bookOnlyRef.current) {
        const target = bookTop.current ?? locRef.current.pageIndex;
        showOriginalAt(target);
        if (pages[target]) setAnnouncement(`المحاضرة الأصلية: ${fullPageLabel(pages[target]!)}، الصفحة المرتبطة بما كنت تقرؤه في كتاب الدراسة.`);
      }
      setBookView(false);
      writePref(VIEW_PREF_KEY(sourceId), null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceId, split, showOriginalAt, pages],
  );

  /** «افتح في المحاضرة» from the full Study Book: the original lecture at that page */
  const changeViewToPage = useCallback(
    (i: number) => {
      if (!showOriginalAt(i)) goToPage(i);
      else if (pages[i]) setAnnouncement(`المحاضرة الأصلية: ${fullPageLabel(pages[i]!)}.`);
    },
    [showOriginalAt, goToPage, pages],
  );

  /** the Study Book reports the lecture page of its top block (Lecture Twin; optional sync in the split) */
  const onBookPage = useCallback(
    (i: number) => {
      bookTop.current = i;
      if (bookOnlyRef.current) {
        // the rail follows what is being read
        setPageIndex((p) => (p === i ? p : i));
        locRef.current = { pageIndex: i, frac: 0 };
        return;
      }
      if (stateRef.current.splitBook && bookSyncRef.current && i !== locRef.current.pageIndex) {
        movedByBook.current = Date.now();
        goToPage(i, 0);
      }
    },
    [goToPage],
  );
  const bookSyncRef = useRef(bookSync);
  bookSyncRef.current = bookSync;
  // lecture scrolled in the split → the Study Book follows (unless the move came from the book itself)
  useEffect(() => {
    if (!splitBookActive || !bookSync) return;
    if (Date.now() - movedByBook.current < 900) return;
    setBookJump((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex]);

  // ── PDF link annotations: internal → that page (Back returns), external → only after an explicit confirmation ──
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const pdfLinks = useMemo(
    () => ({
      goToPage: (i: number, label: string) => {
        void nav.openSourceLocation({ sourceId, versionId, pageIndex: i, label }).then((r) => {
          if (!r.ok) toast.show({ title: 'لم يُفتح الرابط', description: r.reason_ar, tone: 'warning' });
        });
      },
      openExternal: (u: string) => setExternalUrl(u),
    }),
    [nav, sourceId, versionId, toast],
  );

  // ── page context ──
  const tool = ink.toolState.tool;
  // note pages take ink even in a text source (fixed paper), so writing is possible whenever there is somewhere to write
  const writing = (inkAvailable || (notePageInk && hasNotePages)) && ink.isWritingTool;
  const registerTextRoot = useCallback((i: number, el: HTMLElement | null) => {
    if (el) textRoots.current.set(i, el);
    else textRoots.current.delete(i);
  }, []);
  const onStrokeActiveChange = useCallback((active: boolean) => {
    strokeActive.current = active;
    if (!active) lastStrokeEndAt.current = performance.now();
  }, []);
  const pageCtx = useMemo<ReaderPageContextValue>(
    () => ({
      sourceId,
      versionId,
      mode: doc.mode,
      pdf: doc.pdf,
      textInteractive: !writing,
      inkInteractive: writing,
      inkEnabled: inkAvailable,
      onStrokeActiveChange,
      highlight,
      searchResults: searchOpen ? results : [],
      currentResult: searchOpen ? currentResult : null,
      registerTextRoot,
      anchorFor,
      reportPageSize,
      textLang: detail.language === 'en' || detail.language === 'ar' ? detail.language : null,
      notePageInk,
      notePageActions: notes.actions,
      paperRtl: detail.language !== 'en',
      pdfLinks,
    }),
    [sourceId, versionId, doc.mode, doc.pdf, writing, inkAvailable, onStrokeActiveChange, highlight, searchOpen, results, currentResult, registerTextRoot, anchorFor, reportPageSize, detail.language, notePageInk, notes.actions, pdfLinks],
  );

  // ── page links (ink kind 'link') and PDF links (track F1): following one records Back (§11) ──
  const navRef = useRef(nav);
  navRef.current = nav;
  const [linkPick, setLinkPick] = useState<{ resolve: (c: LinkChoice | null) => void } | null>(null);
  const followLink = useCallback(
    async (target: LinkTarget) => {
      if (target.type === 'source_page') {
        const r = await navRef.current.openSourceLocation({
          sourceId: target.source_id,
          versionId: target.version_id,
          pageId: target.page_id,
          pageIndex: target.page_index,
          bbox: target.bbox ?? null,
          regionId: target.region_id ?? null,
          label: 'الموضع المرتبط',
        });
        if (!r.ok) toast.show({ title: 'لم يُفتح الرابط', description: r.reason_ar, tone: 'warning' });
        return;
      }
      const id = target.note_page_id;
      if (seqRef.current.ofNote(id) >= 0) {
        pushHere();
        goToNote(id);
        setAnnouncement('فُتحت صفحة الملاحظات المرتبطة. للعودة استخدم «العودة إلى موضعك».');
        return;
      }
      const row = (await getDb().notePages.get(id)) ?? null;
      if (!row || row.deletedAt) {
        toast.show({
          title: row ? 'الصفحة المرتبطة في المحذوفات' : 'الصفحة المرتبطة غير موجودة على هذا الجهاز',
          description: row ? 'استعدها من قائمة المحذوفات ثم افتح الرابط مرة أخرى.' : 'ربما حُذفت نهائيًا، أو لم تصل إلى هذا الجهاز بعد.',
          tone: 'warning',
        });
        return;
      }
      pushHere();
      if (row.nodeId) navigate(`/notebook/${encodeURIComponent(row.nodeId)}?page=${encodeURIComponent(id)}`);
      else if (row.sourceId) navigate(`${studyUrl({ sourceId: row.sourceId })}?note=${encodeURIComponent(id)}`);
    },
    [toast, pushHere, goToNote, navigate],
  );
  const linkHost = useMemo<InkLinkHost>(
    () => ({
      pickTarget: () => new Promise<LinkChoice | null>((resolve) => setLinkPick({ resolve })),
      open: (target) => void followLink(target),
      describe: (t) => {
        if (t.type !== 'note_page') return null;
        const sh = sheetsRef.current[seqRef.current.ofNote(t.note_page_id)];
        return sh ? sheetLabel(sh, pages) : null;
      },
    }),
    [followLink, pages],
  );
  const currentInkPage = useCallback(() => {
    const id = noteRef.current;
    if (id) {
      const sh = sheetsRef.current[seqRef.current.ofNote(id)];
      if (sh?.kind === 'note') return { targetKey: `note_page:${id}`, anchor: { type: 'note_page' as const, note_page_id: id, space: 'page_norm' as const }, ar: sh.note.height / sh.note.width, pageWidthPt: sh.note.width };
    }
    if (!inkAvailable) return null;
    const pg = pages[locRef.current.pageIndex];
    const a = anchorFor(locRef.current.pageIndex);
    if (!pg || !a) return null;
    const m = measured.get(pg.page_index);
    const w = m?.w ?? pg.width ?? 595;
    const h = m?.h ?? pg.height ?? 842;
    return { targetKey: `source_page:${pg.id}`, anchor: a, ar: h / w, pageWidthPt: w };
  }, [inkAvailable, pages, anchorFor, measured]);

  // ── session prompts ──
  const conflict = session.conflict;
  const remote = session.remote;
  const resolve = async (choice: 'theirs' | 'mine') => {
    const server = await session.resolveConflict(choice, { location: buildLocation(), versionId });
    if (choice === 'theirs' && server) {
      if (server.version_id && server.version_id !== versionId) navigate(studyUrl({ sourceId, versionId: server.version_id, pageIndex: server.location.page_index ?? 0, offset: server.location.page_offset ?? 0 }));
      else goToPage(server.location.page_index ?? 0, server.location.page_offset ?? 0);
    }
  };

  const page = pages[pageIndex] ?? null;
  const backTop = backStack[backStack.length - 1];
  const zoomLabel = zoomPercent(fit === 'width' ? effectiveZoom : zoom);
  const railNode = (
    <StudyRail
      doc={doc}
      page={page}
      pageIndex={pageIndex}
      tab={railTab}
      onTab={setRailTab}
      mineTab={mineTab}
      onMineTab={setMineTab}
      draft={draft}
      onDraftConsumed={() => setDraft(null)}
      anchorFor={anchorFor}
      onGoToPage={(i) => {
        if (panels.phone) setRailOpen(false);
        goToPage(i);
      }}
      onOpenSplit={(id) => setSplit({ sourceId: id, pageIndex: 0 })}
      splitReason={splitReason}
      online={online}
      notePages={{
        live: notes.sheets.flatMap((sh) => (sh.kind === 'note' ? [{ id: sh.note.id, label: sheetLabel(sh, pages) }] : [])),
        trashed: notes.rows.filter((r) => r.deletedAt).map((r) => ({ id: r.id, label: r.title ? `«${r.title}» — صفحة ملاحظات` : 'صفحة ملاحظات بلا عنوان' })),
        onGo: (id) => {
          if (panels.phone) setRailOpen(false);
          goToNote(id);
        },
        onRestore: (id) => void notes.restore(id),
        onNew: () => notes.openNew(seqCurrent),
      }}
    />
  );
  const leftNode = (
    <LeftPanel
      doc={doc}
      pageIndex={pageIndex}
      tab={leftTab}
      onTab={setLeftTab}
      anchorFor={anchorFor}
      onGoToPage={(i, f) => {
        if (panels.phone) setLeftOpen(false);
        goToPage(i, f ?? 0);
      }}
    />
  );

  return (
    <InkHost links={linkHost} currentPage={currentInkPage} notify={(m) => toast.show({ title: m, tone: 'warning' })}>
    <SourceNavigationContext.Provider value={nav}>
      <ReaderPageContext.Provider value={pageCtx}>
        <div
          ref={rootRef}
          className={cx('wk-root', focusMode && 'wk-root--focus', panels.phone && 'wk-root--phone')}
          data-tool={tool}
          style={{ ['--wk-rail-w' as string]: `${panels.railWidth}px` }}
        >
          <a className="ml-skip-link" href="#wk-book" onClick={(e) => {
            e.preventDefault();
            canvasRef.current?.element()?.focus();
          }}>
            انتقل إلى الكتاب
          </a>
          <p className="ml-visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
          {!focusMode ? (
            <TopBar
              title={detail.title}
              backTo={backToFor(detail)}
              phone={panels.phone}
              pages={pages}
              pageIndex={pageIndex}
              onGoToPage={(i) => {
                goToPage(i);
                if (pages[i]) setAnnouncement(`انتقلت إلى ${fullPageLabel(pages[i]!)}.`);
              }}
              view={view}
              onView={changeView}
              splitReason={splitReason}
              studyBookReason={studyBook.reason}
              searchOpen={searchOpen}
              onToggleSearch={() => {
                // searching the source text happens in the original (its hits are on the pages)
                if (bookOnly && !searchOpen) changeView('original');
                setSearchOpen((o) => !o);
                setSearchFocus((n) => n + 1);
              }}
              zoomLabel={zoomLabel}
              fit={fit === 'width'}
              onZoomIn={() => {
                setFit(null);
                setZoom(zoomIn(fit === 'width' ? effectiveZoom : zoom));
              }}
              onZoomOut={() => {
                setFit(null);
                setZoom(zoomOut(fit === 'width' ? effectiveZoom : zoom));
              }}
              onZoomTo={(z) => {
                if (z === 'fit') setFit('width');
                else {
                  setFit(null);
                  setZoom(clampZoom(z));
                }
              }}
              onRotate={(d) => setViewRotation((r) => normalizeRotation(r + d * 90))}
              layout={layoutPref}
              spreadReason={spreadReason}
              onLayout={(l) => {
                setLayoutPref(l);
                void updateSettings({ page_layout: l });
              }}
              flipAnimation={settings.page_flip_animation}
              onFlipAnimation={(v) => void updateSettings({ page_flip_animation: v })}
              focusMode={focusMode}
              onFocusMode={toggleFocus}
              leftOpen={panels.left !== 'closed'}
              onToggleLeft={toggleLeft}
              railOpen={panels.rail !== 'closed'}
              onToggleRail={toggleRail}
              saveState={sync.state}
              saveDetail={describeSyncSnapshot(sync)}
              back={backTop ? { label: 'العودة إلى موضعك', title: backTop.label } : null}
              onBack={() => nav.goBack()}
              inkAvailable={(inkAvailable || (notePageInk && hasNotePages)) && !bookOnly}
              noteLabel={notePageId && notes.index.ofNote(notePageId) >= 0 ? 'صفحة ملاحظات بعدها' : null}
              extraMenuItems={
                <>
                  <MenuItem icon={<FilePlus2 size={16} />} disabled={bookOnly} disabledReason="صفحات الملاحظات تُضاف في المحاضرة الأصلية." onSelect={() => notes.openNew(seqCurrent)}>
                    صفحة ملاحظات بعد هذه الصفحة…
                  </MenuItem>
                  {offlineAction.item}
                </>
              }
            />
          ) : (
            <div className="wk-focusbar">
              <Button size="sm" variant="secondary" icon={<Focus size={16} />} onClick={toggleFocus}>
                إنهاء وضع التركيز
              </Button>
              <span className="wk-focusbar__page">{page ? fullPageLabel(page) : ''}</span>
            </div>
          )}

          {remote && !conflict && (
            <RemoteMoveBanner
              label={pages[remote.location.page_index ?? 0] && remote.versionId === versionId ? fullPageLabel(pages[remote.location.page_index ?? 0]!) : `الصفحة ${(remote.location.page_index ?? 0) + 1} في الملف`}
              onGo={() => {
                session.dismissRemote();
                if (remote.versionId && remote.versionId !== versionId) navigate(studyUrl({ sourceId, versionId: remote.versionId, pageIndex: remote.location.page_index ?? 0 }));
                else goToPage(remote.location.page_index ?? 0, remote.location.page_offset ?? 0);
              }}
              onDismiss={session.dismissRemote}
            />
          )}
          {doc.pdfError && (
            <div className="wk-banner wk-banner--warning" role="alert">
              {doc.pdfError}
            </div>
          )}
          {placeNoticeOpen && (
            <div className="wk-banner wk-banner--warning" role="alert">
              الموضع المطلوب غير موجود في هذا الإصدار من المصدر (ربما أُعيدت معالجته أو تغيّرت صفحاته)؛ لم يُفتح موضع آخر على أنه هو، ويُعرض الكتاب من صفحته الأولى.{' '}
              <Button size="sm" variant="plain" onClick={() => setPlaceNoticeOpen(false)}>
                حسنًا
              </Button>
            </div>
          )}
          {doc.mode === 'unsupported' && (
            <div className="wk-banner wk-banner--warning" role="alert">
              هذا النوع من المصادر لا يُعرض في القارئ بعد.
            </div>
          )}

          <div className={cx('wk-body', panels.rail === 'docked' && 'wk-body--rail', panels.left === 'docked' && 'wk-body--left', (splitActive || splitBookActive) && 'wk-body--split', bookOnly && 'wk-body--book')}>
            <main className="wk-main" aria-label="الكتاب">
              {searchOpen && (
                <SearchPanel
                  doc={doc}
                  query={query}
                  onQuery={setQuery}
                  results={results}
                  onResults={(r) => setResults(r)}
                  current={current}
                  onCurrent={setCurrent}
                  onClose={() => setSearchOpen(false)}
                  focusKey={searchFocus}
                />
              )}
              <div className="wk-panes">
                {bookOnly ? (
                  <StudyBookPane
                    doc={doc}
                    pageIndex={pageIndex}
                    jumpKey={bookJump}
                    onVisiblePage={onBookPage}
                    onOpenPage={(i) => changeViewToPage(i)}
                    online={online}
                    onBookChanged={studyBook.refresh}
                  />
                ) : (
                <BookCanvas
                  ref={canvasRef}
                  id="wk-book"
                  sheets={notes.sheets}
                  fallbackSize={null}
                  measured={measured}
                  pageIndex={seqCurrent}
                  initialFrac={canvasStart.frac}
                  zoom={zoom}
                  fit={fit}
                  viewRotation={viewRotation}
                  layout={layout}
                  spreadRtl={detail.language === 'ar'}
                  flipAnimation={settings.page_flip_animation}
                  label={`صفحات ${detail.title}`}
                  onLocation={onCanvasLocation}
                  onEffectiveZoom={setEffectiveZoom}
                  onZoomGesture={(z) => {
                    setFit(null);
                    setZoom(clampZoom(z));
                  }}
                  onViewed={(seq) => {
                    // reading progress counts source pages only (§45)
                    const sh = sheetsRef.current[seq];
                    if (sh?.kind === 'source') markViewed(sh.page.page_index);
                  }}
                  onSwipe={(dir) => step(dir, 'swipe')}
                  strokeActive={() => strokeActive.current}
                  className={cx(writing && 'wk-canvas--writing')}
                />
                )}
                {splitBookActive && (
                  <StudyBookPane
                    compact
                    doc={doc}
                    pageIndex={pageIndex}
                    jumpKey={bookJump}
                    onVisiblePage={onBookPage}
                    onOpenPage={(i) => goToPage(i)}
                    online={online}
                    onBookChanged={studyBook.refresh}
                    toolbar={
                      <>
                        <Button
                          size="sm"
                          variant="plain"
                          icon={<Link2 size={16} />}
                          aria-pressed={bookSync}
                          onClick={() => {
                            const next = !bookSync;
                            setBookSync(next);
                            writePref(BOOK_SYNC_KEY, next ? 'on' : 'off');
                            if (next) setBookJump((n) => n + 1);
                          }}
                        >
                          {bookSync ? 'التمرير متزامن' : 'التمرير مستقل'}
                        </Button>
                        <IconButton size="sm" label="أغلق كتاب الدراسة الجانبي" icon={<X size={16} />} onClick={() => changeView('original')} />
                      </>
                    }
                  />
                )}
                {splitActive && split && (
                  <SecondaryPane
                    key={split.sourceId}
                    sourceId={split.sourceId}
                    initialPage={split.pageIndex}
                    initialZoom={split.zoom ?? null}
                    online={online}
                    onPage={(i) => setSplit((s) => (s && s.pageIndex !== i ? { ...s, pageIndex: i } : s))}
                    onZoom={(z) => setSplit((s) => (s ? { ...s, zoom: z } : s))}
                    onClose={() => setSplit(null)}
                  />
                )}
              </div>
            </main>

            {panels.rail === 'docked' && (
              <aside className="wk-rail" aria-label="لوحة الدراسة" style={{ width: panels.railWidth }}>
                <div className="wk-rail__inner">{railNode}</div>
                <div {...rail.handleProps('تغيير عرض لوحة الدراسة')} />
              </aside>
            )}
            {panels.left === 'docked' && (
              <nav className="wk-left" aria-label="الصفحات والفهرس والعلامات">
                {leftNode}
              </nav>
            )}
          </div>

          {selection && !focusMode && !bookOnly && (
            <SelectionToolbar
              selection={selection}
              canvas={canvasRef.current?.element() ?? null}
              textRoot={(i) => textRoots.current.get(i) ?? null}
              anchorFor={anchorFor}
              fixedPages={doc.mode === 'pdf' || doc.mode === 'image'}
              onAddNote={(i, quote: TextQuote | null) => {
                setDraft({ pageIndex: i, quote });
                setRailTab('mine');
                setMineTab('notes');
                setRailOpen(true);
                setLastPanel('rail');
                clearSelection();
              }}
              onDone={clearSelection}
            />
          )}

          <Sheet open={panels.rail === 'sheet'} onClose={() => setRailOpen(false)} title="لوحة الدراسة" side="start" width="min(26rem, 92vw)">
            {railNode}
          </Sheet>
          <Sheet open={panels.left === 'sheet'} onClose={() => setLeftOpen(false)} title="الصفحات والفهرس والعلامات" side="end" width="min(22rem, 92vw)">
            {leftNode}
          </Sheet>
          <SplitPicker
            open={splitPicker}
            onClose={() => setSplitPicker(false)}
            detail={detail}
            onPick={(id) => {
              setSplitPicker(false);
              setSplit({ sourceId: id, pageIndex: 0 });
            }}
          />
          {conflict && (
            <SessionConflictDialog
              open
              theirs={{ location: conflict.server.location, versionId: conflict.server.version_id, updatedAt: conflict.server.updated_at }}
              mine={{ location: buildLocation() }}
              pages={pages}
              versions={detail.versions}
              currentVersionId={versionId}
              onTheirs={() => void resolve('theirs')}
              onMine={() => void resolve('mine')}
            />
          )}
          {offlineAction.dialog}
          {notes.dialogs}
          <LinkTargetDialog
            open={!!linkPick}
            sources={[{ sourceId, versionId, title: detail.title, pages, current: pageIndex }]}
            notePages={notes.sheets.flatMap((sh) => (sh.kind === 'note' ? [{ id: sh.note.id, label: sheetLabel(sh, pages) }] : []))}
            onCancel={() => {
              linkPick?.resolve(null);
              setLinkPick(null);
            }}
            onChoose={(c) => {
              linkPick?.resolve(c);
              setLinkPick(null);
            }}
          />
          <ExternalLinkDialog url={externalUrl} onClose={() => setExternalUrl(null)} />
        </div>
      </ReaderPageContext.Provider>
    </SourceNavigationContext.Provider>
    </InkHost>
  );
}
