// Feedback after answering (practice) or after finishing (exam): correct / incorrect / not scored with the reason,
// who stands behind the key, explanation and distractor explanations with evidence chips, origin and occurrences,
// lecture pages, AC-27 signal, and the editable mistake type (auto suggestion kept visible next to the owner's).
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CircleCheck, CircleHelp, CircleX, FileQuestion, Sparkles } from 'lucide-react';
import {
  MASTERY_SIGNAL_LABELS_AR,
  MISTAKE_TYPES,
  MISTAKE_TYPE_LABELS_AR,
  type AttemptFeedbackView,
  type MistakeType,
} from '@medlevo/shared';
import { RichTextView, Select, StatusPill, type SelectOption } from '../../design';
import { ClaimedText } from './ClaimedText';
import { MISTAKE_HELP_AR } from './model';
import { MixedLine } from './MixedLine';

export interface FeedbackPanelProps {
  feedback: AttemptFeedbackView;
  /** owner edit of the mistake type (null clears it) */
  onMistakeChange?: (type: MistakeType | null) => void | Promise<void>;
  /** «السؤال 3» heading level context */
  headingId?: string;
}

function ResultLine({ fb }: { fb: AttemptFeedbackView }) {
  if (!fb.attempt) {
    return (
      <p className="ex-result-line ex-result-line--neutral" role="status">
        <CircleHelp size={20} aria-hidden="true" />
        <span>عرضت الحل قبل الإجابة؛ إن أجبت الآن تُسجَّل الإجابة لكنها لا تُحتسب.</span>
      </p>
    );
  }
  if (!fb.scored || fb.is_correct === null) {
    return (
      <p className="ex-result-line ex-result-line--neutral" role="status">
        <CircleHelp size={20} aria-hidden="true" />
        <span>
          <strong>غير محسوب.</strong> {fb.unscored_reason_ar ?? 'لا يدخل في النتيجة.'}
          {fb.is_correct !== null && <> (إجابتك {fb.is_correct ? 'تطابق' : 'لا تطابق'} المفتاح المعروض.)</>}
        </span>
      </p>
    );
  }
  return fb.is_correct ? (
    <p className="ex-result-line ex-result-line--ok" role="status">
      <CircleCheck size={20} aria-hidden="true" />
      <strong>إجابة صحيحة</strong>
    </p>
  ) : (
    <p className="ex-result-line ex-result-line--bad" role="status">
      <CircleX size={20} aria-hidden="true" />
      <strong>إجابة غير صحيحة</strong>
    </p>
  );
}

export function MistakeEditor({ feedback, onChange }: { feedback: AttemptFeedbackView; onChange: (t: MistakeType | null) => void | Promise<void> }) {
  const a = feedback.attempt;
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState<MistakeType | ''>(a?.mistake_type ?? '');
  const hintId = useId();
  if (!a || a.is_correct !== false) return null;
  const options: SelectOption<MistakeType | ''>[] = [{ value: '', label: 'بلا تصنيف' }, ...MISTAKE_TYPES.map((t) => ({ value: t, label: MISTAKE_TYPE_LABELS_AR[t] }))];
  return (
    <section className="ex-mistake" aria-labelledby={`${hintId}-h`}>
      <h3 id={`${hintId}-h`} className="ex-subhead">
        نوع الخطأ (تقديري وقابل للتعديل)
      </h3>
      {a.auto_mistake_type && (
        <p className="ex-muted" id={hintId}>
          {feedback.mistake_reason_ar ?? `اقتراح آلي: ${MISTAKE_TYPE_LABELS_AR[a.auto_mistake_type]}`}
        </p>
      )}
      <Select<MistakeType | ''>
        label="صنّف خطأك"
        hint={value ? MISTAKE_HELP_AR[value] : 'هذا تصنيف تعليمي، لا تشخيص.'}
        options={options}
        value={value}
        disabled={saving}
        onValueChange={async (v) => {
          setValue(v);
          setSaving(true);
          try {
            await onChange(v || null);
          } finally {
            setSaving(false);
          }
        }}
      />
      <p className="ex-muted">
        {a.mistake_origin === 'owner' || (value && value !== a.auto_mistake_type) ? 'صنّفته بنفسك.' : a.mistake_origin === 'auto' ? 'التصنيف الحالي اقتراح آلي.' : ''}
      </p>
    </section>
  );
}

export function FeedbackPanel({ feedback: fb, onMistakeChange }: FeedbackPanelProps) {
  const location = useLocation();
  const correct = new Set(fb.correct_option_ids ?? []);
  const chosen = new Set(fb.attempt?.selected_option_ids ?? []);
  const generated = fb.origin_type === 'generated';
  return (
    <section className="ex-feedback" aria-label="التصحيح والشرح">
      <ResultLine fb={fb} />
      {fb.mastery_signal && fb.mastery_signal !== 'correct_confident_independent' && fb.mastery_signal !== 'wrong' && (
        <p className="ex-note" role="note">
          {MASTERY_SIGNAL_LABELS_AR[fb.mastery_signal]}
        </p>
      )}
      {fb.newer_version_note_ar && (
        <p className="ex-note ex-note--warn" role="note">
          {fb.newer_version_note_ar}
        </p>
      )}

      <ul className="ex-fb-options" dir={fb.stem.paragraphs[0]?.dir ?? 'rtl'}>
        {fb.options.map((o) => {
          const isKey = correct.has(o.id);
          const isMine = chosen.has(o.id);
          const why = fb.distractor_explanations?.[o.id];
          return (
            <li key={o.id} className="ex-fb-option" data-key={isKey ? 'true' : undefined} data-mine={isMine ? 'true' : undefined}>
              <div className="ex-fb-option__head">
                <span className="ex-opt__label" aria-hidden="true">
                  {o.display_label}
                </span>
                <span className="ml-visually-hidden">الخيار {o.display_label}: </span>
                <RichTextView value={o.text} className="ex-fb-option__text" />
                <span className="ex-fb-option__tags">
                  {isKey && (
                    <StatusPill tone="success" icon={<CircleCheck size={14} />}>
                      الإجابة الصحيحة
                    </StatusPill>
                  )}
                  {isMine && (
                    <StatusPill tone={isKey ? 'success' : correct.size ? 'danger' : 'neutral'} icon={false}>
                      اختيارك
                    </StatusPill>
                  )}
                </span>
              </div>
              {why && !isKey && <ClaimedText value={why} claims={fb.claims} className="ex-fb-option__why" />}
            </li>
          );
        })}
      </ul>
      {fb.correct_option_ids && (
        <p className="ex-muted">
          مصدر المفتاح: <strong>{fb.answer_status_label_ar}</strong>
          {generated && ' — حل مولد من الأدلة، ليس مفتاحًا من امتحان أو مصدر.'}
        </p>
      )}
      {!fb.correct_option_ids && <p className="ex-muted">لا يوجد مفتاح محسوم لهذا السؤال ({fb.answer_status_label_ar})؛ لا يُعرض حل مخمَّن.</p>}

      {fb.explanation && fb.explanation.paragraphs.length > 0 ? (
        <section aria-label="الشرح">
          <h3 className="ex-subhead">لماذا هذه الإجابة</h3>
          <ClaimedText value={fb.explanation} claims={fb.claims} />
        </section>
      ) : (
        <p className="ex-muted">لا يوجد شرح محفوظ لهذا السؤال. ارجع إلى صفحات المحاضرة أدناه.</p>
      )}

      <section className="ex-origin" aria-label="أصل السؤال">
        <p className="ex-origin__label">
          {generated ? <Sparkles size={16} aria-hidden="true" /> : <FileQuestion size={16} aria-hidden="true" />}
          <MixedLine text={fb.origin_label_ar} />
        </p>
        {fb.occurrences.length > 0 && (
          <ul className="ex-list">
            {fb.occurrences.map((o) => (
              <li key={o.id}>
                <MixedLine text={o.origin_label_ar} />
              </li>
            ))}
          </ul>
        )}
        {generated && (fb.learning_objective || fb.difficulty_est) && (
          <p className="ex-muted">
            {fb.learning_objective && (
              <>
                هدف التعلم: <MixedLine text={fb.learning_objective} />.{' '}
              </>
            )}
            {fb.difficulty_est && <>الصعوبة (تقدير فقط): {fb.difficulty_est === 'very_hard' ? 'صعب جدًا' : fb.difficulty_est === 'hard' ? 'صعب' : 'متوسط'}.</>}
          </p>
        )}
        {fb.lecture_links.length > 0 && (
          <ul className="ex-list" aria-label="في المحاضرة">
            {fb.lecture_links.map((l) => (
              <li key={l.lecture_source_id}>
                <MixedLine text={`${l.lecture_title} — ${l.relation_label_ar}`} />{' '}
                {l.pages.map((p) => (
                  <Link key={p.page_id} className="ex-link" to={`/study/${encodeURIComponent(l.lecture_source_id)}?page_id=${encodeURIComponent(p.page_id)}`}>
                    {p.label_ar}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        )}
        <Link className="ex-link" to={`/questions/${encodeURIComponent(fb.question_id)}`}>
          افتح السؤال في خزنة الأسئلة
        </Link>
        {/* learning web track: a review card from this mistake (the server builds it from the question version + key) */}
        {fb.attempt && fb.attempt.is_correct === false && fb.correct_option_ids && (
          <Link
            className="ex-link"
            to={`/review/cards/new?from=mistake&attempt=${encodeURIComponent(fb.attempt.id)}&back=${encodeURIComponent(location.pathname + location.search)}`}
          >
            أنشئ بطاقة من هذا الخطأ
          </Link>
        )}
      </section>

      {onMistakeChange && <MistakeEditor feedback={fb} onChange={onMistakeChange} />}
    </section>
  );
}
