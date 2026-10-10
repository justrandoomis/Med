// The library filtered by a topic (/library?topic=<id>, §05 «used as a library filter»): the sources the topic links
// to — the ones you accepted or linked, then the suggestions (marked as such, so a wrong automatic link never hides
// content inside a topic silently) — plus how many questions / places it links to.
import { Link } from 'react-router-dom';
import { Tag, X } from 'lucide-react';
import type { TopicDetailResponse, TopicsResponse } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, Select, StatusPill, buttonClass } from '../../design';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, topicUrl } from './api';
import './brain.css';

export function TopicFilterView({ topicId, onClear }: { topicId: string; onClear: () => void }) {
  const q = useQuery<TopicDetailResponse>(BRAIN_PATHS.topic(topicId), { cache: true });
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تصفية المكتبة…" />;
  if (q.error && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />;
  const d = q.data!;
  const sources = d.links.filter((l) => l.entity_type === 'source' && l.status !== 'rejected' && l.label);
  const others = d.links.filter((l) => l.entity_type !== 'source' && l.status !== 'rejected');
  return (
    <section className="kb-topic-filter" aria-labelledby="tf-h">
      <div className="lw-head">
        <h2 id="tf-h" className="lw-sheet__title">
          <Tag size={18} aria-hidden="true" /> مصفّاة بالموضوع: <bdi>{d.topic.title_ar ?? d.topic.title}</bdi>
        </h2>
        <button type="button" className={buttonClass({ size: 'sm', variant: 'plain' })} onClick={onClear}>
          <X size={16} aria-hidden="true" /> إلغاء التصفية
        </button>
      </div>
      {sources.length === 0 ? (
        <EmptyState headingLevel={3} title="لا مصادر مرتبطة بهذا الموضوع" description="اربط مصادر من صفحة الموضوع، أو راجع الاقتراحات هناك." actions={<Link className={buttonClass({ variant: 'secondary' })} to={topicUrl(d.topic.id)}>صفحة الموضوع</Link>} />
      ) : (
        <ul className="ml-list" role="list">
          {sources.map((l) => (
            <li key={l.id} className="ml-row">
              <Link to={l.href ?? '#'} className="ml-row__main">
                <span className="ml-row__text">
                  <span className="ml-row__title">
                    <bdi>{l.label}</bdi>
                  </span>
                  {l.sublabel && <span className="ml-row__sub">{l.sublabel}</span>}
                </span>
              </Link>
              <span className="ml-row__aside">{l.status === 'suggested' ? <StatusPill tone="info">مقترح — لم تقرره بعد</StatusPill> : <StatusPill tone="success">مرتبط</StatusPill>}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="lw-muted">
        وفي الموضوع أيضًا {others.length} {others.length === 1 ? 'رابط آخر' : 'روابط أخرى'} (مواضع وأسئلة ومفاهيم) —{' '}
        <Link className="lw-link" to={topicUrl(d.topic.id)}>
          افتح صفحة الموضوع
        </Link>
      </p>
    </section>
  );
}

/** «تصفية بموضوع» — the library's topic filter control (hidden while there are no topics). */
export function TopicFilterSelect({ value, onChange }: { value: string | null; onChange: (topicId: string | null) => void }) {
  const q = useQuery<TopicsResponse>('/library/topics', { cache: true });
  const topics = q.data?.topics ?? [];
  if (topics.length === 0) return null;
  return (
    <Select<string>
      label="تصفية بموضوع"
      hideLabel
      options={[{ value: '', label: 'كل الموضوعات (بلا تصفية)' }, ...topics.map((t) => ({ value: t.id, label: t.title_ar ? `${t.title_ar} — ${t.title}` : t.title }))]}
      value={value ?? ''}
      onValueChange={(v) => onChange(v || null)}
    />
  );
}
