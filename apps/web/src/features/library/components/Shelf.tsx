// The shelf: notebooks (and any top-level folders) as covers.
import { Link } from 'react-router-dom';
import { GripVertical, Plus, Star } from 'lucide-react';
import { LIBRARY_NODE_KIND_LABELS_AR, type LibraryNodeView } from '@medlevo/shared';
import type { useLibraryDnd } from '../dnd';
import { countAr, NOUN } from '../labels';
import { type LibraryIndex, subtreeCounts } from '../model';
import { Cover, coverOf } from './Cover';
import { NodeMenu } from './ItemMenus';

type Dnd = ReturnType<typeof useLibraryDnd>;

export function ShelfItem({ node, index, dnd, readOnly }: { node: LibraryNodeView; index: LibraryIndex; dnd?: Dnd; readOnly?: boolean }) {
  const counts = subtreeCounts(index, node.id);
  return (
    <li className="ml-shelf__item" {...(dnd && !readOnly ? dnd.dropProps(node.id) : {})}>
      <Link to={`/library/${node.id}`} className="ml-shelf__link">
        <Cover cover={coverOf(node)} title={node.title} />
        <span className="ml-visually-hidden">
          {`، ${LIBRARY_NODE_KIND_LABELS_AR[node.kind]}، ${countAr(counts.sources, NOUN.source)}`}
          {node.is_favorite ? '، في المفضلة' : ''}
        </span>
      </Link>
      <div className="ml-shelf__meta">
        {dnd && !readOnly && (
          <span className="ml-drag-handle" {...dnd.handleProps({ kind: 'node', id: node.id, title: node.title })}>
            <GripVertical size={16} />
          </span>
        )}
        <span className="ml-shelf__meta-text" aria-hidden="true">
          <span className="ml-shelf__kind">
            {LIBRARY_NODE_KIND_LABELS_AR[node.kind]}
            {node.is_favorite && <Star size={13} />}
          </span>
          <span className="ml-shelf__count">
            {countAr(counts.sources, NOUN.source)}
            {counts.folders > 0 ? `، ${countAr(counts.folders, NOUN.folder)}` : ''}
          </span>
        </span>
        {!readOnly && <NodeMenu node={node} index={index} />}
      </div>
    </li>
  );
}

export function NewNotebookTile({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <li className="ml-shelf__item">
      <button type="button" className="ml-shelf__new" onClick={onClick} disabled={disabled}>
        <Plus size={22} aria-hidden="true" />
        دفتر جديد
      </button>
    </li>
  );
}
