// Assign owner tags to a node or source. Changes apply immediately (each toggle is one request).
import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import type { TagsResponse, TagView } from '@medlevo/shared';
import { Button, Checkbox, Dialog, ErrorState, LoadingState, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { mutate, useQuery } from '../data';

export function TagsDialog({
  open,
  entity,
  onClose,
}: {
  open: boolean;
  entity: { type: 'library_node' | 'source'; id: string; title: string; tags: TagView[] };
  onClose: () => void;
}) {
  const q = useQuery<TagsResponse>(open ? '/library/tags' : null);
  const [assigned, setAssigned] = useState<Set<string> | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = assigned ?? new Set(entity.tags.map((t) => t.id));

  const toggle = async (tagId: string, on: boolean) => {
    setError(null);
    const next = new Set(current);
    if (on) next.add(tagId);
    else next.delete(tagId);
    setAssigned(next);
    try {
      await mutate(() =>
        on
          ? api.post(`/library/tags/${tagId}/links`, { entity_type: entity.type, entity_id: entity.id })
          : api.del(`/library/tags/${tagId}/links?entity_type=${entity.type}&entity_id=${encodeURIComponent(entity.id)}`),
      );
    } catch (e) {
      setAssigned(current);
      setError(errorMessage(e));
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ tag: TagView }>('/library/tags', { name: n });
      await toggle(res.tag.id, true);
      setName('');
      await q.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setAssigned(null);
        onClose();
      }}
      title={`وسوم «${entity.title}»`}
      description="الوسوم تساعدك على التصفية في المكتبة. حذف وسم لا يحذف أي عنصر."
      footer={
        <Button
          variant="primary"
          onClick={() => {
            setAssigned(null);
            onClose();
          }}
        >
          تم
        </Button>
      }
    >
      {q.loading && !q.data && <LoadingState stage="جارٍ تحميل الوسوم…" inline />}
      {q.error && !q.data && <ErrorState inline message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && (
        <div className="ml-stack">
          {q.data.tags.length === 0 && <p className="ml-trash-note">لا توجد وسوم بعد. أنشئ أول وسم بالأسفل.</p>}
          {q.data.tags.map((t) => (
            <Checkbox key={t.id} label={<bdi>{t.name}</bdi>} checked={current.has(t.id)} onCheckedChange={(on) => void toggle(t.id, on)} />
          ))}
          <form onSubmit={create} className="ml-cluster" style={{ alignItems: 'flex-end' }}>
            <TextField label="وسم جديد" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} dir="auto" fieldClassName="ml-grow" />
            <Button type="submit" icon={<Plus size={16} />} loading={busy} disabled={!name.trim()}>
              إضافة
            </Button>
          </form>
          {error && (
            <p className="ml-field__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
