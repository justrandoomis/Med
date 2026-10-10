// List rows for folders and sources (inset-grouped lists). The row's main area is ONE link; actions
// live in a separate menu button (no nested interactive elements). A pointer-only drag handle lets
// the owner drag items onto folders; the menu's «نقل…» is the keyboard path.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Folder, GripVertical, Star } from 'lucide-react';
import { LIBRARY_NODE_KIND_LABELS_AR, type LibraryNodeView, type SourceSummary } from '@medlevo/shared';
import { StatusPill } from '../../../design';
import type { useLibraryDnd } from '../dnd';
import { countAr, formatIcon, NOUN, ProcessingPill, SourceSubtitle } from '../labels';
import { type LibraryIndex, subtreeCounts } from '../model';
import { folderTone, libraryIcon } from './Cover';
import { NodeMenu, SourceMenu } from './ItemMenus';
import { OnDeviceBadge } from '../../offline/OnDevice';

type Dnd = ReturnType<typeof useLibraryDnd>;

export function FolderRow({ node, index, dnd, readOnly }: { node: LibraryNodeView; index: LibraryIndex; dnd?: Dnd; readOnly?: boolean }) {
  const counts = subtreeCounts(index, node.id);
  const parts = [LIBRARY_NODE_KIND_LABELS_AR[node.kind], countAr(counts.sources, NOUN.source)];
  if (counts.folders > 0) parts.push(countAr(counts.folders, NOUN.folder));
  return (
    <li className="ml-row" {...(dnd && !readOnly ? dnd.dropProps(node.id) : {})}>
      {dnd && !readOnly && (
        <span className="ml-drag-handle" {...dnd.handleProps({ kind: 'node', id: node.id, title: node.title })}>
          <GripVertical size={16} />
        </span>
      )}
      <Link to={`/library/${node.id}`} className="ml-row__main">
        <span className="ml-row__icon" data-color={folderTone(node)} aria-hidden="true">
          {libraryIcon(node.cover?.symbol ?? node.icon, 18) ?? <Folder size={18} />}
        </span>
        <span className="ml-row__text">
          <span className="ml-row__title"><bdi>{node.title}</bdi></span>
          <span className="ml-row__sub">{parts.join('، ')}</span>
        </span>
        {node.is_favorite && (
          <>
            <Star size={16} aria-hidden="true" />
            <span className="ml-visually-hidden">في المفضلة</span>
          </>
        )}
      </Link>
      {!readOnly && (
        <span className="ml-row__aside">
          <NodeMenu node={node} index={index} />
        </span>
      )}
    </li>
  );
}

export function SourceRow({
  source,
  index,
  dnd,
  readOnly,
  extra,
  meta,
}: {
  source: SourceSummary;
  index: LibraryIndex;
  dnd?: Dnd;
  readOnly?: boolean;
  /** extra line under the title (e.g. links in the course view) */
  extra?: ReactNode;
  /** replaces the default subtitle */
  meta?: ReactNode;
}) {
  return (
    <li className="ml-row">
      {dnd && !readOnly && (
        <span className="ml-drag-handle" {...dnd.handleProps({ kind: 'source', id: source.id, title: source.title })}>
          <GripVertical size={16} />
        </span>
      )}
      <Link to={`/sources/${source.id}`} className="ml-row__main">
        <span className="ml-row__icon" aria-hidden="true">
          {formatIcon(source.format)}
        </span>
        <span className="ml-row__text">
          <span className="ml-row__title"><bdi>{source.title}</bdi></span>
          <span className="ml-row__sub">{meta ?? <SourceSubtitle source={source} />}</span>
          <span className="ml-row__status">
            <ProcessingPill status={source.processing_status} format={source.format} />
            <OnDeviceBadge sourceId={source.id} />
            {source.tags.slice(0, 3).map((t) => (
              <StatusPill key={t.id} tone="neutral" icon={false}>
                <bdi>{t.name}</bdi>
              </StatusPill>
            ))}
          </span>
          {extra}
        </span>
      </Link>
      {!readOnly && (
        <span className="ml-row__aside">
          <SourceMenu source={source} index={index} />
        </span>
      )}
    </li>
  );
}
