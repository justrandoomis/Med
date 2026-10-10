// Handwritten answer for a written question (§41, track F4): write in the pad → «حوّل إلى نص» (the vision reader on
// the server; requires_configuration without one) → the read text with uncertain words marked → the owner REVIEWS,
// edits and explicitly confirms it → only then is it saved for grading. Uncertain reading never costs points: what is
// graded is the text the owner confirmed. The pad strokes are kept on this device while writing and with the reading
// on the server.
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, ScanText, Save } from 'lucide-react';
import { newId, RECOGNITION_LANG_LABELS_AR, RECOGNITION_LANGS, type InkRecognitionView, type RecognitionLang, type WrittenQuestionView } from '@medlevo/shared';
import { Button, Checkbox, SegmentedControl, Spinner, TextArea } from '../../design';
import { errorMessage } from '../../lib/api';
import { getDb, kvGet, kvSet } from '../../lib/localdb';
import { recognitionApi, waitForRecognition } from '../workspace/handwriting/api';
import { InkPad, type PadStroke } from '../workspace/handwriting/InkPad';
import { renderPadPicture, type RenderedPicture } from '../workspace/handwriting/raster';
import { RecognizedLines, uncertainSummaryAr } from '../workspace/handwriting/RecognizedText';
import { examsApi } from './api';

const padKey = (questionId: string) => `written-pad:${questionId}`;

export interface HandwrittenAnswerDeps {
  render?: (strokes: PadStroke[]) => RenderedPicture;
  recognize?: typeof recognitionApi.create;
  wait?: typeof waitForRecognition;
  save?: typeof examsApi.saveWritten;
}

export function HandwrittenAnswer({
  view,
  online,
  recognition,
  onSaved,
  deps = {},
}: {
  view: WrittenQuestionView;
  online: boolean;
  recognition: { available: boolean; reason: string | null };
  onSaved: () => void;
  deps?: HandwrittenAnswerDeps;
}) {
  const [strokes, setStrokes] = useState<PadStroke[]>([]);
  const [lang, setLang] = useState<RecognitionLang>('mixed');
  const [reading, setReading] = useState(false);
  const [rec, setRec] = useState<InkRecognitionView | null>(null);
  const [text, setText] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a retry after a lost response re-sends the SAME attempt id (idempotent on the server)
  const attemptId = useRef(newId());

  // the pad is a draft on this device until the answer is saved (the owner's writing is never lost)
  useEffect(() => {
    void kvGet<PadStroke[]>(getDb(), padKey(view.question_id))
      .then((s) => Array.isArray(s) && setStrokes(s))
      .catch(() => undefined);
  }, [view.question_id]);
  const change = (s: PadStroke[]) => {
    setStrokes(s);
    setRec(null);
    setConfirmed(false);
    void kvSet(getDb(), padKey(view.question_id), s).catch(() => undefined);
  };

  const readReason = !recognition.available ? recognition.reason : !online ? 'قراءة الخط تحتاج اتصالًا بالخادم؛ ما كتبته محفوظ على هذا الجهاز.' : strokes.length === 0 ? 'اكتب إجابتك في اللوحة أولًا.' : null;

  const read = async () => {
    setError(null);
    setReading(true);
    setRec(null);
    setConfirmed(false);
    try {
      const pic = (deps.render ?? renderPadPicture)(strokes);
      const created = await (deps.recognize ?? recognitionApi.create)({
        id: newId(),
        purpose: 'written_answer',
        lang,
        question_id: view.question_id,
        strokes,
        image_png_base64: pic.base64,
      });
      const done = await (deps.wait ?? waitForRecognition)(created.id);
      setRec(done);
      setText(done.effective_text);
      if (done.status !== 'recognized') setError(done.error_ar ?? 'تعذّرت قراءة الكتابة. اكتب الإجابة بلوحة المفاتيح، أو أعد الكتابة بوضوح.');
    } catch (e) {
      setError(errorMessage(e, 'تعذّرت قراءة الكتابة الآن؛ ما كتبته محفوظ على هذا الجهاز.'));
    } finally {
      setReading(false);
    }
  };

  const save = async () => {
    if (!rec || !confirmed || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await (deps.save ?? examsApi.saveWritten)({
        id: attemptId.current,
        question_id: view.question_id,
        question_version_id: view.question_version_id,
        answer_text: text.trim(),
        recognized_text: rec.recognized_text,
        recognized_confirmed: true,
        recognition_id: rec.id,
        answered_at: Date.now(),
      });
      attemptId.current = newId();
      await kvSet(getDb(), padKey(view.question_id), []).catch(() => undefined);
      setStrokes([]);
      setRec(null);
      setConfirmed(false);
      setText('');
      onSaved();
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ الإجابة؛ كتابتك والنص محفوظان هنا.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ex-handwritten">
      <InkPad strokes={strokes} onChange={change} label="لوحة إجابتك بخط اليد" disabled={reading || saving} />
      <div className="hw-row">
        <SegmentedControl<RecognitionLang>
          label="لغة الكتابة"
          showLabel
          options={RECOGNITION_LANGS.map((l) => ({ value: l, label: RECOGNITION_LANG_LABELS_AR[l] }))}
          value={lang}
          onValueChange={setLang}
        />
        <Button variant="secondary" icon={<ScanText size={16} />} loading={reading} disabled={!!readReason || reading} aria-describedby={readReason ? 'ex-hw-why' : undefined} onClick={() => void read()}>
          حوّل إلى نص
        </Button>
      </div>
      {readReason && (
        <p id="ex-hw-why" className="ex-muted" role="note">
          {readReason}
        </p>
      )}
      {reading && (
        <p className="ex-muted" role="status" aria-live="polite">
          <Spinner size={14} /> تُقرأ كتابتك…
        </p>
      )}
      {error && (
        <p className="ex-note ex-note--warn" role="alert">
          {error}
        </p>
      )}
      {rec && rec.status === 'recognized' && (
        <section className="ex-hw-review" aria-labelledby="ex-hw-review-h">
          <h3 id="ex-hw-review-h" className="ex-subhead">
            راجع النص المقروء قبل الحفظ
          </h3>
          <p className="ex-muted">{rec.origin_label_ar}</p>
          <RecognizedLines lines={rec.lines} label="ما قرأه القارئ الآلي من خط يدك" />
          {uncertainSummaryAr(rec.uncertain_count) && <p className="ex-muted">{uncertainSummaryAr(rec.uncertain_count)}</p>}
          <TextArea
            label="إجابتك كما تريد تقييمها"
            hint="صحّح أي كلمة قُرئت خطأ. هذا النص وحده يُقيَّم بعد تأكيدك، ولا يُخصم شيء بسبب غموض القراءة."
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirmed(false);
            }}
            dir="auto"
          />
          <Checkbox checked={confirmed} onCheckedChange={setConfirmed} label="راجعت النص، وهو إجابتي" />
          <Button variant="primary" icon={confirmed ? <CircleCheck size={16} /> : <Save size={16} />} loading={saving} disabled={!confirmed || !text.trim() || !online} onClick={() => void save()}>
            احفظ الإجابة المؤكَّدة
          </Button>
        </section>
      )}
    </div>
  );
}
