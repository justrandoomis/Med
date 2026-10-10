// السجل (§48, §56): the owner-visible change log in words — what changed, by whom (you, a background job, the
// system), when, and the before → after facts. Filter by kind; older entries on demand.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import type { HistoryEntryView } from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, Select } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime, dayKey, formatDate } from '../../lib/time';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { SectionHeader, useLoad } from './shared';

function Entry({ e }: { e: HistoryEntryView }) {
  return (
    <li className="cc-hist">
      <p className="cc-hist__head">
        <span className="cc-hist__action">{e.action_label_ar}</span>
        <span className="cc-muted">{e.entity_label_ar}</span>
        <span className="cc-muted">{e.actor_label_ar}</span>
        <time className="cc-muted" dateTime={new Date(e.at).toISOString()}>
          {formatDateTime(e.at)}
        </time>
      </p>
      {e.summary && <BidiText as="p" dir="rtl" className="cc-hist__summary" text={e.summary} />}
      {e.changes.length > 0 && (
        <dl className="cc-hist__changes">
          {e.changes.map((c, i) => (
            <div key={i} className="cc-hist__change">
              <dt>{c.label}</dt>
              <dd>
                {c.before !== null && <BidiText as="span" className="cc-hist__before" text={c.before} />}
                {c.before !== null && c.after !== null && (
                  <>
                    <span aria-hidden="true"> ← </span>
                    <span className="ml-visually-hidden"> ثم صار </span>
                  </>
                )}
                {c.after !== null && <BidiText as="span" className="cc-hist__after" text={c.after} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {e.link && (
        <Link to={e.link.href} className="cc-link">
          {e.link.label_ar}
        </Link>
      )}
    </li>
  );
}

export function HistoryScreen() {
  const [type, setType] = useState('');
  const first = useLoad(() => controlApi.history({ entity_type: type }), [type]);
  const [older, setOlder] = useState<HistoryEntryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOlder([]);
    setCursor(first.data?.next_before ?? null);
  }, [first.data]);
  const entries = [...(first.data?.entries ?? []), ...older];
  const loadMore = async () => {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const r = await controlApi.history({ entity_type: type, before: cursor });
      setOlder((o) => [...o, ...r.entries]);
      setCursor(r.next_before);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // group by day in the owner's timezone
  const days: Array<{ key: string; label: string; items: HistoryEntryView[] }> = [];
  for (const e of entries) {
    const k = dayKey(e.at);
    const last = days[days.length - 1];
    if (last && last.key === k) last.items.push(e);
    else days.push({ key: k, label: formatDate(e.at), items: [e] });
  }
  return (
    <div className="cc-section">
      <SectionHeader title="السجل" lede="ما تغيّر في بياناتك ومتى وبيد من، مع القيم قبل التغيير وبعده. لا تُعرض فيه كلمات مرور أو مفاتيح." />
      <div className="cc-filters">
        <Select label="النوع" value={type} onValueChange={setType} options={[{ value: '', label: 'كل الأنواع' }, ...(first.data?.entity_types ?? []).map((t) => ({ value: t.value, label: t.label_ar }))]} />
      </div>
      {first.error ? (
        <ErrorState inline message={first.error} onRetry={first.reload} />
      ) : !first.data ? (
        <LoadingState inline stage="جارٍ تحميل السجل…" />
      ) : entries.length === 0 ? (
        <EmptyState icon={<History size={28} />} title="لا شيء في السجل بعد" description="كل تعديل أو تصحيح أو قرار مراجعة يُسجَّل هنا." />
      ) : (
        <>
          {days.map((d) => (
            <section key={d.key} className="cc-hist-day" aria-label={d.label}>
              <h2 className="ml-group-header">{d.label}</h2>
              <ul role="list" className="cc-hists">
                {d.items.map((e) => (
                  <Entry key={e.id} e={e} />
                ))}
              </ul>
            </section>
          ))}
          {cursor && (
            <div className="cc-more">
              <Button onClick={() => void loadMore()} loading={busy} loadingLabel="جارٍ التحميل…">
                أقدم
              </Button>
            </div>
          )}
          {error && <ErrorState inline message={error} />}
        </>
      )}
    </div>
  );
}
