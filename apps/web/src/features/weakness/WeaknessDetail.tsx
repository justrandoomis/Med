// /weakness/:id — one weakness (§44, AC-27): why it is listed (reasons, signals with their AC-27 weights, the score
// formula — an estimate), what to do (suggested actions, a dedicated revision for repeated mistakes) and the owner's
// corrections: rename, note, dismiss / resolve / bring back, exclude a signal that does not belong (the attempt itself
// is never changed).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Repeat } from 'lucide-react';
import { CONFIDENCE_LEVELS, MISTAKE_TYPE_LABELS_AR, type WeaknessDetailView } from '@medlevo/shared';
import { Button, Checkbox, ErrorState, LoadingState, TextArea, TextField, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { formatDate, formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { learningApi } from '../review/api';
import { MinutesPicker } from '../review/components/MinutesPicker';
import { replayUrl } from '../review/links';
import { ActionButton, WEAKNESS_KIND_AR, WeaknessStatus } from './parts';
import '../review/learning.css';
import './weakness.css';

const TYPE_AR: Record<string, string> = { mcq: 'سؤال اختيار', card: 'مراجعة بطاقة', written: 'إجابة مقالية', case: 'حالة سريرية', osce: 'OSCE', viva: 'امتحان شفهي' };
const CONF_AR: Record<(typeof CONFIDENCE_LEVELS)[number], string> = { guess: 'تخمين', unsure: 'غير متأكد', confident: 'واثق' };

export function WeaknessDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const caps = useCapabilities();
  const toast = useToast();
  const [w, setW] = useState<WeaknessDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(20);
  usePageTitle(w?.label ?? 'نقطة ضعف');

  const apply = (v: WeaknessDetailView) => {
    setW(v);
    setLabel(v.label);
    setNote(v.owner_note ?? '');
  };
  useEffect(() => {
    void learningApi
      .weakness(id)
      .then(apply)
      .catch((e) => setError(errorMessage(e, 'تعذّر تحميل نقطة الضعف.')));
  }, [id]);

  const patch = async (body: Parameters<typeof learningApi.patchWeakness>[1], ok: string) => {
    setBusy(true);
    try {
      apply(await learningApi.patchWeakness(id, body));
      toast.show({ title: ok, tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر الحفظ.'), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="ml-page lw-page"><ErrorState message={error} /></div>;
  if (!w) return <div className="ml-page lw-page"><LoadingState stage="جارٍ تحميل نقطة الضعف…" /></div>;
  const c = w.counts;
  const excluded = new Set(w.signal_views.filter((s) => s.excluded).map((s) => s.ref));

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <p className="lw-muted">{WEAKNESS_KIND_AR[w.kind] ?? w.kind}</p>
          <h1 className="ml-page__title">
            <BidiText as="span" text={w.label} />
          </h1>
          <p className="ml-cluster">
            <WeaknessStatus status={w.status} />
            <span className="lw-muted">{w.status_reason_ar}</span>
          </p>
        </div>
        <Link to="/weakness" className={buttonClass({ variant: 'plain' })}>
          <ArrowRight size={16} aria-hidden="true" />
          نقاط الضعف
        </Link>
      </header>

      <div className="lw-editor">
        <div className="lw-stack">
          <section className="lw-sheet" aria-labelledby="lw-why-h">
            <h2 id="lw-why-h" className="lw-sheet__title">
              لماذا تظهر هنا
            </h2>
            <ul className="lw-wk__reasons">
              {w.reasons_ar.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="lw-muted">{`عدد الإشارات ${c.signals}: ${c.wrong} خاطئة، ${c.correct_independent} صحيحة باستقلال وثقة، ${c.correct_assisted} صحيحة بمساعدة أو تخمين، ${c.not_scored} غير محسوبة، ${c.lapses} نسيان بطاقات، ${c.excluded} استبعدتها.`}</p>
            <p className="lw-muted">{`مؤشر الضعف (تقدير): ${w.score.toFixed(2)} — ${w.score_formula_ar}`}</p>
          </section>

          {w.suggested_actions.length > 0 && (
            <section className="lw-sheet" aria-labelledby="lw-do-h">
              <h2 id="lw-do-h" className="lw-sheet__title">
                ما يُقترح الآن
              </h2>
              <div className="lw-wk__actions lw-stack-sm">
                {w.suggested_actions.map((a, i) => (
                  <ActionButton key={`${a.kind}-${i}`} action={a} back={`/weakness/${encodeURIComponent(w.id)}`} />
                ))}
              </div>
            </section>
          )}

          {(w.repeated.summary_ar || w.dedicated_revision_available) && (
            <section className="lw-sheet" aria-labelledby="lw-rep-h">
              <h2 id="lw-rep-h" className="lw-sheet__title">
                <Repeat size={18} aria-hidden="true" /> أخطاء متكررة
              </h2>
              {w.repeated.summary_ar && <p>{w.repeated.summary_ar}</p>}
              {w.dedicated_revision_available && (
                <>
                  <p className="lw-muted">مراجعة مخصّصة لهذه النقطة: أسئلتها وبطاقاتها وصفحاتها، ضمن المدة التي تحددها.</p>
                  <MinutesPicker value={minutes} onChange={setMinutes} />
                  <Button
                    variant="primary"
                    loading={busy}
                    disabled={!caps.online}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const s = await learningApi.weaknessRevision(w.id, Math.max(5, minutes));
                        navigate(`/review/revision/${encodeURIComponent(s.id)}`);
                      } catch (e) {
                        toast.show({ title: errorMessage(e, 'تعذّر بناء المراجعة.'), tone: 'danger' });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    ابنِ مراجعة مخصّصة
                  </Button>
                </>
              )}
            </section>
          )}

          <section className="lw-sheet" aria-labelledby="lw-sig-h">
            <h2 id="lw-sig-h" className="lw-sheet__title">
              الإشارات ({w.signal_views.length})
            </h2>
            <p className="lw-muted">كل إشارة بوزنها في التقدير. إن كانت إشارة لا تخص هذه النقطة فاستبعدها — المحاولة نفسها لا تتغير.</p>
            <ul className="lw-signals">
              {w.signal_views.map((s) => (
                <li key={s.ref} className="lw-signals__item" data-excluded={s.excluded || undefined}>
                  <div className="lw-signals__main">
                    <BidiText as="span" className="lw-signals__label" text={s.label} />
                    <span className="lw-muted">
                      {`${TYPE_AR[s.type] ?? s.type} — ${formatDateTime(s.at)} — ${s.category_label_ar}${s.weight !== null ? ` (وزن ${s.weight})` : ''}`}
                      {s.confidence && ` — ${CONF_AR[s.confidence]}`}
                      {s.hints_used > 0 && ` — تلميحات: ${s.hints_used}`}
                      {s.mistake_type && ` — ${MISTAKE_TYPE_LABELS_AR[s.mistake_type]}${s.mistake_origin === 'auto' ? ' (تلقائي)' : ''}`}
                    </span>
                    {s.question_id && (
                      <Link className="lw-link" to={replayUrl(s.question_id, s.type === 'mcq' ? s.ref.replace(/^mcq:/, '') : null)}>
                        لماذا ترجح إجابة على أخرى؟
                      </Link>
                    )}
                  </div>
                  <Checkbox
                    label="استبعدها"
                    checked={excluded.has(s.ref)}
                    disabled={!caps.online || busy}
                    onCheckedChange={(v) => {
                      const next = new Set(excluded);
                      if (v) next.add(s.ref);
                      else next.delete(s.ref);
                      void patch({ excluded_refs: [...next] }, v ? 'استُبعدت الإشارة من هذه النقطة (المحاولة لم تتغير).' : 'أُعيدت الإشارة.');
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="lw-editor__preview" aria-label="تصحيحاتك">
          <h2 className="lw-sheet__subtitle">الاسم والملاحظة</h2>
          <TextField label="الاسم" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} hint={w.label_origin === 'owner' ? 'اسم وضعته بنفسك.' : 'اسم تلقائي من المفهوم أو المحاضرة.'} />
          <TextArea label="ملاحظتك" value={note} maxLength={2000} rows={3} onChange={(e) => setNote(e.target.value)} />
          <Button variant="secondary" loading={busy} disabled={!caps.online || (label === w.label && note === (w.owner_note ?? ''))} onClick={() => void patch({ label: label.trim() || null, note: note.trim() || null }, 'حُفظ.')}>
            احفظ
          </Button>
          <h2 className="lw-sheet__subtitle">الحالة</h2>
          <p className="lw-muted">{w.status_origin === 'owner' ? 'حالة حددتها بنفسك؛ تبقى حتى تظهر أخطاء جديدة بعدها.' : 'حالة تلقائية من إشاراتك.'}</p>
          <div className="ml-cluster">
            {w.status !== 'resolved' && (
              <Button size="sm" variant="secondary" disabled={!caps.online || busy} onClick={() => void patch({ status: 'resolved' }, 'علّمتها متجاوزة.')}>
                تجاوزتها
              </Button>
            )}
            {w.status !== 'dismissed' && (
              <Button size="sm" variant="secondary" disabled={!caps.online || busy} onClick={() => void patch({ status: 'dismissed' }, 'استُبعدت؛ تعود إن ظهرت أخطاء جديدة.')}>
                ليست نقطة ضعف
              </Button>
            )}
            {(w.status === 'dismissed' || w.status === 'resolved') && (
              <Button size="sm" variant="secondary" disabled={!caps.online || busy} onClick={() => void patch({ status: 'active' }, 'أُعيدت نشطة.')}>
                أعدها نشطة
              </Button>
            )}
          </div>
          <p className="lw-muted">{`ظهرت أول مرة ${formatDate(w.created_at)}${w.last_signal_at ? `، آخر إشارة ${formatDate(w.last_signal_at)}` : ''}.`}</p>
        </aside>
      </div>
    </div>
  );
}
