// مراجعة السؤال مع الأصل (§34, §48): the original page with the question's region highlighted next to the
// structured, editable version. Accept (records which fields you compared), correct (saved as a NEW version —
// the original and any attempted version stay as they were) or reject (the question is retired, never deleted).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { detectDir, type QuestionDetailResponse, type QuestionOriginalView, type QuestionValidationIssue } from '@medlevo/shared';
import { Breadcrumbs, Button, Checkbox, ConfirmDialog, ErrorState, IconButton, LoadingState, TextArea, TextField, useToast } from '../../design';
import { ApiError, errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { questionsApi } from './api';
import { ChecksSection } from './DetailSections';
import { AnswerPill, ExtractionPill, MixedText, NegationPill } from './labels';
import { CHECK_LABELS_AR, changedFields, nextLabel, plainOf, type EditableOption } from './model';
import { OriginalPages } from './OriginalPages';
import './questions.css';

const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'stem', label: 'نص السؤال' },
  { key: 'options', label: 'الخيارات وتسمياتها' },
  { key: 'images', label: 'الصور والجداول التابعة' },
  { key: 'key', label: 'مفتاح الإجابة' },
];

export function ReviewScreen() {
  const { questionId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('مراجعة السؤال مع الأصل');
  const [d, setD] = useState<QuestionDetailResponse | null>(null);
  const [orig, setOrig] = useState<QuestionOriginalView | null>(null);
  const [origError, setOrigError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState<EditableOption[]>([]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set(['stem', 'options']));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'save' | 'accept' | null>(null);
  const [blockers, setBlockers] = useState<QuestionValidationIssue[] | null>(null);
  const [ack, setAck] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const det = await questionsApi.detail(questionId);
      setD(det);
      setStem(plainOf(det.question.current.stem));
      setOptions(det.question.current.options.map((o) => ({ option_key: o.option_key, source_label: o.source_label, text: plainOf(o.text) })));
      setError(null);
      try {
        setOrig(await questionsApi.original(questionId));
      } catch (e) {
        setOrigError(errorMessage(e));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [questionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const original = useMemo(
    () => (d ? { stem: plainOf(d.question.current.stem), options: d.question.current.options.map((o) => ({ option_key: o.option_key, source_label: o.source_label, text: plainOf(o.text) })) } : null),
    [d],
  );
  const changed = original ? changedFields(original, { stem, options }) : [];

  if (!d && !error) return <LoadingState stage="جارٍ تحميل السؤال وأصله…" />;
  if (error && !d) {
    return (
      <div className="ml-page">
        <ErrorState message={error} onRetry={() => void load()} />
      </div>
    );
  }
  const q = d!.question;
  const v = q.current;

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await questionsApi.correct(q.id, {
        stem: changed.includes('stem') ? stem : undefined,
        options: changed.includes('options') ? options.map((o) => ({ option_key: o.option_key, source_label: o.source_label, text: o.text })) : undefined,
        reviewed_fields: [...reviewed],
        note: note.trim() || undefined,
      });
      toast.show({ tone: 'success', title: 'حُفظ التصحيح في نسخة جديدة', description: 'النسخة السابقة محفوظة كما هي في سجل النسخ.' });
      navigate(`/questions/${q.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    setBusy('accept');
    setError(null);
    try {
      await questionsApi.review(q.id, { decision: 'accept', reviewed_fields: [...reviewed], reason: note.trim() || undefined, acknowledge_blockers: ack || undefined });
      toast.show({ tone: 'success', title: 'اعتمدتَ السؤال بعد مراجعته', description: 'سُجلت الحقول التي قارنتها بالأصل.' });
      navigate(`/questions/${q.id}`);
    } catch (e) {
      if (isApiError(e) && e.status === 409 && (e as ApiError).details) {
        const det = (e as ApiError).details as { blockers?: Array<{ check: QuestionValidationIssue['check']; reason_ar: string }> };
        setBlockers((det.blockers ?? []).map((b) => ({ check: b.check, reason_ar: b.reason_ar, passed: false, severity: 'blocker' as const })));
      } else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    await questionsApi.review(q.id, { decision: 'reject', reason: note.trim() || undefined });
    toast.show({ tone: 'neutral', title: 'استُبعد السؤال', description: 'بقي محفوظًا مع محاولاتك، ولن يظهر في التدريب أو الاختبارات.' });
    navigate('/questions/review');
  };

  const setOpt = (i: number, patch: Partial<EditableOption>) => setOptions((xs) => xs.map((o, k) => (k === i ? { ...o, ...patch } : o)));

  return (
    <div className="ml-page qv-page qv-review">
      <Breadcrumbs items={[{ label: 'خزنة أسئلتي', to: '/questions' }, { label: 'السؤال', to: `/questions/${q.id}` }, { label: 'المراجعة مع الأصل' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">المراجعة مع الأصل</h1>
        <p className="ml-page__lede">
          <MixedText text={q.origin_label_ar} />
        </p>
        <div className="ml-cluster">
          <ExtractionPill status={v.extraction_status} />
          <AnswerPill status={v.answer_status} />
          <NegationPill terms={v.negation_terms} />
        </div>
      </header>

      <div className="qv-review__grid">
        <section className="qv-review__original" aria-labelledby="qv-orig-h">
          <h2 id="qv-orig-h" className="qv-section__h">
            الأصل
          </h2>
          {orig ? <OriginalPages original={orig} /> : origError ? <ErrorState inline message={origError} /> : <LoadingState stage="جارٍ تحميل الصفحة الأصلية…" />}
          {orig?.raw_text && (
            <details className="qv-details">
              <summary>النص كما استُخرج من الصفحة</summary>
              <p className="qv-rawtext">
                <MixedText text={orig.raw_text} />
              </p>
            </details>
          )}
        </section>

        <section className="qv-review__form" aria-labelledby="qv-form-h">
          <h2 id="qv-form-h" className="qv-section__h">
            النسخة المنظمة
          </h2>
          <TextArea label="نص السؤال" value={stem} onChange={(e) => setStem(e.target.value)} rows={4} dir={detectDir(stem)} />
          <fieldset className="qv-optedit">
            <legend className="ml-field__label">الخيارات (التسمية كما طُبعت ونص الخيار)</legend>
            {options.map((o, i) => (
              <div key={o.option_key ?? `new-${i}`} className="qv-optedit__row">
                <TextField
                  label={`تسمية الخيار ${i + 1}`}
                  hideLabel
                  value={o.source_label ?? ''}
                  onChange={(e) => setOpt(i, { source_label: e.target.value || null })}
                  className="qv-optedit__label"
                  fieldClassName="qv-optedit__labelfield"
                  maxLength={8}
                />
                <TextField
                  label={`نص الخيار ${o.source_label ?? i + 1}`}
                  hideLabel
                  value={o.text}
                  onChange={(e) => setOpt(i, { text: e.target.value })}
                  dir={detectDir(o.text)}
                  fieldClassName="qv-optedit__textfield"
                />
                <IconButton label={`حذف الخيار ${o.source_label ?? i + 1}`} icon={<Trash2 size={16} />} onClick={() => setOptions((xs) => xs.filter((_, k) => k !== i))} />
              </div>
            ))}
            <Button size="sm" variant="plain" icon={<Plus size={16} />} onClick={() => setOptions((xs) => [...xs, { source_label: nextLabel(xs.map((x) => x.source_label)), text: '' }])}>
              إضافة خيار
            </Button>
          </fieldset>

          <fieldset className="qv-reviewed">
            <legend className="ml-field__label">ما الذي قارنته بالأصل بنفسك؟</legend>
            {FIELDS.map((f) => (
              <Checkbox
                key={f.key}
                label={f.label}
                checked={reviewed.has(f.key)}
                onCheckedChange={(c) =>
                  setReviewed((s) => {
                    const n = new Set(s);
                    if (c) n.add(f.key);
                    else n.delete(f.key);
                    return n;
                  })
                }
              />
            ))}
          </fieldset>
          <TextField label="ملاحظة (اختيارية، تُحفظ مع القرار)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />

          {blockers && blockers.length > 0 && (
            <div className="qv-alert" role="alert">
              <p>
                <strong>لا يُعتمد السؤال تلقائيًا:</strong> فحوص مانعة لم تُجتز.
              </p>
              <ul className="qv-blockers">
                {blockers.map((b) => (
                  <li key={b.check}>
                    {CHECK_LABELS_AR[b.check]}: {b.reason_ar}
                  </li>
                ))}
              </ul>
              <Checkbox label="قارنتُ النص بالأصل وأعتمده رغم ذلك" checked={ack} onCheckedChange={setAck} />
            </div>
          )}
          {error && <ErrorState inline message={error} />}

          <div className="ml-cluster qv-review__actions">
            {changed.length > 0 ? (
              <Button variant="primary" loading={busy === 'save'} onClick={() => void save()} disabled={!stem.trim()}>
                حفظ التصحيح كنسخة جديدة
              </Button>
            ) : (
              <Button variant="primary" loading={busy === 'accept'} onClick={() => void accept()} disabled={(blockers?.length ?? 0) > 0 && !ack}>
                قبول كما هو
              </Button>
            )}
            {changed.length > 0 && (
              <Button
                variant="plain"
                onClick={() => {
                  setStem(original!.stem);
                  setOptions(original!.options);
                }}
              >
                تراجع عن التعديلات
              </Button>
            )}
            <Button variant="destructive" onClick={() => setRejectOpen(true)} disabled={busy !== null}>
              رفض السؤال
            </Button>
            <Link to={`/questions/${q.id}`} className="qv-link">
              تفاصيل السؤال
            </Link>
          </div>
          <ChecksSection issues={v.validation?.issues} />
        </section>
      </div>

      <ConfirmDialog
        open={rejectOpen}
        title="رفض هذا السؤال؟"
        impact="يُستبعد السؤال من الخزنة والتدريب والاختبارات، لكنه لا يُحذف: يبقى مع محاولاتك وسجله، ويمكنك إعادته بقبوله لاحقًا من تصفية «مستبعد»."
        confirmLabel="رفض السؤال"
        destructive
        onConfirm={reject}
        onCancel={() => setRejectOpen(false)}
      />
    </div>
  );
}
