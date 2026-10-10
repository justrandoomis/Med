// /concepts/:conceptId — one concept: its names, status, every place it is STATED (exact quote, page, role — each a
// link back to the reader), its relations (inferred ones labelled, with reasons) and topic links. Opening a place in
// another lecture never changes the Source Lock of a study session.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Tag, X } from 'lucide-react';
import type { BrainConceptResponse, ConceptMentionView, TopicsResponse } from '@medlevo/shared';
import { Breadcrumbs, Button, EmptyState, ErrorState, LoadingState, Menu, MenuItem, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, brainApi, conceptUrl } from './api';
import { ConceptStatusPill, RelationRow } from './ConceptsScreen';
import '../review/learning.css';
import './brain.css';

function mentionHref(m: ConceptMentionView): string {
  const q = new URLSearchParams({ v: m.version_id, ...(m.page_id ? { page_id: m.page_id } : {}), region: m.region_id });
  return `/study/${encodeURIComponent(m.source_id)}?${q.toString()}`;
}

export function ConceptScreen() {
  const { conceptId = '' } = useParams();
  const q = useQuery<BrainConceptResponse>(BRAIN_PATHS.concept(conceptId));
  const topics = useQuery<TopicsResponse>('/library/topics');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  usePageTitle(q.data?.concept.name ?? 'مفهوم');
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل المفهوم…" />;
  if (q.error && !q.data) {
    return (
      <div className="ml-page">
        <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />
      </div>
    );
  }
  const c = q.data!.concept;
  const relations = q.data!.relations ?? [];
  const byLecture = new Map<string, ConceptMentionView[]>();
  for (const m of c.mentions ?? []) {
    const list = byLecture.get(m.source_id) ?? [];
    list.push(m);
    byLecture.set(m.source_id, list);
  }
  const decide = async (status: 'accepted' | 'rejected') => {
    setBusy(true);
    try {
      await brainApi.patchConcept(c.id, { status });
      toast.show({ title: status === 'accepted' ? 'قبلت المفهوم' : 'رفضت المفهوم — لن يُقترح مجددًا', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const linkToTopic = async (topicId: string, entityType: string, entityId: string) => {
    try {
      await brainApi.linkTopic(topicId, entityType, entityId);
      toast.show({ title: 'رُبط بالموضوع', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  const topicList = topics.data?.topics ?? [];

  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'المفاهيم', to: '/concepts' }, { label: <bdi>{c.name}</bdi> }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">
          {c.name_en && <bdi dir="ltr">{c.name_en}</bdi>}
          {c.name_en && c.name_ar && <span aria-hidden="true"> — </span>}
          {c.name_ar && <bdi dir="rtl">{c.name_ar}</bdi>}
        </h1>
        <div className="kb-concept__head">
          <ConceptStatusPill status={c.status} />
          {c.name_origin === 'owner' && <span className="lw-muted">اسم من تسميتك</span>}
          {c.aliases.length > 0 && <span className="lw-muted">أسماء أخرى: {c.aliases.join('، ')}</span>}
        </div>
      </header>
      {c.merged_into ? (
        <p className="lw-note">
          <span>
            هذا المفهوم مدموج في{' '}
            <Link className="lw-link" to={conceptUrl(c.merged_into.id)}>
              <bdi>{c.merged_into.name}</bdi>
            </Link>
            .
          </span>
        </p>
      ) : (
        <div className="kb-concept__actions">
          {c.status !== 'accepted' && (
            <Button size="sm" variant="secondary" icon={<Check size={16} />} onClick={() => void decide('accepted')} disabled={busy}>
              اقبل المفهوم
            </Button>
          )}
          {c.status !== 'rejected' && (
            <Button size="sm" variant="secondary" icon={<X size={16} />} onClick={() => void decide('rejected')} disabled={busy}>
              ارفض المفهوم
            </Button>
          )}
          {topicList.length > 0 && (
            <Menu trigger={<Button size="sm" variant="plain" icon={<Tag size={16} />}>اربطه بموضوع</Button>} label="اختر موضوعًا">
              {topicList.map((t) => (
                <MenuItem key={t.id} onSelect={() => void linkToTopic(t.id, 'concept', c.id)}>
                  {t.title_ar ?? t.title}
                </MenuItem>
              ))}
            </Menu>
          )}
        </div>
      )}
      <div className="lw-stack">
        <section className="lw-sheet" aria-labelledby="cs-m">
          <h2 id="cs-m" className="lw-sheet__title">
            أين يُذكر
          </h2>
          {byLecture.size === 0 ? (
            <EmptyState headingLevel={3} title="لا مواضع" description="مفهوم أضفته بنفسك ولم يظهر اسمه في نص المحاضرات المستخرجة بعد." />
          ) : (
            [...byLecture.entries()].map(([sid, ms]) => (
              <div key={sid} className="kb-mentions">
                <h3 className="lw-sheet__subtitle">
                  <bdi>{ms[0]!.source_title}</bdi>
                </h3>
                <ul className="kb-mention-list">
                  {ms.map((m) => (
                    <li key={m.id} className="kb-mention">
                      <div className="kb-mention__meta">
                        <Link className="lw-link" to={mentionHref(m)}>
                          {m.page_label_ar ?? 'افتح الموضع'}
                        </Link>
                        <span className="kb-role">{m.role_label_ar}</span>
                        <span className="lw-muted">{m.support === 'stated' ? 'مذكور في النص' : 'مرشح لربط الأسئلة'}</span>
                        {m.section && <span className="lw-muted">تحت «<bdi>{m.section}</bdi>»</span>}
                      </div>
                      {m.quote && (
                        <blockquote className="kb-quote" dir="auto">
                          {m.quote}
                        </blockquote>
                      )}
                      {topicList.length > 0 && (
                        <Menu trigger={<Button size="sm" variant="plain" icon={<Tag size={14} />}>اربط هذا الموضع بموضوع</Button>} label="اختر موضوعًا لهذا الموضع">
                          {topicList.map((t) => (
                            <MenuItem key={t.id} onSelect={() => void linkToTopic(t.id, 'source_region', m.region_id)}>
                              {t.title_ar ?? t.title}
                            </MenuItem>
                          ))}
                        </Menu>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
        <section className="lw-sheet" aria-labelledby="cs-r">
          <h2 id="cs-r" className="lw-sheet__title">
            العلاقات
          </h2>
          {relations.length === 0 ? (
            <p className="lw-muted">لا علاقات لهذا المفهوم بعد.</p>
          ) : (
            <ul className="kb-relations">
              {relations.map((r) => (
                <RelationRow key={r.id} relation={r} />
              ))}
            </ul>
          )}
          <p className="lw-muted">فتح موضع في محاضرة أخرى لا يغيّر نطاق المصدر (Source Lock) في جلسة دراستك.</p>
        </section>
      </div>
    </div>
  );
}
