// «ابدأ الدراسة» (P1-T5 step 2; PRD AOS-2.17–2.19, 4.1; ARCHITECTURE_DELTA §6.5). Creates — or reopens — the viewer's
// personal copy of an official lecture: a stub in «مكتبتي › موادي من القنوات › <المادة>» with the SAME file (no new
// bytes), and a personal layer only the viewer sees. The client id is fixed for the dialog's life, so a retry after a
// lost response reopens the same copy instead of making a second one. A forked or followed copy needs a published
// explanation (step 3): it is not offered here (no control that does nothing, AOS-23.3).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import { newId, type DocumentCopyView } from '@medlevo/shared';
import { Button, Checkbox, Dialog, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { studyUrl } from '../workspace/nav/SourceNavigation';
import { copiesApi } from './api';
import './copies.css';

export interface StartStudyingTarget {
  spaceId: string;
  lectureId: string;
  title: string;
  subjectTitle: string;
  versionNo: number | null;
}

export function StartStudyingDialog({
  open,
  onClose,
  target,
  pageIndex,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  target: StartStudyingTarget;
  /** the page to open the reader at (from a search hit) */
  pageIndex?: number | null;
  onStarted?: (copy: DocumentCopyView) => void;
}) {
  const online = useOnline();
  const navigate = useNavigate();
  const toast = useToast();
  const [clientId] = useState(() => newId());
  const [autoCopy, setAutoCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await copiesApi.start({ id: clientId, space_id: target.spaceId, lecture_id: target.lectureId, mode: 'personal' });
      let copy = res.copy;
      if (autoCopy && copy.reanchor_policy !== 'auto') {
        try {
          copy = await copiesApi.patch(copy.id, { reanchor_policy: 'auto' });
        } catch (e) {
          // the copy exists; only the preference failed — say so, never pretend it was saved
          toast.show({ tone: 'warning', title: 'بدأت الدراسة، لكن لم يُحفظ خيار النقل التلقائي.', description: errorMessage(e) });
        }
      }
      toast.show({ tone: 'success', title: res.created ? 'أُضيفت المحاضرة إلى مكتبتك.' : 'فُتحت نسختك الموجودة من هذه المحاضرة.' });
      onStarted?.(copy);
      onClose();
      navigate(studyUrl({ sourceId: copy.source_id, pageIndex: pageIndex ?? null }));
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
      title="ابدأ الدراسة"
      description={`«${target.title}» — ${target.subjectTitle}${target.versionNo ? ` · الإصدار ${target.versionNo}` : ''}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button icon={<BookOpenCheck size={18} />} onClick={start} loading={busy} disabled={!online}>
            ابدأ الدراسة
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        <p className="cp-sheet__line">
          تُضاف المحاضرة إلى مكتبتك في «موادي من القنوات» › {target.subjectTitle}: الملف الرسمي نفسه دون نسخة جديدة منه، وكتابتك
          وملاحظاتك في طبقتك الشخصية لا يراها أحد غيرك.
        </p>
        <p className="cp-sheet__line cp-sheet__line--muted">إن كانت لديك نسخة من قبل فُتحت هي نفسها، بكل ما كتبته عليها.</p>
        <Checkbox
          checked={autoCopy}
          onCheckedChange={setAutoCopy}
          label="انقل ملاحظاتي تلقائيًا إلى الإصدارات الجديدة"
          description="عند نشر إصدار جديد من المحاضرة تُنسخ ملاحظاتك إليه وحدها ويصلك تقرير بما نُقل وما يحتاج مراجعتك. تبقى الأصلية على الإصدار السابق دون تغيير."
        />
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: بدء الدراسة يحتاج الخادم مرة واحدة لإضافة المحاضرة إلى مكتبتك.
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
