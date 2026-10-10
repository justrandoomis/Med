// «الأسئلة» rail tab (§30, §35): source questions linked to THIS lecture — the current page first — each with
// its origin («سؤال من مصدر الأسئلة — …»), the relation and its reason, «افتح الأصل» (jumps to the question's
// page with Source Jump & Back) and «تدرّب» (the exams track's route; disabled with the honest reason until it
// exists). Weak course-only links stay collapsed. Nothing here is generated.
// Track F3: the study mode sets how many linked questions are open (this page / the lecture / all) and the policy of a
// practice set started here; «امتحن نفسك» hides link reasons, link decisions and the question's original page (a
// question source page can carry its printed key) and starts an assessed exam. «أنشئ سؤال اختيار من متعدد» from a
// selection opens the Create MCQ panel here (the generated question is labelled and lands in the vault).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilePlus2, ListChecks } from 'lucide-react';
import { richTextFromPlain, type LectureQuestionItem, type LectureQuestionsResponse, type SourcePageView } from '@medlevo/shared';
import type { SourceDocument } from '../data/useSourceDocument';
import { Button, buttonClass, ErrorState, RichTextView, Skeleton, StatusPill } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import { useSourceNavigation } from '../nav/SourceNavigation';
import { questionsApi } from '../../questions/api';
import { AnswerPill, MixedText, RelationPill } from '../../questions/labels';
import { groupLectureItems } from '../../questions/model';
import { PracticeButton } from '../../questions/PracticeButton';
import '../../questions/questions.css';
import { arrangementFor, practiceHref, type ModeArrangement } from '../modes/arrangement';
import { mcqRequestStore, useMcqRequest, type McqRequest } from '../model/mcqRequest';
import { fullPageLabel } from '../model/pages';
import { CreateMcqPanel } from './CreateMcqPanel';

export interface QuestionsTabProps {
  doc: SourceDocument;
  page: SourcePageView | null;
  pageIndex: number;
  onGoToPage: (pageIndex: number) => void;
  online: boolean;
  /** (track F3) the study mode's arrangement (density, practice policy, what Exam mode hides) */
  arrangement?: ModeArrangement;
}

export function QuestionsTab({ doc, page, onGoToPage, online, arrangement }: QuestionsTabProps) {
  const a = arrangement ?? arrangementFor('learn');
  const caps = useCapabilities();
  const vault = caps.feature('questions.vault');
  const exams = caps.feature('exams');
  const sourceId = doc.detail.id;
  const [data, setData] = useState<LectureQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pageId = page?.id ?? null;

  const load = useCallback(async () => {
    if (!vault.available) return;
    setLoading(true);
    try {
      setData(await questionsApi.forLecture(sourceId, pageId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل الأسئلة المرتبطة.'));
    } finally {
      setLoading(false);
    }
  }, [sourceId, pageId, vault.available]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupLectureItems(data?.items ?? []), [data]);

  // «أنشئ سؤال اختيار من متعدد» handed over by the selection toolbar (this source only)
  const pendingMcq = useMcqRequest();
  const [mcq, setMcq] = useState<McqRequest | null>(null);
  useEffect(() => {
    if (!pendingMcq || pendingMcq.source_id !== sourceId) return;
    setMcq(pendingMcq);
    mcqRequestStore.clear(pendingMcq.id);
  }, [pendingMcq, sourceId]);
  const mcqPanel = mcq ? (
    <CreateMcqPanel request={mcq} pageLabel={doc.pages[mcq.pageIndex] ? fullPageLabel(doc.pages[mcq.pageIndex]!) : 'الصفحة المحددة'} onClose={() => setMcq(null)} />
  ) : null;

  if (!vault.available) {
    return (
      <div className="wk-rail-section">
        {mcqPanel}
        <div className="wk-disabled-card" role="note">
          <p className="wk-disabled-card__title">غير متاح الآن</p>
          <p className="wk-muted">{vault.reason ?? 'خزنة الأسئلة غير متاحة.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="qv-rail">
      {mcqPanel}
      <p className="wk-rail-lede">
        {a.showLinkReasons
          ? 'أسئلة من مصادر أسئلتك وامتحاناتك السابقة ترتبط بهذه المحاضرة، مع سبب الربط وصفحاته. أسئلة هذه الصفحة أولًا.'
          : 'أسئلة من مصادر أسئلتك ترتبط بهذه المحاضرة. في وضع «امتحن نفسك» تُخفى أسباب الربط والصفحات الأصلية للأسئلة حتى لا يظهر الحل.'}
      </p>
      {!online && !data && <p className="wk-muted">لا يوجد اتصال؛ تظهر الأسئلة المرتبطة عند عودته.</p>}
      {loading && !data && <Skeleton lines={4} />}
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      {data && (
        <>
          {data.matching.message_ar && (
            <p className="wk-muted" role="status">
              {data.matching.message_ar}
            </p>
          )}
          {!exams.available && data.items.length > 0 && (
            <p id="qv-rail-practice-why" className="wk-muted">
              «تدرّب»: {exams.reason ?? 'التدريب غير متاح بعد.'}
            </p>
          )}
          {groups.onPage.length > 0 && <Group title={`في هذه الصفحة (${groups.onPage.length})`} items={groups.onPage} lectureId={sourceId} onGoToPage={onGoToPage} doc={doc} onChanged={() => void load()} a={a} />}
          {groups.inLecture.length > 0 &&
            (a.questionDensity === 'page' && groups.onPage.length > 0 ? (
              <details className="qv-details">
                <summary>{`في صفحات أخرى من المحاضرة (${groups.inLecture.length})`}</summary>
                <Group title="في صفحات أخرى من المحاضرة" items={groups.inLecture} lectureId={sourceId} onGoToPage={onGoToPage} doc={doc} onChanged={() => void load()} a={a} />
              </details>
            ) : (
              <Group title={`${groups.onPage.length ? 'في صفحات أخرى من المحاضرة' : 'في هذه المحاضرة'} (${groups.inLecture.length})`} items={groups.inLecture} lectureId={sourceId} onGoToPage={onGoToPage} doc={doc} onChanged={() => void load()} a={a} />
            ))}
          {groups.courseOnly.length > 0 && (
            <details className="qv-details" open={a.questionDensity === 'all' ? true : undefined}>
              <summary>مرتبطة بالكورس فقط ({groups.courseOnly.length})</summary>
              <Group title="أسئلة من الكورس لا تغطيها هذه المحاضرة مباشرة" items={groups.courseOnly} lectureId={sourceId} onGoToPage={onGoToPage} doc={doc} onChanged={() => void load()} a={a} />
            </details>
          )}
          <div className="wk-rail-actions">
            <Link to={`/questions?lecture_id=${encodeURIComponent(sourceId)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              <ListChecks size={16} aria-hidden="true" />
              كل أسئلة المحاضرة في الخزنة
            </Link>
            <Link to={`/questions/add?mode=text&lecture=${encodeURIComponent(sourceId)}`} className={buttonClass({ variant: 'plain', size: 'sm' })}>
              <FilePlus2 size={16} aria-hidden="true" />
              إضافة سؤال لهذه المحاضرة
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function Group({
  title,
  items,
  lectureId,
  onGoToPage,
  doc,
  onChanged,
  a,
}: {
  title: string;
  items: LectureQuestionItem[];
  lectureId: string;
  onGoToPage: (i: number) => void;
  doc: SourceDocument;
  onChanged: () => void;
  a: ModeArrangement;
}) {
  return (
    <section className="qv-rail__group" aria-label={title}>
      <h3 className="qv-rail__h">{title}</h3>
      <ul className="qv-rail__list" role="list">
        {items.map((it) => (
          <RailItem key={it.link.id} item={it} lectureId={lectureId} onGoToPage={onGoToPage} doc={doc} onChanged={onChanged} a={a} />
        ))}
      </ul>
    </section>
  );
}

function RailItem({
  item,
  lectureId,
  onGoToPage,
  doc,
  onChanged,
  a,
}: {
  item: LectureQuestionItem;
  lectureId: string;
  onGoToPage: (i: number) => void;
  doc: SourceDocument;
  onChanged: () => void;
  a: ModeArrangement;
}) {
  const nav = useSourceNavigation();
  const stem = useMemo(() => richTextFromPlain(item.stem_preview), [item.stem_preview]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openOriginal = async () => {
    if (!item.original) return;
    const r = await nav.openSourceLocation({
      sourceId: item.original.source_id,
      versionId: item.original.version_id,
      pageId: item.original.page_id,
      pageIndex: item.original.page_index,
      bbox: item.original.bbox,
      regionId: item.original.region_id,
      label: item.origin_label_ar,
    });
    if (!r.ok) setNote(r.reason_ar);
  };
  const decide = async (status: 'accepted' | 'rejected') => {
    setBusy(true);
    try {
      await questionsApi.decideLink(item.link.id, status);
      onChanged();
    } catch (e) {
      setNote(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const lecturePages = item.link.lecture_pages;
  return (
    <li className="qv-rail__item">
      {item.original && a.showQuestionSource ? (
        <button type="button" className="qv-rail__origin" onClick={() => void openOriginal()} aria-label={`افتح الأصل: ${item.origin_label_ar}`}>
          <MixedText text={item.origin_label_ar} />
        </button>
      ) : (
        <span className="wk-muted">
          <MixedText text={item.origin_label_ar} />
        </span>
      )}
      <RichTextView value={stem} className="qv-rail__stem" />
      <div className="qv-rail__pills">
        <RelationPill relation={item.link.relation} />
        <AnswerPill status={item.answer_status} />
        {item.has_negation && (
          <StatusPill tone="info" icon={false}>
            بصيغة نفي
          </StatusPill>
        )}
        {item.link.status === 'accepted' && (
          <StatusPill tone="success" icon={false}>
            {item.link.origin === 'owner' ? 'ربطته بنفسك' : 'قبلت الربط'}
          </StatusPill>
        )}
      </div>
      {a.showLinkReasons && (
        <details className="qv-details">
          <summary>لماذا رُبط بهذه المحاضرة؟</summary>
          <p className="qv-rail__reason">
            <MixedText text={item.link.reason} />
          </p>
          {lecturePages.length > 0 && (
            <div className="wk-rail-actions" aria-label="صفحات المحاضرة التي دعمت الربط">
              {lecturePages.map((p) => (
                <Button
                  key={p.page_id}
                  size="sm"
                  variant="plain"
                  onClick={() => {
                    const idx = doc.pages.findIndex((x) => x.id === p.page_id);
                    onGoToPage(idx >= 0 ? idx : p.page_index);
                  }}
                >
                  {p.label_ar}
                </Button>
              ))}
            </div>
          )}
          {item.link.status === 'suggested' && (
            <div className="wk-rail-actions">
              <Button size="sm" variant="secondary" loading={busy} onClick={() => void decide('accepted')}>
                الربط صحيح
              </Button>
              <Button size="sm" variant="plain" disabled={busy} onClick={() => void decide('rejected')}>
                غير مرتبط
              </Button>
            </div>
          )}
        </details>
      )}
      <div className="wk-rail-actions">
        <PracticeButton
          sourceId={lectureId}
          questionId={item.question_id}
          size="sm"
          describedBy="qv-rail-practice-why"
          reasonShownElsewhere
          href={practiceHref(a, lectureId, item.question_id)}
          label={a.practice.mode === 'exam' ? 'امتحن نفسك' : a.practice.mode === 'revision' ? 'راجع' : undefined}
        />
        {a.showLinkReasons && (
          <Link to={`/questions/${item.question_id}`} className={buttonClass({ variant: 'plain', size: 'sm' })}>
            التفاصيل
          </Link>
        )}
      </div>
      {note && (
        <p className="wk-muted" role="status">
          {note}
        </p>
      )}
    </li>
  );
}
