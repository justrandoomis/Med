// المصادر والأولويات (§09, §48): per task, the order in which source types are searched for evidence (where the
// search STARTS — never who wins a conflict), changed only after an impact preview; and each source's own priority
// number and the reason you chose it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { SOURCE_TYPE_LABELS_AR, type ControlSourceRow, type ImpactChange, type OwnerSettings, type SourceType, type SourcesPrioritiesResponse } from '@medlevo/shared';
import { Bidi, Button, ErrorState, IconButton, LoadingState, Select, StatusPill, TextField } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { ImpactReview } from './ImpactReview';
import { SectionHeader, useLoad } from './shared';

type Purposes = SourcesPrioritiesResponse['purposes'];

function typeLabel(t: string): string {
  return SOURCE_TYPE_LABELS_AR[t as SourceType] ?? t;
}

function OrderEditor({ purpose, order, types, onChange }: { purpose: Purposes[number]; order: string[]; types: SourcesPrioritiesResponse['source_types']; onChange: (o: string[]) => void }) {
  const move = (i: number, d: -1 | 1) => {
    const n = [...order];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j]!, n[i]!];
    onChange(n);
  };
  const available = types.filter((t) => !order.includes(t.value));
  return (
    <li className="cc-prio">
      <h3 className="cc-prio__title">{purpose.title_ar}</h3>
      <p className="cc-muted">{purpose.description_ar}</p>
      <ol className="cc-prio__list" aria-label={`ترتيب الأنواع: ${purpose.title_ar}`}>
        {order.map((t, i) => (
          <li key={t} className="cc-prio__row">
            <span className="cc-prio__rank" aria-hidden="true">
              {i + 1}
            </span>
            <span className="cc-prio__name">{typeLabel(t)}</span>
            <span className="cc-prio__tools">
              <IconButton size="sm" label={`قدّم «${typeLabel(t)}»`} icon={<ArrowUp size={16} />} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" label={`أخّر «${typeLabel(t)}»`} icon={<ArrowDown size={16} />} disabled={i === order.length - 1} onClick={() => move(i, 1)} />
              <IconButton size="sm" label={`أزل «${typeLabel(t)}» من الترتيب`} icon={<X size={16} />} disabled={order.length <= 1} onClick={() => onChange(order.filter((x) => x !== t))} />
            </span>
          </li>
        ))}
      </ol>
      {available.length > 0 && (
        <Select
          label="أضف نوعًا إلى نهاية الترتيب"
          value=""
          options={[{ value: '', label: 'اختر نوعًا…' }, ...available.map((t) => ({ value: t.value, label: t.label_ar }))]}
          onValueChange={(v) => v && onChange([...order, v])}
        />
      )}
    </li>
  );
}

function SourceRow({ s, onSaved }: { s: ControlSourceRow; onSaved: (r: ControlSourceRow) => void }) {
  const [editing, setEditing] = useState(false);
  const [priority, setPriority] = useState(String(s.priority));
  const [reason, setReason] = useState(s.selection_reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = async () => {
    const n = Number(priority);
    if (!Number.isInteger(n) || n < -100 || n > 100) {
      setFields({ priority: 'اكتب رقمًا صحيحًا من سالب مئة إلى مئة.' });
      return;
    }
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const d = await controlApi.patchSource(s.id, { priority: n, selection_reason: reason.trim() || null });
      onSaved({ ...s, priority: d.priority, selection_reason: d.selection_reason });
      setEditing(false);
    } catch (e) {
      setFields(fieldErrors(e));
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="cc-src">
      <div className="cc-src__head">
        <Link to={`/sources/${encodeURIComponent(s.id)}`} className="cc-src__title">
          <BidiText as="span" dir="rtl" text={s.title} />
        </Link>
        <span className="cc-muted">{s.source_type_label_ar}</span>
        {s.frozen && <StatusPill tone="info">نسخة مثبّتة</StatusPill>}
        {s.open_review_items > 0 && (
          <Link to={`/control/review?source=${encodeURIComponent(s.id)}`} className="cc-link">
            {s.open_review_items} للمراجعة
          </Link>
        )}
      </div>
      {s.reference_for.length > 0 && (
        <p className="cc-muted">
          مرجع مختار لـ:{' '}
          {s.reference_for.map((t, i) => (
            <span key={i}>
              {i > 0 ? '، ' : ''}
              <BidiText as="span" dir="rtl" text={t} />
            </span>
          ))}
        </p>
      )}
      {!editing ? (
        <div className="cc-src__facts">
          <span>الأولوية: {s.priority}</span>
          <span>{s.selection_reason ? <BidiText as="span" dir="rtl" text={`سبب الاختيار: ${s.selection_reason}`} /> : 'لا سبب اختيار مكتوب.'}</span>
          <Button size="sm" variant="plain" onClick={() => setEditing(true)}>
            عدّل
          </Button>
        </div>
      ) : (
        <form
          className="cc-src__form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField label={<>الأولوية (من <Bidi dir="ltr">-100</Bidi> إلى <Bidi dir="ltr">100</Bidi>)</>} inputMode="numeric" dir="ltr" value={priority} onChange={(e) => setPriority(e.target.value)} error={fields.priority} />
          <TextField label="لماذا اخترت هذا المصدر" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} error={fields.selection_reason} />
          {error && <ErrorState inline message={error} />}
          <div className="cc-impact__actions">
            <Button type="submit" variant="primary" loading={busy} loadingLabel="جارٍ الحفظ…">
              احفظ
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setPriority(String(s.priority));
                setReason(s.selection_reason ?? '');
              }}
            >
              إلغاء
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function SourcesScreen() {
  const data = useLoad(() => controlApi.sources(), []);
  const d = data.data;
  const [orders, setOrders] = useState<Record<string, string[]>>({});
  const [change, setChange] = useState<ImpactChange | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const [rows, setRows] = useState<ControlSourceRow[]>([]);
  useEffect(() => {
    if (!d) return;
    setOrders(Object.fromEntries(d.purposes.map((p) => [p.purpose, p.order])));
    setRows(d.sources);
  }, [d]);
  const dirty = !!d && d.purposes.some((p) => JSON.stringify(orders[p.purpose] ?? p.order) !== JSON.stringify(p.order));
  return (
    <div className="cc-section">
      <SectionHeader title="المصادر والأولويات" lede="من أين يبدأ البحث عن الأدلة لكل مهمة، وما تعرفه عن كل مصدر ولماذا اخترته." />
      {data.error ? (
        <ErrorState inline message={data.error} onRetry={data.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل المصادر والأولويات…" />
      ) : (
        <>
          <section className="cc-block" aria-labelledby="cc-prio-h">
            <h2 id="cc-prio-h" className="cc-block__title">
              أولوية أنواع المصادر لكل مهمة
            </h2>
            <ul role="list" className="cc-prios">
              {d.purposes.map((p) => (
                <OrderEditor
                  key={p.purpose}
                  purpose={p}
                  types={d.source_types}
                  order={orders[p.purpose] ?? p.order}
                  onChange={(o) => {
                    setDone(null);
                    setChange(null);
                    setOrders({ ...orders, [p.purpose]: o });
                  }}
                />
              ))}
            </ul>
            <div className="cc-impact__actions">
              <Button
                variant="secondary"
                disabled={!dirty || !!change}
                onClick={() =>
                  setChange({
                    kind: 'settings',
                    patch: { source_priority: Object.fromEntries(d.purposes.map((p) => [p.purpose, orders[p.purpose] ?? p.order])) as OwnerSettings['source_priority'] },
                  })
                }
              >
                اعرض الأثر قبل الحفظ
              </Button>
              {dirty && !change && (
                <Button variant="plain" onClick={() => setOrders(Object.fromEntries(d.purposes.map((p) => [p.purpose, p.order])))}>
                  تراجع عن التعديلات
                </Button>
              )}
            </div>
            {change && (
              <ImpactReview
                change={change}
                onCancel={() => setChange(null)}
                onApplied={(effects) => {
                  setChange(null);
                  setDone(effects);
                  data.reload();
                }}
              />
            )}
            {done && (
              <ul className="cc-outcome cc-bullets" role="status">
                {done.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            <ul className="cc-notes">
              {d.notes_ar.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
          <section className="cc-block" aria-labelledby="cc-srcs-h">
            <h2 id="cc-srcs-h" className="cc-block__title">
              مصادرك
            </h2>
            {rows.length === 0 ? (
              <p className="cc-muted">لا مصادر بعد. ارفع محاضرة أو مرجعًا من المكتبة.</p>
            ) : (
              <ul role="list" className="cc-srcs">
                {rows.map((s) => (
                  <SourceRow key={s.id} s={s} onSaved={(r) => setRows((all) => all.map((x) => (x.id === r.id ? r : x)))} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
