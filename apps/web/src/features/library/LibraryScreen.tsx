// المكتبة (§05, §23): notebooks as covers on a shelf, title search, tag filter, and the favorites /
// recent / archive / trash views. Read-only (from this device's cache) when the server is unreachable.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutTemplate, Library, NotebookPen, Plus, Tags, Upload } from 'lucide-react';
import {
  SORT_MODE_LABELS_AR,
  SORT_MODES,
  type FavoritesResponse,
  type LibraryNodeView,
  type RecentResponse,
  type SortMode,
  type TagView,
} from '@medlevo/shared';
import { Button, buttonClass, EmptyState, ErrorState, LoadingState, Menu, MenuItem, Select, Tab, TabList, TabPanel, Tabs, TextField, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { mutate, useQuery } from './data';
import { OfflineNotice, useMoveByDrag } from './shared';
import { NodeDialog } from './components/NodeDialog';
import { FolderRow, SourceRow } from './components/Rows';
import { NewNotebookTile, ShelfItem } from './components/Shelf';
import { TemplatesDialog } from './components/TemplatesDialog';
import { childrenOf, filterByTags, type LibraryIndex, searchLibrary } from './model';
import { TrashView } from './TrashView';
import { readRootSort, useLibrary, writeRootSort } from './useLibrary';
import { TopicFilterSelect, TopicFilterView } from '../brain/TopicFilter';
import './library.css';

const VIEWS = [
  { value: 'shelf', label: 'الرف' },
  { value: 'favorites', label: 'المفضلة' },
  { value: 'recent', label: 'الأخيرة' },
  { value: 'archive', label: 'الأرشيف' },
  { value: 'trash', label: 'السلة' },
] as const;
type View = (typeof VIEWS)[number]['value'];

function TagBar({ tags, selected, onToggle }: { tags: TagView[]; selected: string[]; onToggle: (id: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="ml-tagbar" role="group" aria-label="تصفية حسب الوسم">
      {tags.map((t) => (
        <button key={t.id} type="button" className="ml-tag" aria-pressed={selected.includes(t.id)} onClick={() => onToggle(t.id)} data-color={t.color ?? undefined}>
          <span className="ml-tag__dot" aria-hidden="true" />
          <bdi>{t.name}</bdi>
        </button>
      ))}
    </div>
  );
}

export function LibraryScreen() {
  usePageTitle('المكتبة');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = (VIEWS.some((v) => v.value === params.get('view')) ? params.get('view') : 'shelf') as View;
  const lib = useLibrary();
  const [query, setQuery] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [rootSort, setRootSort] = useState<SortMode>(readRootSort);
  const [dialog, setDialog] = useState<null | 'notebook' | 'template'>(null);
  const dnd = useMoveByDrag(lib.index);
  const readOnly = lib.fromCache;

  const allTags = useMemo(() => {
    const map = new Map<string, TagView>();
    for (const n of lib.data?.nodes ?? []) for (const t of n.tags) map.set(t.id, t);
    for (const s of lib.data?.sources ?? []) for (const t of s.tags) map.set(t.id, t);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [lib.data]);

  const setView = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'shelf') next.delete('view');
    else next.set('view', v);
    setParams(next, { replace: true });
  };
  const toggleTag = (id: string) => setTagIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  // §05: a topic is also a library filter (?topic=<id>) — track F2
  const topicFilter = params.get('topic');
  const setTopicFilter = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('topic', id);
    else next.delete('topic');
    setParams(next, { replace: true });
  };

  return (
    <div className="ml-page ml-library">
      <header className="ml-library__header">
        <h1 className="ml-page__title">المكتبة</h1>
        <div className="ml-library__actions">
          <Link to="/library/topics" className={buttonClass({ variant: 'secondary' })}>
            <Tags size={18} aria-hidden="true" />
            الموضوعات
          </Link>
          <Menu trigger={<Button icon={<Plus size={18} />} disabled={readOnly}>جديد</Button>} label="إنشاء">
            <MenuItem icon={<NotebookPen size={16} />} onSelect={() => setDialog('notebook')}>
              دفتر جديد
            </MenuItem>
            <MenuItem icon={<LayoutTemplate size={16} />} onSelect={() => setDialog('template')}>
              مادة من قالب دراسة…
            </MenuItem>
          </Menu>
          {readOnly ? (
            <Button variant="primary" icon={<Upload size={18} />} disabled>
              رفع ملفات
            </Button>
          ) : (
            <Link to="/upload" className={buttonClass({ variant: 'primary' })}>
              <Upload size={18} aria-hidden="true" />
              رفع ملفات
            </Link>
          )}
        </div>
      </header>

      {lib.fromCache && <OfflineNotice cachedAt={lib.cachedAt} />}

      {topicFilter && <TopicFilterView topicId={topicFilter} onClear={() => setTopicFilter(null)} />}
      {!topicFilter && (
      <Tabs value={view} onValueChange={setView}>
        <div className="ml-library__tools">
          <div className="ml-library__views">
            <TabList label="عرض المكتبة">
              {VIEWS.map((v) => (
                <Tab key={v.value} value={v.value}>
                  {v.label}
                </Tab>
              ))}
            </TabList>
          </div>
          <TextField
            label="ابحث في العناوين"
            hideLabel
            type="search"
            placeholder="ابحث في عناوين الدفاتر والمصادر"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            fieldClassName="ml-library__search"
            dir="auto"
          />
          <TopicFilterSelect value={topicFilter} onChange={setTopicFilter} />
        </div>
        {(view === 'shelf' || query) && allTags.length > 0 && (
          <div style={{ marginBottom: 'var(--ml-space-5)' }}>
            <TagBar tags={allTags} selected={tagIds} onToggle={toggleTag} />
          </div>
        )}

        {lib.loading && !lib.data && <LoadingState stage="جارٍ تحميل المكتبة…" />}
        {lib.error && !lib.data && <ErrorState message={lib.error.message} onRetry={() => void lib.refresh()} />}

        {lib.index &&
          VIEWS.map((v) => (
            <TabPanel key={v.value} value={v.value}>
              {view === v.value &&
                (query.trim() ? (
                  <SearchResults index={lib.index!} query={query} tagIds={tagIds} readOnly={readOnly} />
                ) : v.value === 'shelf' ? (
                  <ShelfView
                    index={lib.index!}
                    sort={rootSort}
                    tagIds={tagIds}
                    dnd={dnd}
                    readOnly={readOnly}
                    onNew={() => setDialog('notebook')}
                    onTemplate={() => setDialog('template')}
                    onSort={(s) => {
                      setRootSort(s);
                      writeRootSort(s);
                    }}
                  />
                ) : v.value === 'favorites' ? (
                  <FavoritesView index={lib.index!} readOnly={readOnly} />
                ) : v.value === 'recent' ? (
                  <RecentView index={lib.index!} readOnly={readOnly} />
                ) : v.value === 'archive' ? (
                  <ArchiveView readOnly={readOnly} />
                ) : (
                  <TrashView readOnly={readOnly} />
                ))}
            </TabPanel>
          ))}
      </Tabs>
      )}
      {dnd.ghost}

      <NodeDialog open={dialog === 'notebook'} mode={{ type: 'create', parentId: null, kind: 'notebook' }} onClose={() => setDialog(null)} onSaved={(n) => navigate(`/library/${n.id}`)} />
      <TemplatesDialog open={dialog === 'template'} parentId={null} onClose={() => setDialog(null)} onCreated={(n) => navigate(`/library/${n.id}`)} />
    </div>
  );
}

function ShelfView({
  index,
  sort,
  tagIds,
  dnd,
  readOnly,
  onNew,
  onTemplate,
  onSort,
}: {
  index: LibraryIndex;
  sort: SortMode;
  tagIds: string[];
  dnd: ReturnType<typeof useMoveByDrag>;
  readOnly: boolean;
  onNew: () => void;
  onTemplate: () => void;
  onSort: (s: SortMode) => void;
}) {
  const roots = filterByTags(childrenOf(index, null, sort), tagIds);
  if (index.nodes.size === 0) {
    return (
      <EmptyState
        icon={<Library size={28} />}
        title="مكتبتك فارغة"
        description="ابدأ بدفتر لمادة أو كورس، ثم ارفع محاضراتك ومراجعك ومصادر أسئلتك داخله. يمكنك أيضًا البدء من قالب دراسة جاهز وتعديله كما تريد."
        actions={
          <>
            <Button variant="primary" icon={<NotebookPen size={18} />} onClick={onNew} disabled={readOnly}>
              دفتر جديد
            </Button>
            <Button icon={<LayoutTemplate size={18} />} onClick={onTemplate} disabled={readOnly}>
              ابدأ من قالب
            </Button>
          </>
        }
      />
    );
  }
  return (
    <section className="ml-library__section" aria-labelledby="shelf-title">
      <div className="ml-library__section-head">
        <h2 id="shelf-title" className="ml-library__section-title">
          دفاتري
        </h2>
        <Select<SortMode> label="الترتيب" hideLabel options={SORT_MODES.map((m) => ({ value: m, label: SORT_MODE_LABELS_AR[m] }))} value={sort} onValueChange={onSort} />
      </div>
      {roots.length === 0 ? (
        <p className="ml-library__section-note">لا توجد دفاتر تحمل الوسوم المختارة.</p>
      ) : (
        <ul className="ml-shelf" role="list">
          {roots.map((n) => (
            <ShelfItem key={n.id} node={n} index={index} dnd={dnd} readOnly={readOnly} />
          ))}
          {!readOnly && tagIds.length === 0 && <NewNotebookTile onClick={onNew} />}
        </ul>
      )}
    </section>
  );
}

function SearchResults({ index, query, tagIds, readOnly }: { index: LibraryIndex; query: string; tagIds: string[]; readOnly: boolean }) {
  const hits = searchLibrary(index, query).filter((h) => (h.node ? filterByTags([h.node], tagIds).length : filterByTags([h.source!], tagIds).length));
  if (hits.length === 0) {
    return <EmptyState title="لا نتائج" description={<>لا يوجد عنوان دفتر أو مصدر يطابق «<bdi>{query}</bdi>». يبحث هذا الحقل في العناوين فقط؛ للبحث في نصوص المصادر استخدم البحث العام.</>} headingLevel={2} />;
  }
  return (
    <section aria-label="نتائج البحث في العناوين">
      <ul className="ml-list" role="list">
        {hits.map((h) =>
          h.kind === 'node' ? (
            <FolderRow key={h.id} node={h.node!} index={index} readOnly={readOnly} />
          ) : (
            <SourceRow key={h.id} source={h.source!} index={index} readOnly={readOnly} meta={<bdi>{h.path.map((p) => p.title).join(' / ') || '—'}</bdi>} />
          ),
        )}
      </ul>
    </section>
  );
}

function FavoritesView({ index, readOnly }: { index: LibraryIndex; readOnly: boolean }) {
  const q = useQuery<FavoritesResponse>('/library/favorites', { cache: true });
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل المفضلة…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  const data = q.data!;
  if (data.nodes.length + data.sources.length === 0) {
    return <EmptyState title="لا شيء في المفضلة" description="من قائمة أي دفتر أو مصدر اختر «إضافة إلى المفضلة» ليظهر هنا." headingLevel={2} />;
  }
  return (
    <div className="ml-stack">
      {data.nodes.length > 0 && (
        <ul className="ml-list" role="list" aria-label="دفاتر ومجلدات مفضلة">
          {data.nodes.map((n) => (index.nodes.get(n.id) ? <FolderRow key={n.id} node={index.nodes.get(n.id)!} index={index} readOnly={readOnly} /> : null))}
        </ul>
      )}
      {data.sources.length > 0 && (
        <ul className="ml-list" role="list" aria-label="مصادر مفضلة">
          {data.sources.map((s) => (
            <SourceRow key={s.id} source={s} index={index} readOnly={readOnly} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RecentView({ index, readOnly }: { index: LibraryIndex; readOnly: boolean }) {
  const q = useQuery<RecentResponse>('/library/recent?limit=30', { cache: true });
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل آخر ما فتحته…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  if (q.data!.sources.length === 0) {
    return <EmptyState title="لم تفتح أي مصدر بعد" description="المصادر التي تفتحها للدراسة تظهر هنا مرتبة من الأحدث." headingLevel={2} />;
  }
  return (
    <ul className="ml-list" role="list">
      {q.data!.sources.map((s) => (
        <SourceRow key={s.id} source={s} index={index} readOnly={readOnly} meta={s.last_opened_at ? `فُتح ${formatRelative(s.last_opened_at)}` : undefined} />
      ))}
    </ul>
  );
}

function ArchiveView({ readOnly }: { readOnly: boolean }) {
  const lib = useLibrary('archived');
  const toast = useToast();
  if (lib.loading && !lib.data) return <LoadingState stage="جارٍ تحميل الأرشيف…" />;
  if (lib.error && !lib.data) return <ErrorState message={lib.error.message} onRetry={() => void lib.refresh()} />;
  const nodes = (lib.data?.nodes ?? []).filter((n) => n.archived_at !== null);
  const sources = (lib.data?.sources ?? []).filter((s) => s.archived_at !== null);
  if (nodes.length + sources.length === 0) {
    return <EmptyState title="الأرشيف فارغ" description="أرشف ما أنهيت دراسته ليختفي من الرف دون حذفه. تبقى كتابتك وأسئلتك كما هي." headingLevel={2} />;
  }
  const unarchive = (n: LibraryNodeView) =>
    void mutate(() => api.post(`/library/nodes/${n.id}/unarchive`))
      .then(() => toast.show({ title: `أُخرج «${n.title}» من الأرشيف`, tone: 'success' }))
      .catch((e) => toast.show({ title: errorMessage(e), tone: 'danger' }));
  return (
    <div className="ml-stack">
      {nodes.length > 0 && (
        <ul className="ml-list" role="list" aria-label="دفاتر ومجلدات مؤرشفة">
          {nodes.map((n) => (
            <li key={n.id} className="ml-row">
              <Link to={`/library/${n.id}`} className="ml-row__main">
                <span className="ml-row__text">
                  <span className="ml-row__title"><bdi>{n.title}</bdi></span>
                  <span className="ml-row__sub">أُرشف {formatRelative(n.archived_at!)}</span>
                </span>
              </Link>
              <span className="ml-row__aside">
                <Button size="sm" onClick={() => unarchive(n)} disabled={readOnly}>
                  إخراج من الأرشيف
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && lib.index && (
        <ul className="ml-list" role="list" aria-label="مصادر مؤرشفة">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} index={lib.index!} readOnly={readOnly} />
          ))}
        </ul>
      )}
    </div>
  );
}
