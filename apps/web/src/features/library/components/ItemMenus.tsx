// Action menus for library items. Every action is reachable by keyboard (Menu + dialogs); moving is
// also possible by dragging. Trashing shows what goes with it; nothing is deleted from here.
import { useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Ellipsis, FolderInput, Pencil, Star, StarOff, Tag, Trash2 } from 'lucide-react';
import type { ImpactReport, LibraryNodeView, SourceSummary } from '@medlevo/shared';
import { ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, useToast } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { mutate } from '../data';
import { canMoveInto, childrenOf, type LibraryIndex } from '../model';
import { MoveDialog } from './FolderPicker';
import { NodeDialog } from './NodeDialog';
import { TagsDialog } from './TagsDialog';

export function ImpactList({ report }: { report: ImpactReport | null }) {
  if (!report) return <p>جارٍ حساب الأثر…</p>;
  return (
    <ul className="ml-impact-lines">
      {report.lines_ar.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

function useTrashFlow(kind: 'node' | 'source', id: string, title: string) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const start = async () => {
    setImpact(null);
    setOpen(true);
    try {
      setImpact(await api.get<ImpactReport>(kind === 'node' ? `/library/nodes/${id}/impact?mode=trash` : `/sources/${id}/impact?mode=trash`));
    } catch (e) {
      setImpact({ nodes: 0, sources: 0, versions: 0, pages: 0, annotations: 0, notes: 0, questions: 0, flashcards: 0, artifacts: 0, lines_ar: [errorMessage(e)] });
    }
  };
  const dialog = (
    <ConfirmDialog
      open={open}
      title={`نقل «${title}» إلى سلة المحذوفات؟`}
      impact={<ImpactList report={impact} />}
      confirmLabel="نقل إلى السلة"
      onCancel={() => setOpen(false)}
      onConfirm={async () => {
        await mutate(() => api.post(kind === 'node' ? `/library/nodes/${id}/trash` : `/sources/${id}/trash`));
        setOpen(false);
        toast.show({ title: `نُقل «${title}» إلى سلة المحذوفات`, tone: 'neutral' });
      }}
    />
  );
  return { start, dialog };
}

export function NodeMenu({ node, index, onNavigateAway }: { node: LibraryNodeView; index: LibraryIndex; onNavigateAway?: () => void }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'edit' | 'move' | 'tags'>(null);
  const trash = useTrashFlow('node', node.id, node.title);
  const parent = node.parent_id ? index.nodes.get(node.parent_id) : undefined;
  const siblings = childrenOf(index, node.parent_id, 'manual');
  const pos = siblings.findIndex((s) => s.id === node.id);
  const manual = (parent?.sort_mode ?? 'manual') === 'manual';
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await mutate(fn);
      if (done) toast.show({ title: done, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  const reorderReason = manual ? undefined : 'الترتيب هنا تلقائي؛ اختر «ترتيبي اليدوي» لتحريك العناصر.';
  return (
    <>
      <Menu trigger={<IconButton label={`خيارات «${node.title}»`} icon={<Ellipsis size={20} />} size="sm" />}>
        <MenuItem icon={<Pencil size={16} />} onSelect={() => setDialog('edit')}>
          تعديل الاسم والغلاف
        </MenuItem>
        <MenuItem icon={<FolderInput size={16} />} onSelect={() => setDialog('move')}>
          نقل…
        </MenuItem>
        <MenuItem
          icon={<ArrowUp size={16} />}
          disabled={!manual || pos <= 0}
          disabledReason={reorderReason ?? 'هذا أول عنصر.'}
          onSelect={() => void run(() => api.post(`/library/nodes/${node.id}/move`, { parent_id: node.parent_id, before_id: siblings[pos - 1]!.id }))}
        >
          تحريك للأعلى
        </MenuItem>
        <MenuItem
          icon={<ArrowDown size={16} />}
          disabled={!manual || pos === -1 || pos >= siblings.length - 1}
          disabledReason={reorderReason ?? 'هذا آخر عنصر.'}
          onSelect={() => void run(() => api.post(`/library/nodes/${node.id}/move`, { parent_id: node.parent_id, after_id: siblings[pos + 1]!.id }))}
        >
          تحريك للأسفل
        </MenuItem>
        <MenuItem icon={<Tag size={16} />} onSelect={() => setDialog('tags')}>
          الوسوم…
        </MenuItem>
        <MenuItem
          icon={node.is_favorite ? <StarOff size={16} /> : <Star size={16} />}
          onSelect={() => void run(() => api.patch(`/library/nodes/${node.id}`, { is_favorite: !node.is_favorite }), node.is_favorite ? 'أُزيل من المفضلة' : 'أُضيف إلى المفضلة')}
        >
          {node.is_favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={node.archived_at ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          onSelect={() =>
            void run(
              () => api.post(`/library/nodes/${node.id}/${node.archived_at ? 'unarchive' : 'archive'}`),
              node.archived_at ? `أُخرج «${node.title}» من الأرشيف` : `أُرشف «${node.title}»؛ تجده في تبويب الأرشيف`,
            ).then(() => !node.archived_at && onNavigateAway?.())
          }
        >
          {node.archived_at ? 'إخراج من الأرشيف' : 'أرشفة'}
        </MenuItem>
        <MenuItem icon={<Trash2 size={16} />} destructive onSelect={() => void trash.start()}>
          نقل إلى السلة…
        </MenuItem>
      </Menu>
      <NodeDialog open={dialog === 'edit'} mode={{ type: 'edit', node }} onClose={() => setDialog(null)} />
      <MoveDialog
        open={dialog === 'move'}
        title={`نقل «${node.title}»`}
        index={index}
        initial={node.parent_id}
        allowRoot
        disabledReason={(target) => (canMoveInto(index, node.id, target.id) ? null : target.id === node.id ? 'العنصر نفسه' : 'داخل العنصر نفسه')}
        onConfirm={async (target) => {
          await mutate(() => api.post(`/library/nodes/${node.id}/move`, { parent_id: target }));
          toast.show({ title: `نُقل «${node.title}»`, tone: 'success' });
        }}
        onClose={() => setDialog(null)}
      />
      <TagsDialog open={dialog === 'tags'} entity={{ type: 'library_node', id: node.id, title: node.title, tags: node.tags }} onClose={() => setDialog(null)} />
      {trash.dialog}
    </>
  );
}

export function SourceMenu({ source, index }: { source: SourceSummary; index: LibraryIndex }) {
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'move' | 'tags'>(null);
  const trash = useTrashFlow('source', source.id, source.title);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await mutate(fn);
      if (done) toast.show({ title: done, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <>
      <Menu trigger={<IconButton label={`خيارات «${source.title}»`} icon={<Ellipsis size={20} />} size="sm" />}>
        <MenuItem icon={<FolderInput size={16} />} onSelect={() => setDialog('move')}>
          نقل إلى مجلد آخر…
        </MenuItem>
        <MenuItem icon={<Tag size={16} />} onSelect={() => setDialog('tags')}>
          الوسوم…
        </MenuItem>
        <MenuItem
          icon={source.is_favorite ? <StarOff size={16} /> : <Star size={16} />}
          onSelect={() => void run(() => api.patch(`/sources/${source.id}`, { is_favorite: !source.is_favorite }), source.is_favorite ? 'أُزيل من المفضلة' : 'أُضيف إلى المفضلة')}
        >
          {source.is_favorite ? 'إزالة من المفضلة' : 'إضافة إلى المفضلة'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={source.archived_at ? <ArchiveRestore size={16} /> : <Archive size={16} />}
          onSelect={() => void run(() => api.post(`/sources/${source.id}/${source.archived_at ? 'unarchive' : 'archive'}`), source.archived_at ? 'أُخرج من الأرشيف' : 'أُرشف المصدر')}
        >
          {source.archived_at ? 'إخراج من الأرشيف' : 'أرشفة'}
        </MenuItem>
        <MenuItem icon={<Trash2 size={16} />} destructive onSelect={() => void trash.start()}>
          نقل إلى السلة…
        </MenuItem>
      </Menu>
      <MoveDialog
        open={dialog === 'move'}
        title={`نقل «${source.title}»`}
        index={index}
        initial={source.node_id}
        allowRoot={false}
        onConfirm={async (target) => {
          if (!target) return;
          await mutate(() => api.patch(`/sources/${source.id}`, { node_id: target }));
          toast.show({ title: `نُقل «${source.title}»`, tone: 'success' });
        }}
        onClose={() => setDialog(null)}
      />
      <TagsDialog open={dialog === 'tags'} entity={{ type: 'source', id: source.id, title: source.title, tags: source.tags }} onClose={() => setDialog(null)} />
      {trash.dialog}
    </>
  );
}
