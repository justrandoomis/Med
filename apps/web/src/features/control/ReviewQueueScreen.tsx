// قائمة المراجعة (§48): every kind of item that needs the owner's decision, with its specific reason and where it
// is — filtered by state, kind and source. Each row opens the side-by-side review (or says which screen owns it).
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ClipboardCheck } from 'lucide-react';
import { REVIEW_KIND_LABELS_AR, REVIEW_QUEUE_KINDS, type ReviewQueueItemView, type ReviewQueueKind } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, ListItem, LoadingState, SegmentedControl, Select, StatusPill } from '../../design';
import { errorMessage } from '../../lib/api';
import { BidiText } from '../evidence/BidiText';
import { formatDateTime } from '../../lib/time';
import { controlApi, type ReviewFilter } from './api';
import { itemsAr } from './model';
import { SectionHeader, useLoad } from './shared';

const STATUS_OPTIONS = [
  { value: 'open', label: 'بانتظارك' },
  { value: 'resolved', label: 'عولجت' },
  { value: 'all', label: 'الكل' },
] as const;

const HANDLED_AR: Record<ReviewQueueItemView['handled_in'], string | null> = {
  control: null,
  questions: 'يُراجع في شاشة الأسئلة',
  workspace: 'يُراجع في مساحة الدراسة',
  exams: 'من توليد الأسئلة',
};

function ItemRow({ item }: { item: ReviewQueueItemView }) {
  const handled = HANDLED_AR[item.handled_in];
  return (
    <ListItem
      to={`/control/review/${encodeURIComponent(item.id)}`}
      className="cc-qrow"
      title={
        <span className="cc-qrow__title">
          <span className="cc-qrow__kind">{item.kind_label_ar}</span>
          {item.status !== 'open' && (
            <StatusPill tone={item.status === 'dismissed' ? 'neutral' : 'success'} className="cc-qrow__pill">
              {item.status_label_ar}
            </StatusPill>
          )}
        </span>
      }
      subtitle={
        <span className="cc-qrow__sub">
          <BidiText as="span" dir="rtl" className="cc-qrow__reason" text={item.reason} />
          <span className="cc-qrow__where">
            {item.source_title && <BidiText as="span" dir="rtl" text={item.source_title} />}
            {item.location_label_ar && <span>{item.location_label_ar}</span>}
            {handled && <span className="cc-qrow__handled">{handled}</span>}
            <span>{formatDateTime(item.created_at)}</span>
          </span>
        </span>
      }
      trailing={<ChevronLeft size={18} aria-hidden="true" />}
    />
  );
}

export function ReviewQueueScreen() {
  const [params, setParams] = useSearchParams();
  const status = (['open', 'resolved', 'all'] as const).find((s) => s === params.get('status')) ?? 'open';
  const kindParam = params.get('kind') ?? '';
  const kind = (REVIEW_QUEUE_KINDS as readonly string[]).includes(kindParam) ? (kindParam as ReviewQueueKind) : '';
  const sourceId = params.get('source') ?? '';
  const filter: ReviewFilter = { status, kind, source_id: sourceId };
  const list = useLoad(() => controlApi.review(filter), [status, kind, sourceId]);
  const [more, setMore] = useState<{ items: ReviewQueueItemView[]; cursor: string | null; busy: boolean; error: string | null }>({ items: [], cursor: null, busy: false, error: null });
  const items = useMemo(() => [...(list.data?.items ?? []), ...more.items], [list.data, more.items]);
  const nextCursor = more.cursor ?? list.data?.next_cursor ?? null;

  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const reset = () => setMore({ items: [], cursor: null, busy: false, error: null });

  const loadMore = async () => {
    if (!nextCursor) return;
    setMore((m) => ({ ...m, busy: true, error: null }));
    try {
      const r = await controlApi.review({ ...filter, cursor: nextCursor });
      setMore((m) => ({ items: [...m.items, ...r.items], cursor: r.next_cursor ?? '', busy: false, error: null }));
    } catch (e) {
      setMore((m) => ({ ...m, busy: false, error: errorMessage(e) }));
    }
  };

  const counts = list.data?.counts;
  const kindOptions = [
    { value: '' as const, label: 'كل الأنواع' },
    ...REVIEW_QUEUE_KINDS.map((k) => ({ value: k, label: `${REVIEW_KIND_LABELS_AR[k]}${counts?.open_by_kind[k] ? ` (${counts.open_by_kind[k]})` : ''}` })),
  ];
  const sourceOptions = [{ value: '', label: 'كل المصادر' }, ...(list.data?.sources ?? []).map((s) => ({ value: s.id, label: s.open ? `${s.title} (${s.open})` : s.title }))];

  return (
    <div className="cc-section">
      <SectionHeader
        title="قائمة المراجعة"
        lede={
          counts
            ? counts.open
              ? `${itemsAr(counts.open)} بانتظار قرارك. كل عنصر يعرض الأصل والنسخة المنظمة والسبب المحدد، وقرارك يُحفظ في السجل.`
              : 'لا شيء ينتظر قرارك الآن. ما عولج سابقًا محفوظ مع قرارك.'
            : 'ما استُخرج آليًا ويحتاج قرارك، مع الأصل والسبب المحدد.'
        }
      />
      <div className="cc-filters" role="group" aria-label="تصفية القائمة">
        <SegmentedControl
          label="الحالة"
          value={status}
          onValueChange={(v) => {
            reset();
            set('status', v === 'open' ? '' : v);
          }}
          options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <Select
          label="النوع"
          value={kind}
          options={kindOptions}
          onValueChange={(v) => {
            reset();
            set('kind', v);
          }}
        />
        <Select
          label="المصدر"
          value={sourceId}
          options={sourceOptions}
          onValueChange={(v) => {
            reset();
            set('source', v);
          }}
        />
      </div>
      {list.error ? (
        <ErrorState inline message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <LoadingState inline stage="جارٍ تحميل قائمة المراجعة…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={28} />}
          title={status === 'open' ? 'لا شيء ينتظر مراجعتك' : 'لا عناصر بهذه التصفية'}
          description={status === 'open' ? 'عندما تجد المعالجة نصًا مشكوكًا فيه أو صفحة غير مقروءة أو سؤالًا ناقصًا، يظهر هنا مع سببه.' : 'غيّر التصفية لترى عناصر أخرى.'}
        />
      ) : (
        <>
          <ul role="list" className="ml-list cc-queue" aria-label="عناصر المراجعة" aria-busy={list.loading || undefined}>
            {items.map((i) => (
              <ItemRow key={i.id} item={i} />
            ))}
          </ul>
          {nextCursor && (
            <div className="cc-more">
              <Button onClick={() => void loadMore()} loading={more.busy} loadingLabel="جارٍ التحميل…">
                عرض المزيد
              </Button>
              {more.error && <ErrorState inline message={more.error} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
