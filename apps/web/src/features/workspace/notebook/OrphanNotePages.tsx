// «صفحات بلا دفتر» (Round 7 — H3 item 7, §26 / §47 never lose the owner's writing). A note page whose notebook (or
// source) was purged while a device that still wrote on it was offline reaches the server with neither link; the
// server keeps it and lists it at GET /api/annotations/orphan-pages. This library section shows those pages with how
// much is written on them, and lets the owner move one into a notebook / folder or move it to the trash (with undo and
// a restore list). Nothing is deleted here: trash is a tombstone, and moving keeps the page id, so its ink follows.
// Local-first like every note-page change (data/notePages.ts): one IndexedDB row + outbox op, works offline.
import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileQuestion, FolderInput, RotateCcw, Trash2 } from 'lucide-react';
import { NOTE_PAGE_TEMPLATE_LABELS_AR, type LibraryNodeView } from '@medlevo/shared';
import { Button, IconButton, SaveStatus, Tooltip, useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { getSyncEngine, useEntitySyncState } from '../../../lib/sync';
import { useOnline } from '../../../lib/useOnline';
import { MoveDialog } from '../../library/components/FolderPicker';
import type { LibraryIndex } from '../../library/model';
import { registerWorkspaceAppliers, type WorkspaceNotePageRow } from '../data/local';
import { byOrder, moveNotePageToNode, restoreNotePage, seedOrphanNotePages, sortOrderAtEnd, trashNotePage, useOrphanNotePages, useSplitTrash, useWritingCounts } from '../data/notePages';
import './notebook.css';

export const ORPHAN_PAGES_TITLE_AR = 'صفحات بلا دفتر';
export const ORPHAN_PAGES_WHY_AR =
  'حُذف دفتر هذه الصفحات أو مصدرها نهائيًا بينما كان جهاز آخر يكتب عليها دون اتصال، فحُفظت كما هي مع كتابتها. انقل كل صفحة إلى دفتر لتعود إلى مكانها، أو انقلها إلى المحذوفات.';

function writingLabel(n: number | undefined): string {
  if (n === undefined) return '';
  if (n === 0) return 'لا كتابة عليها على هذا الجهاز';
  if (n === 1) return 'عليها عنصر واحد';
  if (n === 2) return 'عليها عنصران';
  return n <= 10 ? `عليها ${n} عناصر` : `عليها ${n} عنصرًا`;
}

export function OrphanNotePages({ index, readOnly = false }: { index: LibraryIndex; readOnly?: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const online = useOnline();
  const rows = useOrphanNotePages();
  const { live, trashed } = useSplitTrash(rows);
  const counts = useWritingCounts(live.map((r) => r.id));
  const [moving, setMoving] = useState<WorkspaceNotePageRow | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  useEffect(() => {
    registerWorkspaceAppliers(getSyncEngine());
    if (!online) return;
    void seedOrphanNotePages(getDb()).catch(() => undefined);
  }, [online]);

  if (live.length === 0 && trashed.length === 0) return null;
  const fail = (e: unknown) => toast.show({ title: 'تعذّر حفظ التغيير على هذا الجهاز', description: e instanceof Error ? e.message : undefined, tone: 'danger' });
  const name = (r: WorkspaceNotePageRow) => r.title ?? 'صفحة بلا عنوان';

  const trash = (r: WorkspaceNotePageRow) =>
    void trashNotePage(getDb(), r)
      .then(() =>
        toast.show({
          title: 'نُقلت الصفحة إلى المحذوفات',
          description: 'كتابتها محفوظة ويمكن استعادتها من «المحذوفة» في هذا القسم.',
          duration: 10_000,
          action: { label: 'تراجع', onClick: () => void restoreNotePage(getDb(), r).catch(fail) },
        }),
      )
      .catch(fail);

  const moveTo = async (target: string | null) => {
    if (!moving || !target) return;
    const node = index.nodes.get(target);
    const theirs = (await getDb().notePages.where('nodeId').equals(target).toArray()) as WorkspaceNotePageRow[];
    const order = sortOrderAtEnd(theirs.filter((p) => !p.deletedAt).sort(byOrder));
    const row = moving;
    await moveNotePageToNode(getDb(), row, target, order);
    toast.show({
      title: `نُقلت «${name(row)}» إلى «${node?.title ?? 'الدفتر'}»`,
      description: 'مع كل ما كُتب عليها، في آخر صفحات الدفتر.',
      duration: 10_000,
      action: { label: 'افتح الصفحة', onClick: () => navigate(`/notebook/${encodeURIComponent(target)}?page=${encodeURIComponent(row.id)}`) },
    });
  };

  return (
    <section className="ml-library__section nb-orphans" aria-labelledby="nb-orphans-title">
      <div className="ml-library__section-head">
        <h2 id="nb-orphans-title" className="ml-library__section-title">
          {ORPHAN_PAGES_TITLE_AR}
        </h2>
        <span className="ml-library__section-note">{live.length === 1 ? 'صفحة واحدة' : live.length === 2 ? 'صفحتان' : `${live.length} صفحات`}</span>
      </div>
      <p className="nb-orphans__why">{ORPHAN_PAGES_WHY_AR}</p>
      {live.length > 0 && (
        <ul className="nb-pages__list" role="list" aria-label={ORPHAN_PAGES_TITLE_AR}>
          {live.map((r) => (
            <OrphanRow key={r.id} row={r} name={name(r)} writing={writingLabel(counts.get(r.id))} readOnly={readOnly} onMove={() => setMoving(r)} onTrash={() => trash(r)} />
          ))}
        </ul>
      )}
      {trashed.length > 0 && (
        <div className="nb-pages__trash">
          <button type="button" className="nb-pages__trash-toggle" aria-expanded={showTrash} onClick={() => setShowTrash((v) => !v)}>
            <Trash2 size={16} aria-hidden="true" />
            المحذوفة ({trashed.length})
          </button>
          {showTrash && (
            <ul className="nb-pages__list" role="list">
              {trashed.map((r) => (
                <li key={r.id} className="nb-pages__row nb-pages__row--trashed">
                  <FileQuestion size={16} aria-hidden="true" />
                  <span className="nb-pages__name">
                    <bdi>{name(r)}</bdi>
                    <span className="wk-muted"> — {NOTE_PAGE_TEMPLATE_LABELS_AR[r.template]}</span>
                  </span>
                  <Tooltip content="استعادة مع كتابتها" describe={false}>
                    <IconButton size="sm" label={`استعادة ${name(r)}`} icon={<RotateCcw size={16} />} onClick={() => void restoreNotePage(getDb(), r).catch(fail)} />
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <MoveDialog
        open={!!moving}
        title={moving ? `نقل «${name(moving)}» إلى دفتر` : 'نقل إلى دفتر'}
        index={index}
        initial={null}
        allowRoot={false}
        requireChange={false}
        confirmLabel="انقل إلى هنا"
        disabledReason={(n: LibraryNodeView) => (n.deleted_at ? 'في السلة' : null)}
        onConfirm={moveTo}
        onClose={() => setMoving(null)}
      />
    </section>
  );
}

function OrphanRow({ row, name, writing, readOnly, onMove, onTrash }: { row: WorkspaceNotePageRow; name: string; writing: string; readOnly: boolean; onMove: () => void; onTrash: () => void }) {
  const state = useEntitySyncState('note_page', row.id);
  const nameId = useId();
  return (
    <li className="nb-pages__row nb-orphans__row">
      <FileQuestion size={16} aria-hidden="true" />
      <span className="nb-pages__name" id={nameId}>
        <bdi>{name}</bdi>
        <span className="wk-muted">
          {' '}
          — {NOTE_PAGE_TEMPLATE_LABELS_AR[row.template]}
          {writing ? ` · ${writing}` : ''}
        </span>
      </span>
      <SaveStatus state={state ?? 'synced'} compact />
      <span className="nb-pages__actions">
        <Button size="sm" variant="secondary" icon={<FolderInput size={16} />} onClick={onMove} disabled={readOnly} aria-describedby={nameId}>
          انقل إلى دفتر…
        </Button>
        <Tooltip content="نقل إلى المحذوفات" describe={false}>
          <IconButton size="sm" label={`انقل ${name} إلى المحذوفات`} icon={<Trash2 size={16} />} onClick={onTrash} />
        </Tooltip>
      </span>
    </li>
  );
}
