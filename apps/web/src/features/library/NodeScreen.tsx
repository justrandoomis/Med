// A notebook / folder / course screen (§05, §23). Courses group their sources into lectures,
// references and question sources, and show how they are linked to each other.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, FolderPlus, LayoutTemplate, Library, Plus, Upload } from 'lucide-react';
import {
  LIBRARY_NODE_KIND_LABELS_AR,
  SORT_MODE_LABELS_AR,
  SORT_MODES,
  SOURCE_LINK_LABELS_AR,
  type LibraryNodeKind,
  type LibraryNodeView,
  type NodeLinksResponse,
  type SortMode,
  type SourceSummary,
} from '@medlevo/shared';
import { Breadcrumbs, Button, buttonClass, EmptyState, ErrorState, LoadingState, Menu, MenuItem, Select, StatusPill, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { mutate, useQuery } from './data';
import { Cover, coverOf } from './components/Cover';
import { NodeMenu } from './components/ItemMenus';
import { NodeDialog } from './components/NodeDialog';
import { FolderRow, SourceRow } from './components/Rows';
import { TemplatesDialog } from './components/TemplatesDialog';
import { countAr, NOUN } from './labels';
import { childrenOf, groupForCourse, type LibraryIndex, pathOf, sourcesIn, sourcesInSubtree, subtreeCounts } from './model';
import { OfflineNotice, useMoveByDrag } from './shared';
import { useLibrary } from './useLibrary';
import './library.css';

export function NodeScreen() {
  const { nodeId = '' } = useParams();
  const lib = useLibrary('archived');
  const node = lib.index?.nodes.get(nodeId);
  usePageTitle(node?.title ?? 'المكتبة');
  const dnd = useMoveByDrag(lib.index);

  if (lib.loading && !lib.data) return <LoadingState stage="جارٍ تحميل المجلد…" />;
  if (lib.error && !lib.data) {
    return (
      <div className="ml-page">
        <ErrorState message={lib.error.message} onRetry={() => void lib.refresh()} />
      </div>
    );
  }
  if (!lib.index || !node) {
    return (
      <div className="ml-page">
        <h1 className="ml-visually-hidden">عنصر غير موجود</h1>
        <EmptyState
          icon={<Library size={28} />}
          title="هذا العنصر غير موجود في مكتبتك"
          description="ربما نُقل إلى سلة المحذوفات أو حُذف نهائيًا."
          actions={
            <Link to="/library" className={buttonClass({ variant: 'primary' })}>
              العودة إلى المكتبة
            </Link>
          }
        />
      </div>
    );
  }
  return <NodeView key={node.id} node={node} index={lib.index} readOnly={lib.fromCache} cachedAt={lib.cachedAt} dnd={dnd} />;
}

function NodeView({ node, index, readOnly, cachedAt, dnd }: { node: LibraryNodeView; index: LibraryIndex; readOnly: boolean; cachedAt: number | null; dnd: ReturnType<typeof useMoveByDrag> }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | { kind: LibraryNodeKind } | 'template'>(null);
  const path = pathOf(index, node.id);
  const archivedHere = path.some((p) => p.archived_at !== null);
  const children = childrenOf(index, node.id, node.sort_mode).filter((c) => archivedHere || c.archived_at === null);
  const sources = sourcesIn(index, node.id, node.sort_mode).filter((s) => archivedHere || s.archived_at === null);
  const counts = subtreeCounts(index, node.id);
  const isCourse = node.kind === 'course';

  const setSort = (sort_mode: SortMode) =>
    void mutate(() => api.patch(`/library/nodes/${node.id}`, { sort_mode })).catch((e) => toast.show({ title: errorMessage(e), tone: 'danger' }));

  return (
    <div className="ml-page ml-library">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, ...path.map((p) => ({ label: <bdi>{p.title}</bdi>, to: `/library/${p.id}` }))]} />
      {readOnly && <OfflineNotice cachedAt={cachedAt} />}
      <header className="ml-node-head" {...(readOnly ? {} : dnd.dropProps(node.id))}>
        <Cover cover={coverOf(node)} title={node.title} size="mini" />
        <div className="ml-node-head__text">
          <h1 className="ml-node-head__title">
            <bdi>{node.title}</bdi>
          </h1>
          <p className="ml-node-head__sub">
            {LIBRARY_NODE_KIND_LABELS_AR[node.kind]}، {countAr(counts.sources, NOUN.source)}
            {counts.folders > 0 ? `، ${countAr(counts.folders, NOUN.folder)}` : ''}
          </p>
          {node.description && (
            <p className="ml-node-head__sub">
              <bdi>{node.description}</bdi>
            </p>
          )}
          {archivedHere && (
            <p className="ml-node-head__sub">
              <StatusPill tone="neutral" icon={<Archive size={14} />}>
                في الأرشيف
              </StatusPill>
            </p>
          )}
          <div className="ml-node-head__actions">
            {readOnly ? (
              <Button variant="primary" icon={<Upload size={18} />} disabled>
                رفع إلى هنا
              </Button>
            ) : (
              <Link to={`/upload?node=${node.id}`} className={buttonClass({ variant: 'primary' })}>
                <Upload size={18} aria-hidden="true" />
                رفع إلى هنا
              </Link>
            )}
            <Menu trigger={<Button icon={<Plus size={18} />} disabled={readOnly}>جديد</Button>} label="إنشاء داخل هذا العنصر">
              <MenuItem icon={<FolderPlus size={16} />} onSelect={() => setDialog({ kind: 'folder' })}>
                مجلد
              </MenuItem>
              <MenuItem icon={<FolderPlus size={16} />} onSelect={() => setDialog({ kind: 'course' })}>
                كورس
              </MenuItem>
              <MenuItem icon={<FolderPlus size={16} />} onSelect={() => setDialog({ kind: 'topic_folder' })}>
                موضوع
              </MenuItem>
              <MenuItem icon={<LayoutTemplate size={16} />} onSelect={() => setDialog('template')}>
                مادة من قالب دراسة…
              </MenuItem>
            </Menu>
            <Select<SortMode>
              label="ترتيب المحتوى"
              hideLabel
              options={SORT_MODES.map((m) => ({ value: m, label: SORT_MODE_LABELS_AR[m] }))}
              value={node.sort_mode}
              onValueChange={setSort}
              disabled={readOnly}
            />
            {!readOnly && <NodeMenu node={node} index={index} onNavigateAway={() => navigate(node.parent_id ? `/library/${node.parent_id}` : '/library')} />}
          </div>
        </div>
      </header>

      {isCourse && <CourseSources node={node} index={index} readOnly={readOnly} dnd={dnd} />}

      {children.length > 0 && (
        <section className="ml-library__section" aria-labelledby="folders-title">
          <div className="ml-library__section-head">
            <h2 id="folders-title" className="ml-library__section-title">
              المجلدات
            </h2>
          </div>
          <ul className="ml-list" role="list">
            {children.map((c) => (
              <FolderRow key={c.id} node={c} index={index} dnd={dnd} readOnly={readOnly} />
            ))}
          </ul>
        </section>
      )}

      {!isCourse && sources.length > 0 && (
        <section className="ml-library__section" aria-labelledby="sources-title">
          <div className="ml-library__section-head">
            <h2 id="sources-title" className="ml-library__section-title">
              المصادر
            </h2>
          </div>
          <ul className="ml-list" role="list">
            {sources.map((s) => (
              <SourceRow key={s.id} source={s} index={index} dnd={dnd} readOnly={readOnly} />
            ))}
          </ul>
        </section>
      )}

      {children.length === 0 && sources.length === 0 && !(isCourse && counts.sources > 0) && (
        <EmptyState
          title={isCourse ? 'هذا الكورس فارغ' : 'هذا المجلد فارغ'}
          description={
            isCourse
              ? 'ارفع محاضرات الكورس ومراجعه ومصادر أسئلته هنا. سيقترح النظام نوع كل ملف من اسمه، ويمكنك تصحيحه.'
              : 'ارفع ملفات إلى هنا أو أنشئ مجلدًا لتنظيمها.'
          }
          headingLevel={2}
        />
      )}
      {dnd.ghost}

      {dialog && dialog !== 'template' && (
        <NodeDialog open mode={{ type: 'create', parentId: node.id, kind: dialog.kind }} onClose={() => setDialog(null)} onSaved={(n) => navigate(`/library/${n.id}`)} />
      )}
      <TemplatesDialog open={dialog === 'template'} parentId={node.id} onClose={() => setDialog(null)} onCreated={(n) => navigate(`/library/${n.id}`)} />
    </div>
  );
}

function CourseSources({ node, index, readOnly, dnd }: { node: LibraryNodeView; index: LibraryIndex; readOnly: boolean; dnd: ReturnType<typeof useMoveByDrag> }) {
  const all = sourcesInSubtree(index, node.id).filter((s) => s.archived_at === null);
  const links = useQuery<NodeLinksResponse>(`/library/nodes/${node.id}/links`, { cache: true });
  const groups = groupForCourse(all);
  if (all.length === 0) return null;
  const titleOf = (id: string) => index.sources.get(id)?.title;
  const linksFor = (s: SourceSummary) => {
    const ls = links.data?.links ?? [];
    const incoming = ls.filter((l) => l.to_source_id === s.id && titleOf(l.from_source_id));
    const outgoing = ls.filter((l) => l.from_source_id === s.id && titleOf(l.to_source_id));
    if (incoming.length + outgoing.length === 0) return null;
    return (
      <span className="ml-row__links">
        {incoming.map((l) => (
          <span key={l.id}>
            {l.relation === 'reference_for' ? 'مرجعها: ' : l.relation === 'question_source_for' ? 'أسئلتها: ' : l.relation === 'audio_for' ? 'تسجيلها: ' : 'مرتبط: '}
            <bdi>{titleOf(l.from_source_id)}</bdi>
          </span>
        ))}
        {outgoing.map((l) => (
          <span key={l.id}>
            {SOURCE_LINK_LABELS_AR[l.relation]} <bdi>{titleOf(l.to_source_id)}</bdi>
          </span>
        ))}
      </span>
    );
  };
  const ungrouped = all.filter((s) => !groups.some((g) => g.sources.includes(s)));
  return (
    <>
      <p className="ml-course-note">مصادر الكورس مجمّعة حسب نوعها من كل مجلداته. الروابط بين المحاضرات والمراجع ومصادر الأسئلة تُضاف من صفحة المصدر.</p>
      {groups.map((g) => (
        <section key={g.key} className="ml-library__section" aria-labelledby={`course-${g.key}`}>
          <div className="ml-library__section-head">
            <h2 id={`course-${g.key}`} className="ml-library__section-title">
              {g.title}
            </h2>
            <span className="ml-library__section-note">{countAr(g.sources.length, NOUN.source)}</span>
          </div>
          <ul className="ml-list" role="list">
            {g.sources.map((s) => (
              <SourceRow key={s.id} source={s} index={index} dnd={dnd} readOnly={readOnly} extra={linksFor(s)} />
            ))}
          </ul>
        </section>
      ))}
      {ungrouped.length > 0 && (
        <section className="ml-library__section">
          <ul className="ml-list" role="list">
            {ungrouped.map((s) => (
              <SourceRow key={s.id} source={s} index={index} dnd={dnd} readOnly={readOnly} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
