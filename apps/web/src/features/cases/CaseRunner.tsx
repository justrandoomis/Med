// /cases/run/:attemptId — playing a case, an OSCE station (text) or a viva (§42).
// The server runs the case: the page only shows what has been revealed (facts, the current stage's choices by label,
// feedback when the attempt's mode allows it). Every action is an event with a client id: a failed request keeps the
// owner's choice / text and can be sent again without ever being applied twice. Typed text is kept on this device
// until the server has it. Voice mode is not available (said with the reason); nothing starts the microphone.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CircleCheck, ClipboardList, FileText, MessageSquareText, Send, Stethoscope } from 'lucide-react';
import { newId, type CaseEventInput, type CaseHistoryEntry, type CaseRunView } from '@medlevo/shared';
import { Breadcrumbs, Button, ConfirmDialog, ErrorState, LoadingState, StatusPill, TextArea, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { casesApi } from './api';
import { AppropriatenessPill, AuthoredLabel, CaseSentences, HonestyNotes } from './components';
import './cases.css';

type EventBody = DistributiveOmit<CaseEventInput, 'event_id'> & { event_id: string };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Typed text kept on this device until the server has it (owner writing is never lost). */
function useDraft(key: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        if (v) window.localStorage.setItem(key, v);
        else window.localStorage.removeItem(key);
      } catch {
        // private mode: the text stays in the field
      }
    },
    [key],
  );
  return [value, set];
}

function FactsChart({ run }: { run: CaseRunView }) {
  const headingId = useId();
  return (
    <aside className="cs-chart" aria-labelledby={headingId}>
      <div className="cs-chart__head">
        <h2 id={headingId} className="cs-chart__title">
          {run.case.kind === 'viva' ? 'عن الامتحان' : 'ملف المريض'}
        </h2>
        {run.case.kind !== 'viva' && <AuthoredLabel note={run.case.authored_note_ar} />}
      </div>
      {run.case.summary && <BidiText className="cs-chart__story" text={run.case.summary} />}
      {run.facts.length > 0 ? (
        <dl className="cs-facts">
          {run.facts.map((f) => (
            <div key={f.id} className="cs-fact">
              <dt>
                <BidiText as="span" text={f.label} />
              </dt>
              <dd>
                <BidiText as="span" text={f.value} />
                <span className="cs-fact__by">{f.revealed_by_ar}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        run.case.kind !== 'viva' && <p className="cs-muted">لم تظهر معلومات بعد؛ تظهر عندما تسأل أو تفحص أو تطلب فحصًا.</p>
      )}
      {run.case.objectives.length > 0 && (
        <>
          <h3 className="cs-chart__sub">الأهداف</h3>
          <ul className="cs-list">
            {run.case.objectives.map((o) => (
              <li key={o}>
                <BidiText as="span" text={o} />
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

function HistoryItem({ e, run, onRevise, busy }: { e: CaseHistoryEntry; run: CaseRunView; onRevise: (eventId: string, text: string) => Promise<boolean>; busy: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.label);
  const facts = new Map(run.facts.map((f) => [f.id, f]));
  const canRevise = e.type === 'utterance' || e.type === 'viva_answer';
  return (
    <li className={`cs-log__item cs-log__item--${e.type}`}>
      {e.stage_title && <p className="cs-log__where">{e.type === 'viva_answer' ? <BidiText as="span" text={e.stage_title} /> : <>في «<BidiText as="span" text={e.stage_title} />»</>}</p>}
      {e.type === 'choose' && (
        <p className="cs-log__what">
          اخترت: <BidiText as="span" className="cs-log__choice" text={e.label} />
        </p>
      )}
      {(e.type === 'utterance' || e.type === 'viva_answer') && !editing && (
        <p className="cs-log__what">
          <span className="cs-log__who">{e.type === 'utterance' ? 'أنت:' : 'إجابتك:'}</span> <BidiText as="span" text={e.label} />
          {e.revised && <span className="cs-muted"> (مصحَّح)</span>}
        </p>
      )}
      {!['choose', 'utterance', 'viva_answer'].includes(e.type) && <p className="cs-log__minor">{e.label}</p>}
      {e.original_text && (
        <details className="cs-log__original">
          <summary>النص الأصلي قبل التصحيح</summary>
          <BidiText text={e.original_text} />
        </details>
      )}
      {editing && (
        <div className="cs-log__edit">
          <TextArea label="صحّح النص (يُحفظ الأصل في السجل)" value={text} onChange={(ev) => setText(ev.target.value)} rows={3} />
          <div className="ml-cluster">
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!text.trim() || text.trim() === e.label}
              onClick={async () => {
                if (await onRevise(e.event_id, text.trim())) setEditing(false);
              }}
            >
              احفظ التصحيح
            </Button>
            <Button size="sm" variant="plain" onClick={() => setEditing(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      )}
      {e.feedback && (
        <div className="cs-log__feedback">
          {e.feedback.appropriateness && <AppropriatenessPill value={e.feedback.appropriateness} />}
          {e.feedback.consequence && (
            <p className="cs-log__consequence">
              <span className="cs-muted">في السيناريو: </span>
              <BidiText as="span" text={e.feedback.consequence} />
            </p>
          )}
          <CaseSentences sentences={e.feedback.explanation} claims={run.claims} />
          {!e.feedback.appropriateness && run.attempt.feedback === 'end' && !run.finished && <p className="cs-muted">التقييم والشرح يظهران بعد إنهاء المحاولة.</p>}
        </div>
      )}
      {e.revealed_fact_ids.length > 0 && e.type === 'choose' && (
        <ul className="cs-log__facts" aria-label="ما ظهر">
          {e.revealed_fact_ids.map((id) => (
            <li key={id}>
              <BidiText as="span" text={`${facts.get(id)?.label ?? ''}: ${facts.get(id)?.value ?? ''}`} />
            </li>
          ))}
        </ul>
      )}
      {e.patient_responses.length > 0 && (
        <ul className="cs-log__patient" aria-label="جواب المريض">
          {e.patient_responses.map((r) => (
            <li key={r.fact_id}>
              <span className="cs-log__who">المريض:</span> <BidiText as="span" text={r.text} />
            </li>
          ))}
        </ul>
      )}
      {e.no_response_ar && <p className="cs-muted">{e.no_response_ar}</p>}
      {e.matched_items.length > 0 && (
        <p className="cs-log__matched">
          <CircleCheck size={14} aria-hidden="true" /> بنود تحققت بهذا النص: <BidiText as="span" text={e.matched_items.join('، ')} />
        </p>
      )}
      {canRevise && !editing && !run.finished && (
        <Button size="sm" variant="plain" onClick={() => setEditing(true)}>
          صحّح النص
        </Button>
      )}
    </li>
  );
}

export function CaseRunner() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const [run, setRun] = useState<CaseRunView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ event: EventBody; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [pick, setPick] = useState<string>('');
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [text, setText] = useDraft(`medlevo.cases.draft.${attemptId}`);
  const stageHeading = useRef<HTMLHeadingElement>(null);
  usePageTitle(run?.case.title ?? 'حالة سريرية');

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setRun(await casesApi.run(attemptId));
    } catch (e) {
      setLoadError(errorMessage(e, 'تعذّر فتح المحاولة.'));
    }
  }, [attemptId]);
  useEffect(() => {
    void load();
  }, [load]);

  const stageId = run?.stage?.id ?? null;
  const vivaKey = run?.viva?.current ? `${run.viva.current.question_id}:${run.viva.current.follow_up_id ?? ''}` : null;
  useEffect(() => {
    setPick('');
    if (stageId || vivaKey) stageHeading.current?.focus();
  }, [stageId, vivaKey]);

  const send = async (event: DistributiveOmit<CaseEventInput, 'event_id'> & { event_id?: string }, done?: string): Promise<boolean> => {
    const body = { ...event, event_id: event.event_id ?? newId() } as EventBody;
    setBusy(true);
    try {
      const r = await casesApi.event(attemptId, body);
      setRun(r.run);
      setFailed(null);
      if (done) setAnnounce(done);
      return true;
    } catch (e) {
      setFailed({ event: body, message: errorMessage(e, 'تعذّر إرسال الخطوة.') });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!run) return <LoadingState stage="جارٍ فتح المحاولة…" />;

  const stage = run.stage;
  const atEnd = !!stage && stage.is_last && !stage.can_advance && (stage.select !== 'one' || stage.decisions.some((d) => d.chosen));
  const finish = async () => {
    if (await send({ type: 'finish' }, 'انتهت المحاولة.')) navigate(`/cases/report/${encodeURIComponent(attemptId)}`);
  };

  return (
    <div className="ml-page cs-page cs-run">
      <Breadcrumbs items={[{ label: 'الحالات وOSCE', to: '/cases' }, { label: run.case.title, to: `/cases/${encodeURIComponent(run.case.id)}` }, { label: 'محاولة' }]} />
      <header className="ml-page__header cs-head">
        <div>
          <h1 className="ml-page__title">
            <BidiText as="span" text={run.case.title} />
          </h1>
          <div className="ml-cluster cs-meta">
            <StatusPill tone="neutral" icon={<Stethoscope size={14} />}>
              {run.case.osce ? run.case.osce.station_label_ar : run.case.kind_label_ar}
            </StatusPill>
            <StatusPill tone={run.case.origin === 'generated' ? 'info' : 'neutral'} icon={false}>
              {run.case.origin_label_ar}
            </StatusPill>
            <span className="cs-muted">{run.attempt.feedback === 'immediate' ? 'التقييم بعد كل خطوة' : 'التقييم في النهاية'}</span>
          </div>
        </div>
        {!run.finished ? (
          <Button variant="secondary" onClick={() => ((atEnd || run.case.kind !== 'case') && !text.trim() ? void finish() : setConfirmFinish(true))} loading={busy && confirmFinish}>
            أنهِ المحاولة
          </Button>
        ) : (
          <Link to={`/cases/report/${encodeURIComponent(attemptId)}`} className={buttonClass({ variant: 'primary' })}>
            <ClipboardList size={16} aria-hidden="true" />
            اعرض التقرير
          </Link>
        )}
      </header>

      <p className="ml-visually-hidden" aria-live="polite">
        {announce}
      </p>
      {failed && (
        <ErrorState
          inline
          title="لم تُسجَّل الخطوة بعد"
          message={`${failed.message} اختيارك ونصك محفوظان هنا؛ أعد الإرسال (لن يُحتسب مرتين).`}
          onRetry={async () => {
            const sent = failed.event;
            // a re-sent question / answer is in the log now: clear the field so it is not sent a second time
            if ((await send(sent)) && (sent.type === 'utterance' || sent.type === 'viva_answer') && text.trim() === sent.text) setText('');
          }}
          retrying={busy}
          retryLabel="أعد الإرسال"
        />
      )}

      <div className="cs-run__grid">
        <FactsChart run={run} />
        <div className="cs-run__main">
          {run.finished && (
            <section className="cs-panel" aria-labelledby="cs-done-h">
              <h2 id="cs-done-h" className="cs-panel__title" ref={stageHeading} tabIndex={-1}>
                انتهت هذه المحاولة
              </h2>
              <p className="cs-muted">القرارات والنصوص محفوظة كما هي. التقرير يعرض ما تحقق وما فاتك مع مصادره.</p>
              <Link to={`/cases/report/${encodeURIComponent(attemptId)}`} className={buttonClass({ variant: 'primary' })}>
                اعرض التقرير
              </Link>
            </section>
          )}

          {!run.finished && stage && (
            <section className="cs-panel" aria-labelledby="cs-stage-h">
              <p className="cs-panel__kicker">{stage.type_label_ar}</p>
              <h2 id="cs-stage-h" className="cs-panel__title" ref={stageHeading} tabIndex={-1}>
                <BidiText as="span" text={stage.title} />
              </h2>
              {stage.prompt && <BidiText className="cs-panel__prompt" text={stage.prompt} />}
              {stage.select === 'one' && !stage.decisions.some((d) => d.chosen) && (
                <fieldset className="cs-choices">
                  <legend className="cs-muted">اختر قرارًا واحدًا — القرار نهائي في هذه المحاولة.</legend>
                  {stage.decisions.map((d) => (
                    <label key={d.id} className={`cs-choice${pick === d.id ? ' cs-choice--picked' : ''}`}>
                      <input type="radio" name={`stage-${stage.id}`} value={d.id} checked={pick === d.id} onChange={() => setPick(d.id)} />
                      <BidiText as="span" text={d.label} />
                    </label>
                  ))}
                  <Button variant="primary" disabled={!pick} loading={busy} onClick={() => void send({ type: 'choose', stage_id: stage.id, decision_id: pick }, 'سُجّل قرارك.')}>
                    أكّد القرار
                  </Button>
                </fieldset>
              )}
              {stage.select === 'many' && (
                <ul className="cs-many" aria-label="الخيارات">
                  {stage.decisions.map((d) => (
                    <li key={d.id} className="cs-many__row">
                      <BidiText as="span" className="cs-many__label" text={d.label} />
                      {d.chosen ? (
                        <StatusPill tone="accent" icon={<CircleCheck size={14} />}>
                          اخترته
                        </StatusPill>
                      ) : (
                        <Button size="sm" variant="secondary" disabled={busy || !stage.can_advance} onClick={() => void send({ type: 'choose', stage_id: stage.id, decision_id: d.id }, `سُجّل اختيارك: ${d.label}`)}>
                          اختر
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {stage.can_advance && (
                <Button variant={stage.select === 'none' ? 'primary' : 'secondary'} loading={busy} onClick={() => void send({ type: 'advance', stage_id: stage.id }, 'انتقلت إلى المرحلة التالية.')}>
                  {stage.is_last ? 'أنهيت هذه المرحلة' : 'تابع إلى المرحلة التالية'}
                </Button>
              )}
              {atEnd && (
                <div className="cs-panel__end">
                  <p>وصلت إلى نهاية السيناريو.</p>
                  <Button variant="primary" loading={busy} onClick={() => void finish()}>
                    أنهِ وراجع القرارات
                  </Button>
                </div>
              )}
            </section>
          )}

          {!run.finished && run.case.osce && (
            <section className="cs-panel" aria-labelledby="cs-osce-h">
              <p className="cs-panel__kicker">{run.case.osce.station_label_ar}</p>
              <h2 id="cs-osce-h" className="cs-panel__title" ref={stageHeading} tabIndex={-1}>
                تعليمات المرشح
              </h2>
              <BidiText className="cs-panel__prompt" text={run.case.osce.candidate_instructions} />
              <p className="cs-muted">
                {run.case.osce.minutes ? `المدة المقترحة ${run.case.osce.minutes} دقائق (لا يُقاس الوقت هنا). ` : ''}
                اكتب أسئلتك للمريض أو خطواتك كما ستقولها، سطرًا بعد سطر. يجيب «المريض» فقط بما عُرّف في المحطة.
              </p>
              <TextArea label="سؤالك أو خطوتك" value={text} onChange={(ev) => setText(ev.target.value)} rows={3} hint="يُحفظ ما تكتبه على هذا الجهاز حتى يصل إلى الخادم." />
              <Button
                variant="primary"
                icon={<Send size={16} />}
                disabled={!text.trim()}
                loading={busy}
                onClick={async () => {
                  if (await send({ type: 'utterance', text: text.trim() }, 'أُرسل النص.')) setText('');
                }}
              >
                أرسل
              </Button>
              <p className="cs-muted cs-voice">{run.voice.reason_ar}</p>
            </section>
          )}

          {!run.finished && run.viva && (
            <section className="cs-panel" aria-labelledby="cs-viva-h">
              {run.viva.current ? (
                <>
                  <p className="cs-panel__kicker">
                    {run.viva.current.is_follow_up ? 'سؤال متابعة' : `السؤال ${run.viva.current.index} من ${run.viva.current.total}`}
                  </p>
                  <h2 id="cs-viva-h" className="cs-panel__title" ref={stageHeading} tabIndex={-1}>
                    <BidiText as="span" text={run.viva.current.prompt} />
                  </h2>
                  <TextArea label="إجابتك" value={text} onChange={(ev) => setText(ev.target.value)} rows={5} hint="يُحفظ ما تكتبه على هذا الجهاز حتى يصل إلى الخادم." />
                  <Button
                    variant="primary"
                    icon={<MessageSquareText size={16} />}
                    disabled={!text.trim()}
                    loading={busy}
                    onClick={async () => {
                      const cur = run.viva!.current!;
                      if (await send({ type: 'viva_answer', question_id: cur.question_id, follow_up_id: cur.follow_up_id, text: text.trim() }, 'سُجّلت إجابتك.')) setText('');
                    }}
                  >
                    أرسل الإجابة
                  </Button>
                  {run.attempt.judge === 'ai' && <p className="cs-muted">يحكم نموذج ذكاء اصطناعي على تغطية النقاط المعرّفة فقط؛ سؤال المتابعة يُختار بقواعد التعريف.</p>}
                  <p className="cs-muted cs-voice">{run.voice.reason_ar}</p>
                </>
              ) : (
                <>
                  <h2 id="cs-viva-h" className="cs-panel__title" ref={stageHeading} tabIndex={-1}>
                    أجبت عن كل الأسئلة
                  </h2>
                  <Button variant="primary" loading={busy} onClick={() => void finish()}>
                    أنهِ واعرض الفجوات
                  </Button>
                </>
              )}
            </section>
          )}

          <section aria-labelledby="cs-log-h" className="cs-log">
            <h2 id="cs-log-h" className="cs-log__title">
              <FileText size={18} aria-hidden="true" /> سجل المحاولة
            </h2>
            {run.history.length === 0 ? (
              <p className="cs-muted">لا خطوات بعد.</p>
            ) : (
              <ol className="cs-log__list">
                {run.history.map((e) => (
                  <HistoryItem key={e.event_id} e={e} run={run} busy={busy} onRevise={(target, t) => send({ type: 'revise', target_event_id: target, text: t }, 'حُفظ التصحيح.')} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
      <HonestyNotes honesty={run.honesty} />
      <ConfirmDialog
        open={confirmFinish}
        onCancel={() => setConfirmFinish(false)}
        title={text.trim() ? 'إنهاء المحاولة ونصك لم يُرسل بعد؟' : 'إنهاء المحاولة قبل نهاية السيناريو؟'}
        impact={
          text.trim()
            ? 'ما كتبته في الحقل ولم ترسله لا يدخل في هذه المحاولة ولا في تقييمها (يبقى في الحقل على هذا الجهاز). لا يمكن متابعة المحاولة بعد إنهائها.'
            : 'المراحل التي لم تصل إليها تُذكر في التقرير على أنها لم تُجرَ، وبنودها تُحتسب غير متحققة. لا يمكن متابعة هذه المحاولة بعد إنهائها (يمكنك بدء محاولة جديدة).'
        }
        confirmLabel="أنهِ المحاولة"
        onConfirm={async () => {
          await finish();
          setConfirmFinish(false);
        }}
      />
    </div>
  );
}
