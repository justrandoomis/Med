// خزنة أسئلتي (§33): every question of the owner's sources with its origin, separate statuses (extraction /
// key / review) and lecture links. Filters live in the URL so «back» and links keep them.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardList, FilePlus2, ListChecks, Search, SlidersHorizontal } from 'lucide-react';
import {
  ANSWER_STATUSES,
  ANSWER_STATUS_LABELS_AR,
  EXTRACTION_STATUS_LABELS_AR,
  LECTURE_LINK_LABELS_AR,
  LECTURE_LINK_RELATIONS,
  QUESTION_STATUS_LABELS_AR,
  richTextFromPlain,
  type QuestionListItem,
  type QuestionListResponse,
} from '@medlevo/shared';
import { Button, buttonClass, EmptyState, ErrorState, LoadingState, RichTextView, Select, StatusPill, TextField, type SelectOption } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { useLibrary } from '../library/useLibrary';
import { questionsApi, type VaultFilters } from './api';
import { questionCountAr } from './model';
import { AnswerPill, ExtractionPill, MixedText, NegationPill, OriginIcon, QuestionStatusPill, RelationPill, ReviewPill } from './labels';
import './questions.css';

const FILTER_KEYS = ['course_id', 'source_id', 'lecture_id', 'relation', 'answer_status', 'extraction_status', 'status', 'origin', 'review', 'q'] as const;

const opt = <V extends string>(value: V, label: string): SelectOption<V> => ({ value, label });

export function VaultScreen() {
  usePageTitle('خزنة أسئلتي');
  const [params, setParams] = useSearchParams();
  const filters = useMemo<VaultFilters>(() => {
    const f: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f as VaultFilters;
  }, [params]);
  const [data, setData] = useState<QuestionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState(filters.q ?? '');
  // phones: the filter grid is behind a toggle (it would fill the first screen); wide screens always show it
  const [filtersOpen, setFiltersOpen] = useState(false);
  const lib = useLibrary();
  const openReview = useOpenReviewCount();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await questionsApi.list(filters));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الأسئلة.'));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const setFilter = (k: (typeof FILTER_KEYS)[number], v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const loadMore = async () => {
    if (!data?.next_cursor) return;
    setMore(true);
    try {
      const page = await questionsApi.list(filters, data.next_cursor);
      setData({ ...page, items: [...data.items, ...page.items] });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMore(false);
    }
  };

  const courses: SelectOption[] = [
    opt('', 'كل الكورسات'),
    ...[...(lib.index?.nodes.values() ?? [])].filter((n) => n.kind === 'course' && !n.deleted_at).map((n) => opt(n.id, n.title)),
  ];
  const sourceTitle = filters.source_id ? lib.index?.sources.get(filters.source_id)?.title : null;
  const lectureTitle = filters.lecture_id ? lib.index?.sources.get(filters.lecture_id)?.title : null;
  const hasFilters = Object.keys(filters).length > 0;
  const activeCount = (['course_id', 'answer_status', 'extraction_status', 'relation', 'status', 'review'] as const).filter((k) => !!filters[k]).length;

  return (
    <div className="ml-page qv-page">
      <header className="ml-page__header qv-head">
        <div>
          <h1 className="ml-page__title">خزنة أسئلتي</h1>
          <p className="ml-page__lede">أسئلة مصادرك كما طُبعت، بمواضعها الأصلية. حالة الاستخراج وحالة المفتاح منفصلتان دائمًا.</p>
        </div>
        <div className="ml-cluster">
          <Link to="/questions/add" className={buttonClass({ variant: 'primary' })}>
            <FilePlus2 size={18} aria-hidden="true" />
            إضافة سريعة
          </Link>
          <Link to="/questions/review" className={buttonClass({ variant: 'secondary' })}>
            <ClipboardList size={18} aria-hidden="true" />
            قائمة المراجعة{openReview !== null && openReview > 0 ? ` (${openReview})` : ''}
          </Link>
        </div>
      </header>

      <section className="qv-filters" aria-label="تصفية الأسئلة">
        <form
          className="qv-filters__search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('q', search.trim());
          }}
        >
          <TextField label="بحث في نص الأسئلة" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="مثل: Alvarado أو المرارة" />
          <Button type="submit" variant="secondary" icon={<Search size={16} />}>
            بحث
          </Button>
        </form>
        <Button
          variant="secondary"
          size="sm"
          className="qv-filters__toggle"
          icon={<SlidersHorizontal size={16} />}
          aria-expanded={filtersOpen}
          aria-controls="qv-filter-grid"
          onClick={() => setFiltersOpen((o) => !o)}
        >
          التصفية{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
        <div className="qv-filters__grid" id="qv-filter-grid" data-open={filtersOpen ? 'true' : 'false'}>
          <Select label="الكورس" value={filters.course_id ?? ''} options={courses} onValueChange={(v) => setFilter('course_id', v)} />
          <Select
            label="مفتاح الإجابة"
            value={filters.answer_status ?? ''}
            options={[opt('', 'كل الحالات'), ...ANSWER_STATUSES.map((s) => opt(s, ANSWER_STATUS_LABELS_AR[s]))]}
            onValueChange={(v) => setFilter('answer_status', v)}
          />
          <Select
            label="الاستخراج"
            value={filters.extraction_status ?? ''}
            options={[opt('', 'كل الحالات'), ...(Object.keys(EXTRACTION_STATUS_LABELS_AR) as Array<keyof typeof EXTRACTION_STATUS_LABELS_AR>).map((s) => opt(s, EXTRACTION_STATUS_LABELS_AR[s]))]}
            onValueChange={(v) => setFilter('extraction_status', v)}
          />
          <Select
            label="الربط بالمحاضرات"
            value={filters.relation ?? ''}
            options={[opt('', 'أي علاقة أو بلا ربط'), ...LECTURE_LINK_RELATIONS.map((r) => opt(r, LECTURE_LINK_LABELS_AR[r]))]}
            onValueChange={(v) => setFilter('relation', v)}
          />
          <Select
            label="حالة السؤال"
            value={filters.status ?? ''}
            options={[opt('', 'غير المستبعدة'), ...(Object.keys(QUESTION_STATUS_LABELS_AR) as Array<keyof typeof QUESTION_STATUS_LABELS_AR>).map((s) => opt(s, QUESTION_STATUS_LABELS_AR[s]))]}
            onValueChange={(v) => setFilter('status', v)}
          />
          <Select
            label="المراجعة"
            value={filters.review ?? ''}
            options={[opt('', 'الكل'), opt('open', 'فيها عناصر مراجعة مفتوحة'), opt('none', 'بلا عناصر مراجعة')]}
            onValueChange={(v) => setFilter('review', v)}
          />
        </div>
        {(sourceTitle || lectureTitle || filters.source_id || filters.lecture_id) && (
          <div className="ml-cluster qv-filters__chips">
            {filters.source_id && (
              <Button size="sm" variant="secondary" onClick={() => setFilter('source_id', '')} aria-label={`إزالة تصفية المصدر ${sourceTitle ?? ''}`}>
                المصدر: <bdi>{sourceTitle ?? 'مصدر محدد'}</bdi> ✕
              </Button>
            )}
            {filters.lecture_id && (
              <Button size="sm" variant="secondary" onClick={() => setFilter('lecture_id', '')} aria-label={`إزالة تصفية المحاضرة ${lectureTitle ?? ''}`}>
                المحاضرة: <bdi>{lectureTitle ?? 'محاضرة محددة'}</bdi> ✕
              </Button>
            )}
          </div>
        )}
      </section>

      {loading && !data ? (
        <LoadingState stage="جارٍ تحميل الأسئلة…" />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : data && data.total === 0 && !hasFilters ? (
        <EmptyState
          icon={<ListChecks size={28} />}
          title="لا توجد أسئلة في خزنتك بعد"
          description="ارفع ملف أسئلة أو امتحانًا سابقًا من المكتبة واختر نوعه «مصدر أسئلة» أو «امتحان سابق»؛ تُستخرج أسئلته تلقائيًا بعد المعالجة. ولسؤال واحد استخدم الإضافة السريعة."
          actions={
            <div className="ml-cluster">
              <Link to="/questions/add" className={buttonClass({ variant: 'primary' })}>
                إضافة سريعة
              </Link>
              <Link to="/upload" className={buttonClass({ variant: 'secondary' })}>
                رفع ملف
              </Link>
            </div>
          }
        />
      ) : data ? (
        <>
          <p className="qv-count" role="status" aria-live="polite">
            {data.total === 0 ? 'لا توجد أسئلة تطابق هذه التصفية.' : questionCountAr(data.total)}
            {loading && ' — جارٍ التحديث…'}
          </p>
          {data.items.length > 0 && (
            <ul className="ml-list qv-list" role="list">
              {data.items.map((it) => (
                <QuestionRow key={it.id} item={it} />
              ))}
            </ul>
          )}
          {data.next_cursor && (
            <div className="qv-more">
              <Button variant="secondary" loading={more} onClick={() => void loadMore()}>
                عرض المزيد ({data.total - data.items.length} متبقية)
              </Button>
            </div>
          )}
          {error && <ErrorState inline message={error} />}
        </>
      ) : null}
    </div>
  );
}

function QuestionRow({ item }: { item: QuestionListItem }) {
  const stem = useMemo(() => richTextFromPlain(item.stem_preview), [item.stem_preview]);
  return (
    <li className="ml-list__row">
      <Link to={`/questions/${item.id}`} className="qv-row">
        <span className="qv-row__origin">
          <OriginIcon origin={item.origin_type} />
          <MixedText text={item.origin_label_ar} />
        </span>
        <RichTextView value={stem} className="qv-row__stem" />
        <span className="qv-row__pills">
          <QuestionStatusPill status={item.status} />
          <ExtractionPill status={item.extraction_status} />
          <AnswerPill status={item.answer_status} />
          <NegationPill terms={item.negation_terms} />
          <ReviewPill count={item.open_review.length} />
          {item.lecture_links.slice(0, 2).map((l) => (
            <RelationPill key={l.lecture_source_id} relation={l.relation} />
          ))}
          {item.occurrences_count > 1 && <StatusPill tone="neutral" icon={false}>يظهر في {item.occurrences_count} مواضع</StatusPill>}
        </span>
      </Link>
    </li>
  );
}

/** Open question review items (for the button label). */
function useOpenReviewCount(): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    questionsApi
      .reviewQueue({ status: 'open' })
      .then((r) => alive && setN(r.total_open))
      .catch(() => alive && setN(null));
    return () => {
      alive = false;
    };
  }, []);
  return n;
}
