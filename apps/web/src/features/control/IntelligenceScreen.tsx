// الذكاء الاصطناعي (§48 Intelligence, §51, §56): provider and model per role and task, the monthly budget, usage
// per month / task / model — every cost labelled as an ESTIMATE — and the rule-affecting defaults, changed only
// after an impact preview. Models are server settings: their change is previewed here and applied on the server.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AI_TASK_LABELS_AR, MODEL_ROLES, MODEL_ROLE_LABELS_AR, type ImpactChange, type IntelligenceResponse, type ModelRole, type OwnerSettings } from '@medlevo/shared';
import { Bidi, Button, ErrorState, LoadingState, ProgressBar, Select, StatusPill, Switch, TextArea, TextField, type SelectOption } from '../../design';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { ImpactReview } from './ImpactReview';
import { formatCount, formatUsd } from './model';
import { SectionHeader, useControlContext, useLoad } from './shared';

const LEVELS: SelectOption<OwnerSettings['explanation_level']>[] = [
  { value: 'simple', label: 'مبسّط' },
  { value: 'brief', label: 'موجز' },
  { value: 'medium', label: 'متوسط' },
  { value: 'detailed', label: 'مفصّل' },
  { value: 'expert', label: 'متقدّم' },
  { value: 'exam_focus', label: 'مركّز على الامتحان' },
];
const DIALECTS: SelectOption<OwnerSettings['dialect']>[] = [
  { value: 'fusha_simple', label: 'عربية فصحى مبسّطة' },
  { value: 'iraqi_teaching', label: 'أسلوب تدريس عراقي' },
];
const STYLES: SelectOption<OwnerSettings['answer_style']>[] = [
  { value: 'simple', label: 'بسيط' },
  { value: 'short', label: 'قصير' },
  { value: 'detailed', label: 'مفصّل' },
  { value: 'expert', label: 'متقدّم' },
  { value: 'literal', label: 'حرفي من المصدر' },
];
const DENSITY: SelectOption<OwnerSettings['check_question_density']>[] = [
  { value: 'off', label: 'إيقاف' },
  { value: 'low', label: 'قليلة' },
  { value: 'medium', label: 'متوسطة' },
];

function Usage({ d }: { d: IntelligenceResponse }) {
  const months = d.usage.months;
  const [month, setMonth] = useState(months[0]?.month ?? '');
  const m = months.find((x) => x.month === month) ?? months[0];
  if (!m) return null;
  return (
    <section className="cc-block" aria-labelledby="cc-usage-h">
      <h2 id="cc-usage-h" className="cc-block__title">
        الاستخدام
      </h2>
      <div className="cc-usage__pick">
        <Select label="الشهر" value={m.month} onValueChange={setMonth} options={months.map((x) => ({ value: x.month, label: x.label_ar }))} />
      </div>
      <p className="cc-usage__total">
        {m.calls === 0 ? (
          'لا استدعاءات في هذا الشهر.'
        ) : (
          <>
            {formatCount(m.calls)} استدعاء ({formatCount(m.ok)} ناجح{m.errors ? `، ${formatCount(m.errors)} خطأ` : ''}
            {m.schema_rejected ? `، ${formatCount(m.schema_rejected)} رُفضت بنيته` : ''}
            {m.budget_blocked ? `، ${formatCount(m.budget_blocked)} أوقفته الميزانية` : ''}). التكلفة التقديرية: <Bidi dir="ltr">{formatUsd(m.estimated_cost_usd)}</Bidi>
          </>
        )}
      </p>
      {m.by_task.length > 0 && (
        <div className="cc-table-wrap" role="region" aria-label="الاستخدام حسب المهمة" tabIndex={0}>
          <table className="cc-table">
            <caption className="ml-visually-hidden">الاستخدام حسب المهمة في {m.label_ar} (التكاليف تقديرية)</caption>
            <thead>
              <tr>
                <th scope="col">المهمة</th>
                <th scope="col">استدعاءات</th>
                <th scope="col">رموز داخلة / خارجة</th>
                <th scope="col">تكلفة تقديرية</th>
              </tr>
            </thead>
            <tbody>
              {m.by_task.map((b) => (
                <tr key={b.key}>
                  <th scope="row">{b.label_ar}</th>
                  <td>{formatCount(b.calls)}</td>
                  <td>
                    <Bidi dir="ltr">
                      {formatCount(b.input_tokens)} / {formatCount(b.output_tokens)}
                    </Bidi>
                  </td>
                  <td>
                    <Bidi dir="ltr">{formatUsd(b.estimated_cost_usd)}</Bidi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {m.by_model.length > 0 && (
        <p className="cc-muted">
          النماذج التي خدمت الطلبات فعلًا:{' '}
          {m.by_model.map((b, i) => (
            <span key={b.key}>
              {i > 0 ? '، ' : ''}
              <Bidi dir="ltr">{b.key}</Bidi> ({formatCount(b.calls)})
            </span>
          ))}
        </p>
      )}
      <p className="ml-group-footer">{d.usage.note_ar}</p>
    </section>
  );
}

/** Tasks grouped by their state: one line per reason instead of the same reason repeated for every task. */
function TaskStatus({ d }: { d: IntelligenceResponse }) {
  const tasks = Object.keys(d.ai.tasks) as Array<keyof typeof d.ai.tasks>;
  const available = tasks.filter((t) => d.ai.tasks[t].available);
  const byReason = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const s = d.ai.tasks[t];
    if (s.available) continue;
    const r = s.reason_ar ?? 'غير متاحة.';
    byReason.set(r, [...(byReason.get(r) ?? []), t]);
  }
  return (
    <ul role="list" className="cc-tasks" aria-label="المهام وحالتها">
      {available.length > 0 && (
        <li className="cc-tasks__row">
          <StatusPill tone="success">متاحة</StatusPill>
          <span className="cc-tasks__name">{available.map((t) => AI_TASK_LABELS_AR[t]).join('، ')}</span>
          {available.map((t) => d.ai.tasks[t].model).filter(Boolean).length > 0 && (
            <span className="cc-tasks__why">
              النموذج: {[...new Set(available.map((t) => d.ai.tasks[t].model).filter(Boolean))].map((m, i) => (
                <span key={m}>
                  {i > 0 ? '، ' : ''}
                  <Bidi dir="ltr">{m}</Bidi>
                </span>
              ))}
            </span>
          )}
        </li>
      )}
      {[...byReason].map(([reason, list]) => (
        <li key={reason} className="cc-tasks__row">
          <StatusPill tone="neutral">غير متاحة</StatusPill>
          <span className="cc-tasks__name">{list.map((t) => AI_TASK_LABELS_AR[t]).join('، ')}</span>
          <BidiText as="span" dir="rtl" className="cc-tasks__why" text={reason} />
        </li>
      ))}
    </ul>
  );
}

function ModelPreview({ d }: { d: IntelligenceResponse }) {
  const [role, setRole] = useState<ModelRole>('generation');
  const [model, setModel] = useState('');
  const [change, setChange] = useState<ImpactChange | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (model.trim()) setChange({ kind: 'model', role, model: model.trim() });
  };
  return (
    <div className="cc-subblock">
      <form className="cc-inline-form" onSubmit={submit}>
        <Select label="الدور" value={role} onValueChange={(v) => setRole(v)} options={MODEL_ROLES.map((r) => ({ value: r, label: MODEL_ROLE_LABELS_AR[r] }))} />
        <TextField label="النموذج المقترح" dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder={d.roles.find((r) => r.role === role)?.model ?? 'claude-…'} maxLength={120} />
        <Button type="submit" variant="secondary" disabled={!model.trim()}>
          عاين الأثر
        </Button>
      </form>
      {change && <ImpactReview change={change} onApplied={() => setChange(null)} onCancel={() => setChange(null)} />}
    </div>
  );
}

function RulesDefaults({ d, onApplied }: { d: IntelligenceResponse; onApplied: () => void }) {
  const [draft, setDraft] = useState(d.rules);
  const [change, setChange] = useState<ImpactChange | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  useEffect(() => setDraft(d.rules), [d.rules]);
  const patch = useMemo(() => {
    const p: Record<string, unknown> = {};
    for (const k of Object.keys(draft) as Array<keyof typeof draft>) if (draft[k] !== d.rules[k]) p[k] = draft[k];
    return p;
  }, [draft, d.rules]);
  const dirty = Object.keys(patch).length > 0;
  return (
    <section className="cc-block" aria-labelledby="cc-rules-h">
      <h2 id="cc-rules-h" className="cc-block__title">
        قواعد الشرح الافتراضية
      </h2>
      <p className="cc-muted">
        تُطبَّق على ما تطلبه بعد التغيير فقط. قبل الحفظ ترى المحتوى المخزّن الذي لن يُعاد استخدامه بسببها. قواعد مجلد بعينه في{' '}
        <Link to="/explanation-rules">قواعد الشرح</Link>.
      </p>
      <form
        className="cc-rules"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          if (dirty) setChange({ kind: 'settings', patch });
        }}
      >
        <div className="cc-rules__grid">
          <Select label="مستوى الشرح" value={draft.explanation_level} options={LEVELS} onValueChange={(v) => setDraft({ ...draft, explanation_level: v })} />
          <Select label="أسلوب اللغة" value={draft.dialect} options={DIALECTS} onValueChange={(v) => setDraft({ ...draft, dialect: v })} />
          <Select label="أسلوب الإجابة" value={draft.answer_style} options={STYLES} onValueChange={(v) => setDraft({ ...draft, answer_style: v })} />
          <Select label="أسئلة التحقق أثناء الشرح" value={draft.check_question_density} options={DENSITY} onValueChange={(v) => setDraft({ ...draft, check_question_density: v })} />
        </div>
        <Switch label="الأسلوب السقراطي افتراضيًا" checked={draft.socratic_default} onCheckedChange={(v) => setDraft({ ...draft, socratic_default: v })} />
        <TextArea label="تعليماتك الخاصة للشرح" rows={3} maxLength={1000} value={draft.custom_instruction} onChange={(e) => setDraft({ ...draft, custom_instruction: e.target.value })} />
        <div className="cc-impact__actions">
          <Button type="submit" variant="secondary" disabled={!dirty || !!change}>
            اعرض الأثر قبل الحفظ
          </Button>
          {dirty && !change && (
            <Button variant="plain" onClick={() => setDraft(d.rules)}>
              تراجع عن التعديلات
            </Button>
          )}
        </div>
      </form>
      {change && (
        <ImpactReview
          change={change}
          onCancel={() => setChange(null)}
          onApplied={(effects) => {
            setChange(null);
            setDone(effects);
            onApplied();
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
    </section>
  );
}

export function IntelligenceScreen() {
  const intel = useLoad(() => controlApi.intelligence(), []);
  const { reloadOverview } = useControlContext();
  const d = intel.data;
  return (
    <div className="cc-section">
      <SectionHeader title="الذكاء الاصطناعي" lede="المزود والنماذج لكل مهمة، والميزانية، والاستخدام، وقواعد الشرح. التكاليف هنا تقديرية دائمًا، وليست فاتورة المزود." />
      {intel.error ? (
        <ErrorState inline message={intel.error} onRetry={intel.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل حالة الذكاء الاصطناعي…" />
      ) : (
        <>
          <section className="cc-block" aria-labelledby="cc-ai-h">
            <h2 id="cc-ai-h" className="cc-block__title">
              الحالة
            </h2>
            <p className="cc-state-line">
              {d.ai.configured ? (
                <StatusPill tone="success">
                  مهيأ: <Bidi dir="ltr">{d.ai.provider ?? '—'}</Bidi>
                </StatusPill>
              ) : (
                <StatusPill tone="warning">غير مهيأ على الخادم</StatusPill>
              )}
            </p>
            <ul className="cc-bullets cc-muted">
              {d.notes_ar.map((n, i) => (
                <li key={i}>
                  <BidiText as="span" dir="rtl" text={n} />
                </li>
              ))}
            </ul>
            <div className="cc-budget">
              <p>
                الميزانية الشهرية: <Bidi dir="ltr">{formatUsd(d.ai.budget.monthly_usd)}</Bidi>. المصروف التقديري هذا الشهر: <Bidi dir="ltr">{formatUsd(d.ai.budget.spent_usd)}</Bidi>
                ، والمتبقي: <Bidi dir="ltr">{formatUsd(d.ai.budget.remaining_usd)}</Bidi>.
              </p>
              {d.ai.budget.monthly_usd > 0 && (
                <ProgressBar
                  label="المصروف التقديري من الميزانية الشهرية"
                  value={Math.min(d.ai.budget.spent_usd, d.ai.budget.monthly_usd)}
                  max={d.ai.budget.monthly_usd}
                  valueText={`${formatUsd(d.ai.budget.spent_usd)} من ${formatUsd(d.ai.budget.monthly_usd)} (تقديري)`}
                />
              )}
              <p className="cc-muted">
                تُضبط من إعداد الخادم <Bidi dir="ltr">MEDLEVO_AI_MONTHLY_BUDGET_USD</Bidi>. عند بلوغها تتوقف الطلبات مع ذكر السبب، ولا تُعرض نتيجة ناقصة كأنها كاملة.
              </p>
            </div>
          </section>

          <section className="cc-block" aria-labelledby="cc-models-h">
            <h2 id="cc-models-h" className="cc-block__title">
              النماذج والمهام
            </h2>
            <dl className="cc-roles">
              {d.roles.map((r) => (
                <div key={r.role} className="cc-roles__row">
                  <dt>{r.label_ar}</dt>
                  <dd>
                    <span className="cc-roles__k">النموذج</span> {r.model ? <Bidi dir="ltr">{r.model}</Bidi> : 'غير محدد'}
                  </dd>
                  <dd>
                    <span className="cc-roles__k">إعداد الخادم</span> <Bidi dir="ltr" className="cc-roles__env">{r.env_var}</Bidi>
                  </dd>
                </div>
              ))}
            </dl>
            <TaskStatus d={d} />
            <h3 className="cc-subtitle">معاينة أثر تغيير نموذج</h3>
            <p className="cc-muted">تغيير النموذج إعداد على الخادم يُطبَّق عند إعادة تشغيله. اعرف قبل ذلك ما لن يُعاد استخدامه من المحتوى المخزّن.</p>
            <ModelPreview d={d} />
          </section>

          <Usage d={d} />
          <RulesDefaults
            d={d}
            onApplied={() => {
              intel.reload();
              reloadOverview();
            }}
          />
        </>
      )}
    </div>
  );
}
