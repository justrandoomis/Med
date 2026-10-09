// «تحديد المفتاح» — the owner chooses the answer (an OWNER key, never shown as the source's key). The server
// creates a new version and reports the impact on past attempts; nothing is re-graded silently (AC-15, AC-26).
import { useEffect, useState } from 'react';
import type { KeyChangeImpact, QuestionVersionView } from '@medlevo/shared';
import { Bidi, Button, Dialog, RichTextView, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { questionsApi } from './api';

export function KeyDialog({
  open,
  onClose,
  questionId,
  version,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  questionId: string;
  version: QuestionVersionView;
  onDone: (impact: KeyChangeImpact | null) => void;
}) {
  const current = new Set(version.options.filter((o) => version.correct_option_ids?.includes(o.id)).map((o) => o.option_key));
  const [selected, setSelected] = useState<Set<string>>(current);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelected(new Set(version.options.filter((o) => version.correct_option_ids?.includes(o.id)).map((o) => o.option_key)));
      setReason('');
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version.id]);

  const save = async (keys: string[] | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await questionsApi.setKey(questionId, { option_keys: keys, reason: reason.trim() || undefined });
      onDone(r.impact);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k: string) => {
    const next = new Set(version.qtype === 'multi_select' ? selected : []);
    if (selected.has(k) && version.qtype === 'multi_select') next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="تحديد مفتاح الإجابة بنفسك"
      description="يُحفظ كمفتاح حددته أنت، لا كمفتاح المصدر. تُنشأ نسخة جديدة من السؤال، وتبقى محاولاتك السابقة على نسختها مع تقرير بأثر التغيير."
      footer={
        <div className="ml-cluster">
          <Button variant="primary" loading={busy} disabled={selected.size === 0} onClick={() => void save([...selected])}>
            حفظ المفتاح
          </Button>
          {version.answer_status === 'owner_key' && (
            <Button variant="secondary" disabled={busy} onClick={() => void save(null)}>
              إزالة مفتاحي
            </Button>
          )}
          <Button variant="plain" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
        </div>
      }
    >
      <fieldset className="qv-keypick">
        <legend className="ml-field__label">{version.qtype === 'multi_select' ? 'الخيارات الصحيحة' : 'الخيار الصحيح'}</legend>
        {version.options.map((o) => (
          <label key={o.option_key} className="qv-choice">
            <input
              type={version.qtype === 'multi_select' ? 'checkbox' : 'radio'}
              name={`key-${questionId}`}
              checked={selected.has(o.option_key)}
              onChange={() => toggle(o.option_key)}
            />
            {o.source_label && (
              <Bidi dir={/[A-Za-z0-9]/.test(o.source_label) ? 'ltr' : 'rtl'} className="qv-label">
                {o.source_label}
              </Bidi>
            )}
            <RichTextView value={o.text} className="qv-choice__text" />
          </label>
        ))}
      </fieldset>
      <TextField label="السبب (اختياري)" hint="مثل: راجعت المحاضرة ص 13" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      {error && (
        <p className="ml-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
