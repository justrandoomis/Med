// /concepts?course=&source= — concept correction view (§16 «correctable suggestions», §05 «topics I can correct»):
// accept / reject / rename / merge concept candidates, add your own concept, and edit concept relations (accept or reject
// suggested — inferred — relations, add your own, delete). Every decision persists across re-extraction.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, CircleDot, GitMerge, Pencil, Plus, X } from 'lucide-react';
import {
  CONCEPT_STATUS_LABELS_AR,
  RELATION_KINDS,
  RELATION_LABELS_AR,
  conceptRoleLabelAr,
  type BrainConceptListResponse,
  type BrainConceptView,
  type ConceptRelationListResponse,
  type ConceptRelationView,
  type ConceptStatus,
  type RelationKind,
} from '@medlevo/shared';
import { Breadcrumbs, Button, Dialog, EmptyState, ErrorState, LoadingState, SegmentedControl, Select, StatusPill, TextField, useToast, type StatusTone } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, brainApi, conceptUrl, knowledgeUrl } from './api';
import '../review/learning.css';
import './brain.css';

type Filter = 'open' | 'accepted' | 'suggested' | 'rejected';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'open', label: 'المقترحة والمقبولة' },
  { value: 'suggested', label: 'المقترحة' },
  { value: 'accepted', label: 'المقبولة' },
  { value: 'rejected', label: 'المرفوضة' },
];

export const STATUS_TONE: Record<ConceptStatus, { tone: StatusTone; icon: React.ReactNode }> = {
  suggested: { tone: 'info', icon: <CircleDot size={14} /> },
  accepted: { tone: 'success', icon: <Check size={14} /> },
  rejected: { tone: 'neutral', icon: <X size={14} /> },
};

export function ConceptStatusPill({ status }: { status: ConceptStatus }) {
  return (
    <StatusPill tone={STATUS_TONE[status].tone} icon={STATUS_TONE[status].icon}>
      {CONCEPT_STATUS_LABELS_AR[status]}
    </StatusPill>
  );
}

export function ConceptsScreen() {
  usePageTitle('المفاهيم');
  const [params] = useSearchParams();
  const course = params.get('course');
  const source = params.get('source');
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const list = useQuery<BrainConceptListResponse>(BRAIN_PATHS.concepts({ courseNodeId: course, sourceId: source, status: filter === 'open' ? null : filter }));
  const all = useQuery<BrainConceptListResponse>(BRAIN_PATHS.concepts({ courseNodeId: course, sourceId: source, status: 'all' }));
  const relations = useQuery<ConceptRelationListResponse>(course ? BRAIN_PATHS.relations({ courseNodeId: course }) : null);
  const [dialog, setDialog] = useState<null | { kind: 'rename' | 'merge'; concept: BrainConceptView } | { kind: 'create' } | { kind: 'relation' }>(null);
  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.items ?? []).filter((c) => !q || `${c.name_en ?? ''} ${c.name_ar ?? ''}`.toLowerCase().includes(q));
  }, [list.data, search]);
  const back = course ? { label: 'الكورس', to: `/library/${encodeURIComponent(course)}?tab=map` } : null;

  return (
    <div className="ml-page lw-page">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, ...(back ? [back] : []), { label: 'المفاهيم' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">المفاهيم والعلاقات</h1>
        <p className="ml-page__lede">ما استخرجه النظام من محاضراتك، لتصححه: اقبل أو ارفض أو أعد التسمية أو ادمج. قراراتك تبقى عند إعادة الاستخراج.</p>
      </header>
      <div className="lw-stack">
        <div className="kb-filter-row">
          <SegmentedControl<Filter> label="عرض" options={FILTERS} value={filter} onValueChange={setFilter} size="sm" />
          <TextField label="ابحث في الأسماء" hideLabel type="search" placeholder="ابحث في أسماء المفاهيم" value={search} onChange={(e) => setSearch(e.target.value)} dir="auto" />
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setDialog({ kind: 'create' })}>
            مفهوم جديد
          </Button>
          {course && (
            <Link className="lw-link" to={knowledgeUrl(course)}>
              خريطة معرفتي في هذا الكورس
            </Link>
          )}
        </div>
        {list.loading && !list.data && <LoadingState stage="جارٍ تحميل المفاهيم…" />}
        {list.error && !list.data && <ErrorState message={list.error.message} onRetry={() => void list.refresh()} />}
        {list.data && (
          <>
            <p className="lw-muted">
              مقترحة {list.data.counts.suggested} · مقبولة {list.data.counts.accepted} · مرفوضة {list.data.counts.rejected} · مدموجة {list.data.counts.merged}
            </p>
            {items.length === 0 ? (
              <EmptyState headingLevel={2} title="لا مفاهيم هنا" description="تظهر المفاهيم بعد معالجة المحاضرات واستخراج هيكلها (العناوين والتعريفات والأقسام والجداول)." />
            ) : (
              <ul className="kb-concepts" aria-label="المفاهيم">
                {items.map((c) => (
                  <ConceptRow key={c.id} concept={c} onRename={() => setDialog({ kind: 'rename', concept: c })} onMerge={() => setDialog({ kind: 'merge', concept: c })} />
                ))}
              </ul>
            )}
            <ul className="kb-notes">
              {list.data.notes_ar.map((n) => (
                <li key={n} className="lw-muted">
                  {n}
                </li>
              ))}
            </ul>
          </>
        )}
        {course && <RelationsSection relations={relations.data} loading={relations.loading} onAdd={() => setDialog({ kind: 'relation' })} />}
      </div>
      {dialog?.kind === 'rename' && <RenameDialog concept={dialog.concept} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'merge' && <MergeDialog concept={dialog.concept} candidates={(all.data?.items ?? []).filter((x) => x.id !== dialog.concept.id && x.status !== 'rejected')} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'create' && <CreateDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'relation' && <RelationDialog concepts={(all.data?.items ?? []).filter((x) => x.status !== 'rejected')} onClose={() => setDialog(null)} />}
    </div>
  );
}

function ConceptRow({ concept: c, onRename, onMerge }: { concept: BrainConceptView; onRename: () => void; onMerge: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const decide = async (status: ConceptStatus) => {
    setBusy(true);
    try {
      await brainApi.patchConcept(c.id, { status });
      toast.show({ title: status === 'accepted' ? `قبلت «${c.name}»` : status === 'rejected' ? `رفضت «${c.name}» — لن يُقترح مجددًا` : `أعدت «${c.name}» إلى المقترحات`, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="kb-concept">
      <div className="kb-concept__head">
        <Link className="kb-concept__name" to={conceptUrl(c.id)}>
          {c.name_en && <bdi dir="ltr">{c.name_en}</bdi>}
          {c.name_en && c.name_ar && <span aria-hidden="true"> — </span>}
          {c.name_ar && <bdi dir="rtl">{c.name_ar}</bdi>}
        </Link>
        <ConceptStatusPill status={c.status} />
        {c.name_origin === 'owner' && <span className="lw-muted">اسم من تسميتك</span>}
      </div>
      <p className="lw-muted">
        {c.roles.length ? c.roles.map((r) => conceptRoleLabelAr(r)).join('، ') : 'مرشح من النص'} · {c.mention_count} {c.mention_count === 1 ? 'ذكر' : 'مواضع'} في {c.lecture_ids.length}{' '}
        {c.lecture_ids.length === 1 ? 'مصدر' : 'مصادر'}
        {c.has_definition ? ' · له تعريف في المحاضرة' : ''}
        {c.aliases.length ? ` · أسماء أخرى: ${c.aliases.join('، ')}` : ''}
      </p>
      <div className="kb-concept__actions">
        {c.status !== 'accepted' && (
          <Button size="sm" variant="secondary" icon={<Check size={16} />} onClick={() => void decide('accepted')} disabled={busy} aria-label={`اقبل المفهوم ${c.name}`}>
            اقبل
          </Button>
        )}
        {c.status !== 'rejected' ? (
          <Button size="sm" variant="secondary" icon={<X size={16} />} onClick={() => void decide('rejected')} disabled={busy} aria-label={`ارفض المفهوم ${c.name}`}>
            ارفض
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => void decide('suggested')} disabled={busy} aria-label={`أعد ${c.name} إلى المقترحات`}>
            أعده إلى المقترحات
          </Button>
        )}
        <Button size="sm" variant="plain" icon={<Pencil size={16} />} onClick={onRename} aria-label={`أعد تسمية ${c.name}`}>
          أعد التسمية
        </Button>
        <Button size="sm" variant="plain" icon={<GitMerge size={16} />} onClick={onMerge} aria-label={`ادمج ${c.name} في مفهوم آخر`}>
          ادمج
        </Button>
      </div>
    </li>
  );
}

function RenameDialog({ concept, onClose }: { concept: BrainConceptView; onClose: () => void }) {
  const toast = useToast();
  const [en, setEn] = useState(concept.name_en ?? '');
  const [ar, setAr] = useState(concept.name_ar ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!en.trim() && !ar.trim()) {
      setError('اكتب اسمًا واحدًا على الأقل.');
      return;
    }
    setBusy(true);
    try {
      await brainApi.patchConcept(concept.id, { name_en: en.trim() || null, name_ar: ar.trim() || null });
      toast.show({ title: 'حُفظ الاسم. الاسم القديم يبقى اسمًا بديلًا حتى لا يُعاد اقتراحه.', tone: 'success' });
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
      title="إعادة تسمية المفهوم"
      description="اسمك يظهر في كل مكان؛ النص الأصلي في المحاضرة لا يتغير."
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            احفظ
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      <div className="lw-stack-sm">
        <TextField label="الاسم الإنجليزي" value={en} onChange={(e) => setEn(e.target.value)} dir="ltr" lang="en" />
        <TextField label="الاسم العربي" value={ar} onChange={(e) => setAr(e.target.value)} dir="rtl" />
        {error && (
          <p className="lw-note lw-note--warn" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function MergeDialog({ concept, candidates, onClose }: { concept: BrainConceptView; candidates: BrainConceptView[]; onClose: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState(candidates[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setBusy(true);
    try {
      const r = await brainApi.mergeConcept(concept.id, target);
      toast.show({ title: `دُمج «${concept.name}» في «${r.concept.name}»`, tone: 'success' });
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
      title={`دمج «${concept.name}» في مفهوم آخر`}
      description="تنتقل مواضعه وعلاقاته وأسماؤه إلى المفهوم المختار، ويبقى اسمه القديم اسمًا بديلًا؛ لا يُحذف شيء من المحاضرات. الدمج لا يُلغى من هذه الشاشة."
      footer={
        <>
          <Button variant="primary" onClick={() => void merge()} loading={busy} disabled={!target}>
            ادمج
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="lw-muted">لا مفهوم آخر في هذا النطاق للدمج فيه.</p>
      ) : (
        <Select<string> label="ادمجه في" options={candidates.map((c) => ({ value: c.id, label: [c.name_en, c.name_ar].filter(Boolean).join(' — ') }))} value={target} onValueChange={setTarget} />
      )}
      {error && (
        <p className="lw-note lw-note--warn" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await brainApi.createConcept({ name_en: en.trim() || null, name_ar: ar.trim() || null });
      toast.show({ title: 'أضفت المفهوم.', tone: 'success' });
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
      title="مفهوم جديد"
      description="مفهوم تضيفه بنفسك (مقبول). يرتبط بالمحاضرات عندما يظهر اسمه فيها."
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!en.trim() && !ar.trim()}>
            أضف
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      <div className="lw-stack-sm">
        <TextField label="الاسم الإنجليزي" value={en} onChange={(e) => setEn(e.target.value)} dir="ltr" lang="en" />
        <TextField label="الاسم العربي" value={ar} onChange={(e) => setAr(e.target.value)} dir="rtl" />
        {error && (
          <p className="lw-note lw-note--warn" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function RelationsSection({ relations, loading, onAdd }: { relations: ConceptRelationListResponse | null; loading: boolean; onAdd: () => void }) {
  return (
    <section className="lw-sheet" aria-labelledby="kb-rel-h">
      <div className="lw-head">
        <h2 id="kb-rel-h" className="lw-sheet__title">
          العلاقات بين المفاهيم
        </h2>
        <Button size="sm" icon={<Plus size={16} />} onClick={onAdd}>
          علاقة جديدة
        </Button>
      </div>
      {loading && !relations && <LoadingState stage="جارٍ تحميل العلاقات…" inline />}
      {relations && relations.items.length === 0 && <p className="lw-muted">لا علاقات بعد. تُقترح العلاقات حين يُعرَّف مفهوم في محاضرة ويُستخدم في محاضرة لاحقة، أو يُذكر تحت «التشخيص التفريقي».</p>}
      {relations && relations.items.length > 0 && (
        <ul className="kb-relations">
          {relations.items.map((r) => (
            <RelationRow key={r.id} relation={r} />
          ))}
        </ul>
      )}
      {relations?.notes_ar.map((n) => (
        <p key={n} className="lw-muted">
          {n}
        </p>
      ))}
    </section>
  );
}

export function RelationRow({ relation: r }: { relation: ConceptRelationView }) {
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
  const name = `${r.from.name} ${r.relation_label_ar} ${r.to.name}`;
  return (
    <li className="kb-relation" data-support={r.support}>
      <p className="kb-relation__text">
        <Link className="lw-link" to={conceptUrl(r.from.id)}>
          <bdi>{r.from.name}</bdi>
        </Link>{' '}
        <span>{r.relation_label_ar}</span>{' '}
        <Link className="lw-link" to={conceptUrl(r.to.id)}>
          <bdi>{r.to.name}</bdi>
        </Link>
      </p>
      <div className="kb-relation__meta">
        <ConceptStatusPill status={r.status} />
        <span className="kb-support">{r.support_label_ar}</span>
      </div>
      {r.reasons.length > 0 && r.origin === 'auto' && (
        <ul className="kb-reasons">
          {r.reasons.map((x, i) => (
            <li key={i} className="lw-muted">
              {x.text_ar}
              {x.from?.page_id && (
                <>
                  {' '}
                  <Link className="lw-link" to={`/study/${encodeURIComponent(x.from.source_id)}?page_id=${encodeURIComponent(x.from.page_id)}&region=${encodeURIComponent(x.from.region_id)}`}>
                    موضع التعريف
                  </Link>
                </>
              )}
              {x.to?.page_id && (
                <>
                  {' '}
                  <Link className="lw-link" to={`/study/${encodeURIComponent(x.to.source_id)}?page_id=${encodeURIComponent(x.to.page_id)}&region=${encodeURIComponent(x.to.region_id)}`}>
                    موضع الاستخدام
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {r.note && <p className="lw-muted">ملاحظتك: {r.note}</p>}
      <div className="kb-concept__actions">
        {r.status !== 'accepted' && (
          <Button size="sm" variant="secondary" icon={<Check size={16} />} disabled={busy} onClick={() => void act(() => brainApi.patchRelation(r.id, { status: 'accepted' }), 'قبلت العلاقة')} aria-label={`اقبل العلاقة: ${name}`}>
            اقبل
          </Button>
        )}
        {r.origin === 'owner' ? (
          <Button size="sm" variant="secondary" icon={<X size={16} />} disabled={busy} onClick={() => void act(() => brainApi.deleteRelation(r.id), 'حذفت العلاقة')} aria-label={`احذف العلاقة: ${name}`}>
            احذف
          </Button>
        ) : (
          r.status !== 'rejected' && (
            <Button size="sm" variant="secondary" icon={<X size={16} />} disabled={busy} onClick={() => void act(() => brainApi.patchRelation(r.id, { status: 'rejected' }), 'رفضت العلاقة — لن تُقترح مجددًا')} aria-label={`ارفض العلاقة: ${name}`}>
              ارفض
            </Button>
          )
        )}
      </div>
    </li>
  );
}

function RelationDialog({ concepts, onClose }: { concepts: BrainConceptView[]; onClose: () => void }) {
  const toast = useToast();
  const opts = concepts.map((c) => ({ value: c.id, label: [c.name_en, c.name_ar].filter(Boolean).join(' — ') }));
  const [from, setFrom] = useState(opts[0]?.value ?? '');
  const [to, setTo] = useState(opts[1]?.value ?? '');
  const [rel, setRel] = useState<RelationKind>('prerequisite');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await brainApi.createRelation({ from_concept_id: from, to_concept_id: to, relation: rel });
      toast.show({ title: 'أضفت العلاقة (مقبولة، معلَّمة أنها منك).', tone: 'success' });
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
      title="علاقة جديدة بين مفهومين"
      description="علاقة تقرّها أنت؛ تظهر معلَّمة «أضفتها بنفسك» ولا تُعرض كنص من المحاضرة."
      footer={
        <>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!from || !to || from === to}>
            أضف
          </Button>
          <Button onClick={onClose}>إلغاء</Button>
        </>
      }
    >
      {opts.length < 2 ? (
        <p className="lw-muted">تحتاج مفهومين على الأقل.</p>
      ) : (
        <div className="lw-stack-sm">
          <Select<string> label="المفهوم الأول" options={opts} value={from} onValueChange={setFrom} />
          <Select<RelationKind> label="العلاقة" options={RELATION_KINDS.map((k) => ({ value: k, label: RELATION_LABELS_AR[k] }))} value={rel} onValueChange={setRel} />
          <Select<string> label="المفهوم الثاني" options={opts} value={to} onValueChange={setTo} />
          {from === to && <p className="lw-muted">اختر مفهومين مختلفين.</p>}
        </div>
      )}
      {error && (
        <p className="lw-note lw-note--warn" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
