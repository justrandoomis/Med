// Universal Search (§46): one field, exact / keyword modes (semantic disabled with the server's reason),
// filters by result type, source type and subject/course, results grouped by type with origin badges
// («من المصدر» / «ملاحظتي» / «مقروء آليًا» / «مولَّد — ليس دليلًا») and page identity; each opens its exact place.
// Offline: the owner's notes on this device are searched locally and the screen says that full search needs
// the server.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CloudOff, FileInput, FileText, NotebookPen, ScanText, Search as SearchIcon, Sparkles } from 'lucide-react';
import {
  SEARCH_ORIGIN_LABELS_AR,
  SEARCH_RESULT_TYPE_LABELS_AR,
  SEARCH_RESULT_TYPES,
  SOURCE_TYPE_LABELS_AR,
  SOURCE_TYPES,
  type LibraryTreeResponse,
  type SearchMode,
  type SearchOrigin,
  type SearchResponse,
  type SearchResult,
  type SearchResultType,
  type SourceType,
} from '@medlevo/shared';
import { Button, Checkbox, EmptyState, ErrorState, LoadingState, SegmentedControl, Select, StatusPill, TextField, type StatusTone } from '../../design';
import { api, errorMessage, isApiError } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { useOnline } from '../../lib/useOnline';
import { usePageTitle } from '../../lib/usePageTitle';
import { isSearchShortcut } from '../../app/shortcuts';
import { BidiLines, BidiText } from '../evidence/BidiText';
import { studyUrl } from '../workspace/nav/SourceNavigation';
import { searchNotesLocally } from './localSearch';
import './search.css';

const ORIGIN_TONE: Record<SearchOrigin, StatusTone> = { source: 'neutral', owner_note: 'accent', owner_typed: 'accent', imported: 'neutral', recognized: 'info', generated: 'warning' };
const ORIGIN_ICON: Record<SearchOrigin, ReactNode> = {
  source: <FileText size={14} />,
  owner_note: <NotebookPen size={14} />,
  owner_typed: <NotebookPen size={14} />,
  imported: <FileInput size={14} />,
  recognized: <ScanText size={14} />,
  generated: <Sparkles size={14} />,
};
const GROUP_TITLES: Record<SearchResultType, string> = {
  chunks: 'من المصادر',
  questions: 'الأسئلة',
  transcripts: 'التفريغ الصوتي',
  notes: 'ملاحظاتي',
  generated: 'محتوى مولَّد — ليس دليلًا',
};

type Mode = Exclude<SearchMode, 'semantic'>;

interface Params {
  q: string;
  mode: Mode;
  types: SearchResultType[];
  sourceType: SourceType | '';
  node: string;
}

function readParams(sp: URLSearchParams): Params {
  const types = (sp.get('types') ?? '').split(',').filter((t): t is SearchResultType => (SEARCH_RESULT_TYPES as readonly string[]).includes(t));
  const st = sp.get('source_type') ?? '';
  return {
    q: sp.get('q') ?? '',
    mode: sp.get('mode') === 'exact' ? 'exact' : 'keyword',
    types,
    sourceType: (SOURCE_TYPES as readonly string[]).includes(st) ? (st as SourceType) : '',
    node: sp.get('node') ?? '',
  };
}

/** «نتيجة واحدة», «نتيجتان», «3 نتائج», «11 نتيجة». */
export function resultsAr(n: number): string {
  if (n === 1) return 'نتيجة واحدة';
  if (n === 2) return 'نتيجتان';
  if (n >= 3 && n <= 10) return `${n} نتائج`;
  return `${n} نتيجة`;
}

/** Where a result opens: the reader at the exact version/page/region (or the source when that is all we know). */
export function resultHref(r: SearchResult): string | null {
  const l = r.location;
  if (!l?.source_id) return null;
  return studyUrl({ sourceId: l.source_id, versionId: l.version_id, pageIndex: l.page_index, pageId: l.page_id, regionId: l.region_id });
}

export function ResultItem({ r }: { r: SearchResult }) {
  const href = resultHref(r);
  const title = <BidiText as="span" text={r.title} />;
  return (
    <li className="sr-item" data-origin={r.origin}>
      <div className="sr-item__head">
        {href ? (
          <Link to={href} className="sr-item__title">
            {title}
          </Link>
        ) : (
          <span className="sr-item__title sr-item__title--static">{title}</span>
        )}
      </div>
      <div className="sr-item__meta">
        <StatusPill tone={ORIGIN_TONE[r.origin]} icon={ORIGIN_ICON[r.origin]}>
          {SEARCH_ORIGIN_LABELS_AR[r.origin]}
        </StatusPill>
        {r.location?.page_label_ar && <span className="sr-item__page">{r.location.page_label_ar}</span>}
        {r.source_title && r.type !== 'chunks' && <BidiText as="span" className="sr-item__source" text={r.source_title} />}
        {!href && r.type === 'notes' && <span className="sr-item__page">ملاحظة غير مرتبطة بصفحة</span>}
      </div>
      <BidiLines className="sr-item__snippet" text={r.snippet.text} highlights={r.snippet.highlights} />
    </li>
  );
}

export function groupResults(results: SearchResult[]): Array<{ type: SearchResultType; items: SearchResult[] }> {
  const groups: Array<{ type: SearchResultType; items: SearchResult[] }> = [];
  for (const r of results) {
    // generated items always form their own last group, whatever their type
    const type: SearchResultType = r.origin === 'generated' ? 'generated' : r.type;
    let g = groups.find((x) => x.type === type);
    if (!g) {
      g = { type, items: [] };
      groups.push(g);
    }
    g.items.push(r);
  }
  return groups.sort((a, b) => Number(a.type === 'generated') - Number(b.type === 'generated'));
}

function useNodeOptions(online: boolean) {
  const [nodes, setNodes] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    if (!online) return;
    let alive = true;
    api
      .get<LibraryTreeResponse>('/library/tree', { timeoutMs: 20_000, skipAuthRedirect: true })
      .then((t) => {
        if (!alive) return;
        const byId = new Map(t.nodes.map((n) => [n.id, n]));
        setNodes(
          t.nodes
            .filter((n) => (n.kind === 'subject' || n.kind === 'course') && !n.deleted_at)
            .map((n) => {
              const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
              return { value: n.id, label: n.kind === 'course' && parent ? `${parent.title} › ${n.title}` : n.title };
            })
            .sort((a, b) => a.label.localeCompare(b.label, 'ar')),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [online]);
  return nodes;
}

export function SearchScreen() {
  usePageTitle('البحث');
  const [sp, setSp] = useSearchParams();
  const params = readParams(sp);
  const [text, setText] = useState(params.q);
  const online = useOnline();
  const caps = useCapabilities();
  const semantic = caps.feature('search.semantic');
  const nodes = useNodeOptions(online);
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; data: SearchResponse | null; local: SearchResult[] | null }>({
    loading: false,
    error: null,
    data: null,
    local: null,
  });
  const [more, setMore] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  // «أعد المحاولة» re-runs the same search (the URL does not change, so it needs its own trigger)
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  const update = useCallback(
    (patch: Partial<Params>) => {
      const next = { ...readParams(sp), ...patch };
      const out = new URLSearchParams();
      if (next.q) out.set('q', next.q);
      if (next.mode !== 'keyword') out.set('mode', next.mode);
      if (next.types.length) out.set('types', next.types.join(','));
      if (next.sourceType) out.set('source_type', next.sourceType);
      if (next.node) out.set('node', next.node);
      setSp(out, { replace: true });
    },
    [sp, setSp],
  );

  // typing → URL (debounced); the URL drives the search
  useEffect(() => {
    if (text === params.q) return;
    const t = setTimeout(() => update({ q: text.trim() ? text : '' }), 300);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // "/" focuses the field; focus it when the screen opens (after the shell moved focus to the heading)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSearchShortcut(e) && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  const key = sp.toString();
  useEffect(() => {
    const p = readParams(sp);
    const mine = ++seq.current;
    if (!p.q.trim()) {
      setState({ loading: false, error: null, data: null, local: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const runLocal = async (why: string | null) => {
      try {
        const notes = await getDb().notes.toArray();
        if (mine !== seq.current) return;
        setState({ loading: false, error: why, data: null, local: searchNotesLocally(notes, p.q, 50, p.mode) });
      } catch {
        if (mine === seq.current) setState({ loading: false, error: why ?? 'تعذّر البحث في ملاحظات هذا الجهاز.', data: null, local: [] });
      }
    };
    if (!online) {
      void runLocal(null);
      return;
    }
    api
      .get<SearchResponse>('/search', {
        query: { q: p.q, mode: p.mode, types: p.types.length ? p.types.join(',') : undefined, source_type: p.sourceType || undefined, node_id: p.node || undefined, limit: 20 },
        timeoutMs: 20_000,
      })
      .then((data) => mine === seq.current && setState({ loading: false, error: null, data, local: null }))
      .catch((e) => {
        if (mine !== seq.current) return;
        if (isApiError(e) && e.offline) void runLocal(null);
        else setState({ loading: false, error: errorMessage(e), data: null, local: null });
      });
  }, [key, online, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    const data = state.data;
    if (!data?.next_cursor) return;
    setMore({ loading: true, error: null });
    try {
      const next = await api.get<SearchResponse>('/search', {
        query: {
          q: params.q,
          mode: params.mode,
          types: params.types.length ? params.types.join(',') : undefined,
          source_type: params.sourceType || undefined,
          node_id: params.node || undefined,
          limit: 20,
          cursor: data.next_cursor,
        },
        timeoutMs: 20_000,
      });
      setState((s) => (s.data ? { ...s, data: { ...next, results: [...s.data.results, ...next.results] } } : s));
      setMore({ loading: false, error: null });
    } catch (e) {
      setMore({ loading: false, error: errorMessage(e) });
    }
  };

  const results = state.data?.results ?? state.local ?? [];
  const groups = useMemo(() => groupResults(results), [results]);
  const offlineMode = !online || state.local !== null;
  const typeOptions = SEARCH_RESULT_TYPES;
  const toggleType = (t: SearchResultType, on: boolean) => {
    const cur = params.types.length ? params.types : [...typeOptions];
    const next = on ? [...new Set([...cur, t])] : cur.filter((x) => x !== t);
    update({ types: next.length === typeOptions.length ? [] : next });
  };

  return (
    <div className="ml-page sr-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">البحث</h1>
      </header>
      <form
        role="search"
        className="sr-form"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: text });
        }}
      >
        <TextField
          ref={inputRef}
          type="search"
          label="ابحث في مكتبتك"
          hint="المحاضرات والمراجع والأسئلة وملاحظاتك. اضغط / للعودة إلى هذا الحقل."
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          enterKeyHint="search"
          dir="auto"
        />
        <div className="sr-controls">
          <SegmentedControl<SearchMode>
            label="طريقة البحث"
            showLabel
            size="sm"
            value={params.mode}
            onValueChange={(m) => m !== 'semantic' && update({ mode: m })}
            options={[
              { value: 'keyword', label: 'كلمات' },
              { value: 'exact', label: 'مطابقة حرفية' },
              { value: 'semantic', label: 'دلالي', disabled: !semantic.available },
            ]}
          />
          {!semantic.available && <p className="sr-hint">{semantic.reason ?? 'البحث الدلالي غير متاح في هذا الإصدار.'}</p>}
        </div>
        <details className="sr-filters" open={params.types.length > 0 || !!params.sourceType || !!params.node}>
          <summary>تصفية النتائج</summary>
          <div className="sr-filters__body">
            <fieldset className="sr-types">
              <legend>أنواع النتائج</legend>
              {typeOptions.map((t) => (
                <Checkbox key={t} checked={params.types.length === 0 || params.types.includes(t)} onCheckedChange={(on) => toggleType(t, on)} label={SEARCH_RESULT_TYPE_LABELS_AR[t]} />
              ))}
            </fieldset>
            <Select<string>
              label="نوع المصدر"
              value={params.sourceType}
              onValueChange={(v) => update({ sourceType: v as SourceType | '' })}
              options={[{ value: '', label: 'كل الأنواع' }, ...SOURCE_TYPES.map((t) => ({ value: t, label: SOURCE_TYPE_LABELS_AR[t] }))]}
            />
            <Select<string>
              label="المادة أو الكورس"
              value={params.node}
              onValueChange={(v) => update({ node: v })}
              options={[{ value: '', label: 'كل المكتبة' }, ...nodes]}
              disabled={!online}
            />
          </div>
        </details>
      </form>

      <section className="sr-results" aria-labelledby="sr-results-title" aria-busy={state.loading}>
        <h2 id="sr-results-title" className="ml-visually-hidden">
          النتائج
        </h2>
        {offlineMode && (
          <p className="sr-offline" role="status">
            <CloudOff size={16} aria-hidden="true" />
            <span>أنت غير متصل: يُبحث في ملاحظاتك المحفوظة على هذا الجهاز فقط. البحث في المصادر والأسئلة يحتاج الاتصال بالخادم.</span>
          </p>
        )}
        <p className="sr-status" role="status" aria-live="polite">
          {!params.q.trim()
            ? ''
            : state.loading
              ? 'جارٍ البحث…'
              : state.error
                ? ''
                : results.length === 0
                  ? `لا نتائج لـ «${params.q}».`
                  : `${resultsAr(results.length)}${state.data?.next_cursor ? '، وهناك المزيد' : ''}`}
        </p>
        {state.data?.expansions.map((x) => (
          <p key={x.from} className="sr-hint">
            {'وُسّع البحث بقاموس مصطلحاتك: '}
            <bdi dir="ltr" lang="en">{`${x.from} → ${x.to.join(' / ')}`}</bdi>
          </p>
        ))}
        {state.data?.notices_ar.map((n) => (
          <p key={n} className="sr-hint">
            {n}
          </p>
        ))}
        {state.data?.exact_rejected ? <p className="sr-hint">{`استُبعدت ${state.data.exact_rejected} نتيجة لم تطابق العبارة حرفيًا.`}</p> : null}

        {!params.q.trim() ? (
          <EmptyState icon={<SearchIcon size={24} />} title="ابحث في كل ما في مكتبتك" description="اكتب كلمة أو مصطلحًا. الحروف العربية تُطابَق دون التشكيل وصور الهمزة، والمطابقة الحرفية تبحث عن العبارة كما كُتبت." />
        ) : state.loading && results.length === 0 ? (
          <LoadingState stage="جارٍ البحث…" />
        ) : state.error ? (
          <ErrorState message={state.error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          groups.map((g) => (
            <section key={g.type} className={`sr-group sr-group--${g.type}`} aria-labelledby={`sr-g-${g.type}`}>
              <h3 id={`sr-g-${g.type}`} className="sr-group__title">
                {`${GROUP_TITLES[g.type]} (${g.items.length})`}
              </h3>
              <ul className="sr-list">
                {g.items.map((r) => (
                  <ResultItem key={`${r.type}:${r.id}`} r={r} />
                ))}
              </ul>
            </section>
          ))
        )}
        {state.data?.next_cursor && (
          <div className="sr-more">
            <Button variant="secondary" onClick={loadMore} loading={more.loading}>
              نتائج أخرى
            </Button>
            {more.error && <p className="sr-hint sr-hint--danger" role="alert">{more.error}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
