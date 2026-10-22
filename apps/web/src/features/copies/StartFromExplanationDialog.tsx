// «ابدأ الدراسة بهذا الشرح» (P1-T5 step 3; PRD Scenario 2, AOS-4.14 Phase 1 part, Q25; ARCHITECTURE_DELTA §6.5).
// Two kinds of copy of a classmate's published explanation, both in the viewer's own library on the same lecture:
//   * «تابِع الشرح» (followed): the author's writing arrives read-only and keeps up with their new versions — each one
//     previewed first («طبّق التحديث»), or applied at once when the viewer chose so; the viewer's own notes are never
//     touched by an update;
//   * «نسخة مستقلة» (fork): the current version, copied once and freely editable; nothing arrives after.
// Optionally the notes of the viewer's existing personal copy are COPIED into the new copy's own layer (the old copy is
// not changed). The client id is fixed for the dialog's life: a retry after a lost answer reopens the same copy.
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpenCheck } from 'lucide-react';
import { newId, STUDENT_EXPLANATION_LABEL_AR, type DocumentCopyView } from '@medlevo/shared';
import { Button, Checkbox, Dialog, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { copiesApi, copyStudyUrl, pullCopyChanges } from './api';
import './copies.css';
import '../lectures/publications.css';

export interface ExplanationTarget {
  spaceId: string;
  lectureId: string;
  publicationId: string;
  title: string;
  authorName: string;
  headVersionNo: number;
}

type Mode = 'followed' | 'independent_fork';

export function StartFromExplanationDialog({
  open,
  onClose,
  target,
  personalCopy,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  target: ExplanationTarget;
  /** the viewer's personal copy of the lecture, when there is one («انسخ ملاحظاتي من نسختي إليها») */
  personalCopy: DocumentCopyView | null;
  onStarted?: (copy: DocumentCopyView) => void;
}) {
  const online = useOnline();
  const navigate = useNavigate();
  const toast = useToast();
  const name = useId();
  const [clientId] = useState(() => newId());
  const [mode, setMode] = useState<Mode>('followed');
  const [auto, setAuto] = useState(false);
  const [carry, setCarry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await copiesApi.start({
        id: clientId,
        space_id: target.spaceId,
        lecture_id: target.lectureId,
        mode,
        publication_id: target.publicationId,
        ...(carry && personalCopy ? { carry_personal_from_copy_id: personalCopy.id } : {}),
      });
      let copy = res.copy;
      if (mode === 'followed' && auto && copy.update_policy !== 'auto') {
        try {
          copy = await copiesApi.patch(copy.id, { update_policy: 'auto' });
        } catch (e) {
          // the copy exists; only the preference failed — say so, never pretend it was saved
          toast.show({ tone: 'warning', title: 'بدأت الدراسة، لكن لم يُحفظ خيار التطبيق التلقائي.', description: errorMessage(e) });
        }
      }
      pullCopyChanges();
      toast.show({
        tone: 'success',
        title: res.created ? (mode === 'followed' ? `تتابع الآن شرح ${target.authorName}.` : 'أُضيفت نسختك المستقلة إلى مكتبتك.') : 'فُتحت نسختك الموجودة من هذا الشرح.',
      });
      onStarted?.(copy);
      onClose();
      navigate(copyStudyUrl(copy));
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
      size="md"
      title="ابدأ الدراسة بهذا الشرح"
      description={`«${target.title}» — ${target.authorName} · الإصدار ${target.headVersionNo}`}
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
        <fieldset className="pb-choices">
          <legend className="pb-choices__legend">كيف تريد نسختك؟</legend>
          <label className="pb-choice">
            <input type="radio" name={name} value="followed" checked={mode === 'followed'} onChange={() => setMode('followed')} />
            <span className="pb-choice__text">
              <span className="pb-choice__title">تابِع الشرح</span>
              <span className="pb-choice__hint">{`تصلك إصدارات ${target.authorName} الجديدة وتراجع كل تحديث قبل تطبيقه. كتابته للقراءة فقط، وملاحظاتك في طبقتك أنت ولا يغيّرها أي تحديث.`}</span>
            </span>
          </label>
          <label className="pb-choice">
            <input type="radio" name={name} value="independent_fork" checked={mode === 'independent_fork'} onChange={() => setMode('independent_fork')} />
            <span className="pb-choice__text">
              <span className="pb-choice__title">نسخة مستقلة</span>
              <span className="pb-choice__hint">{`تأخذ الإصدار ${target.headVersionNo} كما هو وتعدّل عليه بحرية. لا تصلك تحديثاته بعد ذلك.`}</span>
            </span>
          </label>
        </fieldset>
        {mode === 'followed' && (
          <Checkbox
            checked={auto}
            onCheckedChange={setAuto}
            label="طبّق التحديثات تلقائيًا"
            description="يُطبَّق كل إصدار جديد من الشرح دون أن تراجعه، ويبقى في سجل الطبقة. ملاحظاتك الشخصية لا تتغير أبدًا."
          />
        )}
        {personalCopy && (
          <Checkbox
            checked={carry}
            onCheckedChange={setCarry}
            label="انسخ ملاحظاتي من نسختي إليها"
            description="تُنسخ ملاحظاتك إلى طبقة النسخة الجديدة، وتبقى طبقة نسختك الحالية كما هي (تستطيع إخفاءها من «الطبقات»)."
          />
        )}
        <p className="cp-sheet__line cp-sheet__line--muted">{`${STUDENT_EXPLANATION_LABEL_AR}: يبقى شرح زميلك مميزًا عن المحاضرة الرسمية ولا يُستعمل دليلًا في الإجابات.`}</p>
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: نسخ الشرح إلى مكتبتك يحتاج الخادم مرة واحدة.
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
