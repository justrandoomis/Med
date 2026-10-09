// Pieces shared by the library screens: offline (read-only) notice and drag & drop wiring.
import { CloudOff } from 'lucide-react';
import { useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { mutate } from './data';
import { useLibraryDnd } from './dnd';
import { canMoveInto, type LibraryIndex } from './model';

export function OfflineNotice({ cachedAt }: { cachedAt: number | null }) {
  return (
    <p className="ml-library__offline" role="status">
      <CloudOff size={18} aria-hidden="true" />
      <span>
        تعذّر الوصول إلى الخادم، لذلك تعرض المكتبة نسختها المحفوظة على هذا الجهاز
        {cachedAt ? ` (${formatDateTime(cachedAt)})` : ''}. التعديل والرفع يحتاجان اتصالًا.
      </span>
    </p>
  );
}

/** Drag & drop wiring shared by the shelf and node screens. */
export function useMoveByDrag(index: LibraryIndex | null) {
  const toast = useToast();
  return useLibraryDnd({
    canDrop: (item, target) => {
      if (!index) return false;
      if (item.kind === 'node') return canMoveInto(index, item.id, target) && index.nodes.get(item.id)?.parent_id !== target;
      return index.sources.get(item.id)?.node_id !== target;
    },
    onDrop: (item, target) => {
      const title = index?.nodes.get(target)?.title ?? '';
      void mutate(() => (item.kind === 'node' ? api.post(`/library/nodes/${item.id}/move`, { parent_id: target }) : api.patch(`/sources/${item.id}`, { node_id: target })))
        .then(() => toast.show({ title: `نُقل «${item.title}» إلى «${title}»`, tone: 'success' }))
        .catch((e) => toast.show({ title: errorMessage(e), tone: 'danger' }));
    },
  });
}

