// /cases/:caseId — a case: its status and what still needs the owner's review, generation progress (polled while it
// runs, removed sentences listed), starting an attempt (feedback after each step or at the end; deterministic or —
// AI-gated — model judge for viva), the attempts so far, and the full definition behind an explicit disclosure
// (it reveals the solution).
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Play, Trash2 } from 'lucide-react';
import {
  CASE_FACT_KIND_LABELS_AR,
  CASE_STAGE_TYPE_LABELS_AR,
  CHECKLIST_CATEGORY_LABELS_AR,
  type CaseAttemptListResponse,
  type CaseDetailView,
  type CasesCapabilities,
} from '@medlevo/shared';
import { Breadcrumbs, Button, ConfirmDialog, ErrorState, LoadingState, SegmentedControl, StatusPill, buttonClass } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { casesApi } from './api';
import { AppropriatenessPill, AuthoredLabel, CaseSentences, HonestyNotes } from './components';
import './cases.css';

function DefinitionOutline({ c }: { c: CaseDetailView }) {
  const d = c.definition;
  return (
    <div className="cs-outline">
      {d.facts.length > 0 && (
        <>
          <h3 className="cs-section__sub">المعلومات الثابتة</h3>
          <ul className="cs-list">
            {d.facts.map((f) => (
              <li key={f.id}>
                <BidiText as="span" text={`${f.label}: ${f.value}`} /> <span className="cs-muted">({CASE_FACT_KIND_LABELS_AR[f.kind]}، {f.reveal === 'start' ? 'من البداية' : 'عند الطلب'})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.stages.map((s) => (
        <div key={s.id} className="cs-outline__stage">
          <h3 className="cs-section__sub">
            {CASE_STAGE_TYPE_LABELS_AR[s.type]} — <BidiText as="span" text={s.title} />
          </h3>
          {s.prompt && <BidiText className="cs-muted" text={s.prompt} />}
          <ul className="cs-list">
            {s.decisions.map((x) => (
              <li key={x.id}>
                <BidiText as="span" text={x.label} /> <AppropriatenessPill value={x.appropriateness} />
                {x.consequence && <BidiText className="cs-muted" text={`في السيناريو: ${x.consequence}`} />}
                <CaseSentences sentences={x.explanation} claims={c.claims} />
              </li>
            ))}
          </ul>
          <CaseSentences sentences={s.teaching_points} claims={c.claims} />
        </div>
      ))}
      {d.osce && (
        <>
          <h3 className="cs-section__sub">تعليمات المرشح</h3>
          <BidiText text={d.osce.candidate_instructions} />
        </>
      )}
      {d.checklist.length > 0 && (
        <>
          <h3 className="cs-section__sub">قائمة التقييم</h3>
          <ul className="cs-list">
            {d.checklist.map((x) => (
              <li key={x.id}>
                <BidiText as="span" text={x.text} /> <span className="cs-muted">({CHECKLIST_CATEGORY_LABELS_AR[x.category]})</span>
                {x.match.length > 0 && <BidiText className="cs-muted" text={`عبارات مطابقة: ${x.match.join('، ')}`} />}
                <CaseSentences sentences={x.rationale} claims={c.claims} />
              </li>
            ))}
          </ul>
        </>
      )}
      {d.viva?.questions.map((q) => (
        <div key={q.id} className="cs-outline__stage">
          <h3 className="cs-section__sub">
            <BidiText as="span" text={q.prompt} />
          </h3>
          <ul className="cs-list">
            {q.points.map((p) => (
              <li key={p.id}>
                <BidiText as="span" text={p.text} />
                <CaseSentences sentences={p.rationale} claims={c.claims} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CaseDetailScreen() {
  const { caseId = '' } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState<CaseDetailView | null>(null);
  const [caps, setCaps] = useState<CasesCapabilities | null>(null);
  const [attempts, setAttempts] = useState<CaseAttemptListResponse['attempts']>([]);
  const [error, setError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<'immediate' | 'end'>('immediate');
  const [judge, setJudge] = useState<'deterministic' | 'ai'>('deterministic');
  const [starting, setStarting] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  usePageTitle(c?.title ?? 'حالة');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [detail, list, a] = await Promise.all([casesApi.get(caseId), casesApi.list(), casesApi.attempts(caseId)]);
      setC(detail);
      setCaps(list.capabilities);
      setAttempts(a.attempts);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الحالة.'));
    }
  }, [caseId]);
  useEffect(() => {
    void load();
  }, [load]);

  // poll while a generation runs (real status only)
  const generating = !!c?.generation && ['queued', 'running'].includes(c.generation.status);
  useEffect(() => {
    if (!generating) return;
    const t = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(t);
  }, [generating, c, load]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!c) return <LoadingState stage="جارٍ تحميل الحالة…" />;

  const playable = !c.validation.some((i) => i.severity === 'error') && c.version_no >= 1;
  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const run = await casesApi.start(c.id, { feedback, judge: c.kind === 'viva' ? judge : 'deterministic', mode: 'text' });
      navigate(`/cases/run/${encodeURIComponent(run.attempt.id)}`);
    } catch (e) {
      setStartError(errorMessage(e, 'تعذّر بدء المحاولة.'));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ml-page cs-page">
      <Breadcrumbs items={[{ label: 'الحالات وOSCE', to: '/cases' }, { label: c.title }]} />
      <header className="ml-page__header cs-head">
        <div>
          <h1 className="ml-page__title">
            <BidiText as="span" text={c.title} />
          </h1>
          <div className="ml-cluster cs-meta">
            <StatusPill tone="neutral" icon={false}>
              {c.kind_label_ar}
            </StatusPill>
            <StatusPill tone={c.origin === 'generated' ? 'info' : 'neutral'} icon={false}>
              {c.origin_label_ar}
            </StatusPill>
            <StatusPill tone={c.status === 'ready' ? 'success' : c.status === 'needs_review' ? 'warning' : 'neutral'}>{c.status_label_ar}</StatusPill>
            {c.kind !== 'viva' && <AuthoredLabel note={c.authored_note_ar} />}
          </div>
          {c.scope_describe_ar && <p className="cs-muted">نطاق الأدلة: {c.scope_describe_ar}</p>}
        </div>
        <div className="ml-cluster">
          {c.version_no >= 1 && (
            <Link to={`/cases/${encodeURIComponent(c.id)}/edit`} className={buttonClass({ variant: 'secondary' })}>
              <Pencil size={16} aria-hidden="true" />
              عدّل
            </Link>
          )}
          <Button variant="plain" icon={<Trash2 size={16} />} onClick={() => setTrashOpen(true)}>
            إلى السلة
          </Button>
        </div>
      </header>

      {c.generation && (
        <section className="cs-note" aria-live="polite">
          <p>
            التوليد: {c.generation.status_label_ar}
            {c.generation.model ? ` (${c.generation.model})` : ''}
          </p>
          {c.generation.message_ar && <BidiText text={c.generation.message_ar} />}
          {c.generation.removed.length > 0 && (
            <details>
              <summary>ما حُذف لأنه لم يجتز التحقق من الأدلة ({c.generation.removed.length})</summary>
              <ul className="cs-list">
                {c.generation.removed.map((r, i) => (
                  <li key={i}>
                    <BidiText as="span" text={r.text} /> — <span className="cs-muted">{r.reason_ar}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {c.status_reasons_ar.length > 0 && !generating && (
        <section className={c.status === 'draft' ? 'cs-note cs-note--warn' : 'cs-note'} aria-labelledby="cs-reasons-h">
          <h2 id="cs-reasons-h" className="cs-note__title">
            {c.status === 'draft' ? 'لا يمكن بدء الحالة قبل إصلاح ما يلي' : 'تحتاج مراجعتك (يمكن تشغيلها)'}
          </h2>
          <ul className="cs-list">
            {c.status_reasons_ar.map((r) => (
              <li key={r}>
                <BidiText as="span" text={r} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {playable && (
        <section className="cs-section" aria-labelledby="cs-start-h">
          <h2 id="cs-start-h" className="cs-section__title">
            ابدأ محاولة
          </h2>
          <SegmentedControl
            label="متى ترى التقييم والشرح؟"
            showLabel
            value={feedback}
            onValueChange={(v) => setFeedback(v)}
            options={[
              { value: 'immediate', label: 'بعد كل خطوة' },
              { value: 'end', label: 'في النهاية' },
            ]}
          />
          {c.kind === 'viva' && (
            <>
              <SegmentedControl
                label="الحكم على إجاباتك"
                showLabel
                value={judge}
                onValueChange={(v) => setJudge(v)}
                options={[
                  { value: 'deterministic', label: 'مطابقة بالكلمات' },
                  { value: 'ai', label: 'نموذج ذكاء اصطناعي', disabled: !caps?.ai_viva_judge.available },
                ]}
              />
              {!caps?.ai_viva_judge.available && caps?.ai_viva_judge.reason_ar && <p className="cs-muted">{caps.ai_viva_judge.reason_ar}</p>}
            </>
          )}
          <p className="cs-muted">الوضع النصي فقط. {caps?.voice.reason_ar}</p>
          {startError && <ErrorState inline message={startError} />}
          <Button variant="primary" size="lg" icon={<Play size={18} />} loading={starting} onClick={() => void start()}>
            ابدأ
          </Button>
        </section>
      )}

      {attempts.length > 0 && (
        <section className="cs-section" aria-labelledby="cs-att-h">
          <h2 id="cs-att-h" className="cs-section__title">
            محاولاتك
          </h2>
          <ul className="cs-attempts">
            {attempts.map((a) => (
              <li key={a.id} className="cs-attempt">
                <span>{formatDateTime(a.started_at)}</span>
                <StatusPill tone={a.status === 'completed' ? 'success' : 'info'} icon={false}>
                  {a.status === 'completed' ? 'مكتملة' : 'جارية'}
                </StatusPill>
                {a.score && <span className="cs-muted">{`${a.score.got} من ${a.score.max} (تقدير)`}</span>}
                <Link className="cs-link" to={a.status === 'completed' ? `/cases/report/${encodeURIComponent(a.id)}` : `/cases/run/${encodeURIComponent(a.id)}`}>
                  {a.status === 'completed' ? 'التقرير' : 'أكمل'}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {c.version_no >= 1 && (
        <details className="cs-section cs-reveal">
          <summary>اعرض تعريف الحالة كاملًا (يكشف الحل)</summary>
          <DefinitionOutline c={c} />
          <p className="cs-muted">النسخة {c.version_no}. كل تعديل يُنشئ نسخة جديدة؛ المحاولات الجارية تبقى على نسختها.</p>
        </details>
      )}
      <HonestyNotes honesty={c.honesty} />
      <ConfirmDialog
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        title="نقل الحالة إلى سلة المحذوفات؟"
        impact="تختفي من القائمة، وتبقى محاولاتك وتقاريرها محفوظة. يمكنك استعادتها لاحقًا."
        confirmLabel="انقل إلى السلة"
        onConfirm={async () => {
          await casesApi.trash(c.id);
          navigate('/cases');
        }}
      />
    </div>
  );
}
