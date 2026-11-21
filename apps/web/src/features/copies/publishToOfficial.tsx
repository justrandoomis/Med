// «انشرها كمحاضرة رسمية» (Phase 1 completion — PRD AOS-19H.4, X8 (c); ARCHITECTURE_DELTA §6.9; server
// `POST /api/spaces/:s/lectures/from-vault`). A Subject Moderator (or an Admin of the subject, or the platform admin)
// sees their OWN private lecture in the library and makes it a DRAFT official lecture of a subject they moderate: the
// file is registered there by its sha256 (no copy), the subject processes it, and it reaches students only when they
// publish it from «المحتوى الرسمي». Their own ink stays private in their library (copy, never move).
//
// The row menu item exists ONLY for a viewer who moderates at least one subject (read once per session from P1-T4's
// channel tree; the server still decides every request) — nobody else sees a decorative control. The result says
// honestly what was created and what it waits for; a refusal shows the server's reason (and leaves no draft behind).
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { OFFICIAL_LECTURE_STATUS_LABELS_AR, type LectureFromVaultResponse, type SourceSummary } from '@medlevo/shared';
import { Button, Dialog, MenuItem, Select, StatusPill, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { type AdminSubject, lecturesApi, loadAdminSubjects } from '../lectures/api';
import { dropLinkStatus, useLinkStatus } from './linkStatusStore';
import './copies.css';

// ───────── the subjects the viewer may publish into (once per session) ─────────

/** undefined: not known yet (offline, loading, failed — nothing is offered); [] none */
let targets: AdminSubject[] | undefined;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function loadTargets(): void {
  if (targets !== undefined || loading) return;
  loading = loadAdminSubjects(['subject_moderator', 'admin'])
    .then((list) => {
      // the server's rule (rules/lectures.ts `officialModerator`): a Subject Moderator or an Admin of the subject
      targets = list.filter((s) => s.moderator);
    })
    .catch(() => {
      // not known: asked again on the next visit (never offered on a failed answer)
      targets = undefined;
    })
    .finally(() => {
      loading = null;
      notify();
    });
}

/** For tests (and sign-out): forget the subjects. */
export function resetPublishTargets(): void {
  targets = undefined;
  loading = null;
  notify();
}

/** The subjects the viewer may publish their own lecture into; undefined while unknown. */
export function usePublishTargets(): AdminSubject[] | undefined {
  const online = useOnline();
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (online) loadTargets();
  }, [online]);
  return targets;
}

// ───────── the row menu action ─────────

/**
 * The row menu's «انشرها كمحاضرة رسمية…» for the viewer's own private lecture: render `item` inside the `<Menu>` and
 * `dialog` outside it. Nothing at all for a viewer who moderates no subject, for a row that is already an official
 * copy or linked to one, or for anything that is not a lecture with a file.
 */
export function usePublishToOfficialAction(source: Pick<SourceSummary, 'id' | 'title' | 'source_type' | 'active_version_id' | 'deleted_at'>): { item: ReactNode; dialog: ReactNode } {
  const subjects = usePublishTargets();
  const status = useLinkStatus(source.id);
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const eligible =
    !!subjects &&
    subjects.length > 0 &&
    source.source_type === 'lecture' &&
    !!source.active_version_id &&
    source.deleted_at === null &&
    // an official copy (stub) or a lecture already linked to its official twin is official already
    status !== undefined &&
    !status?.official &&
    !status?.linked;
  const item = eligible ? (
    <MenuItem icon={<Upload size={16} />} onSelect={() => setOpen(true)} disabled={!online} disabledReason={online ? undefined : 'النشر يحتاج اتصالًا بالخادم.'}>
      انشرها كمحاضرة رسمية…
    </MenuItem>
  ) : null;
  // the dialog stays while open, whatever the row's status becomes (its result must stay on screen)
  const dialog =
    open && subjects && subjects.length > 0 ? (
      <PublishToOfficialDialog
        open
        sourceId={source.id}
        sourceTitle={source.title}
        subjects={subjects}
        onClose={() => {
          setOpen(false);
          dropLinkStatus([source.id]);
        }}
      />
    ) : null;
  return { item, dialog };
}

// ───────── the dialog ─────────

export function PublishToOfficialDialog({
  open,
  onClose,
  sourceId,
  sourceTitle,
  subjects,
}: {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  sourceTitle: string;
  subjects: AdminSubject[];
}) {
  const online = useOnline();
  const navigate = useNavigate();
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [title, setTitle] = useState(sourceTitle.slice(0, 200));
  const [lectureNo, setLectureNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ res: LectureFromVaultResponse; subject: AdminSubject } | null>(null);
  const subject = subjects.find((s) => s.id === subjectId) ?? subjects[0];
  const no = lectureNo.trim() === '' ? null : Number(lectureNo);
  const noError = no !== null && (!Number.isInteger(no) || no < 1 || no > 999) ? 'اكتب رقمًا صحيحًا من 1 إلى 999، أو اتركه فارغًا.' : null;
  const titleError = title.trim() === '' ? 'اكتب عنوان المحاضرة.' : null;

  const publish = async () => {
    if (!subject || noError || titleError) return;
    setBusy(true);
    setError(null);
    try {
      const res = await lecturesApi.fromVault(subject.spaceId, { source_id: sourceId, title: title.trim(), lecture_no: no });
      setDone({ res, subject });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const l = done.res.lecture;
    const waits = l.status === 'in_review';
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="أُنشئت مسودة المحاضرة الرسمية"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              إغلاق
            </Button>
            <Button
              onClick={() => {
                onClose();
                navigate(`/admin/official?subject=${encodeURIComponent(done.subject.id)}`);
              }}
            >
              افتح «المحتوى الرسمي»
            </Button>
          </>
        }
      >
        <div className="cp-sheet">
          <p className="cp-sheet__line">
            <bdi>{l.title}</bdi> — {done.subject.title} <StatusPill tone={waits ? 'warning' : 'neutral'}>{OFFICIAL_LECTURE_STATUS_LABELS_AR[l.status]}</StatusPill>
          </p>
          <p className="cp-sheet__line">
            {waits
              ? 'تنتظر موافقة مشرف المادة. لا يراها الطلاب حتى تُنشر.'
              : 'لا يراها الطلاب بعد: تُعالَج الآن في المادة، ثم انشر إصدارها من «المحتوى الرسمي» حين تنتهي معالجتها.'}
          </p>
          <p className="cp-sheet__line cp-sheet__line--muted">ملفك الخاص وكل ما كتبته عليه بقي في مكتبتك كما هو؛ لم يُنقل منه شيء.</p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="انشرها كمحاضرة رسمية"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button icon={<Upload size={18} />} onClick={publish} loading={busy} disabled={!online || !subject || !!noError || !!titleError}>
            أنشئ المسودة الرسمية
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        <p className="cp-sheet__line">
          يُسجَّل ملف هذه المحاضرة في المادة كمسودة محاضرة رسمية (دون نسخ الملف). لا يراها الطلاب حتى تنشرها من «المحتوى الرسمي». تبقى
          كتابتك وملاحظاتك عليها خاصة في مكتبتك.
        </p>
        {subjects.length > 1 ? (
          <Select label="المادة" value={subject?.id ?? ''} onValueChange={setSubjectId} options={subjects.map((s) => ({ value: s.id, label: s.title }))} />
        ) : (
          <p className="cp-sheet__line">
            المادة: <bdi>{subject?.title}</bdi>
          </p>
        )}
        <TextField label="عنوان المحاضرة الرسمية" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} error={titleError ?? undefined} required />
        <TextField label="رقم المحاضرة (اختياري)" inputMode="numeric" value={lectureNo} onChange={(e) => setLectureNo(e.target.value)} error={noError ?? undefined} />
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: النشر يحتاج الخادم.
          </p>
        )}
        {error && (
          <p className="cp-sheet__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
