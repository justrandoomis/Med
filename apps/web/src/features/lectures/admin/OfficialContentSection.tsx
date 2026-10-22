// «المحتوى الرسمي» — the official lectures of a subject in «إدارة القنوات» (IA §4.10; PRD AOS-18.3, 18.4, 18.9, 18.10;
// Q5). For a Subject Moderator: lectures waiting for approval, versions waiting to be published (with the publish
// preview: page changes from the previous version and how many students hold a copy, never a count under 5),
// contributors' correction proposals, withdrawal and the rights takedown. For a Contributor: their own drafts and their
// status. Adding a lecture (title, number, date, file) is open to both; a contributor's file waits for a moderator.
// (C2) «ارفع عدة محاضرات» adds one draft per file (AOS-2.3 / 18.3); the duplicate answer of the server is shown as given
// (3.6); a Subject Moderator reviews what the analysis proposed — numbers, dates, «إصدار جديد من …» — marked as
// machine-made (3.18, 3.11, 19I.5); each version names its uploader and publisher (18.18).
// Every action is decided by the server; the reasons it gives are shown as they are.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, FilePlus2, Files, ListChecks, Send, Undo2 } from 'lucide-react';
import {
  IMPORT_SUGGESTION_FIELD_LABELS_AR,
  LECTURE_WITHDRAW_REASON_LABELS_AR,
  LECTURE_WITHDRAW_REASONS,
  OFFICIAL_BADGE_AR,
  OFFICIAL_LECTURE_STATUS_LABELS_AR,
  type LectureWithdrawReason,
  type OfficialCorrectionView,
  type OfficialLectureDetail,
  type OfficialLectureView,
  type OfficialVersionView,
  type PublishOfficialVersionPreview,
  type SubjectReviewItem,
} from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState, Select, StatusPill, TextArea, TextField, useToast } from '../../../design';
import { ApiError, errorMessage, fieldErrors } from '../../../lib/api';
import { formatDateTime } from '../../../lib/time';
import { BidiText } from '../../evidence/BidiText';
import { type AdminSubject, lecturesApi } from '../api';
import { SubjectScope } from './SubjectScope';
import { useAdminSubjects } from './useAdminSubjects';
import './lectures-admin.css';

const CHANGE_LABELS_AR: Record<string, string> = { identical: 'مطابقة', edited: 'معدّلة', changed: 'تغيّرت', moved: 'نُقلت', inserted: 'مضافة', removed: 'محذوفة', uncertain: 'غير مؤكدة' };

function lectureLabel(l: Pick<OfficialLectureView, 'title' | 'lecture_no'>): string {
  return l.lecture_no ? `المحاضرة ${l.lecture_no} — ${l.title}` : l.title;
}

interface Loaded {
  lectures: OfficialLectureDetail[];
  corrections: OfficialCorrectionView[];
}

function AddLecture({ subject, onDone }: { subject: AdminSubject; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [no, setNo] = useState('');
  const [heldOn, setHeldOn] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // a draft created by this form whose file did not go through: the next send uploads into it instead of creating a
  // second lecture with the same title (review R12); it is forgotten when the details change
  const [created, setCreated] = useState<{ id: string; title: string; no: string; heldOn: string } | null>(null);
  const sameDraft = !!created && created.title === title.trim() && created.no === no && created.heldOn === heldOn;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    setFormError(null);
    let lectureId = sameDraft ? created!.id : null;
    try {
      if (!lectureId) {
        const lecture = await lecturesApi.create(subject.spaceId, { title: title.trim(), lecture_no: no ? Number(no) : null, held_on: heldOn || null });
        lectureId = lecture.id;
      }
      if (file) {
        try {
          const up = await lecturesApi.upload(subject.spaceId, lectureId, file);
          // (C2, AOS-3.6) the server names a duplicate only when the uploader may see it; shown as it is said
          if (up.duplicate_note_ar) toast.show({ title: up.duplicate_note_ar, tone: 'info' });
        } catch (err) {
          setCreated({ id: lectureId, title: title.trim(), no, heldOn });
          setFormError(`أُضيفت المسودة «${title.trim()}» لكن رفع الملف لم يكتمل: ${errorMessage(err)} اختر الملف وأعد الإرسال لرفعه إلى المسودة نفسها.`);
          onDone();
          return;
        }
      }
      toast.show({ title: subject.moderator ? 'أُضيفت المحاضرة مسودةً؛ انشرها بعد انتهاء المعالجة.' : 'أُضيفت المحاضرة؛ تنتظر موافقة مشرف المادة.', tone: 'success' });
      setTitle('');
      setNo('');
      setHeldOn('');
      setFile(null);
      setCreated(null);
      onDone();
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="lec-admin__add" onSubmit={(e) => void submit(e)} aria-labelledby="lec-add-title">
      <h2 id="lec-add-title" className="lec-admin__h2">
        <FilePlus2 size={18} aria-hidden="true" /> أضف محاضرة رسمية
      </h2>
      <div className="lec-admin__add-grid">
        <TextField label="عنوان المحاضرة" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} error={errors.title} />
        <TextField label="رقم المحاضرة" inputMode="numeric" dir="ltr" value={no} onChange={(e) => setNo(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))} error={errors.lecture_no} hint="اختياري" />
        <TextField label="تاريخ المحاضرة" type="date" dir="ltr" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} error={errors.held_on} hint="اختياري" />
        <label className="lec-admin__file">
          <span className="lec-admin__file-label">ملف المحاضرة (PDF أو PPTX أو DOCX أو صورة)</span>
          <input type="file" accept=".pdf,.pptx,.docx,.png,.jpg,.jpeg,.zip,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      {formError && <p className="lec-admin__error" role="alert">{formError}</p>}
      <div className="lec-admin__actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!title.trim() || (sameDraft && !file)}>
          {sameDraft ? 'ارفع الملف إلى المسودة' : file ? 'أضف وارفع الملف' : 'أضف مسودة'}
        </Button>
      </div>
      <p className="lec-admin__note">{subject.moderator ? 'تبقى المحاضرة مسودة لا يراها الطلاب حتى تنشر إصدارها.' : 'ملفك يصل إلى مشرف المادة ليوافق عليه وينشره؛ لا يراه الطلاب قبل ذلك.'}</p>
    </form>
  );
}

// ───────── (C2, AOS-2.3 / 18.3) «ارفع عدة محاضرات»: one draft per file, uploaded one after the other ─────────

const MAX_BULK = 30;
const filesAr = (n: number) => (n === 1 ? 'ملف واحد مختار' : n === 2 ? 'ملفان مختاران' : n <= 10 ? `${n} ملفات مختارة` : `${n} ملفًا مختارًا`);
const uploadAr = (n: number) => (n === 1 ? 'ارفع محاضرة واحدة' : n === 2 ? 'ارفع محاضرتين' : n <= 10 ? `ارفع ${n} محاضرات` : `ارفع ${n} محاضرة`);
/** the draft's title from its file: the name without its extension (the server reads the number and date from the file) */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || name).slice(0, 200);
}

interface BulkResult {
  name: string;
  title: string;
  ok: boolean;
  note: string | null;
  /** (review C2 R4) a failed file can be sent again: into the draft already made for it (never a second draft) */
  file: File;
  lectureId: string | null;
}

/** One file of «ارفع عدة محاضرات»: its draft (made once — a retry reuses `lectureId`), then its upload. */
async function uploadOne(spaceId: string, f: File, title: string, lectureId: string | null): Promise<BulkResult> {
  let id = lectureId;
  try {
    id ??= (await lecturesApi.create(spaceId, { title })).id;
    const up = await lecturesApi.upload(spaceId, id, f);
    return { name: f.name, title, ok: true, note: up.duplicate_note_ar ?? null, file: f, lectureId: id };
  } catch (err) {
    return {
      name: f.name,
      title,
      ok: false,
      note: id ? `أُضيفت المسودة لكن رفع ملفها لم يكتمل: ${errorMessage(err)} «أعد المحاولة» يرفعه إلى المسودة نفسها.` : `${errorMessage(err)} لم تُضف مسودة لهذا الملف.`,
      file: f,
      lectureId: id,
    };
  }
}

function BulkUpload({ subject, onDone }: { subject: AdminSubject; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [retrying, setRetrying] = useState<number | null>(null);
  const tooMany = files.length > MAX_BULK;

  const run = async () => {
    if (progress || files.length === 0 || tooMany) return;
    const out: BulkResult[] = [];
    setResults([]);
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      setProgress({ done: i, total: files.length });
      out.push(await uploadOne(subject.spaceId, f, titleFromFileName(f.name), null));
      setResults([...out]);
    }
    setProgress(null);
    setFiles([]);
    setInputKey((k) => k + 1);
    onDone();
  };

  // (review C2 R4) «أعد المحاولة»: the same file into the same draft (or a first draft when none was made)
  const retry = async (i: number) => {
    const r = results?.[i];
    if (!r || r.ok || progress || retrying !== null) return;
    setRetrying(i);
    const next = await uploadOne(subject.spaceId, r.file, r.title, r.lectureId);
    setResults((prev) => (prev ? prev.map((x, j) => (j === i ? next : x)) : prev));
    setRetrying(null);
    onDone();
  };

  const okCount = results?.filter((r) => r.ok).length ?? 0;
  return (
    <section className="lec-admin__add" aria-labelledby="lec-bulk-title">
      <h2 id="lec-bulk-title" className="lec-admin__h2">
        <Files size={18} aria-hidden="true" /> ارفع عدة محاضرات
      </h2>
      <p className="lec-admin__note">محاضرة لكل ملف، باسم الملف. يُقرأ رقم المحاضرة وتاريخها من الملف، وما لم يتأكد منه التحليل ينتظر مراجعتك.</p>
      <label className="lec-admin__file">
        <span className="lec-admin__file-label">ملفات المحاضرات (PDF أو PPTX أو DOCX أو صورة، حتى {MAX_BULK} ملفًا)</span>
        <input key={inputKey} type="file" multiple accept=".pdf,.pptx,.docx,.png,.jpg,.jpeg,.zip,application/pdf" disabled={!!progress} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      </label>
      {files.length > 0 && <p className="lec-admin__note">{filesAr(files.length)}</p>}
      {tooMany && (
        <p className="lec-admin__error" role="alert">
          {`اختر ${MAX_BULK} ملفًا على الأكثر في المرة الواحدة.`}
        </p>
      )}
      <div className="lec-admin__actions">
        <Button variant="primary" loading={!!progress} disabled={files.length === 0 || tooMany} onClick={() => void run()}>
          {files.length ? uploadAr(files.length) : 'ارفع المحاضرات'}
        </Button>
      </div>
      {progress && (
        <p className="lec-admin__note" role="status">
          {`جارٍ رفع ${progress.done + 1} من ${progress.total}…`}
        </p>
      )}
      {results && results.length > 0 && (
        <>
          <ul className="lec-admin__versions" aria-label="نتيجة الرفع">
            {results.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                <BidiText as="span" text={r.title} />
                {r.ok ? ': رُفع' : ': لم يُرفع'}
                {r.note ? ` — ${r.note}` : ''}
                {!r.ok && !progress && (
                  <Button variant="secondary" loading={retrying === i} disabled={retrying !== null && retrying !== i} onClick={() => void retry(i)}>
                    {`أعد المحاولة: ${r.name}`}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!progress && (
            <p className="lec-admin__note" role="status">
              {`رُفعت ${okCount} من ${results.length}. ${subject.moderator ? 'الأرقام والتواريخ تُقرأ من الملفات وتنتظر مراجعتك.' : 'تنتظر موافقة مشرف المادة.'}`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ───────── (C2, AOS-3.18 / 3.11 / 19I.5) the subject's review queue: what the analysis proposed, for a human ─────────

function proposalAr(i: SubjectReviewItem): string {
  const v = i.suggestion.value;
  if (v.field === 'lecture_no') return `${IMPORT_SUGGESTION_FIELD_LABELS_AR.lecture_no}: ${v.lecture_no}`;
  if (v.field === 'held_on') return `${IMPORT_SUGGESTION_FIELD_LABELS_AR.held_on}: ${v.held_on}`;
  if (v.field === 'title') return `${IMPORT_SUGGESTION_FIELD_LABELS_AR.title}: ${v.title}`;
  if (v.field === 'new_version_of') return `إصدار جديد من «${i.target_lecture?.title ?? v.title}»`;
  return IMPORT_SUGGESTION_FIELD_LABELS_AR[v.field];
}

function ReviewQueue({ subject, onChanged }: { subject: AdminSubject; onChanged: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<SubjectReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    lecturesApi
      .review(subject.spaceId)
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // the queue is the subject's moderators' (an Admin without official power here is refused): no section then
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setHidden(true);
        else setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [subject.spaceId, nonce]);
  if (hidden) return null;
  const decide = async (item: SubjectReviewItem, action: 'accept' | 'reject') => {
    setBusy(item.suggestion.id);
    try {
      const r = await lecturesApi.decideReview(subject.spaceId, item.suggestion.id, action);
      toast.show({ title: r.result_ar, tone: 'success' });
      setNonce((n) => n + 1);
      onChanged();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="lec-review" className="lec-admin__group">
      <h2 id="lec-review" className="lec-admin__h2">
        <ListChecks size={18} aria-hidden="true" /> مراجعة ما اقترحه التحليل
      </h2>
      <p className="lec-admin__note">اقتراحات آلية من قراءة الملفات المرفوعة: لا يتغير شيء حتى تقبلها، وما ترفضه لا يعود.</p>
      {error ? (
        <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} inline />
      ) : !items ? (
        <LoadingState stage="جارٍ تحميل الاقتراحات…" inline />
      ) : items.length === 0 ? (
        <p className="lec-admin__empty">لا اقتراحات تنتظر المراجعة.</p>
      ) : (
        <ul className="lec-admin__list">
          {items.map((i) => (
            <li key={i.suggestion.id} className="lec-admin__row">
              <div className="lec-admin__row-head">
                <StatusPill tone="info">{i.suggestion.certainty === 'certain' ? 'اقتراح آلي — مؤكد' : 'اقتراح آلي — غير مؤكد'}</StatusPill>
                <BidiText as="span" className="lec-admin__title" text={proposalAr(i)} />
              </div>
              <p className="lec-admin__meta">
                {'في: '}
                <BidiText as="span" text={i.lecture?.title ?? i.suggestion.source_title} />
                {i.suggestion.reasons_ar.length ? ` · لماذا: ${i.suggestion.reasons_ar.join('، ')}` : ''}
              </p>
              <p className="lec-admin__meta">{i.suggestion.effect_ar}</p>
              <div className="lec-admin__actions">
                <Button variant="primary" loading={busy === i.suggestion.id} disabled={!!busy && busy !== i.suggestion.id} onClick={() => void decide(i, 'accept')}>
                  اقبل
                </Button>
                <Button variant="secondary" disabled={!!busy} onClick={() => void decide(i, 'reject')}>
                  ارفض
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PublishDialog({ subject, lecture, version, onClose, onDone }: { subject: AdminSubject; lecture: OfficialLectureDetail; version: OfficialVersionView; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<PublishOfficialVersionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    lecturesApi
      .previewPublish(subject.spaceId, lecture.id, version.id)
      .then((p) => alive && setPreview(p))
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [subject.spaceId, lecture.id, version.id]);
  const changes = preview?.changes ? Object.entries(preview.changes).filter(([, n]) => n > 0) : [];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`نشر الإصدار ${version.version_no} من «${lectureLabel(lecture)}»`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            variant="primary"
            icon={<Send size={16} />}
            loading={busy}
            disabled={!preview}
            onClick={async () => {
              setBusy(true);
              try {
                await lecturesApi.publish(subject.spaceId, lecture.id, version.id, note.trim() || null);
                onDone();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            انشر للطلاب
          </Button>
        </>
      }
    >
      {!preview && !error && <LoadingState stage="جارٍ تجهيز المعاينة…" inline />}
      {error && <p className="lec-admin__error" role="alert">{error}</p>}
      {preview && (
        <div className="lec-admin__preview">
          <p>
            {preview.previous ? `يحل محل الإصدار ${preview.previous.version_no}. ` : 'هذا أول إصدار رسمي للمحاضرة. '}
            {preview.version.page_count !== null ? `عدد الصفحات: ${preview.version.page_count}.` : ''}
          </p>
          {preview.previous && (
            <p>
              {preview.changes
                ? changes.length
                  ? `الصفحات مقارنة بالإصدار السابق: ${changes.map(([k, n]) => `${CHANGE_LABELS_AR[k] ?? k} ${n}`).join('، ')}.`
                  : 'لا تغيير في الصفحات عن الإصدار السابق.'
                : 'لم تُحسب مقارنة الصفحات بعد؛ تُحسب بعد النشر وتظهر في «قارن الإصدارات».'}
            </p>
          )}
          <p>الطلاب الذين يملكون نسخة من المحاضرة: {preview.holders.label_ar}. ملاحظاتهم لا تُحذف؛ يُعرض عليهم نقلها إلى الإصدار الجديد.</p>
          <TextArea label="ملاحظة التغيير (يراها الطلاب)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} hint="اختياري" />
        </div>
      )}
    </Dialog>
  );
}

function WithdrawDialog({ subject, lecture, onClose, onDone }: { subject: AdminSubject; lecture: OfficialLectureDetail; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<LectureWithdrawReason>('replaced');
  const [note, setNote] = useState('');
  const neverPublished = lecture.head_version === null;
  const impact =
    reason === 'rights_takedown'
      ? 'تُحذف ملفات المحاضرة ونصها من المادة نهائيًا ولا يمكن التراجع. تبقى ملاحظات الطلاب وحبرهم في نسخهم فوق صفحات فارغة تذكر السبب.'
      : neverPublished
        ? 'لم تُنشر هذه المحاضرة؛ لا يراها الطلاب ولا تظهر في التحديثات. تبقى عندك وعند من رفعها «مسحوبة» مع السبب.'
        : 'تختفي المحاضرة من قائمة المحاضرات الجديدة وتظهر «مسحوبة» مع السبب. لا يُحذف شيء: يبقى الملف وملاحظات الطلاب كما هي.';
  return (
    <ConfirmDialog
      open
      title={`سحب «${lectureLabel(lecture)}»`}
      impact={impact}
      confirmLabel={reason === 'rights_takedown' ? 'اسحب واحذف الملفات' : 'اسحب المحاضرة'}
      destructive
      requireText={reason === 'rights_takedown' ? 'حذف' : undefined}
      onCancel={onClose}
      onConfirm={async () => {
        if (note.trim().length < 2) throw new Error('اكتب سطرًا يشرح السبب للطلاب.');
        try {
          await lecturesApi.withdraw(subject.spaceId, lecture.id, { reason, note_ar: note.trim() });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        onDone();
      }}
    >
      <Select label="السبب" value={reason} onValueChange={(v) => setReason(v as LectureWithdrawReason)} options={LECTURE_WITHDRAW_REASONS.map((r) => ({ value: r, label: LECTURE_WITHDRAW_REASON_LABELS_AR[r] }))} />
      <TextArea label={neverPublished ? 'السبب (يراه من رفعها)' : 'ما يراه الطلاب'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} required hint="سطر قصير يشرح السبب (حرفان على الأقل)." />
    </ConfirmDialog>
  );
}

function LectureRow({ subject, lecture, onChanged }: { subject: AdminSubject; lecture: OfficialLectureDetail; onChanged: () => void }) {
  const toast = useToast();
  const [publishing, setPublishing] = useState<OfficialVersionView | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const drafts = lecture.versions.filter((v) => v.status === 'draft');
  const latestDraft = drafts[0] ?? null;
  const ready = latestDraft ? ['ready', 'partial', 'needs_review'].includes(latestDraft.processing_status) : false;
  // a contributor's upload waits for approval (in review); a moderator's own draft needs none — publishing is enough
  const awaiting = lecture.status === 'in_review';
  const tone = lecture.status === 'published' ? 'success' : lecture.status === 'withdrawn' ? 'neutral' : lecture.status === 'in_review' ? 'warning' : 'info';
  return (
    <li className="lec-admin__row" data-status={lecture.status}>
      <div className="lec-admin__row-head">
        <span className="lec-admin__badge" aria-label={`محتوى ${OFFICIAL_BADGE_AR}`}>
          <CheckCircle2 size={14} aria-hidden="true" /> {OFFICIAL_BADGE_AR}
        </span>
        <BidiText as="span" className="lec-admin__title" text={lectureLabel(lecture)} />
        <StatusPill tone={tone}>{OFFICIAL_LECTURE_STATUS_LABELS_AR[lecture.status]}</StatusPill>
      </div>
      <p className="lec-admin__meta">
        رفعها {lecture.uploaded_by.display_name}
        {lecture.approved ? ` · وافق عليها ${lecture.approved.by.display_name}` : ''}
        {lecture.lecture_no_origin === 'detected' ? ' · رقم مقروء آليًا من الملف' : ''}
        {lecture.head_version ? ` · الإصدار المنشور ${lecture.head_version.version_no}` : ''}
        {lecture.withdrawn ? ` · سبب السحب: ${lecture.withdrawn.note_ar}` : ''}
      </p>
      {lecture.versions.length > 0 && (
        <ul className="lec-admin__versions" aria-label={`إصدارات ${lecture.title}`}>
          {lecture.versions.map((v) => (
            <li key={v.id}>
              الإصدار {v.version_no}
              {v.kind === 'correction' ? ' (تصحيح)' : ''} — {v.status === 'published' ? 'منشور' : v.status === 'superseded' ? 'سابق' : 'غير منشور'}
              {v.file_name ? ` · ${v.file_name}` : ''}
              {v.status === 'draft' && !['ready', 'partial', 'needs_review'].includes(v.processing_status) ? ' · تجري المعالجة' : ''}
              {v.uploaded_by ? ` · رفعه ${v.uploaded_by.display_name}` : ''}
              {v.published_at ? ` · نُشر ${formatDateTime(v.published_at)}` : ''}
              {v.published_by ? ` · نشره ${v.published_by.display_name}` : ''}
            </li>
          ))}
        </ul>
      )}
      {subject.moderator && lecture.status !== 'withdrawn' && (
        <div className="lec-admin__actions">
          {awaiting && (
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  await lecturesApi.approve(subject.spaceId, lecture.id);
                  toast.show({ title: 'تمت الموافقة على المسودة.', tone: 'success' });
                  onChanged();
                } catch (e) {
                  toast.show({ title: errorMessage(e), tone: 'danger' });
                }
              }}
            >
              وافق
            </Button>
          )}
          {latestDraft && (
            <Button variant="primary" icon={<Send size={16} />} disabled={!ready} aria-describedby={ready ? undefined : `wait-${lecture.id}`} onClick={() => setPublishing(latestDraft)}>
              انشر الإصدار {latestDraft.version_no}
            </Button>
          )}
          {latestDraft && !ready && (
            <span id={`wait-${lecture.id}`} className="lec-admin__hint">
              يُتاح النشر بعد انتهاء معالجة الملف.
            </span>
          )}
          <Button variant="plain" icon={<Undo2 size={16} />} onClick={() => setWithdrawing(true)}>
            اسحب
          </Button>
        </div>
      )}
      {publishing && (
        <PublishDialog
          subject={subject}
          lecture={lecture}
          version={publishing}
          onClose={() => setPublishing(null)}
          onDone={() => {
            setPublishing(null);
            toast.show({ title: 'نُشر الإصدار للطلاب.', tone: 'success' });
            onChanged();
          }}
        />
      )}
      {withdrawing && (
        <WithdrawDialog
          subject={subject}
          lecture={lecture}
          onClose={() => setWithdrawing(false)}
          onDone={() => {
            setWithdrawing(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

function CorrectionRow({ subject, c, onChanged }: { subject: AdminSubject; c: OfficialCorrectionView; onChanged: () => void }) {
  const toast = useToast();
  const decide = async (decision: 'accept' | 'reject') => {
    try {
      await lecturesApi.decideCorrection(subject.spaceId, c.lecture.id, c.id, decision);
      toast.show({ title: decision === 'accept' ? 'قُبل التصحيح؛ يُنشأ إصدار جديد من المحاضرة.' : 'رُفض الاقتراح.', tone: 'success' });
      onChanged();
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <li className="lec-admin__row">
      <div className="lec-admin__row-head">
        <BidiText as="span" className="lec-admin__title" text={`${c.lecture.title} — الإصدار ${c.version.version_no}`} />
        <span className="lec-admin__meta">اقترحه {c.proposed_by.display_name}</span>
      </div>
      {c.note && <BidiText as="p" className="lec-admin__meta" text={c.note} />}
      <ul className="lec-admin__diff">
        {c.items.map((it) => (
          <li key={it.region_id}>
            {it.page_index !== null && <span className="lec-admin__meta">صفحة {it.page_index + 1}: </span>}
            <del>
              <BidiText as="span" text={it.before ?? '—'} />
            </del>{' '}
            <ins>
              <BidiText as="span" text={it.after || '(حذف النص)'} />
            </ins>
          </li>
        ))}
      </ul>
      <div className="lec-admin__actions">
        <Button variant="primary" onClick={() => void decide('accept')}>
          اقبل وانشر إصدارًا مصححًا
        </Button>
        <Button variant="secondary" onClick={() => void decide('reject')}>
          ارفض
        </Button>
      </div>
    </li>
  );
}

function SubjectContent({ subject }: { subject: AdminSubject }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await lecturesApi.list(subject.spaceId);
      const lectures = await Promise.all(list.items.map((l) => lecturesApi.detail(subject.spaceId, l.id)));
      const corrections = subject.moderator ? (await lecturesApi.corrections(subject.spaceId, { status: 'open' })).corrections : [];
      return { lectures, corrections };
    })()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [subject.spaceId, subject.moderator, nonce]);

  if (error) return <ErrorState message={error} onRetry={reload} inline />;
  if (!data) return <LoadingState stage="جارٍ تحميل محاضرات المادة…" inline />;
  const waiting = data.lectures.filter((l) => l.status === 'in_review' || l.status === 'draft' || l.versions.some((v) => v.status === 'draft'));
  const rest = data.lectures.filter((l) => !waiting.includes(l));
  return (
    <>
      <AddLecture subject={subject} onDone={reload} />
      <BulkUpload subject={subject} onDone={reload} />
      {subject.moderator && <ReviewQueue subject={subject} onChanged={reload} />}
      <section aria-labelledby="lec-waiting" className="lec-admin__group">
        <h2 id="lec-waiting" className="lec-admin__h2">
          {subject.moderator ? 'بانتظار الموافقة أو النشر' : 'مسوداتي'}
        </h2>
        {waiting.length ? (
          <ul className="lec-admin__list">
            {waiting.map((l) => (
              <LectureRow key={l.id} subject={subject} lecture={l} onChanged={reload} />
            ))}
          </ul>
        ) : (
          <p className="lec-admin__empty">لا شيء ينتظر الآن.</p>
        )}
      </section>
      {subject.moderator && (
        <section aria-labelledby="lec-corrections" className="lec-admin__group">
          <h2 id="lec-corrections" className="lec-admin__h2">
            تصحيحات مقترحة
          </h2>
          {data.corrections.length ? (
            <ul className="lec-admin__list">
              {data.corrections.map((c) => (
                <CorrectionRow key={c.id} subject={subject} c={c} onChanged={reload} />
              ))}
            </ul>
          ) : (
            <p className="lec-admin__empty">لا توجد تصحيحات مقترحة.</p>
          )}
        </section>
      )}
      <section aria-labelledby="lec-published" className="lec-admin__group">
        <h2 id="lec-published" className="lec-admin__h2">
          المحاضرات المنشورة والمسحوبة
        </h2>
        {rest.length ? (
          <ul className="lec-admin__list">
            {rest.map((l) => (
              <LectureRow key={l.id} subject={subject} lecture={l} onChanged={reload} />
            ))}
          </ul>
        ) : (
          <EmptyState headingLevel={3} title="لا توجد محاضرات منشورة بعد" description="تظهر هنا محاضرات المادة بعد نشر إصدارها الأول." />
        )}
      </section>
    </>
  );
}

export function OfficialContentSection() {
  const subjects = useAdminSubjects(['subject_moderator', 'admin', 'contributor']);
  return (
    <div className="lec-admin" dir="rtl">
      <h1 className="lec-admin__h1">المحتوى الرسمي</h1>
      <SubjectScope state={subjects}>{(s) => <SubjectContent key={s.spaceId} subject={s} />}</SubjectScope>
    </div>
  );
}

export const Component = OfficialContentSection;
