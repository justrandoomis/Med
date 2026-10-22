// «اربط بالمحاضرة الرسمية» (P1-T5 step 2; PRD AOS-19H.3; ARCHITECTURE_DELTA §6.9). A lecture the student uploaded
// privately exists officially in one of their subjects (same file, or most pages): one tap COPIES their ink, highlights
// and notes onto the official version in a personal copy, with the inserted note pages; what cannot be placed safely is
// listed in the review list of the OFFICIAL copy («ملاحظاتي ← إعادة ربط», Phase 1 completion C2 — X8 c), to copy there by
// hand or keep on the private lecture; the private file and everything on it stay exactly as they were. The candidates come from the server (subjects the viewer belongs
// to only); the client id is fixed for the dialog's life, so a retry never makes a second copy.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import { newId, type LinkToOfficialResponse, type OfficialLinkCandidate } from '@medlevo/shared';
import { Button, Dialog } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { studyUrl } from '../workspace/nav/SourceNavigation';
import { copiesApi } from './api';
import { dropLinkStatus } from './linkStatusStore';
import './copies.css';

const keyOf = (c: OfficialLinkCandidate) => `${c.space_id}/${c.lecture_id}/${c.version_id}`;

export function LinkToOfficialDialog({
  open,
  onClose,
  sourceId,
  candidates,
  unavailable,
}: {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  candidates: OfficialLinkCandidate[];
  /** (C2) opened from the library menu and the twin is gone (or could not be fetched): say so instead of a dead form */
  unavailable?: string;
}) {
  const online = useOnline();
  const navigate = useNavigate();
  const [clientId] = useState(() => newId());
  const [chosen, setChosen] = useState<string>(candidates[0] ? keyOf(candidates[0]) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LinkToOfficialResponse | null>(null);
  const pick = candidates.find((c) => keyOf(c) === chosen) ?? candidates[0];

  const link = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const res = await copiesApi.link({ id: clientId, source_id: sourceId, space_id: pick.space_id, lecture_id: pick.lecture_id, to_version_id: pick.version_id });
      // the library rows of both documents say «مرتبطة» / «رسمي» from now on
      dropLinkStatus([sourceId, res.copy.source_id]);
      setDone(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const s = done.summary;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="رُبطت المحاضرة بنسختها الرسمية"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              البقاء في نسختي الخاصة
            </Button>
            <Button
              variant={s && s.needs_review > 0 ? 'secondary' : 'primary'}
              onClick={() => {
                onClose();
                navigate(studyUrl({ sourceId: done.copy.source_id }));
              }}
            >
              افتح النسخة الرسمية
            </Button>
            {s && s.needs_review > 0 && (
              <Button
                onClick={() => {
                  onClose();
                  navigate(studyUrl({ sourceId: done.copy.source_id, panel: 'review' }));
                }}
              >
                راجع ما لم يُنسخ
              </Button>
            )}
          </>
        }
      >
        <div className="cp-sheet">
          {s ? (
            <>
              <p className="cp-sheet__line">{s.summary_ar}</p>
              <ul className="cp-counts" aria-label="ما نُسخ">
                <li>
                  <span className="cp-counts__n">{s.copied}</span> نُسخ إلى مكانه
                </li>
                <li>
                  <span className="cp-counts__n">{s.needs_review}</span> ينتظر مراجعتك (تغيّرت صفحته)
                </li>
                <li>
                  <span className="cp-counts__n">{s.kept}</span> بقي في نسختك الخاصة فقط
                </li>
                {s.note_pages && s.note_pages.total > 0 && (
                  <li>
                    <span className="cp-counts__n">{s.note_pages.copied}</span>
                    {` من ${s.note_pages.total} صفحة ملاحظات مضافة نُسخت بما عليها`}
                  </li>
                )}
              </ul>
              {/* C2 (X8 c): they are listed in the review list of the official copy; the originals stay where they are */}
              {s.needs_review > 0 && (
                <p className="cp-sheet__line cp-sheet__line--muted">
                  ما لم يُنسخ تلقائيًا تجده في «ملاحظاتي ← إعادة ربط» في النسخة الرسمية: انسخه إلى الصفحة المقترحة أو إلى صفحة تختارها، أو أبقِه في محاضرتك الخاصة. لا يضيع منه شيء.
                </p>
              )}
            </>
          ) : (
            <p className="cp-sheet__line">يجري نسخ ملاحظاتك؛ يصلك تقرير بما نُسخ حين ينتهي.</p>
          )}
          <p className="cp-sheet__line cp-sheet__line--muted">ملفك الخاص وكل ما كتبته عليه لم يتغيّر.</p>
        </div>
      </Dialog>
    );
  }

  if (unavailable && candidates.length === 0) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="اربط بالمحاضرة الرسمية"
        footer={
          <Button variant="secondary" onClick={onClose}>
            إغلاق
          </Button>
        }
      >
        <p className="cp-sheet__line" role="status">
          {unavailable}
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="اربط بالمحاضرة الرسمية"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button icon={<Link2 size={18} />} onClick={link} loading={busy} disabled={!online || !pick}>
            اربط وانسخ ملاحظاتي
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        <p className="cp-sheet__line">
          تُنسخ كتابتك وتظليلاتك وملاحظاتك إلى النسخة الرسمية في مكتبتك، وما لا يمكن وضعه في مكانه بأمان يُعرض عليك للمراجعة. يبقى
          ملفك الخاص وكل ما كتبته عليه كما هو.
        </p>
        <fieldset className="cp-candidates">
          <legend className="cp-candidates__legend">{candidates.length > 1 ? 'اختر المحاضرة الرسمية' : 'المحاضرة الرسمية'}</legend>
          {candidates.map((c) => (
            <label key={keyOf(c)} className="cp-candidate">
              <input type="radio" name="cp-candidate" value={keyOf(c)} checked={keyOf(c) === keyOf(pick!)} onChange={() => setChosen(keyOf(c))} />
              <span className="cp-candidate__text">
                <span className="cp-candidate__title">
                  <bdi>{c.title}</bdi> — {c.subject.title} · الإصدار {c.version_no}
                </span>
                {c.basis_ar.map((b) => (
                  <span key={b} className="cp-candidate__basis">
                    {b}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </fieldset>
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: الربط يحتاج الخادم.
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
