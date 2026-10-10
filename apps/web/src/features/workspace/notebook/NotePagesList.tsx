// «صفحات الدفتر»: the page list of a notebook / folder (§26, §5, track F1) — sections (dividers) with their pages,
// open, rename, change the paper, reorder, move to the trash and restore. Everything is local-first: each action is
// one IndexedDB row + outbox op (data/notePages.ts) and works offline.
import { useState } from 'react';
import { ArrowDown, ArrowUp, FileText, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { NOTE_PAGE_TEMPLATE_LABELS_AR, type NotePageTemplate } from '@medlevo/shared';
import { IconButton, Menu, MenuItem, MenuSeparator, SaveStatus, Tooltip, cx, useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { useEntitySyncState } from '../../../lib/sync';
import type { WorkspaceNotePageRow } from '../data/local';
import { movedSortOrder, restoreNotePage, trashNotePage, updateNotePage } from '../data/notePages';
import { RenameNotePageDialog } from '../notes/NotePageDialogs';

export interface NotebookSection {
  divider: WorkspaceNotePageRow | null;
  pages: WorkspaceNotePageRow[];
}

/** Live pages in order, grouped by the dividers that start each section (pages before the first divider: no section). */
export function sectionsOf(live: readonly WorkspaceNotePageRow[]): NotebookSection[] {
  const out: NotebookSection[] = [{ divider: null, pages: [] }];
  for (const r of live) {
    if ((r.kind ?? 'page') === 'divider') out.push({ divider: r, pages: [] });
    else out[out.length - 1]!.pages.push(r);
  }
  return out[0]!.pages.length === 0 && out.length > 1 ? out.slice(1) : out;
}

/** 1-based number of each live page (dividers are not counted as pages). */
export function pageNumbers(live: readonly WorkspaceNotePageRow[]): Map<string, number> {
  const m = new Map<string, number>();
  let n = 0;
  for (const r of live) if ((r.kind ?? 'page') === 'page') m.set(r.id, ++n);
  return m;
}

export function NotePagesList({
  live,
  trashed,
  currentId,
  onOpen,
  compact = false,
  announce,
}: {
  live: WorkspaceNotePageRow[];
  trashed: WorkspaceNotePageRow[];
  currentId?: string | null;
  onOpen: (id: string) => void;
  /** library view: no reorder controls, at most a few pages per section */
  compact?: boolean;
  announce?: (msg: string) => void;
}) {
  const toast = useToast();
  const [renaming, setRenaming] = useState<WorkspaceNotePageRow | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const numbers = pageNumbers(live);
  const sections = sectionsOf(live);
  const say = (m: string) => announce?.(m);
  const fail = (e: unknown) => toast.show({ title: 'تعذّر حفظ التغيير على هذا الجهاز', description: e instanceof Error ? e.message : undefined, tone: 'danger' });

  const move = (row: WorkspaceNotePageRow, dir: -1 | 1) => {
    const order = movedSortOrder(live, row.id, dir);
    if (order == null) return;
    void updateNotePage(getDb(), row, { sortOrder: order })
      .then(() => say(dir < 0 ? 'نُقلت إلى الأمام.' : 'نُقلت إلى الخلف.'))
      .catch(fail);
  };
  const trash = (row: WorkspaceNotePageRow) =>
    void trashNotePage(getDb(), row)
      .then(() =>
        toast.show({
          title: (row.kind ?? 'page') === 'divider' ? 'نُقل القسم إلى المحذوفات' : 'نُقلت الصفحة إلى المحذوفات',
          description: 'كتابتها محفوظة ويمكن استعادتها من «المحذوفة».',
          duration: 10_000,
          action: { label: 'تراجع', onClick: () => void restoreNotePage(getDb(), row).catch(fail) },
        }),
      )
      .catch(fail);

  return (
    <div className={cx('nb-pages', compact && 'nb-pages--compact')}>
      {live.length === 0 && <p className="wk-muted">لا صفحات في هذا الدفتر بعد.</p>}
      {sections.map((sec) => (
        <section key={sec.divider?.id ?? 'none'} className="nb-pages__section" aria-label={sec.divider?.title ?? 'صفحات بلا قسم'}>
          {sec.divider && (
            <div className="nb-pages__divider" data-color={sec.divider.color ?? undefined}>
              <span className="nb-pages__tab" aria-hidden="true" />
              <bdi className="nb-pages__divider-title">{sec.divider.title ?? 'قسم'}</bdi>
              {!compact && <RowActions row={sec.divider} canUp={live[0]?.id !== sec.divider.id} canDown={live[live.length - 1]?.id !== sec.divider.id} onMove={move} onRename={setRenaming} onTrash={trash} />}
            </div>
          )}
          <ol className="nb-pages__list" role="list">
            {(compact ? sec.pages.slice(0, 6) : sec.pages).map((r) => (
              <PageRow
                key={r.id}
                row={r}
                number={numbers.get(r.id) ?? 0}
                current={r.id === currentId}
                compact={compact}
                canUp={live[0]?.id !== r.id}
                canDown={live[live.length - 1]?.id !== r.id}
                onOpen={() => onOpen(r.id)}
                onMove={move}
                onRename={setRenaming}
                onTrash={trash}
                onTemplate={(t) => void updateNotePage(getDb(), r, { template: t }).then(() => say('غُيّر نوع الورق.')).catch(fail)}
              />
            ))}
            {compact && sec.pages.length > 6 && <li className="wk-muted nb-pages__more">و{sec.pages.length - 6} صفحات أخرى في الدفتر</li>}
          </ol>
        </section>
      ))}

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
                  <FileText size={16} aria-hidden="true" />
                  <span className="nb-pages__name">
                    <bdi>{r.title ?? ((r.kind ?? 'page') === 'divider' ? 'قسم بلا اسم' : 'صفحة بلا عنوان')}</bdi>
                    <span className="wk-muted"> — {NOTE_PAGE_TEMPLATE_LABELS_AR[r.template]}</span>
                  </span>
                  <Tooltip content="استعادة مع كتابتها" describe={false}>
                    <IconButton
                      size="sm"
                      label={`استعادة ${r.title ?? 'الصفحة'}`}
                      icon={<RotateCcw size={16} />}
                      onClick={() =>
                        void restoreNotePage(getDb(), r)
                          .then(() => say('استُعيدت الصفحة مع كتابتها.'))
                          .catch(fail)
                      }
                    />
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <RenameNotePageDialog
        open={!!renaming}
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (renaming) await updateNotePage(getDb(), renaming, { title }).then(() => say('حُفظ العنوان.'), fail);
          setRenaming(null);
        }}
      />
    </div>
  );
}

function PageRow({
  row,
  number,
  current,
  compact,
  canUp,
  canDown,
  onOpen,
  onMove,
  onRename,
  onTrash,
  onTemplate,
}: {
  row: WorkspaceNotePageRow;
  number: number;
  current: boolean;
  compact: boolean;
  canUp: boolean;
  canDown: boolean;
  onOpen: () => void;
  onMove: (r: WorkspaceNotePageRow, dir: -1 | 1) => void;
  onRename: (r: WorkspaceNotePageRow) => void;
  onTrash: (r: WorkspaceNotePageRow) => void;
  onTemplate: (t: NotePageTemplate) => void;
}) {
  const state = useEntitySyncState('note_page', row.id);
  const name = row.title ?? `صفحة ${number}`;
  return (
    <li className={cx('nb-pages__row', current && 'is-current')}>
      <button type="button" className="nb-pages__open" onClick={onOpen} aria-current={current ? 'page' : undefined}>
        <span className="nb-pages__num" aria-hidden="true">
          {number}
        </span>
        <span className="nb-pages__name">
          <bdi>{name}</bdi>
          <span className="wk-muted"> — {NOTE_PAGE_TEMPLATE_LABELS_AR[row.template]}</span>
        </span>
      </button>
      <SaveStatus state={state ?? 'synced'} compact />
      {!compact && (
        <RowActions row={row} canUp={canUp} canDown={canDown} onMove={onMove} onRename={onRename} onTrash={onTrash} onTemplate={onTemplate} />
      )}
    </li>
  );
}

function RowActions({
  row,
  canUp,
  canDown,
  onMove,
  onRename,
  onTrash,
  onTemplate,
}: {
  row: WorkspaceNotePageRow;
  canUp: boolean;
  canDown: boolean;
  onMove: (r: WorkspaceNotePageRow, dir: -1 | 1) => void;
  onRename: (r: WorkspaceNotePageRow) => void;
  onTrash: (r: WorkspaceNotePageRow) => void;
  onTemplate?: (t: NotePageTemplate) => void;
}) {
  const divider = (row.kind ?? 'page') === 'divider';
  const name = row.title ?? (divider ? 'القسم' : 'الصفحة');
  return (
    <span className="nb-pages__actions">
      <Tooltip content="إلى الأمام" describe={false}>
        <IconButton size="sm" label={`انقل ${name} إلى الأمام`} icon={<ArrowUp size={16} />} disabled={!canUp} onClick={() => onMove(row, -1)} />
      </Tooltip>
      <Tooltip content="إلى الخلف" describe={false}>
        <IconButton size="sm" label={`انقل ${name} إلى الخلف`} icon={<ArrowDown size={16} />} disabled={!canDown} onClick={() => onMove(row, 1)} />
      </Tooltip>
      <Menu label={`خيارات ${name}`} align="end" trigger={<IconButton size="sm" label={`خيارات ${name}`} icon={<MoreHorizontal size={16} />} />}>
        <MenuItem icon={<Pencil size={16} />} onSelect={() => onRename(row)}>
          إعادة التسمية…
        </MenuItem>
        {onTemplate &&
          (['blank', 'ruled', 'dotted', 'grid'] as const).map((t) => (
            <MenuItem key={t} hint={t === row.template ? 'الحالي' : undefined} onSelect={() => onTemplate(t)}>
              ورق {NOTE_PAGE_TEMPLATE_LABELS_AR[t]}
            </MenuItem>
          ))}
        <MenuSeparator />
        <MenuItem icon={<Trash2 size={16} />} destructive onSelect={() => onTrash(row)}>
          نقل إلى المحذوفات
        </MenuItem>
      </Menu>
    </span>
  );
}
