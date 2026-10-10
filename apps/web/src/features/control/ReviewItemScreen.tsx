// The review desk (§48): the ORIGINAL (page region / page) next to the STRUCTURED data, the specific reason, and the
// owner's decision — accept / correct / reject / close — each with exactly what it does, before it is applied.
// Correcting extracted text never loses the previous text (history below) and raises a content change alert for
// whatever depends on that page (AC-26). Items owned by another screen link there.
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Bell, ChevronRight, ExternalLink } from 'lucide-react';
import type { LectureKind, ResolveReviewResponse, ReviewActionSpec, ReviewItemDetail, ReviewStructured } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Select, StatusPill, TextArea, TextField, buttonClass } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';
import { confidenceLabel } from './model';
import { OriginalView } from './OriginalView';
import { useControlContext, useLoad } from './shared';

function TextBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? 'cc-text'}>
      {text.split(/\n+/).map((line, i) => (
        <BidiText key={i} as="p" text={line} />
      ))}
    </div>
  );
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="cc-facts">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="cc-facts__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function Structured({ s }: { s: ReviewStructured }) {
  switch (s.type) {
    case 'region':
      return (
        <>
          <Facts
            rows={[
              ['النوع', s.region.kind_label_ar],
              ['مصدر النص', s.region.text_origin_label_ar],
              ['الحالة', s.region.status_label_ar],
              ['الثقة', confidenceLabel(s.region.confidence)],
            ]}
          />
          {s.region.text ? <TextBlock text={s.region.text} /> : <p className="cc-muted">لا نص في هذه المنطقة.</p>}
        </>
      );
    case 'page':
      return (
        <>
          <Facts
            rows={[
              ['قراءة النص', s.page.text_status_label_ar],
              ['السبب', s.page.error_detail_ar ? <BidiText as="span" dir="rtl" text={s.page.error_detail_ar} /> : null],
              ['مناطق مقروءة في الصفحة', String(s.page.region_count)],
              ['الثقة', confidenceLabel(s.page.ocr_confidence)],
            ]}
          />
          {s.page.owner_text ? (
            <>
              <p className="cc-label">النص الذي كتبته لهذه الصفحة</p>
              <TextBlock text={s.page.owner_text} />
            </>
          ) : (
            <p className="cc-muted">لا يوجد نص مستخرج لهذه الصفحة. لن يُخترع لها أي نص.</p>
          )}
        </>
      );
    case 'classification':
      return (
        <Facts
          rows={[
            ['التصنيف الحالي', s.current ? `${s.options.find((o) => o.value === s.current)?.label_ar ?? s.current}${s.current_origin === 'owner' ? ' (قرارك)' : s.current_origin === 'auto' ? ' (تلقائي)' : ''}` : 'بلا تصنيف'],
            ['المقترح', s.suggested ? (s.options.find((o) => o.value === s.suggested)?.label_ar ?? s.suggested) : '—'],
            [
              'لماذا',
              s.reasons_ar.length ? (
                <ul className="cc-bullets">
                  {s.reasons_ar.map((r, i) => (
                    <li key={i}>
                      <BidiText as="span" dir="rtl" text={r} />
                    </li>
                  ))}
                </ul>
              ) : null,
            ],
          ]}
        />
      );
    case 'claim':
      return (
        <>
          <Facts rows={[['المحتوى', s.artifact_title], ['نوع الدعم', s.support_label_ar], ['الحالة', s.status_label_ar]]} />
          <TextBlock text={s.text} />
        </>
      );
    case 'question':
      return s.stem_preview ? <TextBlock text={s.stem_preview} /> : <p className="cc-muted">افتح السؤال لترى نصه وخياراته مع الصفحة الأصلية.</p>;
    case 'note_anchor':
      return (
        <>
          <Facts rows={[['النسخة السابقة من كتاب الدراسة', s.previous_version_no !== null ? String(s.previous_version_no) : null], ['النسخة الجديدة', s.new_version_no !== null ? String(s.new_version_no) : null]]} />
          {s.preview ? <TextBlock text={s.preview} /> : null}
        </>
      );
    case 'generated_question':
      return (
        <>
          <p className="cc-label">سؤال مولّد — لم يُنشر</p>
          {s.stem && <TextBlock text={s.stem} />}
          {s.options.length > 0 && (
            <ol className="cc-bullets" type="A" dir="ltr">
              {s.options.map((o, i) => (
                <li key={i}>
                  <BidiText as="span" text={o} />
                </li>
              ))}
            </ol>
          )}
          {s.issues_ar.length > 0 && (
            <>
              <p className="cc-label">لماذا لم يجتز الفحص</p>
              <ul className="cc-bullets">
                {s.issues_ar.map((x, i) => (
                  <li key={i}>
                    <BidiText as="span" dir="rtl" text={x} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
    default:
      return s.facts.length ? <Facts rows={s.facts.map((f) => [f.label_ar, f.value])} /> : <p className="cc-muted">لا توجد بيانات إضافية.</p>;
  }
}

function currentText(s: ReviewStructured): string {
  if (s.type === 'region') return s.region.text ?? '';
  if (s.type === 'page') return s.page.owner_text ?? '';
  return '';
}

function Decide({ item, onDone }: { item: ReviewItemDetail; onDone: (r: ResolveReviewResponse) => void }) {
  const groupId = useId();
  const [action, setAction] = useState<ReviewActionSpec | null>(null);
  const [text, setText] = useState(currentText(item.structured));
  const [kind, setKind] = useState<LectureKind | ''>(item.structured.type === 'classification' ? (item.structured.suggested ?? '') : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!action) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const r = await controlApi.resolve(item.id, {
        action: action.action,
        ...(action.input === 'text' ? { text } : {}),
        ...(action.input === 'lecture_kind' && kind ? { lecture_kind: kind } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(r);
    } catch (err) {
      const f = fieldErrors(err);
      if (f.text) setFieldError(f.text);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cc-decide" onSubmit={(e) => void submit(e)} aria-labelledby={`${groupId}-h`}>
      <h2 id={`${groupId}-h`} className="cc-desk__title">
        قرارك
      </h2>
      <fieldset className="cc-choices">
        <legend className="ml-visually-hidden">اختر ما تريد فعله بهذا العنصر</legend>
        {item.actions.map((a) => (
          <label key={a.action} className="cc-choice" data-selected={action?.action === a.action || undefined}>
            <input type="radio" name={`${groupId}-action`} value={a.action} checked={action?.action === a.action} onChange={() => setAction(a)} />
            <span className="cc-choice__text">
              <span className="cc-choice__label">{a.label_ar}</span>
              <span className="cc-choice__effect">{a.effect_ar}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {action?.input === 'text' && (
        <TextArea
          label={item.structured.type === 'page' ? 'نص الصفحة كما تقرؤه في الأصل' : 'النص الصحيح كما في الأصل'}
          hint="اكتب النص كما هو مطبوع، بالعربية والإنجليزية كما وردتا. يُحفظ النص السابق في السجل."
          rows={Math.min(14, Math.max(4, Math.ceil(text.length / 60)))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="cc-editor"
          dir="auto"
          error={fieldError ?? undefined}
          required
        />
      )}
      {action?.input === 'lecture_kind' && item.structured.type === 'classification' && (
        <Select<LectureKind | ''>
          label="نوع المحاضرة"
          value={kind}
          onValueChange={setKind}
          options={[{ value: '', label: 'اختر…' }, ...item.structured.options.map((o) => ({ value: o.value, label: o.label_ar }))]}
        />
      )}
      {action && <TextField label="ملاحظتك (اختيارية)" hint="تُحفظ مع القرار في السجل." value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />}
      {error && <ErrorState inline message={error} />}
      <div className="cc-decide__actions">
        <Button type="submit" variant={action?.action === 'reject' ? 'destructive' : 'primary'} disabled={!action || (action.input === 'lecture_kind' && !kind)} loading={busy} loadingLabel="جارٍ الحفظ…">
          {action ? `طبّق: ${action.label_ar}` : 'اختر قرارًا أولًا'}
        </Button>
      </div>
    </form>
  );
}

function Outcome({ r }: { r: ResolveReviewResponse }) {
  return (
    <section className="cc-outcome" role="status" aria-live="polite" aria-label="ما حدث">
      <p className="cc-outcome__title">حُفظ قرارك</p>
      <ul className="cc-bullets">
        {r.effects_ar.map((e, i) => (
          <li key={i}>
            <BidiText as="span" dir="rtl" text={e} />
          </li>
        ))}
      </ul>
      {r.alert && (
        <Link to="/control/alerts" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <Bell size={14} aria-hidden="true" /> اعرض تنبيه تغيّر المحتوى
        </Link>
      )}
    </section>
  );
}

export function ReviewItemScreen() {
  const { itemId = '' } = useParams();
  const item = useLoad(() => controlApi.reviewItem(itemId), [itemId]);
  const [outcome, setOutcome] = useState<ResolveReviewResponse | null>(null);
  const { reloadOverview } = useControlContext();
  usePageTitle(item.data ? `${item.data.kind_label_ar} — المراجعة` : 'عنصر مراجعة');
  useEffect(() => setOutcome(null), [itemId]);
  const d = item.data;

  return (
    <div className="cc-section cc-item">
      <Link to="/control/review" className="cc-back cc-back--always">
        <ChevronRight size={18} aria-hidden="true" />
        <span>قائمة المراجعة</span>
      </Link>
      {item.error ? (
        <ErrorState message={item.error} onRetry={item.reload} />
      ) : !d ? (
        <LoadingState stage="جارٍ فتح عنصر المراجعة…" />
      ) : (
        <>
          <header className="cc-head">
            <div className="cc-head__row">
              <h1 className="ml-page__title cc-head__title">{d.kind_label_ar}</h1>
              <StatusPill tone={d.status === 'open' ? 'warning' : d.status === 'dismissed' ? 'neutral' : 'success'}>{d.status_label_ar}</StatusPill>
            </div>
            <div className="cc-reason">
              <p className="cc-label">سبب المراجعة</p>
              <BidiText as="p" dir="rtl" text={d.reason} />
            </div>
            <p className="cc-where">
              {d.source_title && <BidiText as="span" dir="rtl" text={d.source_title} />}
              {d.location_label_ar && <span>{d.location_label_ar}</span>}
              {d.original && <span>النسخة {d.original.version_no}{d.original.is_active_version ? '' : ' (ليست النسخة المستخدمة للدراسة)'}</span>}
              <span>{formatDateTime(d.created_at)}</span>
            </p>
          </header>

          {d.link && (
            <div className="cc-handoff">
              <p>{d.actions_note_ar ?? 'يُعالج هذا العنصر في شاشته الخاصة.'}</p>
              <Link to={d.link.href} className={buttonClass({ variant: 'primary' })}>
                {d.link.label_ar}
              </Link>
            </div>
          )}

          <div className="cc-desk">
            <section className="cc-desk__side cc-desk__side--orig" aria-labelledby="cc-orig-h">
              <h2 id="cc-orig-h" className="cc-desk__title">
                الأصل
              </h2>
              {d.original ? (
                <>
                  <OriginalView original={d.original} />
                  {d.original.open_link && (
                    <Link to={d.original.open_link.href} className="cc-link">
                      <ExternalLink size={14} aria-hidden="true" /> {d.original.open_link.label_ar}
                    </Link>
                  )}
                </>
              ) : (
                <p className="cc-muted">هذا العنصر لا يشير إلى صفحة محددة في مصدر.</p>
              )}
            </section>
            <section className="cc-desk__side cc-desk__side--struct" aria-labelledby="cc-struct-h">
              <h2 id="cc-struct-h" className="cc-desk__title">
                النسخة المنظمة
              </h2>
              <Structured s={d.structured} />
            </section>
          </div>

          {outcome && <Outcome r={outcome} />}

          {d.status === 'open' && d.actions.length > 0 ? (
            <>
              {!d.link && d.actions_note_ar && <p className="cc-muted">{d.actions_note_ar}</p>}
              <Decide
                key={d.id}
                item={d}
                onDone={(r) => {
                  setOutcome(r);
                  item.setData(r.item);
                  reloadOverview();
                }}
              />
            </>
          ) : d.resolution ? (
            <section className="cc-resolution" aria-label="القرار المحفوظ">
              <h2 className="cc-desk__title">القرار المحفوظ</h2>
              <Facts
                rows={[
                  ['القرار', d.status_label_ar],
                  ['بواسطة', d.resolution.by === 'owner' ? 'أنت' : d.resolution.by === 'server' ? 'الخادم (تلقائيًا)' : d.resolution.by],
                  ['متى', d.resolution.at ? formatDateTime(d.resolution.at) : null],
                  ['ملاحظتك', d.resolution.note ? <BidiText as="span" dir="rtl" text={d.resolution.note} /> : null],
                ]}
              />
              {!outcome && d.resolution.effects_ar.length > 0 && (
                <ul className="cc-bullets">
                  {d.resolution.effects_ar.map((e, i) => (
                    <li key={i}>
                      <BidiText as="span" dir="rtl" text={e} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {d.corrections.length > 0 && (
            <section className="cc-corrections" aria-labelledby="cc-corr-h">
              <h2 id="cc-corr-h" className="cc-desk__title">
                سجل التصحيحات
              </h2>
              <p className="cc-muted">النص السابق لا يُحذف أبدًا؛ كل تغيير محفوظ هنا كما كان.</p>
              <ol className="cc-corr-list">
                {d.corrections.map((c) => (
                  <li key={c.id} className="cc-corr">
                    <p className="cc-corr__head">
                      <span className="cc-corr__action">{c.action_label_ar}</span>
                      <span>{formatDateTime(c.created_at)}</span>
                    </p>
                    {c.action === 'correct' || c.action === 'owner_text' ? (
                      <div className="cc-corr__diff">
                        <div>
                          <p className="cc-label">قبل</p>
                          {c.before_text ? <TextBlock text={c.before_text} className="cc-text cc-text--before" /> : <p className="cc-muted">لا نص.</p>}
                        </div>
                        <div>
                          <p className="cc-label">بعد</p>
                          {c.after_text ? <TextBlock text={c.after_text} className="cc-text" /> : <p className="cc-muted">لا نص.</p>}
                        </div>
                      </div>
                    ) : null}
                    {c.note && <BidiText as="p" dir="rtl" className="cc-muted" text={`ملاحظتك: ${c.note}`} />}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </div>
  );
}
