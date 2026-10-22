// «أبلغ» on a published explanation (P1-T5 step 3; PRD AOS-21.16, 21.44). The report goes to P1-T4's moderation: the
// moderators of the subject see it in «إدارة القنوات» and may hide the explanation with a reason; the author never
// learns who reported. One open report per person per explanation — a second one answers the server's reason.
import { useId, useState } from 'react';
import { Flag } from 'lucide-react';
import { REPORT_REASON_LABELS_AR, REPORT_REASONS, type ReportReason } from '@medlevo/shared';
import { Button, Dialog, TextArea, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { typed } from '../../lib/typedText';
import { useOnline } from '../../lib/useOnline';
import { publicationsApi } from './api';
import './publications.css';

export function ReportDialog({ open, onClose, publication }: { open: boolean; onClose: () => void; publication: { id: string; title: string } }) {
  const online = useOnline();
  const toast = useToast();
  const name = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!reason) {
      setError('اختر سبب البلاغ.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await publicationsApi.report({ target: { db: 'system', type: 'publication', id: publication.id }, reason, ...(note.trim() ? { note: note.trim() } : {}) });
      toast.show({ tone: 'success', title: 'وصل بلاغك إلى مشرفي المادة.', description: 'لا يعرف صاحب الشرح من أبلغ.' });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="أبلغ عن هذا الشرح"
      description={`«${publication.title}» — يصل البلاغ إلى مشرفي المادة وحدهم، ولا يعرف صاحب الشرح من أبلغ.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button icon={<Flag size={18} />} onClick={send} loading={busy} disabled={!online}>
            أرسل البلاغ
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        <fieldset className="pb-choices">
          <legend className="pb-choices__legend">السبب</legend>
          {REPORT_REASONS.map((r) => (
            <label key={r} className="pb-choice">
              <input type="radio" name={name} value={r} checked={reason === r} onChange={() => setReason(r)} />
              <span className="pb-choice__text">
                <span className="pb-choice__title">{REPORT_REASON_LABELS_AR[r]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <TextArea label="تفاصيل (اختياري)" value={note} maxLength={1000} rows={3} onChange={typed(setNote, true)} />
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: إرسال البلاغ يحتاج الخادم.
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
