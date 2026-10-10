// /knowledge?course= — Student Knowledge Map (§44): per concept, what you READ, PRACTISED and (as an ESTIMATE)
// mastered, its prerequisites with their own state, and why. Every state is words + icon (never colour alone); the
// mastery estimate is labelled an estimate and is absent below its minimum sample.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BookOpen, CheckCircle2, Circle, PencilLine, TrendingUp } from 'lucide-react';
import { KNOWLEDGE_STATES, type KnowledgeState, type LibraryTreeResponse, type StudentConceptView, type StudentKnowledgeResponse } from '@medlevo/shared';
import { Breadcrumbs, EmptyState, ErrorState, LoadingState, Select, StatusPill } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, conceptUrl } from './api';
import { KNOWLEDGE_STATE_META, masteryText } from './model';
import '../review/learning.css';
import './brain.css';

const ICONS = { circle: Circle, book: BookOpen, pencil: PencilLine, alert: AlertTriangle, trend: TrendingUp, check: CheckCircle2 };

export function KnowledgeStatePill({ state }: { state: KnowledgeState }) {
  const m = KNOWLEDGE_STATE_META[state];
  const Icon = ICONS[m.icon];
  return (
    <StatusPill tone={m.tone} icon={<Icon size={14} />}>
      {m.label}
    </StatusPill>
  );
}

export function KnowledgeScreen() {
  usePageTitle('خريطة معرفتي');
  const [params, setParams] = useSearchParams();
  const course = params.get('course');
  const [state, setState] = useState<KnowledgeState | 'all'>('all');
  const q = useQuery<StudentKnowledgeResponse>(BRAIN_PATHS.knowledge(course), { cache: true });
  const tree = useQuery<LibraryTreeResponse>('/library/tree', { cache: true });
  const courses = (tree.data?.nodes ?? []).filter((n) => n.kind === 'course');
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => state === 'all' || i.state === state), [q.data, state]);
  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'نقاط الضعف', to: '/weakness' }, { label: 'خريطة معرفتي' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">خريطة معرفتي</h1>
        <p className="ml-page__lede">كل مفهوم: ما قرأته، وما تدربت عليه، وتقدير إتقانك له، ومتطلباته السابقة، ولماذا.</p>
      </header>
      <div className="lw-stack">
        <div className="kb-filter-row">
          <Select<string>
            label="النطاق"
            options={[{ value: '', label: 'كل الكورسات' }, ...courses.map((c) => ({ value: c.id, label: c.title }))]}
            value={course ?? ''}
            onValueChange={(v) => {
              const next = new URLSearchParams(params);
              if (v) next.set('course', v);
              else next.delete('course');
              setParams(next, { replace: true });
            }}
          />
          <Select<string>
            label="الحالة"
            options={[{ value: 'all', label: 'كل الحالات' }, ...KNOWLEDGE_STATES.map((s) => ({ value: s, label: `${KNOWLEDGE_STATE_META[s].label} (${q.data?.counts[s] ?? 0})` }))]}
            value={state}
            onValueChange={(v) => setState(v as KnowledgeState | 'all')}
          />
        </div>
        {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
        {q.loading && !q.data && <LoadingState stage="جارٍ جمع ما قرأته وما تدربت عليه…" />}
        {q.error && !q.data && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
        {q.data && (
          <>
            <p className="lw-note" role="note">
              <span>{q.data.estimate_note_ar}</span>
            </p>
            <ul className="kb-state-counts" aria-label="عدد المفاهيم في كل حالة">
              {KNOWLEDGE_STATES.map((s) => (
                <li key={s}>
                  <KnowledgeStatePill state={s} /> <span>{q.data!.counts[s]}</span>
                </li>
              ))}
            </ul>
            {items.length === 0 ? (
              <EmptyState headingLevel={2} title="لا مفاهيم هنا" description="تظهر المفاهيم بعد استخراج هيكل محاضراتك. اختر نطاقًا آخر أو حالة أخرى." />
            ) : (
              <ul className="kb-know-list" aria-label="المفاهيم وحالتها">
                {items.map((i) => (
                  <ConceptKnowledge key={i.concept_id} item={i} />
                ))}
              </ul>
            )}
            <ul className="kb-notes">
              {q.data.notes_ar.map((n) => (
                <li key={n} className="lw-muted">
                  {n}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function ConceptKnowledge({ item: i }: { item: StudentConceptView }) {
  return (
    <li className="kb-know">
      <div className="kb-concept__head">
        <Link className="kb-concept__name" to={conceptUrl(i.concept_id)}>
          <bdi>{i.name}</bdi>
        </Link>
        <KnowledgeStatePill state={i.state} />
        {i.concept_status === 'suggested' && <span className="lw-muted">مفهوم مقترح</span>}
      </div>
      <dl className="kb-know__facts">
        <div>
          <dt>القراءة</dt>
          <dd>{i.reading.pages_total ? `${i.reading.pages_viewed} من ${i.reading.pages_total} صفحات يُذكر فيها` : 'لا صفحات معروفة'}</dd>
        </div>
        <div>
          <dt>التدريب</dt>
          <dd>
            {i.practice.question_attempts} محاولة على {i.practice.questions} سؤال{i.practice.cards ? ` · ${i.practice.card_reviews} مراجعة لـ${i.practice.cards} بطاقة` : ''}
          </dd>
        </div>
        <div>
          <dt>الإتقان</dt>
          <dd>{masteryText(i.mastery_estimate, i.mastery_sample)}</dd>
        </div>
      </dl>
      {i.prerequisites.length > 0 && (
        <div className="kb-prereqs">
          <span className="lw-muted">متطلبات سابقة:</span>
          <ul>
            {i.prerequisites.map((p) => (
              <li key={p.relation_id}>
                <Link className="lw-link" to={conceptUrl(p.concept_id)}>
                  <bdi>{p.name}</bdi>
                </Link>{' '}
                <KnowledgeStatePill state={p.state} />{' '}
                <span className="lw-muted">{p.support === 'inferred' ? '(علاقة مستنتجة — مقترحة)' : '(علاقة أقررتها)'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="kb-why">
        <summary>لماذا هذه الحالة؟</summary>
        <ul>
          {i.reasons_ar.map((r) => (
            <li key={r}>{r}</li>
          ))}
          <li>{i.mastery_basis_ar}</li>
        </ul>
      </details>
      <p className="kb-next">
        <span className="lw-muted">الخطوة التالية:</span> {i.next_step_ar}
        {i.lectures[0] && (
          <>
            {' '}
            <Link className="lw-link" to={`/study/${encodeURIComponent(i.lectures[0].source_id)}${i.lectures[0].page_ids[0] ? `?page_id=${encodeURIComponent(i.lectures[0].page_ids[0])}` : ''}`}>
              افتح {i.lectures[0].first_page_label_ar ?? 'المحاضرة'}
            </Link>
          </>
        )}
      </p>
    </li>
  );
}
