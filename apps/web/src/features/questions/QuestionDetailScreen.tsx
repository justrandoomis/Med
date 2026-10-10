// تفاصيل السؤال (§33–§36): the stem with negation emphasized, options with their printed labels, the key and who
// stands behind it, where the question appears (open the original page), lecture links with reasons,
// duplicates, extraction checks and the version history.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CircleCheck, FileQuestion, KeyRound, ScanSearch } from 'lucide-react';
import type { KeyChangeImpact, QuestionDetailResponse } from '@medlevo/shared';
import { Bidi, Breadcrumbs, Button, buttonClass, EmptyState, ErrorState, LoadingState, RichTextView, useToast } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { usePageTitle } from '../../lib/usePageTitle';
import { questionsApi } from './api';
import { AnswerCheckSection } from './AnswerCheck';
import { ChecksSection, DuplicatesSection, KeysSection, LinksSection, OccurrencesSection, ReviewItemsSection, VersionsSection } from './DetailSections';
import { KeyDialog } from './KeyDialog';
import { AnswerPill, ExtractionPill, MixedText, NegationPill, OriginIcon, QuestionStatusPill, ReviewPill, Stem } from './labels';
import { isCorrect, keyOriginLabel } from './model';
import { PracticeButton } from './PracticeButton';
import './questions.css';

export function QuestionDetailScreen() {
  const { questionId = '' } = useParams();
  const [d, setD] = useState<QuestionDetailResponse | null>(null);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const toast = useToast();
  usePageTitle('سؤال من الخزنة');

  const load = useCallback(async () => {
    try {
      setD(await questionsApi.detail(questionId));
      setError(null);
    } catch (e) {
      setError({ message: errorMessage(e), notFound: isApiError(e) && e.status === 404 });
    }
  }, [questionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!d && !error) return <LoadingState stage="جارٍ تحميل السؤال…" />;
  if (error && !d) {
    return (
      <div className="ml-page">
        {error.notFound ? (
          <>
            <h1 className="ml-visually-hidden">سؤال غير موجود</h1>
            <EmptyState
              icon={<FileQuestion size={28} />}
              title="هذا السؤال غير موجود"
              description="ربما حُذف مصدره نهائيًا."
              actions={
                <Link to="/questions" className={buttonClass({ variant: 'primary' })}>
                  العودة إلى الخزنة
                </Link>
              }
            />
          </>
        ) : (
          <ErrorState message={error.message} onRetry={() => void load()} />
        )}
      </div>
    );
  }
  const q = d!.question;
  const v = q.current;
  const keyBy = keyOriginLabel(v.answer_status);
  const openReview = d!.review_items.filter((r) => r.status === 'open').length;
  const practiceSource = q.occurrences[0]?.source_id ?? q.lecture_links[0]?.lecture_source_id ?? null;

  const afterKey = (impact: KeyChangeImpact | null) => {
    toast.show({ tone: 'success', title: 'حُفظ المفتاح في نسخة جديدة', description: impact?.summary_ar, duration: impact && impact.would_change > 0 ? null : undefined });
    void load();
  };

  return (
    <div className="ml-page qv-page qv-detail">
      <Breadcrumbs items={[{ label: 'خزنة أسئلتي', to: '/questions' }, { label: 'السؤال' }]} />
      <header className="qv-detail__head">
        <p className="qv-origin">
          <OriginIcon origin={q.origin_type} />
          <MixedText text={q.origin_label_ar} />
        </p>
        <h1 className="ml-visually-hidden">السؤال</h1>
        <div className="ml-cluster">
          <QuestionStatusPill status={q.status} />
          <ExtractionPill status={v.extraction_status} />
          <AnswerPill status={v.answer_status} />
          <NegationPill terms={v.negation_terms} />
          <ReviewPill count={openReview} />
        </div>
      </header>

      <article className="ml-paper qv-sheet" aria-label="نص السؤال">
        <Stem value={v.stem} className="qv-sheet__stem" />
        {v.options.length > 0 && (
          <ol className="qv-options" aria-label="الخيارات كما طُبعت">
            {v.options.map((o) => {
              const correct = isCorrect(v, o);
              return (
                <li key={o.id} className={correct ? 'qv-option qv-option--correct' : 'qv-option'}>
                  {o.source_label && (
                    <Bidi dir={/[A-Za-z0-9]/.test(o.source_label) ? 'ltr' : 'rtl'} className="qv-label">
                      {o.source_label}
                    </Bidi>
                  )}
                  <RichTextView value={o.text} className="qv-option__text" />
                  {correct && (
                    <span className="qv-option__mark">
                      <CircleCheck size={16} aria-hidden="true" />
                      الإجابة{keyBy ? ` — ${keyBy}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {v.explanation && (
          <div className="qv-explanation">
            <h2 className="qv-section__h">الشرح</h2>
            <RichTextView value={v.explanation} />
          </div>
        )}
      </article>

      <div className="ml-cluster qv-actions">
        {q.origin_type === 'source' && (
          <Link to={`/questions/${q.id}/review`} className={buttonClass({ variant: openReview > 0 ? 'primary' : 'secondary' })}>
            <ScanSearch size={18} aria-hidden="true" />
            مراجعة مع الأصل
          </Link>
        )}
        {v.options.length > 0 && (
          <Button variant="secondary" icon={<KeyRound size={18} />} onClick={() => setKeyOpen(true)}>
            {v.answer_status === 'owner_key' ? 'تعديل مفتاحي' : 'تحديد المفتاح بنفسي'}
          </Button>
        )}
        {practiceSource && <PracticeButton sourceId={practiceSource} questionId={q.id} />}
      </div>

      <KeysSection d={d!} />
      <AnswerCheckSection d={d!} onChanged={() => void load()} />
      <OccurrencesSection d={d!} />
      <LinksSection d={d!} onChanged={() => void load()} />
      <DuplicatesSection questionId={q.id} count={q.duplicates.length} onChanged={() => void load()} />
      <ChecksSection issues={v.validation?.issues} />
      <ReviewItemsSection d={d!} />
      <VersionsSection d={d!} />

      <KeyDialog open={keyOpen} onClose={() => setKeyOpen(false)} questionId={q.id} version={v} onDone={afterKey} />
    </div>
  );
}
