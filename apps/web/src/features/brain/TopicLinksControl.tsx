// Round 7 H4 (§05): «الموضوعات» on an item that is not a source — a clinical case, a generated explanation, a past
// attempt. Shows the topics the item is linked to (accepted, and suggestions marked as such), links it to another topic
// (accepted at once: the owner decided) and removes a link. The item itself is never changed.
import { Link } from 'react-router-dom';
import { Tag, X } from 'lucide-react';
import type { TopicEntityType, TopicLinksResponse, TopicsResponse } from '@medlevo/shared';
import { Button, Menu, MenuItem, StatusPill, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useQuery } from '../library/data';
import { brainApi, topicUrl } from './api';
import './brain.css';

export function topicLinksPath(entityType: TopicEntityType, entityId: string): string {
  return `/library/topic-links?entity_type=${encodeURIComponent(entityType)}&entity_id=${encodeURIComponent(entityId)}`;
}

export function TopicLinksControl({ entityType, entityId, itemLabel, disabled }: { entityType: TopicEntityType; entityId: string; itemLabel: string; disabled?: boolean }) {
  const links = useQuery<TopicLinksResponse>(topicLinksPath(entityType, entityId));
  const topics = useQuery<TopicsResponse>('/library/topics', { cache: true });
  const toast = useToast();
  const live = (links.data?.links ?? []).filter((l) => l.status !== 'rejected');
  const linkedIds = new Set(live.filter((l) => l.status === 'accepted').map((l) => l.topic_id));
  const choices = (topics.data?.topics ?? []).filter((t) => !linkedIds.has(t.id));
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.show({ title: ok, tone: 'success' });
      void links.refresh();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  const headingId = `tl-${entityType}-${entityId}`;
  return (
    <section className="kb-topic-control" aria-labelledby={headingId}>
      <h2 id={headingId} className="kb-topic-control__title">
        <Tag size={16} aria-hidden="true" /> الموضوعات
      </h2>
      {links.loading && !links.data ? (
        <span className="lw-muted">جارٍ التحميل…</span>
      ) : links.error && !links.data ? (
        <span className="lw-muted">تعذّر تحميل روابط الموضوعات: {links.error.message}</span>
      ) : live.length === 0 ? (
        <span className="lw-muted">غير مرتبط بموضوع بعد.</span>
      ) : (
        <ul className="kb-topic-chips" aria-label={`موضوعات ${itemLabel}`}>
          {live.map((l) => {
            const name = l.topic_title_ar ?? l.topic_title;
            return (
              <li key={l.id} className="kb-topic-chip">
                <Link className="lw-link" to={topicUrl(l.topic_id)}>
                  <bdi>{name}</bdi>
                </Link>
                {l.status === 'suggested' && <StatusPill tone="info">اقتراح — لم تقرره بعد</StatusPill>}
                {l.status === 'suggested' && (
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void act(() => brainApi.decideTopicLink(l.id, 'accepted'), 'قبلت الربط')} aria-label={`اقبل ربط ${itemLabel} بموضوع ${name}`}>
                    اقبل
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="plain"
                  icon={<X size={14} />}
                  disabled={disabled}
                  onClick={() => void act(() => (l.status === 'suggested' ? brainApi.decideTopicLink(l.id, 'rejected') : brainApi.unlinkTopic(l.id)), 'أزلت الربط — العنصر نفسه لم يتغيّر')}
                  aria-label={`أزل ربط ${itemLabel} بموضوع ${name}`}
                >
                  أزل
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {topics.data && topics.data.topics.length === 0 ? (
        <Link className="lw-link" to="/library/topics">
          أنشئ موضوعًا أولًا
        </Link>
      ) : (
        choices.length > 0 && (
          <Menu
            label="اختر موضوعًا"
            trigger={
              <Button size="sm" variant="plain" icon={<Tag size={16} />} disabled={disabled}>
                اربط بموضوع
              </Button>
            }
          >
            {choices.map((t) => (
              <MenuItem key={t.id} onSelect={() => void act(() => brainApi.linkTopic(t.id, entityType, entityId), `رُبط بموضوع «${t.title_ar ?? t.title}»`)}>
                {t.title_ar ?? t.title}
              </MenuItem>
            ))}
          </Menu>
        )
      )}
    </section>
  );
}
