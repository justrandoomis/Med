// Note pages inside the reader (track F1): the page sequence of a source with the owner's note pages inserted after
// its pages, the page menu (rename, paper, move, a new page after, trash with «تراجع»), and the dialogs.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fullPageLabel } from '../model/pages';
import type { NotePageTemplate, SourcePageView } from '@medlevo/shared';
import { useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import type { WorkspaceNotePageRow } from '../data/local';
import {
  createNotePage,
  fetchNotePages,
  mergeServerNotePages,
  restoreNotePage,
  sortOrderBetween,
  trashNotePage,
  updateNotePage,
  useNotePagesOfSource,
  type NotePagePatch,
} from '../data/notePages';
import { buildSequence, indexSequence, insertionAfter, type ReaderSheet, type SequenceIndex } from '../model/sequence';
import type { NotePageActions } from '../reader/readerContext';
import { NewNotePageDialog, RenameNotePageDialog, type NewNotePageChoice } from './NotePageDialogs';

type NoteSheet = Extract<ReaderSheet, { kind: 'note' }>;

/**
 * Where a note page goes when moved one place earlier (-1) or later (+1) in the reading sequence: past a neighbouring
 * note page of the same source page (a new sort order), or across a source page (it then follows the page before /
 * the page itself). null at the start / end of the book.
 */
export function moveNoteInSequence(sheets: readonly ReaderSheet[], id: string, dir: -1 | 1): NotePagePatch | null {
  const i = sheets.findIndex((s) => s.kind === 'note' && s.note.id === id);
  if (i < 0) return null;
  const me = sheets[i] as NoteSheet;
  const nb = sheets[i + dir];
  if (!nb) return null;
  const groupOf = (after: number) => sheets.filter((s): s is NoteSheet => s.kind === 'note' && s.after === after && s.note.id !== id);
  if (nb.kind === 'note') {
    const group = groupOf(me.after);
    const gi = group.findIndex((g) => g.note.id === nb.note.id);
    const sortOrder = dir < 0 ? sortOrderBetween(group[gi - 1]?.note.sortOrder, nb.note.sortOrder) : sortOrderBetween(nb.note.sortOrder, group[gi + 1]?.note.sortOrder);
    return { sortOrder };
  }
  // across a source page
  const newAfter = dir < 0 ? nb.page.page_index - 1 : nb.page.page_index;
  const group = groupOf(newAfter);
  const prevSource = sheets.find((s) => s.kind === 'source' && s.page.page_index === newAfter);
  return {
    afterPageIndex: newAfter,
    afterPageId: prevSource?.kind === 'source' ? prevSource.page.id : null,
    sortOrder: dir < 0 ? sortOrderBetween(group[group.length - 1]?.note.sortOrder, null) : sortOrderBetween(null, group[0]?.note.sortOrder),
  };
}

export interface ReaderNotePages {
  rows: WorkspaceNotePageRow[];
  sheets: ReaderSheet[];
  index: SequenceIndex;
  actions: NotePageActions;
  /** open «صفحة ملاحظات جديدة» to insert after a sheet of the sequence */
  openNew: (afterSeq: number) => void;
  restore: (id: string) => Promise<void>;
  dialogs: ReactNode;
}

export function useReaderNotePages(opts: {
  sourceId: string;
  pages: readonly SourcePageView[];
  online: boolean;
  /** the new page was created (the reader moves to it) */
  onCreated: (id: string) => void;
  announce: (msg: string) => void;
}): ReaderNotePages {
  const { sourceId, pages, online, onCreated, announce } = opts;
  const toast = useToast();
  const rows = useNotePagesOfSource(sourceId);
  const sheets = useMemo(() => buildSequence(pages, rows), [pages, rows]);
  const index = useMemo(() => indexSequence(sheets), [sheets]);
  const [newAfter, setNewAfter] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<WorkspaceNotePageRow | null>(null);

  // this device learns the owner's note pages of the source (trashed ones too, for «استعادة»); local edits win
  useEffect(() => {
    if (!online) return;
    void fetchNotePages({ sourceId, includeDeleted: true })
      .then((r) => mergeServerNotePages(getDb(), r.note_pages))
      .catch(() => undefined);
  }, [sourceId, online]);

  const rowOf = useCallback((id: string) => rows.find((r) => r.id === id) ?? null, [rows]);

  const fail = useCallback((e: unknown) => toast.show({ title: 'تعذّر حفظ التغيير على هذا الجهاز', description: e instanceof Error ? e.message : undefined, tone: 'danger' }), [toast]);

  const patch = useCallback(
    async (id: string, p: NotePagePatch, msg: string) => {
      const row = rowOf(id);
      if (!row) return;
      try {
        await updateNotePage(getDb(), row, p);
        announce(msg);
      } catch (e) {
        fail(e);
      }
    },
    [rowOf, announce, fail],
  );

  const restore = useCallback(
    async (id: string) => {
      const row = rowOf(id);
      if (!row) return;
      try {
        await restoreNotePage(getDb(), row);
        announce('استُعيدت صفحة الملاحظات مع كتابتها.');
      } catch (e) {
        fail(e);
      }
    },
    [rowOf, announce, fail],
  );

  const actions = useMemo<NotePageActions>(
    () => ({
      rename: (id) => setRenaming(rowOf(id)),
      setTemplate: (id, template: NotePageTemplate) => void patch(id, { template }, 'غُيّر نوع الورق. الكتابة باقية في مكانها.'),
      move: (id, dir) => {
        const p = moveNoteInSequence(sheets, id, dir);
        if (p) void patch(id, p, dir < 0 ? 'نُقلت الصفحة إلى الأمام.' : 'نُقلت الصفحة إلى الخلف.');
      },
      canMove: (id, dir) => moveNoteInSequence(sheets, id, dir) !== null,
      trash: (id) => {
        const row = rowOf(id);
        if (!row) return;
        void trashNotePage(getDb(), row)
          .then(() => {
            toast.show({
              title: 'نُقلت صفحة الملاحظات إلى المحذوفات',
              description: 'كتابتها محفوظة؛ تستعيدها من هنا أو من «ملاحظاتي ← صفحات الملاحظات».',
              tone: 'neutral',
              duration: 10_000,
              action: { label: 'تراجع', onClick: () => void restoreNotePage(getDb(), { ...row, deletedAt: Date.now() }) },
            });
          })
          .catch(fail);
      },
      insertAfter: (id) => setNewAfter(index.ofNote(id)),
    }),
    [rowOf, patch, sheets, toast, fail, index],
  );

  const where = useMemo(() => {
    if (newAfter == null) return '';
    const s = sheets[newAfter];
    if (!s) return 'في نهاية الكتاب';
    if (s.kind === 'source') return `تُضاف بعد ${fullPageLabel(s.page)}`;
    return s.note.title ? `تُضاف بعد صفحة الملاحظات «${s.note.title}»` : 'تُضاف بعد صفحة الملاحظات الحالية';
  }, [newAfter, sheets]);

  const create = async (c: NewNotePageChoice) => {
    if (newAfter == null) return;
    const ins = insertionAfter(sheets, newAfter);
    try {
      const row = await createNotePage(getDb(), {
        sourceId,
        afterPageIndex: ins.afterPageIndex,
        afterPageId: ins.afterPageId,
        template: c.template,
        title: c.title,
        sortOrder: sortOrderBetween(ins.prevOrder, ins.nextOrder),
      });
      setNewAfter(null);
      announce('أُضيفت صفحة ملاحظات. اختر القلم للكتابة عليها.');
      onCreated(row.id);
    } catch (e) {
      fail(e);
    }
  };

  const dialogs = (
    <>
      <NewNotePageDialog open={newAfter != null} where={where} onClose={() => setNewAfter(null)} onCreate={create} />
      <RenameNotePageDialog
        open={!!renaming}
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (renaming) await patch(renaming.id, { title }, 'حُفظ عنوان الصفحة.');
          setRenaming(null);
        }}
      />
    </>
  );

  return { rows, sheets, index, actions, openNew: setNewAfter, restore, dialogs };
}
