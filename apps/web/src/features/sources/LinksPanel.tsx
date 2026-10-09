// Links between sources (§06, §23): a lecture's chosen references and question sources.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Unlink } from 'lucide-react';
import { SOURCE_LINK_LABELS_AR, SOURCE_TYPE_LABELS_AR, type SourceDetail, type SourceLinkView } from '@medlevo/shared';
import { Button, IconButton, Select, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { mutate } from '../library/data';
import type { LibraryIndex } from '../library/model';

const INCOMING_AR: Record<SourceLinkView['relation'], string> = {
  reference_for: 'مرجع لهذا المصدر',
  question_source_for: 'مصدر أسئلة لهذا المصدر',
  audio_for: 'تسجيل صوتي لهذا المصدر',
  same_topic: 'الموضوع نفسه',
};

export function LinksPanel({ detail, index, readOnly }: { detail: SourceDetail; index: LibraryIndex | null; readOnly: boolean }) {
  const toast = useToast();
  const [relation, setRelation] = useState<SourceLinkView['relation']>('reference_for');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => {
    const all = index ? [...index.sources.values()] : [];
    // same course first, then the rest
    return all
      .filter((s) => s.id !== detail.id)
      .sort((a, b) => Number(b.course_node_id === detail.course_node_id) - Number(a.course_node_id === detail.course_node_id) || a.title.localeCompare(b.title, 'ar'));
  }, [index, detail.id, detail.course_node_id]);

  const add = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await mutate(() => api.post(`/sources/${detail.id}/links`, { to_source_id: target, relation }));
      setTarget('');
      toast.show({ title: 'أُضيف الرابط', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await mutate(() => api.del(`/sources/${detail.id}/links/${id}`));
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  return (
    <div className="ml-stack">
      {detail.links.length === 0 ? (
        <p className="ml-trash-note">لا روابط بعد. اربط المحاضرة بمراجعها ومصادر أسئلتها ليستخدمها نطاق الدراسة (Source Lock) عند اختيارك.</p>
      ) : (
        <ul className="ml-list" role="list">
          {detail.links.map((l) => {
            const outgoing = l.from_source_id === detail.id;
            const otherId = outgoing ? l.to_source_id : l.from_source_id;
            return (
              <li key={l.id} className="ml-row">
                <Link to={`/sources/${otherId}`} className="ml-row__main">
                  <span className="ml-row__icon" aria-hidden="true">
                    <Link2 size={18} />
                  </span>
                  <span className="ml-row__text">
                    <span className="ml-row__sub">{outgoing ? `هذا المصدر ${SOURCE_LINK_LABELS_AR[l.relation]}` : INCOMING_AR[l.relation]}</span>
                    <span className="ml-row__title"><bdi>{l.other_title}</bdi></span>
                    <span className="ml-row__sub">{SOURCE_TYPE_LABELS_AR[l.other_type]}</span>
                  </span>
                </Link>
                {!readOnly && <IconButton label={`إزالة الرابط مع «${l.other_title}»`} icon={<Unlink size={18} />} onClick={() => void remove(l.id)} />}
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <section className="ml-group" aria-label="إضافة رابط">
          <div className="ml-group__row ml-group__row--stack">
            <Select<SourceLinkView['relation']>
              label="هذا المصدر"
              options={(Object.keys(SOURCE_LINK_LABELS_AR) as Array<SourceLinkView['relation']>).map((r) => ({ value: r, label: SOURCE_LINK_LABELS_AR[r] }))}
              value={relation}
              onValueChange={setRelation}
            />
            <Select<string>
              label="المصدر الآخر"
              options={[{ value: '', label: candidates.length ? 'اختر مصدرًا…' : 'لا توجد مصادر أخرى في مكتبتك' }, ...candidates.map((s) => ({ value: s.id, label: `${s.title} (${SOURCE_TYPE_LABELS_AR[s.source_type]})` }))]}
              value={target}
              onValueChange={setTarget}
            />
            <div>
              <Button icon={<Link2 size={16} />} onClick={() => void add()} disabled={!target} loading={busy}>
                إضافة الرابط
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
