// «النسخ المشتقة» on the question screen (§35, §37, track F3): translations and paraphrases as DERIVED versions.
// The original above stays the question — its options, key, attempts and exams are unchanged; a derived version reuses
// the original option ids and key (shown with the same «الإجابة» mark), is labelled «نسخة مشتقة … ليست نص السؤال
// الأصلي ولا تُنسب إلى امتحان سابق», and is shown only after its checks passed (failed ones wait in the review queue).
// Without an AI provider the buttons are disabled with the server's reason.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, Languages, PenLine } from 'lucide-react';
import {
  DERIVED_LANG_LABELS_AR,
  DERIVED_VERSION_LABELS_AR,
  type DeriveQuestionRequest,
  type QuestionDerivationResponse,
  type QuestionDerivationView,
  type QuestionDerivationsResponse,
  type QuestionVersionView,
} from '@medlevo/shared';
import { Bidi, Button, ErrorState, RichTextView, StatusPill } from '../../design';
import { api, errorMessage } from '../../lib/api';

const enc = encodeURIComponent;
export const derivedApi = {
  list: (questionId: string) => api.get<QuestionDerivationsResponse>(`/questions/${enc(questionId)}/derived`),
  request: (questionId: string, body: DeriveQuestionRequest) => api.post<QuestionDerivationResponse>(`/questions/${enc(questionId)}/derived`, body, { timeoutMs: 30_000 }),
  get: (derivationId: string) => api.get<QuestionDerivationResponse>(`/questions/derivations/${enc(derivationId)}`),
};

const PENDING = new Set(['queued', 'running']);

function tone(s: QuestionDerivationView['status']): 'success' | 'warning' | 'danger' | 'info' {
  return s === 'published' ? 'success' : s === 'needs_review' ? 'warning' : s === 'failed' ? 'danger' : 'info';
}

export function DerivedVersionsSection({ questionId, original }: { questionId: string; original: QuestionVersionView }) {
  const [data, setData] = useState<QuestionDerivationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const r = await derivedApi.list(questionId);
      if (!r || !Array.isArray(r.derivations) || !r.can_derive) {
        setError('تعذّر تحميل النسخ المشتقة.');
        return;
      }
      setData(r);
      setError(null);
      window.clearTimeout(timer.current);
      if (r.derivations.some((d) => PENDING.has(d.status))) timer.current = window.setTimeout(() => void load(), 2000);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل النسخ المشتقة.'));
    }
  }, [questionId]);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load]);

  const request = async (body: DeriveQuestionRequest, key: string) => {
    setBusy(key);
    try {
      await derivedApi.request(questionId, body);
      await load();
    } catch (e) {
      setError(errorMessage(e, 'تعذّر طلب النسخة المشتقة.'));
    } finally {
      setBusy(null);
    }
  };

  const can = data?.can_derive ?? { available: false, reason_ar: null };
  const lang = original.lang === 'ar' ? 'ar' : 'en';
  const reasonId = `qv-derive-why-${questionId}`;
  const disabled = !can.available || !!busy;
  return (
    <section className="qv-section" aria-labelledby="qv-derived-h">
      <h2 id="qv-derived-h" className="qv-section__h">
        <Languages size={18} aria-hidden="true" /> النسخ المشتقة (ترجمة وإعادة صياغة)
      </h2>
      <p className="qv-muted">نسخة مساعدة تُعرض بجانب الأصل ولا تحل محله: الخيارات والمفتاح هي نفسها، ويُتحقق من تطابق المعنى (النفي والأرقام والوحدات وكل خيار) قبل عرضها.</p>
      <div className="ml-cluster">
        {lang !== 'ar' && (
          <Button size="sm" variant="secondary" icon={<Languages size={16} />} loading={busy === 'ar'} disabled={disabled} aria-describedby={!can.available ? reasonId : undefined} onClick={() => void request({ kind: 'translation', lang: 'ar' }, 'ar')}>
            ترجمة إلى العربية
          </Button>
        )}
        {lang !== 'en' && (
          <Button size="sm" variant="secondary" icon={<Languages size={16} />} loading={busy === 'en'} disabled={disabled} aria-describedby={!can.available ? reasonId : undefined} onClick={() => void request({ kind: 'translation', lang: 'en' }, 'en')}>
            ترجمة إلى الإنجليزية
          </Button>
        )}
        <Button size="sm" variant="plain" icon={<PenLine size={16} />} loading={busy === 'para'} disabled={disabled} aria-describedby={!can.available ? reasonId : undefined} onClick={() => void request({ kind: 'paraphrase' }, 'para')}>
          إعادة صياغة
        </Button>
      </div>
      {data && !can.available && (
        <p id={reasonId} className="qv-muted" role="note">
          {can.reason_ar}
        </p>
      )}
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      {data && data.derivations.length === 0 && <p className="qv-muted">لا توجد نسخ مشتقة لهذا السؤال.</p>}
      {data && data.derivations.length > 0 && (
        <ul className="qv-versions">
          {data.derivations.map((d) => (
            <li key={d.id} className="qv-card">
              <div className="ml-cluster">
                <strong>{`${DERIVED_VERSION_LABELS_AR[d.kind]} — ${(DERIVED_LANG_LABELS_AR as Record<string, string>)[d.lang] ?? d.lang}`}</strong>
                <StatusPill tone={tone(d.status)}>{d.status_label_ar}</StatusPill>
              </div>
              {d.error_ar && <p className="qv-muted">{d.error_ar}</p>}
              {d.status === 'needs_review' && d.issues.length > 0 && (
                <ul className="qv-muted">
                  {d.issues.slice(0, 4).map((i, k) => (
                    <li key={k}>{i.reason_ar}</li>
                  ))}
                </ul>
              )}
              {d.derived && (
                <>
                  <Button size="sm" variant="plain" aria-expanded={shown === d.id} onClick={() => setShown((s) => (s === d.id ? null : d.id))}>
                    {shown === d.id ? 'أخفِ النسخة المشتقة' : 'اعرض النسخة المشتقة'}
                  </Button>
                  {shown === d.id && (
                    <div className="qv-derived" lang={d.derived.lang}>
                      <p className="qv-derived__notice" role="note">
                        {`${d.derived.label_ar}: ${d.derived.notice_ar}`}
                      </p>
                      {d.derived.stale_note_ar && <p className="qv-muted">{d.derived.stale_note_ar}</p>}
                      {d.derived.has_negation && (
                        <StatusPill tone="info" icon={false}>
                          بصيغة نفي (كما في الأصل)
                        </StatusPill>
                      )}
                      <RichTextView value={d.derived.stem} />
                      <ol className="qv-options qv-options--compact">
                        {d.derived.options.map((o) => {
                          const correct = d.derived!.correct_option_keys?.includes(o.option_key) ?? false;
                          return (
                            <li key={o.id} data-option-id={o.id}>
                              <Bidi dir={/[A-Za-z0-9]/.test(o.display_label) ? 'ltr' : 'rtl'} className="qv-label">
                                {o.display_label}
                              </Bidi>
                              <RichTextView value={o.text} />
                              {correct && (
                                <span className="qv-correct-inline">
                                  <CircleCheck size={14} aria-hidden="true" /> الإجابة (مفتاح الأصل نفسه)
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
