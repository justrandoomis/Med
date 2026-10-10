// «دفتر الملاحظات» on a library notebook / folder screen (§5, §26, track F1): the note pages of this node (sections,
// pages, trash with restore), a link to the notebook, and «صفحة جديدة». Local-first; seeded from the server when
// online (local edits are never overwritten).
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FilePlus2, NotebookTabs } from 'lucide-react';
import { Button, buttonClass, useToast } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { getSyncEngine } from '../../../lib/sync';
import { useOnline } from '../../../lib/useOnline';
import { registerWorkspaceAppliers } from '../data/local';
import { createNotePage, fetchNotePages, mergeServerNotePages, sortOrderAtEnd, useNotePagesOfNode, useSplitTrash } from '../data/notePages';
import { NewNotePageDialog, type NewNotePageChoice } from '../notes/NotePageDialogs';
import { NotePagesList, pageNumbers } from './NotePagesList';
import './notebook.css';

export function NotebookSection({ nodeId, readOnly = false }: { nodeId: string; readOnly?: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const online = useOnline();
  const rows = useNotePagesOfNode(nodeId);
  const { live, trashed } = useSplitTrash(rows);
  const [creating, setCreating] = useState<'page' | 'divider' | null>(null);
  const count = pageNumbers(live).size;

  useEffect(() => {
    registerWorkspaceAppliers(getSyncEngine());
    if (!online) return;
    void fetchNotePages({ nodeId, includeDeleted: true })
      .then((r) => mergeServerNotePages(getDb(), r.note_pages))
      .catch(() => undefined);
  }, [nodeId, online]);

  const open = (id?: string) => navigate(`/notebook/${encodeURIComponent(nodeId)}${id ? `?page=${encodeURIComponent(id)}` : ''}`);
  const create = async (c: NewNotePageChoice) => {
    try {
      const row = await createNotePage(getDb(), { nodeId, template: c.template, title: c.title, kind: c.kind, color: c.color, sortOrder: sortOrderAtEnd(live) });
      setCreating(null);
      open(row.id);
    } catch (e) {
      toast.show({ title: 'تعذّر حفظ الصفحة على هذا الجهاز', description: e instanceof Error ? e.message : undefined, tone: 'danger' });
    }
  };

  return (
    <section className="ml-library__section nb-section" aria-labelledby={`nb-${nodeId}`}>
      <div className="ml-library__section-head nb-section__head">
        <h2 id={`nb-${nodeId}`} className="ml-library__section-title">
          دفتر الملاحظات
        </h2>
        <span className="ml-library__section-note">{count === 0 ? 'صفحات ورقية للكتابة بالقلم' : `${count} ${count === 1 ? 'صفحة' : count === 2 ? 'صفحتان' : count <= 10 ? 'صفحات' : 'صفحة'}`}</span>
        <div className="nb-section__actions">
          {live.length > 0 && (
            <Link to={`/notebook/${encodeURIComponent(nodeId)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <NotebookTabs size={16} aria-hidden="true" />
              افتح الدفتر
            </Link>
          )}
          <Button size="sm" variant={live.length ? 'plain' : 'secondary'} icon={<FilePlus2 size={16} />} disabled={readOnly} onClick={() => setCreating('page')}>
            صفحة ملاحظات جديدة
          </Button>
        </div>
      </div>
      {(live.length > 0 || trashed.length > 0) && <NotePagesList live={live} trashed={trashed} onOpen={(id) => open(id)} compact />}
      <NewNotePageDialog open={!!creating} where="تُضاف في نهاية دفتر الملاحظات" allowDivider defaultKind={creating ?? 'page'} onClose={() => setCreating(null)} onCreate={create} />
    </section>
  );
}
