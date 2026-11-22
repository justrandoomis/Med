// ChatGPT-like history of saved conversations: «محادثة جديدة», a search field, «محادثات هذه المحاضرة» / «كل المحادثات»
// when opened from a lecture, groups by day (اليوم، أمس، آخر 7 أيام، آخر 30 يومًا، أقدم), and per conversation open /
// rename (inline) / delete (with the consequence said first).
import { useEffect, useState } from 'react';
import { MessageSquarePlus, Pencil, Search, Trash2 } from 'lucide-react';
import type { ChatThreadView } from '@medlevo/shared';
import { Button, ConfirmDialog, IconButton, SegmentedControl, Skeleton, TextField } from '../../../design';
import { MixedText } from '../../../lib/MixedText';
import { groupThreads } from './model';

export interface ChatHistoryProps {
  threads: ChatThreadView[] | null;
  activeId: string | null;
  /** shown when the history is opened from a lecture */
  lectureTitle?: string | null;
  filter: 'lecture' | 'all';
  onFilter?: (f: 'lecture' | 'all') => void;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  now?: number;
}

export function ChatHistory(p: ChatHistoryProps) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<ChatThreadView | null>(null);
  const [now, setNow] = useState(() => p.now ?? Date.now());
  useEffect(() => {
    if (p.now !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [p.now]);
  const groups = p.threads ? groupThreads(p.threads, p.now ?? now) : [];
  return (
    <nav className="ch-history" aria-label="المحادثات المحفوظة">
      <div className="ch-history__top">
        <Button variant="secondary" size="sm" icon={<MessageSquarePlus size={16} />} onClick={p.onNew} fullWidth>
          محادثة جديدة
        </Button>
        <TextField label="ابحث في المحادثات" endAdornment={<Search size={14} aria-hidden="true" />} value={p.query} onChange={(e) => p.onQuery(e.target.value)} type="search" />
        {p.onFilter && (
          <SegmentedControl<'lecture' | 'all'>
            label="أي المحادثات"
            size="sm"
            fullWidth
            value={p.filter}
            onValueChange={p.onFilter}
            options={[
              { value: 'lecture', label: 'محادثات هذه المحاضرة' },
              { value: 'all', label: 'كل المحادثات' },
            ]}
          />
        )}
      </div>
      {p.threads === null ? (
        <Skeleton lines={3} />
      ) : groups.length === 0 ? (
        <p className="ch-muted">{p.query.trim() ? 'لا محادثة تطابق البحث.' : p.filter === 'lecture' ? 'لا محادثات محفوظة لهذه المحاضرة بعد.' : 'لا محادثات محفوظة بعد.'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="ch-history__group" aria-labelledby={`ch-hg-${g.key}`}>
            <h3 id={`ch-hg-${g.key}`} className="ch-history__label">
              {g.label}
            </h3>
            <ul role="list" className="ch-history__list">
              {g.threads.map((t) => (
                <li key={t.id} className="ch-history__item" data-active={t.id === p.activeId || undefined}>
                  {editing?.id === t.id ? (
                    <form
                      className="ch-history__rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const title = editing.title.trim();
                        if (!title) return;
                        void p.onRename(t.id, title).then(() => setEditing(null));
                      }}
                    >
                      <TextField label="اسم المحادثة" value={editing.title} onChange={(e) => setEditing({ id: t.id, title: e.target.value })} autoFocus maxLength={200} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                      <Button size="sm" type="submit" variant="primary">
                        احفظ
                      </Button>
                    </form>
                  ) : (
                    <>
                      <button type="button" className="ch-history__open" onClick={() => p.onOpen(t.id)} aria-current={t.id === p.activeId ? 'true' : undefined}>
                        <MixedText className="ch-history__title" text={t.title ?? 'محادثة بلا عنوان'} />
                        {p.filter === 'all' && t.source_title && <MixedText className="ch-history__meta" text={t.source_title} />}
                      </button>
                      <IconButton size="sm" variant="plain" label={`أعد تسمية «${t.title ?? 'محادثة'}»`} icon={<Pencil size={14} />} onClick={() => setEditing({ id: t.id, title: t.title ?? '' })} />
                      <IconButton size="sm" variant="plain" label={`احذف «${t.title ?? 'محادثة'}»`} icon={<Trash2 size={14} />} onClick={() => setDeleting(t)} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="حذف المحادثة"
        impact={`ستختفي «${deleting?.title ?? 'المحادثة'}» من سجلك على كل أجهزتك. الإجابات التي حفظتها كملاحظات تبقى في ملاحظاتي.`}
        confirmLabel="احذف"
        destructive
        onConfirm={async () => {
          if (deleting) await p.onDelete(deleting.id);
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </nav>
  );
}
