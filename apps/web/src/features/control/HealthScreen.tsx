// صحة النظام (§56): daily counts of what verification stopped (rejected citations, claims the evidence did not
// establish) and of sync refusals / kept-both conflicts — each next to its denominator — plus the redacted client error
// sink. Calm by design: one sentence per metric, a quiet 14-day strip, the exact numbers in a table on demand; no
// percentages, no counters dashboard.
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { CLIENT_ERROR_KINDS, type ClientErrorKind, type HealthTrendsResponse, type TrendSeries, type TrendSeriesKey } from '@medlevo/shared';
import { Bidi, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { controlApi } from './api';
import { formatCount } from './model';
import { SectionHeader, useLoad } from './shared';

const FAILURES: TrendSeriesKey[] = ['citation_invalid', 'claim_unsupported', 'sync_rejected', 'sync_conflict'];

const KIND_AR: Record<ClientErrorKind, string> = {
  error: 'خطأ في الصفحة',
  unhandledrejection: 'عملية لم تكتمل (وعد مرفوض)',
  route: 'تعذّر فتح شاشة',
  react: 'خطأ في عرض جزء من الشاشة',
};

/** «2026-10-09» → «9/10» (Latin digits, read the same as the sources) */
function shortDay(d: string): string {
  const [, m, day] = d.split('-');
  return `${Number(day)}/${Number(m)}`;
}

/** One quiet column per day (aria-hidden: the sentence and the table carry the numbers). Today is the accent. */
function DayStrip({ counts, days, label }: { counts: number[]; days: string[]; label: string }) {
  const max = Math.max(1, ...counts);
  const w = 8;
  const gap = 2;
  const h = 28;
  return (
    <svg className="cc-strip" viewBox={`0 0 ${counts.length * (w + gap) - gap} ${h}`} width={counts.length * (w + gap) - gap} height={h} aria-hidden="true" focusable="false">
      {counts.map((c, i) => {
        const bh = c === 0 ? 1.5 : Math.max(3, Math.round((c / max) * (h - 2)));
        return (
          <rect key={days[i]} className={i === counts.length - 1 ? 'cc-strip__bar cc-strip__bar--today' : 'cc-strip__bar'} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={c === 0 ? 0.75 : 2}>
            <title>{`${label} — ${days[i]}: ${c}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function sentence(s: TrendSeries, of: TrendSeries | undefined, days: number): string {
  const base = of ? ` من ${formatCount(of.total)} ${of.key === 'claims_checked' ? 'جملة فُحصت' : 'تغيير وصل'}` : '';
  if (s.total === 0) return `لا شيء في آخر ${formatCount(days)} يومًا${of ? ` (فُحص ${formatCount(of.total)})` : ''}.`;
  return `${formatCount(s.total)}${base} في آخر ${formatCount(days)} يومًا.`;
}

function Trends({ data }: { data: HealthTrendsResponse }) {
  const byKey = new Map(data.series.map((s) => [s.key, s]));
  return (
    <section className="cc-block" aria-labelledby="cc-health-trends-h">
      <h2 id="cc-health-trends-h" className="cc-block__title">
        يومًا بيوم
      </h2>
      <ul role="list" className="cc-trends">
        {FAILURES.map((k) => {
          const s = byKey.get(k);
          if (!s) return null;
          const of = s.of ? byKey.get(s.of) : undefined;
          return (
            <li key={k} className="cc-trend">
              <div className="cc-trend__text">
                <p className="cc-trend__label">{s.label_ar}</p>
                <p className="cc-trend__value">{sentence(s, of, data.days.length)}</p>
                <p className="cc-muted cc-trend__desc">{s.description_ar}</p>
              </div>
              <DayStrip counts={s.counts} days={data.days} label={s.label_ar} />
            </li>
          );
        })}
      </ul>
      <details className="cc-trend__table">
        <summary>الأرقام يومًا بيوم</summary>
        <div className="cc-table-wrap" role="region" aria-label="الأعداد اليومية" tabIndex={0}>
          <table className="cc-table">
            <thead>
              <tr>
                <th scope="col">اليوم</th>
                {data.series.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.label_ar}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.days.map((d, i) => (
                <tr key={d}>
                  <th scope="row">
                    <Bidi dir="ltr">{shortDay(d)}</Bidi>
                  </th>
                  {data.series.map((s) => (
                    <td key={s.key}>{formatCount(s.counts[i] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <ul className="cc-notes">
        {data.notes_ar.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
        <li>
          الأيام بتوقيت <Bidi dir="ltr">{data.timezone}</Bidi>.
        </li>
      </ul>
    </section>
  );
}

function ClientErrors() {
  const s = useLoad(() => controlApi.clientErrors(), []);
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const d = s.data;
  return (
    <section className="cc-block" aria-labelledby="cc-health-errors-h">
      <h2 id="cc-health-errors-h" className="cc-block__title">
        أخطاء الواجهة المسجلة
      </h2>
      {s.error ? (
        <ErrorState inline message={s.error} onRetry={s.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل السجل…" />
      ) : (
        <>
          <p className="cc-muted">{d.retention_ar}</p>
          {/* (review F5) the list is the newest page of the log: say so instead of letting it read as the whole log */}
          {d.total > d.items.length && (
            <p className="cc-muted">
              يُعرض أحدث {formatCount(d.items.length)} من {formatCount(d.total)} خطأ مختلف مسجل.
            </p>
          )}
          {d.items.length === 0 ? (
            <EmptyState headingLevel={3} title="لا أخطاء مسجلة" description="لم تُبلّغ الواجهة عن أي خطأ في المدة المحفوظة." />
          ) : (
            <>
              <ul role="list" className="cc-errors">
                {d.items.map((e) => (
                  <li key={e.id} className="cc-error">
                    <p className="cc-error__head">
                      <span className="cc-error__kind">{KIND_AR[(CLIENT_ERROR_KINDS as readonly string[]).includes(e.kind) ? e.kind : 'error']}</span>
                      <span className="cc-muted">
                        {e.count === 1 ? 'مرة واحدة' : `${formatCount(e.count)} مرات`} · آخرها {formatDateTime(e.last_seen_at)}
                      </span>
                    </p>
                    <p className="cc-error__msg">
                      <Bidi dir="ltr">{e.message}</Bidi>
                    </p>
                    <p className="cc-muted cc-error__meta">
                      {e.route && (
                        <>
                          الصفحة <Bidi dir="ltr">{e.route}</Bidi>
                        </>
                      )}
                      {e.user_agent && (
                        <>
                          {' · '}
                          <Bidi dir="ltr">{e.user_agent}</Bidi>
                        </>
                      )}
                      {e.app_version && (
                        <>
                          {' · الإصدار '}
                          <Bidi dir="ltr">{e.app_version}</Bidi>
                        </>
                      )}
                      {' · أول ظهور '}
                      {formatDateTime(e.first_seen_at)}
                    </p>
                    {e.stack && (
                      <details>
                        <summary>مواضع الشيفرة</summary>
                        <pre dir="ltr" className="cc-error__stack">
                          {e.stack}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
              <Button variant="secondary" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>
                امسح السجل
              </Button>
            </>
          )}
          <ConfirmDialog
            open={confirm}
            title="مسح سجل أخطاء الواجهة؟"
            impact="تُحذف الأخطاء المسجلة فقط (رسائل ومواضع شيفرة منقّاة). لا يمس هذا أي ملاحظة أو كتابة أو مصدر، ويُسجَّل المسح في السجل."
            confirmLabel="امسح السجل"
            destructive
            onCancel={() => setConfirm(false)}
            onConfirm={async () => {
              try {
                const r = await controlApi.clearClientErrors();
                setConfirm(false);
                toast.show({ title: `مُسح ${formatCount(r.deleted)} خطأ من السجل.`, tone: 'success' });
                s.reload();
              } catch (e) {
                throw new Error(errorMessage(e, 'تعذّر مسح السجل.'));
              }
            }}
          />
        </>
      )}
    </section>
  );
}

export function HealthScreen() {
  const t = useLoad(() => controlApi.health(14), []);
  return (
    <div className="cc-section">
      <SectionHeader title="صحة النظام" lede="ما منعه التحقق من الأدلة وما رفضته المزامنة يومًا بيوم، مع ما فُحص كله؛ وأخطاء الواجهة المسجلة دون أي نص من ملفاتك." />
      {t.error ? <ErrorState inline message={t.error} onRetry={t.reload} /> : !t.data ? <LoadingState inline stage="جارٍ حساب الأعداد اليومية…" /> : <Trends data={t.data} />}
      <ClientErrors />
    </div>
  );
}
