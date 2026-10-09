// Study workspace (§23–§26, §30, §46): full-bleed book in the middle, reading/writing bar on top, the
// Contextual Study Rail on the right, pages/outline/bookmarks on the left (only when they fit), and the
// owner's session restored and autosaved. Route: /study/:sourceId?v=<versionId>&page=<index>.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Focus } from 'lucide-react';
import { normalizeRotation, type AnnotationAnchor, type SourceDetail, type TextQuote } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Sheet, buttonClass, cx, useResizablePanel } from '../../design';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { useSettings } from '../../lib/settings';
import { describeSyncSnapshot, getSyncEngine, useSyncSnapshot } from '../../lib/sync';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { InkProvider, useInk } from './ink';
import { fetchSourceAnnotations, markOpened } from './data/api';
import { mergeServerAnnotations, registerWorkspaceAppliers } from './data/local';
import { activeVersionId, useSourceDetail, useVersionDocument, type SourceDocument } from './data/useSourceDocument';
import { SearchPanel } from './chrome/SearchPanel';
import { TopBar } from './chrome/TopBar';
import { canSplit, decidePanels, defaultLeftOpen, effectiveLayout, canShowSpread, RAIL_MAX, RAIL_MIN } from './model/layout';
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
import './workspace.css';

export const STUDY_BOOK_REASON = 'لم يُنشأ كتاب الدراسة بعد؛ يصل مع مرحلة كتاب الدراسة (MedLevo Study Book).';

interface UrlPlace {
  versionId: string | null;
  pageIndex: number | null;
  pageId: string | null;
  bbox: ReturnType<typeof parseBbox>;
  regionId: string | null;
  offset: number | null;
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
  usePageTitle(detail.title);

  // ── initial place: an explicit page in the URL, else the restored session ──
  const initial = useMemo(() => {
    const byId = url.pageId ? pages.findIndex((p) => p.id === url.pageId) : -1;
    const idx = byId >= 0 ? byId : (url.pageIndex ?? decision.location.page_index ?? 0);
    const pageIndex = Math.min(Math.max(0, idx), Math.max(0, pages.length - 1));
    const frac = url.bbox ? Math.max(0, url.bbox.y - 0.05) : (url.offset ?? (url.pageIndex == null && byId < 0 ? (decision.location.page_offset ?? 0) : 0));
    return { pageIndex, frac };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pageIndex, setPageIndex] = useState(initial.pageIndex);
  const locRef = useRef<BookLocation>(initial);
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
  const [split, setSplit] = useState<{ sourceId: string; pageIndex: number } | null>(loc0.split?.secondary_source_id ? { sourceId: loc0.split.secondary_source_id, pageIndex: loc0.split.secondary_page_index ?? 0 } : null);
  const [splitPicker, setSplitPicker] = useState(false);
  const splitReason = panels.phone || !canSplit(panels.canvasWidth + (panels.rail === 'docked' ? Math.min(panels.railWidth, 200) : 0)) ? 'العرض جنبًا إلى جنب يحتاج شاشة أعرض (1024 بكسل على الأقل).' : null;
  const splitActive = !!split && !splitReason;
  const canvasWidth = splitActive ? panels.canvasWidth / 2 : panels.canvasWidth;
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
    if (url.pageIndex != null || url.pageId || url.bbox || url.regionId || url.offset != null) {
      setParams((p) => {
        const n = new URLSearchParams(p);
        ['page', 'page_id', 'bbox', 'region', 'offset'].forEach((k) => n.delete(k));
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
  const stateRef = useRef({ zoom, fit, effectiveZoom, viewRotation, layoutPref, railOpen, railWidth: rail.width, railTab, leftOpen, leftTab, split });
  stateRef.current = { zoom, fit, effectiveZoom, viewRotation, layoutPref, railOpen, railWidth: rail.width, railTab, leftOpen, leftTab, split };
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
      split: s.split ? { mode: 'source', secondary_source_id: s.split.sourceId, secondary_page_index: s.split.pageIndex } : null,
    };
  }, [pages]);
  const save = useCallback(() => session.save(buildLocation(), versionId, stateRef.current.split ? 'split' : 'original'), [session, buildLocation, versionId]);
  useEffect(() => {
    save();
  }, [save, zoom, fit, viewRotation, layoutPref, railOpen, rail.width, railTab, leftOpen, leftTab, split]);

  const onLocation = useCallback(
    (l: BookLocation) => {
      locRef.current = l;
      setPageIndex((p) => (p === l.pageIndex ? p : l.pageIndex));
      save();
    },
    [save],
  );

  // ── navigation ──
  const blockFlip = (gesture: 'key' | 'swipe' = 'key') =>
    flipBlocked({ strokeActive: strokeActive.current, lastStrokeEndAt: lastStrokeEndAt.current, now: performance.now(), hasSelection: hasBookSelection(canvasRef.current?.element() ?? null), gesture });
  const goToPage = useCallback(
    (index: number, frac = 0) => {
      const i = Math.min(Math.max(0, index), pages.length - 1);
      setPageIndex(i);
      locRef.current = { pageIndex: i, frac };
      canvasRef.current?.goTo(i, frac);
      save();
    },
    [pages.length, save],
  );
  const step = useCallback(
    (dir: 1 | -1, gesture: 'key' | 'swipe' = 'key') => {
      if (blockFlip(gesture)) return; // never flip during (or from) a pen stroke, or during a text selection (§24)
      const cur = locRef.current.pageIndex;
      const next = layout === 'continuous' ? cur + dir : stepSpread(cur, dir, layout, pages.length);
      if (next !== cur && next >= 0 && next < pages.length) goToPage(next, 0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, pages.length, goToPage],
  );

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
    }),
    [sourceId, versionId],
  );
  const pushHere = useCallback(() => {
    const p = position();
    const page = pages[p.pageIndex];
    setBackStack((s) => pushBack(s, { position: p, label: `${page ? fullPageLabel(page) : ''} — ${detail.title}`, createdAt: Date.now() }));
  }, [position, pages, detail.title]);

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
        goToPage(idx, req.bbox ? Math.max(0, req.bbox.y - 0.05) : 0);
        return { ok: true };
      },
      goBack() {
        const { entry, stack } = popBack(backStack);
        if (!entry) return false;
        setBackStack(stack);
        setHighlight(null);
        const p = entry.position;
        if (p.sourceId !== sourceId || p.versionId !== versionId) {
          navigate(studyUrl({ sourceId: p.sourceId, versionId: p.versionId, pageIndex: p.pageIndex, offset: p.pageOffset }));
          return true;
        }
        setFit(p.fit);
        if (p.fit !== 'width') setZoom(clampZoom(p.zoom));
        setViewRotation(normalizeRotation(p.rotation));
        setLayoutPref(p.layout);
        // after the layout settles at the restored zoom
        requestAnimationFrame(() => goToPage(p.pageIndex, p.pageOffset));
        setAnnouncement(`عدت إلى ${entry.label}.`);
        return true;
      },
      canGoBack: !!top,
      backLabel: top?.label ?? null,
      clearHighlight: () => setHighlight(null),
    };
  }, [backStack, sourceId, versionId, detail.versions, pages, navigate, pushHere, goToPage, panels.phone]);

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
      // composite widgets handle their own arrows
      const inWidget = !!target?.closest('[role="toolbar"],[role="tablist"],[role="radiogroup"],[role="menu"],[role="separator"],[role="dialog"],.wk-rail,.wk-left,.wk-search');
      const onCanvas = !!target?.closest('.wk-canvas');
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
          if (!blockFlip()) goToPage(key === 'Home' ? 0 : pages.length - 1, 0);
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
  }, [selection, searchOpen, highlight, focusMode, layout, step, goToPage, toggleLeft, toggleRail, toggleFocus, pages.length]);

  // ── page context ──
  const tool = ink.toolState.tool;
  const writing = inkAvailable && ink.isWritingTool;
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
    }),
    [sourceId, versionId, doc.mode, doc.pdf, writing, inkAvailable, onStrokeActiveChange, highlight, searchOpen, results, currentResult, registerTextRoot, anchorFor, reportPageSize, detail.language],
  );

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
              view={splitActive ? 'split' : 'original'}
              onView={(v) => {
                if (v === 'original') setSplit(null);
                else if (!split) setSplitPicker(true);
              }}
              splitReason={splitReason}
              studyBookReason={STUDY_BOOK_REASON}
              searchOpen={searchOpen}
              onToggleSearch={() => {
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
              inkAvailable={inkAvailable}
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
          {doc.mode === 'unsupported' && (
            <div className="wk-banner wk-banner--warning" role="alert">
              هذا النوع من المصادر لا يُعرض في القارئ بعد.
            </div>
          )}

          <div className={cx('wk-body', panels.rail === 'docked' && 'wk-body--rail', panels.left === 'docked' && 'wk-body--left', splitActive && 'wk-body--split')}>
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
                <BookCanvas
                  ref={canvasRef}
                  id="wk-book"
                  pages={pages}
                  fallbackSize={null}
                  measured={measured}
                  pageIndex={pageIndex}
                  initialFrac={initial.frac}
                  zoom={zoom}
                  fit={fit}
                  viewRotation={viewRotation}
                  layout={layout}
                  spreadRtl={detail.language === 'ar'}
                  flipAnimation={settings.page_flip_animation}
                  label={`صفحات ${detail.title}`}
                  onLocation={onLocation}
                  onEffectiveZoom={setEffectiveZoom}
                  onZoomGesture={(z) => {
                    setFit(null);
                    setZoom(clampZoom(z));
                  }}
                  onViewed={markViewed}
                  onSwipe={(dir) => step(dir, 'swipe')}
                  strokeActive={() => strokeActive.current}
                  className={cx(writing && 'wk-canvas--writing')}
                />
                {splitActive && split && (
                  <SecondaryPane sourceId={split.sourceId} initialPage={split.pageIndex} onPage={(i) => setSplit((s) => (s && s.pageIndex !== i ? { ...s, pageIndex: i } : s))} onClose={() => setSplit(null)} />
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

          {selection && !focusMode && (
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
        </div>
      </ReaderPageContext.Provider>
    </SourceNavigationContext.Provider>
  );
}
