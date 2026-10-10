// تقييم الجودة (§57): the latest evaluation report recorded by `npm run eval` — per-axis rates WITH their
// denominators and 95% intervals, the regression set apart from the tuning examples, what did not pass and why, the
// comparison with the previous run, and how to run it. Never a «100%»: a perfect small sample reads «n / n نجحت» with
// the interval's lower bound. The fixtures are synthetic TEST FIXTURE files, never the owner's library.
import { Download } from 'lucide-react';
import { EVAL_AXIS_KIND, EVAL_OUTCOME_LABELS_AR, detectDir, evalRateTextAr, type EvalRate, type EvalReport } from '@medlevo/shared';
import { Bidi, EmptyState, ErrorState, LoadingState, StatusPill, buttonClass } from '../../design';
import { formatDateTime } from '../../lib/time';
import { controlApi } from './api';
import { formatCount } from './model';
import { SectionHeader, useLoad } from './shared';

const KIND_AR = { deterministic: 'حتمي (دون نموذج)', scripted_ai: 'مسار الذكاء الاصطناعي بمزود مكتوب مسبقًا' } as const;

function RateCell({ r }: { r: EvalRate }) {
  if (r.total === 0 && r.not_run === 0) return <span className="cc-muted">—</span>;
  const tone = r.total === 0 ? 'neutral' : r.passed === r.total ? 'success' : 'warning';
  const label = r.total === 0 ? 'لم يُشغَّل' : r.passed === r.total ? 'كلها نجحت' : `لم تنجح ${formatCount(r.total - r.passed)}`;
  return (
    <span className="cc-eval__rate">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="cc-eval__rate-text">{evalRateTextAr(r)}</span>
    </span>
  );
}

function Summary({ report }: { report: EvalReport }) {
  return (
    <section className="cc-block" aria-labelledby="cc-eval-sum-h">
      <h2 id="cc-eval-sum-h" className="cc-block__title">
        آخر تقييم
      </h2>
      <dl className="cc-facts">
        <div className="cc-facts__row">
          <dt>متى</dt>
          <dd>{formatDateTime(report.finished_at)}</dd>
        </div>
        <div className="cc-facts__row">
          <dt>عينة الانحدار (مجمّدة)</dt>
          <dd>
            <RateCell r={report.overall.regression} />
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>أمثلة الضبط</dt>
          <dd>
            <RateCell r={report.overall.tuning} />
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>طريقة محاور الذكاء الاصطناعي</dt>
          <dd>{report.mode === 'scripted' ? 'مزود مكتوب مسبقًا للتقييم فقط: يقيس ضمانات الخادم (الأدلة، الامتناع)، لا جودة نموذج.' : 'المزود المضبوط على الخادم.'}</dd>
        </div>
        <div className="cc-facts__row">
          <dt>الكتالوج</dt>
          <dd>
            <Bidi dir="ltr">{report.catalogue.version}</Bidi> — {formatCount(report.catalogue.cases)} حالة ({formatCount(report.catalogue.regression)} للانحدار، {formatCount(report.catalogue.tuning)} للضبط)
          </dd>
        </div>
        {report.label && (
          <div className="cc-facts__row">
            <dt>وسم التشغيل</dt>
            <dd dir={detectDir(report.label)}>{report.label}</dd>
          </div>
        )}
      </dl>
      <a className={buttonClass({ variant: 'secondary' })} href={`/api/control/evaluation/runs/${encodeURIComponent(report.run_id)}/report.md`} download>
        <Download size={16} aria-hidden="true" />
        <span>نزّل التقرير الكامل (Markdown)</span>
      </a>
    </section>
  );
}

function Axes({ report }: { report: EvalReport }) {
  return (
    <section className="cc-block" aria-labelledby="cc-eval-axes-h">
      <h2 id="cc-eval-axes-h" className="cc-block__title">
        المحاور
      </h2>
      <p className="cc-muted">كل محور يُقاس وحده. لا تُحسب «الاستشهادات موجودة» دقةً؛ دعم الادعاء ومطابقة الدليل محوران منفصلان.</p>
      <div className="cc-table-wrap" role="region" aria-label="نتائج المحاور" tabIndex={0}>
        <table className="cc-table cc-eval__table">
          <thead>
            <tr>
              <th scope="col">المحور</th>
              <th scope="col">عينة الانحدار</th>
              <th scope="col">أمثلة الضبط</th>
            </tr>
          </thead>
          <tbody>
            {report.axes
              .filter((a) => a.regression.total + a.regression.not_run + a.tuning.total + a.tuning.not_run > 0)
              .map((a) => (
                <tr key={a.axis}>
                  <th scope="row">
                    {a.label_ar}
                    <span className="cc-table__note">{KIND_AR[EVAL_AXIS_KIND[a.axis]]}</span>
                  </th>
                  <td>
                    <RateCell r={a.regression} />
                  </td>
                  <td>
                    <RateCell r={a.tuning} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NotPassed({ report }: { report: EvalReport }) {
  const cases = report.cases.filter((c) => c.outcome !== 'pass');
  return (
    <section className="cc-block" aria-labelledby="cc-eval-fail-h">
      <h2 id="cc-eval-fail-h" className="cc-block__title">
        ما لم ينجح ({formatCount(cases.length)})
      </h2>
      {cases.length === 0 ? (
        <p className="cc-muted">نجحت كل الحالات التي شُغّلت في هذا التقييم — ضمن حجم هذه العينة فقط.</p>
      ) : (
        <ul role="list" className="cc-eval__cases">
          {cases.map((c) => (
            <li key={c.case_id} className="cc-eval__case">
              <p className="cc-eval__case-head">
                <StatusPill tone={c.outcome === 'fail' ? 'danger' : 'warning'}>{EVAL_OUTCOME_LABELS_AR[c.outcome]}</StatusPill>
                <span>{c.title_ar}</span>
              </p>
              {c.reason_ar && <p>{c.reason_ar}</p>}
              <details>
                <summary>المتوقع والملاحَظ</summary>
                <dl className="cc-facts">
                  <div className="cc-facts__row">
                    <dt>الحالة</dt>
                    <dd>
                      <Bidi dir="ltr">{c.case_id}</Bidi> · {c.set === 'regression' ? 'عينة الانحدار' : 'أمثلة الضبط'}
                      {c.fixture && (
                        <>
                          {' · '}
                          <Bidi dir="ltr">{c.fixture}</Bidi>
                        </>
                      )}
                    </dd>
                  </div>
                  <div className="cc-facts__row">
                    <dt>المتوقع</dt>
                    <dd>
                      <code dir="ltr" className="cc-eval__code">
                        {c.expected}
                      </code>
                    </dd>
                  </div>
                  <div className="cc-facts__row">
                    <dt>الملاحَظ</dt>
                    <dd>
                      <code dir="ltr" className="cc-eval__code">
                        {c.observed}
                      </code>
                    </dd>
                  </div>
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}
      {report.blocked.length > 0 && (
        <>
          <h3 className="cc-eval__sub">لم يُشغَّل هنا</h3>
          <ul className="cc-notes">
            {report.blocked.map((b, i) => (
              <li key={i}>{b.reason_ar}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function EvaluationScreen() {
  const s = useLoad(() => controlApi.evaluation(), []);
  const d = s.data;
  return (
    <div className="cc-section">
      <SectionHeader title="تقييم الجودة" lede="محاور الدقة مقيسة على ملفات اختبار اصطناعية معروفة الإجابة (ليست مكتبتك). كل نتيجة مع مقامها؛ العينة الصغيرة لا تُعمَّم." />
      {s.error ? (
        <ErrorState inline message={s.error} onRetry={s.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل آخر تقرير…" />
      ) : !d.latest ? (
        <EmptyState
          headingLevel={2}
          title="لم يُسجَّل تقييم بعد"
          description={
            <>
              <p>{d.how_to_run_ar}</p>
              <p>
                الكتالوج الحالي: {formatCount(d.catalogue.cases)} حالة — {formatCount(d.catalogue.regression)} في عينة الانحدار و{formatCount(d.catalogue.tuning)} من أمثلة الضبط.
              </p>
            </>
          }
        />
      ) : (
        <>
          <Summary report={d.latest} />
          <Axes report={d.latest} />
          <NotPassed report={d.latest} />
          {d.compare_with_previous && (
            <section className="cc-block" aria-labelledby="cc-eval-cmp-h">
              <h2 id="cc-eval-cmp-h" className="cc-block__title">
                مقارنة بالتقييم السابق
              </h2>
              <p>
                {d.compare_with_previous.verdict === 'not_comparable'
                  ? d.compare_with_previous.reason_ar
                  : d.compare_with_previous.verdict === 'regressions'
                    ? `${formatCount(d.compare_with_previous.regressions.filter((r) => r.set === 'regression').length)} حالة من عينة الانحدار كانت تنجح ولم تعد تنجح. لا يُعتمد التغيير قبل فحصها أو التراجع عنه (docs/EVALUATION.md).`
                    : 'لا حالة من عينة الانحدار كانت تنجح ثم توقفت.'}
              </p>
              {d.compare_with_previous.regressions.length > 0 && (
                <ul className="cc-notes">
                  {d.compare_with_previous.regressions.map((r) => (
                    <li key={r.case_id}>
                      {r.title_ar} — {EVAL_OUTCOME_LABELS_AR[r.base]} ← {EVAL_OUTCOME_LABELS_AR[r.head]}
                    </li>
                  ))}
                </ul>
              )}
              {d.compare_with_previous.system_changes.length > 0 && (
                <>
                  <h3 className="cc-eval__sub">ما تغيّر في النظام بين التشغيلين</h3>
                  <ul className="cc-notes">
                    {d.compare_with_previous.system_changes.map((c) => (
                      <li key={c.key}>
                        <Bidi dir="ltr">
                          {c.key}: {c.base ?? '—'} → {c.head ?? '—'}
                        </Bidi>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
          <section className="cc-block" aria-labelledby="cc-eval-runs-h">
            <h2 id="cc-eval-runs-h" className="cc-block__title">
              التشغيلات السابقة
            </h2>
            <ul role="list" className="cc-eval__runs">
              {d.runs.map((r) => (
                <li key={r.id}>
                  <span>{formatDateTime(r.started_at)}</span>
                  <span className="cc-muted">{r.overall ? `الانحدار: ${evalRateTextAr(r.overall.regression)}` : r.error ?? '—'}</span>
                </li>
              ))}
            </ul>
            <details className="cc-eval__how">
              <summary>كيف أشغّل التقييم وأقارن وأتراجع؟</summary>
              <p>{d.how_to_run_ar}</p>
            </details>
          </section>
          {d.latest.notes_ar.length > 0 && (
            <ul className="cc-notes">
              {d.latest.notes_ar.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
