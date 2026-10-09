// Trash (§05, §18, §49): restore anything; permanent deletion only after seeing its impact.
import { useMemo, useState } from 'react';
import { Folder, RotateCcw, Trash2 } from 'lucide-react';
import { LIBRARY_NODE_KIND_LABELS_AR, SOURCE_TYPE_LABELS_AR, type ImpactReport } from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, useToast } from '../../design';
import { api, ApiError, errorMessage, isApiError } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { mutate } from './data';
import { MoveDialog } from './components/FolderPicker';
import { ImpactList } from './components/ItemMenus';
import { countAr, formatIcon, NOUN } from './labels';
import { buildIndex, type TrashEntry, trashEntries } from './model';
import { useLibrary } from './useLibrary';

/** True when a permanent delete would remove the owner's own writing or learning history. */
export function ownWorkAtStake(impact: ImpactReport): boolean {
  return impact.annotations + impact.notes + impact.questions + impact.flashcards > 0;
}

export function TrashView({ readOnly }: { readOnly: boolean }) {
  const q = useLibrary('archived,trash');
  const toast = useToast();
  const entries = useMemo(() => (q.data ? trashEntries(q.data.nodes, q.data.sources) : []), [q.data]);
  const liveIndex = useMemo(
    () => (q.data ? buildIndex(q.data.nodes.filter((n) => n.deleted_at === null), q.data.sources.filter((s) => s.deleted_at === null)) : null),
    [q.data],
  );
  const [restoreTarget, setRestoreTarget] = useState<TrashEntry | null>(null);
  const [purge, setPurge] = useState<{ entry: TrashEntry; impact: ImpactReport | null } | null>(null);

  const restore = async (entry: TrashEntry, destination?: string | null) => {
    const url = entry.kind === 'node' ? `/library/nodes/${entry.id}/restore` : `/sources/${entry.id}/restore`;
    const body = destination === undefined ? {} : entry.kind === 'node' ? { parent_id: destination } : { node_id: destination };
    try {
      await mutate(() => api.post(url, body));
      toast.show({ title: `استُعيد «${entry.title}»`, tone: 'success' });
      setRestoreTarget(null);
    } catch (e) {
      if (isApiError(e) && e.status === 409 && (e.details as { reason?: string } | undefined)?.reason === 'parent_in_trash' && destination === undefined) {
        setRestoreTarget(entry);
        return;
      }
      if (destination !== undefined) throw e;
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  const startPurge = async (entry: TrashEntry) => {
    setPurge({ entry, impact: null });
    try {
      const impact = await api.get<ImpactReport>(entry.kind === 'node' ? `/library/nodes/${entry.id}/impact?mode=purge` : `/sources/${entry.id}/impact?mode=purge`);
      setPurge({ entry, impact });
    } catch (e) {
      setPurge(null);
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  const confirmPurge = async () => {
    if (!purge?.impact?.confirm_token) throw new Error('لم يكتمل حساب أثر الحذف بعد.');
    const { entry, impact } = purge;
    const url = `${entry.kind === 'node' ? `/library/nodes/${entry.id}` : `/sources/${entry.id}`}?confirm_token=${encodeURIComponent(impact.confirm_token!)}`;
    try {
      await mutate(() => api.del(url));
    } catch (e) {
      if (isApiError(e) && e.status === 409 && e.code === 'CONFLICT') {
        // the content changed since the impact was computed: show the new impact, ask again
        const fresh = await api.get<ImpactReport>(entry.kind === 'node' ? `/library/nodes/${entry.id}/impact?mode=purge` : `/sources/${entry.id}/impact?mode=purge`);
        setPurge({ entry, impact: fresh });
      }
      throw e instanceof ApiError ? new Error(e.message) : e;
    }
    setPurge(null);
    toast.show({ title: `حُذف «${entry.title}» نهائيًا`, tone: 'neutral' });
  };

  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل سلة المحذوفات…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  if (entries.length === 0) {
    return <EmptyState icon={<Trash2 size={28} />} title="سلة المحذوفات فارغة" description="ما تنقله إلى السلة يبقى هنا حتى تستعيده أو تحذفه نهائيًا بنفسك." headingLevel={2} />;
  }
  return (
    <section aria-labelledby="trash-title">
      <h2 id="trash-title" className="ml-visually-hidden">
        سلة المحذوفات
      </h2>
      <p className="ml-trash-note">لا يُحذف شيء نهائيًا تلقائيًا. الحذف النهائي يعرض أثره أولًا ولا يمكن التراجع عنه.</p>
      <ul className="ml-list" role="list">
        {entries.map((e) => {
          const what =
            e.kind === 'node' ? LIBRARY_NODE_KIND_LABELS_AR[e.node!.kind] : SOURCE_TYPE_LABELS_AR[e.source!.source_type];
          const contains =
            e.kind === 'node' && (e.contains.folders > 0 || e.contains.sources > 0)
              ? `، ومعه ${[e.contains.folders ? countAr(e.contains.folders, NOUN.folder) : '', e.contains.sources ? countAr(e.contains.sources, NOUN.source) : ''].filter(Boolean).join(' و')}`
              : '';
          return (
            <li key={`${e.kind}:${e.id}`} className="ml-row">
              <div className="ml-row__main">
                <span className="ml-row__icon" aria-hidden="true">
                  {e.kind === 'node' ? <Folder size={18} /> : formatIcon(e.source!.format)}
                </span>
                <span className="ml-row__text">
                  <span className="ml-row__title"><bdi>{e.title}</bdi></span>
                  <span className="ml-row__sub">
                    {what}
                    {contains}، حُذف {formatRelative(e.deleted_at)}
                  </span>
                </span>
              </div>
              <span className="ml-row__aside">
                <Button size="sm" variant="secondary" icon={<RotateCcw size={16} />} disabled={readOnly} onClick={() => void restore(e)} aria-label={`استعادة «${e.title}»`}>
                  استعادة
                </Button>
                <Button size="sm" variant="plain" className="ml-danger-text" icon={<Trash2 size={16} />} disabled={readOnly} onClick={() => void startPurge(e)} aria-label={`حذف نهائي: «${e.title}»`}>
                  حذف نهائي
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      {liveIndex && restoreTarget && (
        <MoveDialog
          open
          title={`أين تريد استعادة «${restoreTarget.title}»؟`}
          index={liveIndex}
          initial={null}
          allowRoot={restoreTarget.kind === 'node'}
          requireChange={false}
          confirmLabel="استعادة إلى هنا"
          onConfirm={async (target) => {
            if (restoreTarget.kind === 'source' && !target) throw new Error('اختر مجلدًا للمصدر.');
            await restore(restoreTarget, target);
          }}
          onClose={() => setRestoreTarget(null)}
        />
      )}
      <ConfirmDialog
        open={!!purge}
        destructive
        title={purge ? `حذف «${purge.entry.title}» نهائيًا؟` : ''}
        impact={
          <>
            <ImpactList report={purge?.impact ?? null} />
            <p style={{ marginTop: 'var(--ml-space-2)' }}>لا يمكن التراجع عن الحذف النهائي.</p>
          </>
        }
        confirmLabel="حذف نهائي"
        // the owner's own writing and learning history (ink, notes, attempts, cards & reviews) need the typed confirmation
        requireText={purge?.impact && ownWorkAtStake(purge.impact) ? purge.entry.title : undefined}
        onCancel={() => setPurge(null)}
        onConfirm={confirmPurge}
      />
    </section>
  );
}
