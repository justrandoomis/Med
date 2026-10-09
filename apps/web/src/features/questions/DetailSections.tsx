// Sections of the question detail screen: occurrences (open the original page), source keys, lecture links,
// duplicates, extraction checks, version history and review items.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, History, Lock } from 'lucide-react';
import {
  KEY_BINDING_LABELS_AR,
  KEY_MARK_KIND_LABELS_AR,
  type DuplicateDetail,
  type QuestionDetailResponse,
  type QuestionValidationIssue,
} from '@medlevo/shared';
import { Bidi, Button, buttonClass, ErrorState, RichTextView, StatusPill, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { studyUrl } from '../workspace/nav/SourceNavigation';
import { questionsApi } from './api';
import { AnswerPill, ExtractionPill, MixedText, RelationPill } from './labels';
import { CHECK_LABELS_AR, failedIssues } from './model';

type Detail = QuestionDetailResponse;

export function OccurrencesSection({ d }: { d: Detail }) {
  const occ = d.question.occurrences;
  return (
    <section className="qv-section" aria-labelledby="qv-occ-h">
      <h2 id="qv-occ-h" className="qv-section__h">
        مواضع الظهور في مصادرك
      </h2>
      {occ.length === 0 ? (
        <p className="qv-muted">{d.question.origin_type === 'owner' ? 'أضفت هذا السؤال بنفسك؛ لا يوجد له موضع في ملف.' : 'لا يوجد موضع أصلي محفوظ لهذا السؤال.'}</p>
      ) : (
        <ul className="qv-cards" role="list">
          {occ.map((o) => {
            const box = d.occurrence_boxes[o.id]?.[0];
            return (
              <li key={o.id} className="qv-card">
                <p className="qv-card__title">
                  <MixedText text={o.origin_label_ar} />
                </p>
                <div className="ml-cluster">
                  <Link
                    className={buttonClass({ variant: 'secondary', size: 'sm' })}
                    to={studyUrl({
                      sourceId: o.source_id,
                      versionId: o.source_version_id,
                      pageIndex: box?.page_index ?? o.pages[0]?.page_index ?? 0,
                      pageId: box?.page_id ?? o.pages[0]?.page_id ?? null,
                      bbox: box?.bbox ?? null,
                      regionId: box?.region_id ?? null,
                    })}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    افتح الصفحة الأصلية
                  </Link>
                  <Link className={buttonClass({ variant: 'plain', size: 'sm' })} to={`/questions?source_id=${encodeURIComponent(o.source_id)}`}>
                    أسئلة هذا المصدر
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function KeysSection({ d }: { d: Detail }) {
  const v = d.question.current;
  return (
    <section className="qv-section" aria-labelledby="qv-keys-h">
      <h2 id="qv-keys-h" className="qv-section__h">
        مفتاح الإجابة
      </h2>
      <div className="ml-cluster">
        <AnswerPill status={v.answer_status} />
        <StatusPill tone={d.scorable ? 'success' : 'neutral'} icon={false}>
          {d.scorable ? 'يُحتسب في الاختبارات المقيّمة' : 'للتدريب غير المحسوب فقط'}
        </StatusPill>
      </div>
      {!d.scorable && d.unscorable_reason_ar && <p className="qv-muted">{d.unscorable_reason_ar}</p>}
      {v.key_details?.conflict_ar && (
        <p className="qv-alert" role="note">
          <MixedText text={v.key_details.conflict_ar} />
        </p>
      )}
      {v.key_details?.notes_ar && (
        <p className="qv-muted">
          <MixedText text={v.key_details.notes_ar} />
        </p>
      )}
      {(v.key_details as { source_note_ar?: string } | null)?.source_note_ar && <p className="qv-muted">{(v.key_details as { source_note_ar?: string }).source_note_ar}</p>}
      {d.key_entries.length > 0 ? (
        <ul className="qv-cards" role="list">
          {d.key_entries.map((k) => (
            <li key={k.id} className={k.origin_known ? 'qv-card' : 'qv-card qv-card--muted'}>
              <p className="qv-card__title">
                {k.mark_kind === 'key_table' ? `جدول المفتاح ${k.key_block}` : k.origin_known ? `المفتاح ${k.key_block}` : 'علامة على الصفحة'} —{' '}
                {k.section_key && !k.section_key.startsWith('?') ? (
                  <>
                    القسم <Bidi dir="ltr">{k.section_key}</Bidi> —{' '}
                  </>
                ) : null}
                رقم <Bidi dir="ltr">{k.printed_number}</Bidi>: «<MixedText text={k.key_label} />»
              </p>
              <p className="qv-muted">
                {KEY_MARK_KIND_LABELS_AR[k.mark_kind]} · {KEY_BINDING_LABELS_AR[k.binding]} · <MixedText text={k.source_title} />
                {k.page_label_ar ? ` · ${k.page_label_ar}` : ''}
              </p>
              {k.raw_text && (
                <p className="qv-quote">
                  كما طُبع: <MixedText text={k.raw_text} />
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="qv-muted">لا يوجد مفتاح مطبوع لهذا السؤال في مصادره.</p>
      )}
    </section>
  );
}

export function LinksSection({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (id: string, status: 'accepted' | 'rejected') => {
    setBusy(id);
    setError(null);
    try {
      await questionsApi.decideLink(id, status, status === 'rejected' ? reason : undefined);
      setRejecting(null);
      setReason('');
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const links = d.question.lecture_links;
  return (
    <section className="qv-section" aria-labelledby="qv-links-h">
      <h2 id="qv-links-h" className="qv-section__h">
        الربط بالمحاضرات
      </h2>
      {links.length === 0 ? (
        <p className="qv-muted">لا توجد محاضرة مرتبطة بعد. يُربط السؤال تلقائيًا عندما تُرفع محاضرة من الكورس نفسه تغطي موضوعه.</p>
      ) : (
        <ul className="qv-cards" role="list">
          {links.map((l) => (
            <li key={l.id} className={l.status === 'rejected' ? 'qv-card qv-card--muted' : 'qv-card'}>
              <div className="ml-cluster">
                <p className="qv-card__title">
                  <MixedText text={l.lecture_title} />
                </p>
                <RelationPill relation={l.relation} />
                <StatusPill tone={l.status === 'accepted' ? 'success' : l.status === 'rejected' ? 'neutral' : 'info'} icon={false}>
                  {l.origin === 'owner' ? 'ربطته بنفسك' : l.status === 'accepted' ? 'قبلته' : l.status === 'rejected' ? 'رفضته' : 'مقترح تلقائيًا'}
                </StatusPill>
                {l.answerable_from_lecture && (
                  <StatusPill tone="success" icon={false}>
                    يُحل من المحاضرة
                  </StatusPill>
                )}
              </div>
              <p className="qv-reason">
                <MixedText text={l.reason} />
              </p>
              {l.decision_reason && <p className="qv-muted">سببك: {l.decision_reason}</p>}
              {l.lecture_pages.length > 0 && (
                <div className="ml-cluster" aria-label="صفحات المحاضرة التي دعمت الربط">
                  {l.lecture_pages.map((p) => (
                    <Link key={p.page_id} className={buttonClass({ variant: 'plain', size: 'sm' })} to={studyUrl({ sourceId: l.lecture_source_id, pageIndex: p.page_index, pageId: p.page_id })}>
                      {p.label_ar}
                    </Link>
                  ))}
                </div>
              )}
              {l.status === 'suggested' && (
                <div className="ml-cluster">
                  <Button size="sm" variant="secondary" loading={busy === l.id && !rejecting} onClick={() => void decide(l.id, 'accepted')}>
                    الربط صحيح
                  </Button>
                  <Button size="sm" variant="plain" onClick={() => setRejecting(rejecting === l.id ? null : l.id)} aria-expanded={rejecting === l.id}>
                    غير صحيح…
                  </Button>
                </div>
              )}
              {rejecting === l.id && (
                <form
                  className="qv-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void decide(l.id, 'rejected');
                  }}
                >
                  <TextField label="لماذا؟ (يُحفظ ولا يُعاد اقتراح الربط)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
                  <Button type="submit" size="sm" variant="secondary" loading={busy === l.id}>
                    رفض الربط
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorState inline message={error} />}
    </section>
  );
}

export function DuplicatesSection({ questionId, count, onChanged }: { questionId: string; count: number; onChanged: () => void }) {
  const [items, setItems] = useState<DuplicateDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (count === 0) return;
    let alive = true;
    questionsApi
      .duplicates(questionId)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [questionId, count]);
  if (count === 0) return null;
  const decide = async (id: string, status: 'confirmed' | 'rejected') => {
    setBusy(id);
    try {
      await questionsApi.decideDuplicate(id, status);
      const r = await questionsApi.duplicates(questionId);
      setItems(r.items);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="qv-section" aria-labelledby="qv-dup-h">
      <h2 id="qv-dup-h" className="qv-section__h">
        أسئلة مشابهة
      </h2>
      <p className="qv-muted">لا يُدمج سؤالان تلقائيًا إذا اختلف النفي أو الأرقام أو الخيارات أو الإجابة. تأكيدك يعني فقط ألا يظهرا معًا في اختبار واحد.</p>
      {error && <ErrorState inline message={error} />}
      <ul className="qv-cards" role="list">
        {(items ?? []).map((x) => (
          <li key={x.id} className="qv-card">
            <div className="ml-cluster">
              <StatusPill tone="info" icon={false}>
                {x.kind === 'near' ? 'شبيه جدًا' : x.kind === 'paraphrase' ? 'صياغة أخرى قريبة' : 'مطابق'}
              </StatusPill>
              <StatusPill tone={x.status === 'confirmed' ? 'success' : x.status === 'rejected' ? 'neutral' : 'warning'} icon={false}>
                {x.status === 'confirmed' ? 'أكدتَ أنه مكرر' : x.status === 'rejected' ? 'رفضتَ الاقتراح' : 'اقتراح'}
              </StatusPill>
            </div>
            <Link to={`/questions/${x.other_question_id}`} className="qv-card__link">
              <MixedText text={x.other_stem_preview} />
            </Link>
            <p className="qv-muted">
              <MixedText text={x.other_origin_label_ar} />
            </p>
            {x.blockers.length > 0 && (
              <ul className="qv-blockers">
                {x.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {x.status === 'suggested' && (
              <div className="ml-cluster">
                <Button size="sm" variant="secondary" loading={busy === x.id} onClick={() => void decide(x.id, 'confirmed')}>
                  نعم، السؤال نفسه
                </Button>
                <Button size="sm" variant="plain" disabled={busy === x.id} onClick={() => void decide(x.id, 'rejected')}>
                  ليسا السؤال نفسه
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function IssueRow({ i }: { i: QuestionValidationIssue }) {
  return (
    <li className="qv-issue" data-passed={i.passed ? 'true' : 'false'}>
      <StatusPill tone={i.passed ? 'success' : i.severity === 'blocker' ? 'danger' : 'warning'}>
        {i.passed ? 'اجتاز' : i.severity === 'blocker' ? 'مانع' : 'تنبيه'}
      </StatusPill>
      <span>
        <strong>{CHECK_LABELS_AR[i.check]}:</strong> {i.reason_ar}
      </span>
    </li>
  );
}

export function ChecksSection({ issues }: { issues: QuestionValidationIssue[] | null | undefined }) {
  const failed = failedIssues(issues);
  const passed = (issues ?? []).filter((i) => i.passed);
  return (
    <section className="qv-section" aria-labelledby="qv-checks-h">
      <h2 id="qv-checks-h" className="qv-section__h">
        فحوص الاستخراج
      </h2>
      {failed.length === 0 ? <p className="qv-muted">لم يفشل أي فحص.</p> : <ul className="qv-issues">{failed.map((i) => <IssueRow key={`${i.check}-${i.reason_ar}`} i={i} />)}</ul>}
      {passed.length > 0 && (
        <details className="qv-details">
          <summary>الفحوص التي اجتازها ({passed.length})</summary>
          <ul className="qv-issues">
            {passed.map((i) => (
              <IssueRow key={`${i.check}-ok`} i={i} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const KIND_AR: Record<string, string> = {
  raw_extraction: 'استخراج من المصدر',
  structured: 'نسخة منظمة',
  owner_correction: 'تصحيح منك',
  translation: 'ترجمة',
  paraphrase: 'إعادة صياغة',
  generated: 'مولدة',
};

export function VersionsSection({ d }: { d: Detail }) {
  return (
    <section className="qv-section" aria-labelledby="qv-ver-h">
      <h2 id="qv-ver-h" className="qv-section__h">
        <History size={18} aria-hidden="true" /> سجل النسخ
      </h2>
      <p className="qv-muted">النسخة التي حُلّت عليها محاولات لا تتغير أبدًا؛ كل تصحيح نسخة جديدة.</p>
      <ol className="qv-versions" reversed>
        {d.versions.map((v) => (
          <li key={v.id} className="qv-card">
            <div className="ml-cluster">
              <strong>النسخة {v.version_no}</strong>
              <span>{KIND_AR[v.kind] ?? v.kind}</span>
              {v.id === d.question.current.id && (
                <StatusPill tone="accent" icon={false}>
                  الحالية
                </StatusPill>
              )}
              {v.attempts > 0 && (
                <StatusPill tone="neutral" icon={<Lock size={14} />}>
                  {v.attempts === 1 ? 'محاولة واحدة — مقفلة' : `${v.attempts} محاولات — مقفلة`}
                </StatusPill>
              )}
              <ExtractionPill status={v.extraction_status} />
              <AnswerPill status={v.answer_status} />
            </div>
            <p className="qv-muted">{formatDateTime(v.created_at)}</p>
            {v.note && <p className="qv-muted">{v.note}</p>}
            <details className="qv-details">
              <summary>نص هذه النسخة</summary>
              <RichTextView value={v.stem} />
              <ol className="qv-options qv-options--compact">
                {v.options.map((o) => (
                  <li key={o.id}>
                    {o.source_label && <Bidi dir={/[A-Za-z0-9]/.test(o.source_label) ? 'ltr' : 'rtl'} className="qv-label">{o.source_label}</Bidi>}
                    <RichTextView value={o.text} />
                    {v.correct_option_ids?.includes(o.id) && <span className="qv-correct-inline">✓ الإجابة</span>}
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ReviewItemsSection({ d }: { d: Detail }) {
  if (d.review_items.length === 0) return null;
  return (
    <section className="qv-section" aria-labelledby="qv-rev-h">
      <h2 id="qv-rev-h" className="qv-section__h">
        المراجعة
      </h2>
      <ul className="qv-cards" role="list">
        {d.review_items.map((r) => (
          <li key={r.id} className={r.status === 'open' ? 'qv-card' : 'qv-card qv-card--muted'}>
            <div className="ml-cluster">
              <StatusPill tone={r.status === 'open' ? 'warning' : 'neutral'} icon={false}>
                {r.kind_label_ar}
              </StatusPill>
              <span className="qv-muted">{r.status === 'open' ? 'مفتوح' : r.status === 'accepted' ? 'قُبل' : r.status === 'corrected' ? 'صُحح' : r.status === 'rejected' ? 'رُفض' : 'تُجوهل'}</span>
            </div>
            <p className="qv-reason">
              <MixedText text={r.reason} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
