// /cases/report/:attemptId — the final review of an attempt (§42): what each checklist item judged and why (with the
// owner's own correction beside the automatic verdict), the score as an ESTIMATE from this checklist only, every
// decision with its authored consequence and evidence-linked explanation, appropriate decisions that were missed, the
// viva gap report (covered / missed points, inaccurate concepts, follow-ups asked), a review plan with the pages to
// re-read, and what the simulation can / cannot assess.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, CircleX, PenLine, RotateCcw } from 'lucide-react';
import { type CaseReportView, type ChecklistResult } from '@medlevo/shared';
import { Breadcrumbs, Button, ErrorState, LoadingState, StatusPill, TextField, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText, CitationChip } from '../evidence';
import { casesApi } from './api';
import { AppropriatenessPill, AuthoredLabel, CaseSentences, HonestyNotes } from './components';
import { pointsAr } from './model';
import './cases.css';

function MetPill({ met, label }: { met: boolean; label?: string }) {
  return met ? (
    <StatusPill tone="success" icon={<CircleCheck size={14} />}>
      {label ?? 'تحقق'}
    </StatusPill>
  ) : (
    <StatusPill tone="danger" icon={<CircleX size={14} />}>
      {label ?? 'لم يتحقق'}
    </StatusPill>
  );
}

function ChecklistRow({ item, report, onOverride }: { item: ChecklistResult; report: CaseReportView; onOverride: (met: boolean, note: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(item.override?.note ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <li className="cs-check">
      <div className="cs-check__head">
        <MetPill met={item.met} />
        <BidiText as="span" className="cs-check__text" text={item.text} />
        <span className="cs-muted">
          {item.category_label_ar} — {pointsAr(item.points)}
          {item.critical ? ' — بند أساسي' : ''}
        </span>
      </div>
      <p className="cs-muted">
        الحكم الآلي: {item.auto_met ? 'تحقق' : 'لم يتحقق'} — <BidiText as="span" text={item.auto_reason_ar} />
      </p>
      {item.override && (
        <p className="cs-check__override">
          <PenLine size={14} aria-hidden="true" /> حكمك: {item.override.met ? 'تحقق' : 'لم يتحقق'}
          {item.override.note ? <> — <BidiText as="span" text={item.override.note} /></> : null}
        </p>
      )}
      <CaseSentences sentences={item.rationale} claims={report.claims} />
      {item.evidence_note_ar && <p className="cs-muted">{item.evidence_note_ar}</p>}
      {editing ? (
        <div className="cs-check__edit">
          <TextField label="سبب حكمك (اختياري)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          <div className="ml-cluster">
            {[true, false].map((met) => (
              <Button
                key={String(met)}
                size="sm"
                variant={met ? 'secondary' : 'secondary'}
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onOverride(met, note.trim());
                    setEditing(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {met ? 'أراه متحققًا' : 'أراه غير متحقق'}
              </Button>
            ))}
            <Button size="sm" variant="plain" onClick={() => setEditing(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="plain" icon={<PenLine size={14} />} onClick={() => setEditing(true)}>
          صحّح الحكم على هذا البند
        </Button>
      )}
    </li>
  );
}

export function CaseReport() {
  const { attemptId = '' } = useParams();
  const [report, setReport] = useState<CaseReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  usePageTitle(report ? `تقرير: ${report.case.title}` : 'تقرير المحاولة');

  const load = useCallback(async () => {
    setError(null);
    try {
      setReport(await casesApi.report(attemptId));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل التقرير.'));
    }
  }, [attemptId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!report) return <LoadingState stage="جارٍ تحميل التقرير…" />;

  const override = (id: string) => async (met: boolean, note: string) => {
    setActionError(null);
    try {
      await casesApi.event(attemptId, { type: 'override_item', item_id: id, met, note });
      await load();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر حفظ حكمك.'));
      throw e;
    }
  };

  return (
    <div className="ml-page cs-page">
      <Breadcrumbs items={[{ label: 'الحالات وOSCE', to: '/cases' }, { label: report.case.title, to: `/cases/${encodeURIComponent(report.case.id)}` }, { label: 'التقرير' }]} />
      <header className="ml-page__header cs-head">
        <div>
          <h1 className="ml-page__title">
            تقرير: <BidiText as="span" text={report.case.title} />
          </h1>
          <div className="ml-cluster cs-meta">
            <StatusPill tone="neutral" icon={false}>
              {report.case.osce ? report.case.osce.station_label_ar : report.case.kind_label_ar}
            </StatusPill>
            <StatusPill tone={report.case.origin === 'generated' ? 'info' : 'neutral'} icon={false}>
              {report.case.origin_label_ar}
            </StatusPill>
            {report.case.kind !== 'viva' && <AuthoredLabel note={report.case.authored_note_ar} />}
          </div>
        </div>
        <div className="ml-cluster">
          <Link to={`/cases/run/${encodeURIComponent(attemptId)}`} className={buttonClass({ variant: 'plain' })}>
            سجل المحاولة
          </Link>
          <Link to={`/cases/${encodeURIComponent(report.case.id)}`} className={buttonClass({ variant: 'secondary' })}>
            <RotateCcw size={16} aria-hidden="true" />
            محاولة جديدة
          </Link>
        </div>
      </header>
      {actionError && <ErrorState inline message={actionError} />}

      {report.score && (
        <p className="cs-score">
          تحقق <strong>{report.score.got}</strong> من <strong>{report.score.max}</strong> من نقاط القائمة. <span className="cs-muted">{report.score.label_ar}.</span>
        </p>
      )}
      {report.viva && (
        <p className="cs-score">
          غطّت إجاباتك {pointsAr(report.viva.covered_points)} من أصل {pointsAr(report.viva.total_points)} معرّفة. <span className="cs-muted">تقدير بالمطابقة النصية، ويمكنك تصحيح الحكم على أي نقطة.</span>
        </p>
      )}
      {report.notes_ar.length > 0 && (
        <ul className="cs-notes">
          {report.notes_ar.map((n) => (
            <li key={n}>
              <BidiText as="span" text={n} />
            </li>
          ))}
        </ul>
      )}

      {report.checklist.length > 0 && (
        <section aria-labelledby="cs-r-check" className="cs-section">
          <h2 id="cs-r-check" className="cs-section__title">
            قائمة التقييم
          </h2>
          {report.order_check && <p className={report.order_check.in_order === false ? 'cs-note cs-note--warn' : 'cs-note'}>{report.order_check.note_ar}</p>}
          <ul className="cs-checklist">
            {report.checklist.map((c) => (
              <ChecklistRow key={c.id} item={c} report={report} onOverride={override(c.id)} />
            ))}
          </ul>
        </section>
      )}

      {report.decisions.length > 0 && (
        <section aria-labelledby="cs-r-dec" className="cs-section">
          <h2 id="cs-r-dec" className="cs-section__title">
            مراجعة القرارات
          </h2>
          <ol className="cs-decisions">
            {report.decisions.map((d, i) => (
              <li key={i} className="cs-decision">
                <p className="cs-log__where">
                  {d.stage_type_label_ar} — <BidiText as="span" text={d.stage_title} />
                </p>
                <p className="cs-decision__label">
                  <BidiText as="span" text={d.label} /> <AppropriatenessPill value={d.appropriateness} />
                </p>
                {d.consequence && (
                  <p className="cs-log__consequence">
                    <span className="cs-muted">في السيناريو: </span>
                    <BidiText as="span" text={d.consequence} />
                  </p>
                )}
                <CaseSentences sentences={d.explanation} claims={report.claims} />
              </li>
            ))}
          </ol>
          {report.missed_appropriate.length > 0 && (
            <>
              <h3 className="cs-section__sub">قرارات مناسبة لم تخترها</h3>
              <ul className="cs-decisions">
                {report.missed_appropriate.map((m, i) => (
                  <li key={i} className="cs-decision">
                    <p className="cs-decision__label">
                      <BidiText as="span" text={m.label} /> <span className="cs-muted">(في «{m.stage_title}»)</span>
                    </p>
                    <CaseSentences sentences={m.explanation} claims={report.claims} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {report.viva && (
        <section aria-labelledby="cs-r-viva" className="cs-section">
          <h2 id="cs-r-viva" className="cs-section__title">
            فجوات المعرفة في الامتحان الشفهي
          </h2>
          {report.viva.questions.map((q) => (
            <article key={q.id} className="cs-viva-q">
              <h3 className="cs-section__sub">
                <BidiText as="span" text={q.prompt} />
              </h3>
              {q.answers.length === 0 ? (
                <p className="cs-muted">لم تُجب عن هذا السؤال.</p>
              ) : (
                <ul className="cs-list">
                  {q.answers.map((a, i) => (
                    <li key={i}>
                      {a.follow_up_prompt && (
                        <span className="cs-muted">
                          متابعة: <BidiText as="span" text={a.follow_up_prompt} /> —{' '}
                        </span>
                      )}
                      <BidiText as="span" text={a.text} />
                      {a.original_text && (
                        <span className="cs-muted">
                          {' '}
                          (قبل التصحيح: <BidiText as="span" text={a.original_text} />)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {q.covered.length > 0 && (
                <p>
                  <MetPill met label="غطّيت" />{' '}
                  {q.covered.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && '، '}
                      <BidiText as="span" text={c.text} />
                      {c.by === 'owner' ? ' (بحكمك)' : c.by === 'ai' ? ' (بحكم النموذج)' : ''}
                      {c.by !== 'owner' && (
                        <Button size="sm" variant="plain" onClick={() => void override(`${q.id}:${c.id}`)(false, 'لم أذكرها فعلًا').catch(() => undefined)}>
                          لم أذكرها فعلًا
                        </Button>
                      )}
                    </span>
                  ))}
                </p>
              )}
              {q.missed.length > 0 && (
                <div>
                  <MetPill met={false} label="فاتك" />
                  <ul className="cs-list">
                    {q.missed.map((m) => (
                      <li key={m.id}>
                        <BidiText as="span" text={m.text} />
                        <CaseSentences sentences={m.rationale} claims={report.claims} />
                        <Button size="sm" variant="plain" onClick={() => void override(`${q.id}:${m.id}`)(true, 'ذكرتها بصياغة أخرى').catch(() => undefined)}>
                          ذكرتها بصياغة أخرى
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {q.misconceptions.length > 0 && (
                <div className="cs-note cs-note--warn">
                  <p>
                    مفهوم غير دقيق في إجابتك («<BidiText as="span" text={q.misconceptions[0]!.matched_phrase} />»):
                  </p>
                  {q.misconceptions.map((m) => (
                    <CaseSentences key={m.id} sentences={m.correction} claims={report.claims} />
                  ))}
                </div>
              )}
              {q.follow_ups_asked.length > 0 && (
                <p className="cs-muted">
                  أسئلة المتابعة التي طُرحت: <BidiText as="span" text={q.follow_ups_asked.join(' / ')} />
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      {report.review_plan.length > 0 && (
        <section aria-labelledby="cs-r-plan" className="cs-section">
          <h2 id="cs-r-plan" className="cs-section__title">
            خطة مراجعة
          </h2>
          <ul className="cs-plan">
            {report.review_plan.map((p) => (
              <li key={p.label_ar}>
                <BidiText as="span" text={p.label_ar} />{' '}
                {p.evidence.length ? (
                  p.evidence.map((ev) => <CitationChip key={ev.id} evidence={ev} />)
                ) : (
                  <span className="cs-muted">(لا صفحة مرتبطة بدليل لهذا البند)</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.teaching_points.length > 0 && (
        <section aria-labelledby="cs-r-teach" className="cs-section">
          <h2 id="cs-r-teach" className="cs-section__title">
            نقاط تعليمية
          </h2>
          <CaseSentences sentences={report.teaching_points} claims={report.claims} />
        </section>
      )}

      <HonestyNotes honesty={report.honesty} open />
    </div>
  );
}
