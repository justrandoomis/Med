// /library/topics and /library/topics/:topicId — topics (§05): create / rename / delete; what each topic links to
// (sources, places in sources, questions, concepts…); suggested links to accept or reject (the decision persists — a
// rejected suggestion is never made again); link sources, places in a source (regions) and questions by hand; use a
// topic as a library filter.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Filter, Plus, RotateCcw, Sparkles, Tag, Trash2, X } from 'lucide-react';
import {
  TOPIC_ENTITY_LABELS_AR,
  pageDisplayLabel,
  type LibraryTreeResponse,
  type PageRegionsResponse,
  type RegionKind,
  type QuestionListResponse,
  type SourcePagesResponse,
  type TopicDetailResponse,
  type TopicLinkDetail,
  type TopicEntityType,
} from '@medlevo/shared';
import { Breadcrumbs, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState, Select, StatusPill, TextField, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, brainApi, topicUrl } from './api';
import '../review/learning.css';
import './brain.css';

interface TopicListItem {
  id: string;
  title: string;
  title_ar: string | null;
  parent_topic_id: string | null;
  counts: { accepted: number; suggested: number; rejected: number; sources: number; questions: number };
}

export function TopicsScreen() {
  usePageTitle('الموضوعات');
  const q = useQuery<{ topics: TopicListItem[] }>(BRAIN_PATHS.topics, { cache: true });
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const topics = q.data?.topics ?? [];
  const roots = topics.filter((t) => !t.parent_topic_id || !topics.some((x) => x.id === t.parent_topic_id));
  const childrenOf = (id: string) => topics.filter((t) => t.parent_topic_id === id);
  const renderTree = (list: TopicListItem[], depth: number): React.ReactNode => (
    <ul className={depth === 0 ? 'kb-topics' : 'kb-topics kb-topics--nested'} aria-label={depth === 0 ? 'الموضوعات' : undefined}>
      {list.map((t) => (
        <li key={t.id} className="kb-topic">
          <Link className="kb-topic__title" to={topicUrl(t.id)}>
            <Tag size={16} aria-hidden="true" />
            <bdi>{t.title_ar ? `${t.title_ar} — ${t.title}` : t.title}</bdi>
          </Link>
          <span className="lw-muted">
            مصادر {t.counts.sources} · أسئلة {t.counts.questions} · مقبولة {t.counts.accepted} · مقترحة {t.counts.suggested}
          </span>
          {childrenOf(t.id).length > 0 && renderTree(childrenOf(t.id), depth + 1)}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'الموضوعات' }]} />
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">الموضوعات</h1>
          <p className="ml-page__lede">المجلدات تنظّم الملفات، والموضوعات تربط المعرفة: الملف الواحد يرتبط بأكثر من موضوع دون نسخه.</p>
        </div>
        <Button variant="primary" icon={<Plus size={18} />} onClick={() => setCreating(true)} disabled={q.fromCache}>
          موضوع جديد
        </Button>
      </header>
      {q.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      {q.loading && !q.data && <LoadingState stage="جارٍ تحميل الموضوعات…" />}
      {q.error && !q.data && <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />}
      {q.data && topics.length === 0 && (
        <EmptyState
          title="لا موضوعات بعد"
          description="أنشئ موضوعًا (مثل «Appendicitis»)، وسيقترح النظام المصادر والمواضع والأسئلة التي تذكره لتقبلها أو ترفضها."
          actions={
            <Button variant="primary" icon={<Plus size={18} />} onClick={() => setCreating(true)}>
              موضوع جديد
            </Button>
          }
        />
      )}
      {topics.length > 0 && renderTree(roots, 0)}
      {creating && <TopicDialog topics={topics} onClose={() => setCreating(false)} onSaved={(id) => navigate(topicUrl(id))} />}
    </div>
  );
}

function TopicDialog({ topics, initial, onClose, onSaved }: { topics: TopicListItem[]; initial?: TopicDetailResponse['topic']; onClose: () => void; onSaved?: (id: string) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [titleAr, setTitleAr] = useState(initial?.title_ar ?? '');
  const [parent, setParent] = useState(initial?.parent_topic_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), title_ar: titleAr.trim() || null, parent_topic_id: parent || null };
      const r = initial ? await brainApi.patchTopic(initial.id, body) : await brainApi.createTopic(body);
      // suggestions are deterministic: made now for the new / renamed name (decisions are never overridden)
      const s = await brainApi.suggestTopics(r.topic.id).catch(() => null);
      toast.show({ title: `${initial ? 'حُفظ الموضوع' : 'أُنشئ الموضوع'}${s && s.created ? ` — ${s.created} روابط مقترحة لتراجعها` : ''}`, tone: 'success' });
      onSaved?.(r.topic.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? 'تعديل الموضوع' : 'موضوع جديد'}
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!title.trim()}>
            احفظ
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      <div className="lw-stack-sm">
        <TextField label="اسم الموضوع" value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" required />
        <TextField label="الاسم العربي (اختياري)" value={titleAr} onChange={(e) => setTitleAr(e.target.value)} dir="rtl" />
        <Select<string>
          label="داخل موضوع (اختياري)"
          options={[{ value: '', label: 'بلا موضوع أب' }, ...topics.filter((t) => t.id !== initial?.id).map((t) => ({ value: t.id, label: t.title_ar ?? t.title }))]}
          value={parent}
          onValueChange={setParent}
        />
        {error && (
          <p className="lw-note lw-note--warn" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

const TYPE_ORDER: TopicEntityType[] = ['source', 'source_region', 'question', 'concept', 'library_node', 'image_asset', 'flashcard', 'note'];

export function TopicScreen() {
  const { topicId = '' } = useParams();
  const q = useQuery<TopicDetailResponse>(BRAIN_PATHS.topic(topicId));
  const all = useQuery<{ topics: TopicListItem[] }>(BRAIN_PATHS.topics);
  const toast = useToast();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<null | 'edit' | 'delete' | 'link-source' | 'link-region' | 'link-question'>(null);
  usePageTitle(q.data?.topic.title ?? 'موضوع');
  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل الموضوع…" />;
  if (q.error && !q.data) {
    return (
      <div className="ml-page">
        <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />
      </div>
    );
  }
  const d = q.data!;
  const suggested = d.links.filter((l) => l.status === 'suggested');
  const accepted = d.links.filter((l) => l.status === 'accepted');
  const rejected = d.links.filter((l) => l.status === 'rejected');
  const suggest = async () => {
    try {
      const r = await brainApi.suggestTopics(d.topic.id);
      toast.show({ title: r.created ? `${r.created} اقتراحات جديدة` : 'لا اقتراحات جديدة — قراراتك السابقة باقية', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, { label: 'الموضوعات', to: '/library/topics' }, { label: <bdi>{d.topic.title}</bdi> }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">
          <bdi>{d.topic.title_ar ? `${d.topic.title_ar} — ${d.topic.title}` : d.topic.title}</bdi>
        </h1>
        <p className="lw-muted">
          مقبولة {d.counts.accepted} · مقترحة {d.counts.suggested} · مرفوضة {d.counts.rejected}
        </p>
        <div className="kb-actions">
          <Link className="lw-link" to={`/library?topic=${encodeURIComponent(d.topic.id)}`}>
            <Filter size={16} aria-hidden="true" /> اعرض المكتبة مصفّاة بهذا الموضوع
          </Link>
          <Button size="sm" icon={<Sparkles size={16} />} onClick={() => void suggest()}>
            اقترح روابط الآن
          </Button>
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setDialog('link-source')}>
            اربط مصدرًا
          </Button>
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setDialog('link-region')}>
            اربط موضعًا من مصدر
          </Button>
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setDialog('link-question')}>
            اربط سؤالًا
          </Button>
          <Button size="sm" variant="plain" onClick={() => setDialog('edit')}>
            تعديل
          </Button>
          <Button size="sm" variant="plain" icon={<Trash2 size={16} />} onClick={() => setDialog('delete')}>
            حذف
          </Button>
        </div>
      </header>
      <div className="lw-stack">
        {d.children.length > 0 && (
          <p className="lw-muted">
            مواضيع فرعية:{' '}
            {d.children.map((c, i) => (
              <span key={c.id}>
                {i > 0 && '، '}
                <Link className="lw-link" to={topicUrl(c.id)}>
                  <bdi>{c.title_ar ?? c.title}</bdi>
                </Link>
              </span>
            ))}
          </p>
        )}
        <LinkSection title="روابط مقترحة — راجعها" empty="لا اقتراحات تنتظر قرارك." links={suggested} />
        <LinkSection title="مرتبط بالموضوع" empty="لا روابط مقبولة بعد." links={accepted} grouped />
        {rejected.length > 0 && (
          <details className="lw-sheet">
            <summary>المرفوضة ({rejected.length}) — لن تُقترح مجددًا</summary>
            <ul className="kb-topic-links">
              {rejected.map((l) => (
                <LinkRow key={l.id} link={l} />
              ))}
            </ul>
          </details>
        )}
      </div>
      {dialog === 'edit' && <TopicDialog topics={all.data?.topics ?? []} initial={d.topic} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`حذف الموضوع «${d.topic.title}»؟`}
        impact={`تُزال روابطه (${d.links.length}) فقط؛ المصادر والأسئلة والمواضع نفسها لا تُحذف.`}
        confirmLabel="احذف الموضوع"
        destructive
        onCancel={() => setDialog(null)}
        onConfirm={async () => {
          await brainApi.deleteTopic(d.topic.id);
          navigate('/library/topics');
        }}
      />
      {dialog === 'link-source' && <LinkSourceDialog topicId={d.topic.id} onClose={() => setDialog(null)} />}
      {dialog === 'link-region' && <LinkRegionDialog topicId={d.topic.id} onClose={() => setDialog(null)} />}
      {dialog === 'link-question' && <LinkQuestionDialog topicId={d.topic.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function LinkSection({ title, empty, links, grouped }: { title: string; empty: string; links: TopicLinkDetail[]; grouped?: boolean }) {
  const groups = useMemo(() => {
    if (!grouped) return [{ type: null as TopicEntityType | null, links }];
    return TYPE_ORDER.map((t) => ({ type: t, links: links.filter((l) => l.entity_type === t) })).filter((g) => g.links.length > 0);
  }, [links, grouped]);
  return (
    <section className="lw-sheet" aria-label={title}>
      <h2 className="lw-sheet__title">{title}</h2>
      {links.length === 0 ? (
        <p className="lw-muted">{empty}</p>
      ) : (
        groups.map((g) => (
          <div key={g.type ?? 'all'}>
            {g.type && <h3 className="lw-sheet__subtitle">{TOPIC_ENTITY_LABELS_AR[g.type]}</h3>}
            <ul className="kb-topic-links">
              {g.links.map((l) => (
                <LinkRow key={l.id} link={l} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function LinkRow({ link: l }: { link: TopicLinkDetail }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show({ title: msg, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const typeLabel = TOPIC_ENTITY_LABELS_AR[l.entity_type as TopicEntityType] ?? l.entity_type;
  const label = l.label ?? 'لم يعد موجودًا (حُذف أو أعيدت معالجة الصفحة)';
  return (
    <li className="kb-topic-link">
      <div className="kb-topic-link__main">
        <span className="kb-role">{typeLabel}</span>
        {l.href && l.label ? (
          <Link className="lw-link" to={l.href}>
            <bdi>{label}</bdi>
          </Link>
        ) : (
          <span className="lw-muted">
            <bdi>{label}</bdi>
          </span>
        )}
        {l.sublabel && (
          <span className="lw-muted">
            <bdi>{l.sublabel}</bdi>
          </span>
        )}
        {l.origin === 'auto' ? <StatusPill tone="info">اقتراح تلقائي</StatusPill> : <StatusPill tone="neutral">ربطته بنفسك</StatusPill>}
      </div>
      {l.reason_ar && <p className="lw-muted">لماذا: {l.reason_ar}</p>}
      <div className="kb-concept__actions">
        {l.status !== 'accepted' && (
          <Button size="sm" variant="secondary" icon={<Check size={16} />} disabled={busy} onClick={() => void act(() => brainApi.decideTopicLink(l.id, 'accepted'), 'قبلت الرابط')} aria-label={`اقبل الرابط: ${label}`}>
            اقبل
          </Button>
        )}
        {l.status === 'suggested' && (
          <Button size="sm" variant="secondary" icon={<X size={16} />} disabled={busy} onClick={() => void act(() => brainApi.decideTopicLink(l.id, 'rejected'), 'رفضت الاقتراح — لن يُقترح مجددًا')} aria-label={`ارفض الاقتراح: ${label}`}>
            ارفض
          </Button>
        )}
        {l.status === 'accepted' && (
          <Button size="sm" variant="plain" icon={<X size={16} />} disabled={busy} onClick={() => void act(() => brainApi.unlinkTopic(l.id), 'أزلت الرابط')} aria-label={`أزل الرابط: ${label}`}>
            أزل الرابط
          </Button>
        )}
        {l.status === 'rejected' && (
          <Button size="sm" variant="plain" icon={<RotateCcw size={16} />} disabled={busy} onClick={() => void act(() => brainApi.decideTopicLink(l.id, 'suggested'), 'أعدته إلى الاقتراحات')} aria-label={`أعد إلى الاقتراحات: ${label}`}>
            أعده إلى الاقتراحات
          </Button>
        )}
      </div>
    </li>
  );
}

function LinkSourceDialog({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const tree = useQuery<LibraryTreeResponse>('/library/tree', { cache: true });
  const toast = useToast();
  const sources = (tree.data?.sources ?? []).filter((s) => !s.deleted_at);
  const [sid, setSid] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await brainApi.linkTopic(topicId, 'source', sid || sources[0]!.id);
      toast.show({ title: 'رُبط المصدر بالموضوع', tone: 'success' });
      onClose();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="اربط مصدرًا بالموضوع"
      description="الربط لا ينقل الملف ولا ينسخه؛ يبقى في مجلده."
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={sources.length === 0}>
            اربط
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      {tree.loading && !tree.data ? (
        <LoadingState stage="جارٍ تحميل المصادر…" inline />
      ) : sources.length === 0 ? (
        <p className="lw-muted">لا مصادر في مكتبتك بعد.</p>
      ) : (
        <Select<string> label="المصدر" options={sources.map((s) => ({ value: s.id, label: s.title }))} value={sid || sources[0]!.id} onValueChange={setSid} />
      )}
    </Dialog>
  );
}

/** Page furniture and sub-parts are not offered (a table is linked whole, a question with its options). */
const UNLINKABLE_REGION_KINDS = new Set<RegionKind>(['header', 'footer', 'table_cell', 'option']);

/**
 * Link one place in a source (a region: heading, paragraph, table, figure…) to the topic: choose the source, then the
 * page, then the place — the text of each place is shown so the choice is made on what the page says.
 */
function LinkRegionDialog({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const tree = useQuery<LibraryTreeResponse>('/library/tree', { cache: true });
  const toast = useToast();
  const sources = (tree.data?.sources ?? []).filter((s) => !s.deleted_at && s.active_version_id);
  const [sid, setSid] = useState('');
  const source = sources.find((s) => s.id === sid) ?? sources[0];
  const pages = useQuery<SourcePagesResponse>(source ? `/sources/${encodeURIComponent(source.id)}/versions/${encodeURIComponent(source.active_version_id!)}/pages` : null);
  const pageList = (pages.data?.pages ?? []).filter((p) => p.processing_status === 'ready' || p.processing_status === 'needs_review');
  const [pid, setPid] = useState('');
  const page = pageList.find((p) => p.id === pid) ?? pageList[0];
  const regions = useQuery<PageRegionsResponse>(page ? `/sources/pages/${encodeURIComponent(page.id)}/regions` : null);
  const regionList = (regions.data?.regions ?? []).filter((r) => !!(r.text ?? '').trim() && !UNLINKABLE_REGION_KINDS.has(r.kind));
  const [busyId, setBusyId] = useState<string | null>(null);
  const link = async (regionId: string) => {
    setBusyId(regionId);
    try {
      await brainApi.linkTopic(topicId, 'source_region', regionId);
      toast.show({ title: 'رُبط الموضع بالموضوع', tone: 'success' });
      onClose();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Dialog open onClose={onClose} title="اربط موضعًا من مصدر بالموضوع" description="اختر المصدر ثم الصفحة ثم الموضع بنصه. الربط لا يغيّر المصدر." footer={<Button onClick={onClose}>إغلاق</Button>}>
      {tree.loading && !tree.data ? (
        <LoadingState stage="جارٍ تحميل المصادر…" inline />
      ) : sources.length === 0 ? (
        <p className="lw-muted">لا مصادر معالجة في مكتبتك بعد.</p>
      ) : (
        <div className="lw-stack">
          <Select<string>
            label="المصدر"
            options={sources.map((s) => ({ value: s.id, label: s.title }))}
            value={source!.id}
            onValueChange={(v) => {
              setSid(v);
              setPid('');
            }}
          />
          {pages.loading && !pages.data ? (
            <LoadingState stage="جارٍ تحميل الصفحات…" inline />
          ) : pageList.length === 0 ? (
            <p className="lw-muted">لا صفحات جاهزة في هذا المصدر بعد.</p>
          ) : (
            <Select<string> label="الصفحة" options={pageList.map((p) => ({ value: p.id, label: pageDisplayLabel(p) }))} value={page!.id} onValueChange={setPid} />
          )}
          {page && regions.loading && !regions.data && <LoadingState stage="جارٍ تحميل مواضع الصفحة…" inline />}
          {page && regions.data && regionList.length === 0 && <p className="lw-muted">لا مواضع نصية في هذه الصفحة.</p>}
          {regionList.length > 0 && (
            <ul className="kb-topic-links" aria-label={`مواضع ${pageDisplayLabel(page!)}`}>
              {regionList.slice(0, 60).map((r) => {
                const text = (r.text ?? '').trim();
                const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
                return (
                  <li key={r.id} className="kb-topic-link">
                    <span>
                      <bdi>{preview}</bdi>
                    </span>
                    <Button size="sm" variant="secondary" loading={busyId === r.id} onClick={() => void link(r.id)} aria-label={`اربط الموضع: ${preview.slice(0, 60)}`}>
                      اربط
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function LinkQuestionDialog({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<QuestionListResponse['items'] | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    setBusy(true);
    try {
      const r = await api.get<QuestionListResponse>('/questions', { query: { q: term.trim(), limit: 20 } });
      setResults(r.items);
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const link = async (qid: string) => {
    try {
      await brainApi.linkTopic(topicId, 'question', qid);
      toast.show({ title: 'رُبط السؤال بالموضوع', tone: 'success' });
      onClose();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <Dialog open onClose={onClose} title="اربط سؤالًا بالموضوع" footer={<Button onClick={onClose}>إغلاق</Button>}>
      <form
        className="kb-filter-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <TextField label="ابحث في نصوص الأسئلة" value={term} onChange={(e) => setTerm(e.target.value)} dir="auto" />
        <Button type="submit" loading={busy} disabled={!term.trim()}>
          ابحث
        </Button>
      </form>
      {results && results.length === 0 && <p className="lw-muted">لا أسئلة تطابق.</p>}
      {results && results.length > 0 && (
        <ul className="kb-topic-links">
          {results.map((r) => (
            <li key={r.id} className="kb-topic-link">
              <span>
                <bdi>{r.stem_preview}</bdi> <span className="lw-muted">({r.origin_label_ar})</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void link(r.id)} aria-label={`اربط السؤال: ${r.stem_preview}`}>
                اربط
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
