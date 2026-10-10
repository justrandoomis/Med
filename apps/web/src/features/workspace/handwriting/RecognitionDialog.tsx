// «تحويل إلى نص» / «اسأل عن المحدد» on a lasso selection (track F4, §28, §30).
//  * Convert: the selected strokes are drawn black on white (only them, cropped) → the owner sees exactly that picture
//    and picks the language → the server's vision reader returns a DERIVED reading with uncertain words marked → the
//    owner can correct it. The ink on the page never changes.
//  * Ask: the reading (or what the owner types when nothing can read it) + the paragraph next to the writing become a
//    clear question that is put in the chat composer of the study rail — nothing is sent until the owner sends it.
// Without a vision provider every reading control is disabled with the server's reason (requires_configuration).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, MessageCircleQuestion, RotateCcw, ScanText, Trash2 } from 'lucide-react';
import {
  newId,
  RECOGNITION_LANG_LABELS_AR,
  RECOGNITION_LANGS,
  type AnnotationAnchor,
  type AskContextResponse,
  type InkRecognitionView,
  type NormBox,
  type RecognitionLang,
} from '@medlevo/shared';
import { Button, Dialog, SegmentedControl, Spinner, StatusPill, TextArea } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { isInkStroke, isShape, type InkItem } from '../ink/model';
import { recognitionApi, waitForRecognition } from './api';
import { renderSelectionPicture, type RenderedPicture } from './raster';
import { RecognizedLines, uncertainSummaryAr } from './RecognizedText';
import './handwriting.css';

export interface RecognitionTarget {
  mode: 'convert' | 'ask';
  targetKey: string;
  anchor: AnnotationAnchor;
  items: InkItem[];
  bbox: NormBox;
  ar: number;
}

export interface AskHandoff {
  anchor: AskContextResponse['anchor'];
  /** the paragraph text (the chat's quote) */
  text: string;
  /** the composed question for the composer (editable there; never sent automatically) */
  question: string;
  pageIndex: number;
}

export interface Gate {
  available: boolean;
  reason: string | null;
}

export interface RecognitionDialogDeps {
  api?: Pick<typeof recognitionApi, 'create' | 'get' | 'list' | 'correct' | 'retry' | 'remove' | 'askContext'>;
  render?: (items: InkItem[], ar: number) => RenderedPicture;
  wait?: typeof waitForRecognition;
  /** push pending writing first (a note page must exist on the server before it can be read) */
  syncNow?: () => Promise<void>;
}

export interface RecognitionDialogProps {
  target: RecognitionTarget | null;
  onClose: () => void;
  recognition: Gate;
  chat: Gate;
  online: boolean;
  onAsk: (h: AskHandoff) => void;
  deps?: RecognitionDialogDeps;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading'; rec: InkRecognitionView | null }
  | { kind: 'result'; rec: InkRecognitionView }
  | { kind: 'error'; message: string; rec?: InkRecognitionView }
  /** `rec`: the reading shown before («رجوع» returns to it instead of offering a second reading) */
  | { kind: 'ask'; ctx: AskContextResponse; rec: InkRecognitionView | null };

/** ids of the writing in a selection (what a reading is «of») */
export function writingIds(items: readonly InkItem[]): string[] {
  return items.filter((i) => isInkStroke(i) || isShape(i)).map((i) => i.id);
}

/** An existing reading of exactly this writing (same strokes), the newest first. */
export function matchingRecognition(list: readonly InkRecognitionView[], ids: readonly string[]): InkRecognitionView | null {
  const want = new Set(ids);
  return list.find((r) => r.purpose === 'page_ink' && r.annotation_ids.length === want.size && r.annotation_ids.every((id) => want.has(id))) ?? null;
}

export function RecognitionDialog({ target, onClose, recognition, chat, online, onAsk, deps = {} }: RecognitionDialogProps) {
  const rapi = deps.api ?? recognitionApi;
  const wait = deps.wait ?? waitForRecognition;
  const [lang, setLang] = useState<RecognitionLang>('mixed');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [picture, setPicture] = useState<RenderedPicture | null>(null);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');
  const [typed, setTyped] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ids = useMemo(() => (target ? writingIds(target.items) : []), [target]);
  const pageAnchor = target?.anchor.type === 'page' ? target.anchor : null;

  // a new selection: draw its picture and look for an earlier reading of the same strokes
  useEffect(() => {
    abort.current?.abort();
    setPhase({ kind: 'idle' });
    setNotice(null);
    setCorrection('');
    setTyped('');
    setQuestion('');
    setPicture(null);
    setPictureError(null);
    if (!target) return;
    try {
      setPicture((deps.render ?? renderSelectionPicture)(target.items, target.ar));
    } catch (e) {
      setPictureError(errorMessage(e, 'تعذّر رسم الكتابة المحددة.'));
    }
    if (!online) return;
    let alive = true;
    const q = target.anchor.type === 'page' ? { page_id: target.anchor.page_id } : target.anchor.type === 'note_page' ? { note_page_id: target.anchor.note_page_id } : null;
    if (q)
      rapi
        .list(q)
        .then((list) => {
          const hit = alive ? matchingRecognition(list, ids) : null;
          if (!hit) return;
          setPhase(hit.status === 'queued' || hit.status === 'running' ? { kind: 'reading', rec: hit } : { kind: 'result', rec: hit });
          setCorrection(hit.effective_text);
          if (hit.status === 'queued' || hit.status === 'running') void follow(hit.id);
        })
        .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useEffect(() => () => abort.current?.abort(), []);

  const follow = async (id: string) => {
    const ac = new AbortController();
    abort.current?.abort();
    abort.current = ac;
    try {
      const rec = await wait(id, { signal: ac.signal, onUpdate: (r) => setPhase({ kind: 'reading', rec: r }) });
      if (ac.signal.aborted) return;
      if (rec.status === 'failed') setPhase({ kind: 'error', message: rec.error_ar ?? 'فشلت القراءة.', rec });
      else {
        setPhase({ kind: 'result', rec });
        setCorrection(rec.effective_text);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setPhase({ kind: 'error', message: errorMessage(e, 'تعذّر متابعة القراءة.') });
    }
  };

  const read = async () => {
    if (!target || !picture) return;
    setBusy(true);
    setNotice(null);
    try {
      await deps.syncNow?.().catch(() => undefined);
      const a = target.anchor;
      const rec = await rapi.create({
        id: newId(),
        purpose: 'page_ink',
        lang,
        annotation_ids: ids,
        anchor: a.type === 'page' ? { type: 'page', source_id: a.source_id, version_id: a.version_id, page_id: a.page_id, page_index: a.page_index } : a.type === 'note_page' ? { type: 'note_page', note_page_id: a.note_page_id } : null,
        bbox: target.bbox,
        image_png_base64: picture.base64,
      });
      setPhase({ kind: 'reading', rec });
      void follow(rec.id);
    } catch (e) {
      setPhase({ kind: 'error', message: errorMessage(e, 'تعذّر إرسال الكتابة للقراءة.') });
    } finally {
      setBusy(false);
    }
  };

  const current = phase.kind === 'result' || phase.kind === 'error' ? (phase.kind === 'result' ? phase.rec : (phase.rec ?? null)) : null;

  const saveCorrection = async (text: string | null) => {
    if (!current) return;
    setBusy(true);
    try {
      const rec = await rapi.correct(current.id, text);
      setPhase({ kind: 'result', rec });
      setCorrection(rec.effective_text);
      setNotice(text === null ? 'أُعيدت القراءة الآلية.' : 'حُفظ تصحيحك؛ يظهر في البحث بوصفه نصًا كتبته بنفسك. الحبر لم يتغير.');
    } catch (e) {
      setNotice(errorMessage(e, 'تعذّر حفظ التصحيح؛ نصك ما زال في الحقل.'));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const rec = await rapi.retry(current.id);
      setPhase({ kind: 'reading', rec });
      void follow(rec.id);
    } catch (e) {
      setNotice(errorMessage(e, 'تعذّرت إعادة المحاولة.'));
    } finally {
      setBusy(false);
    }
  };

  const removeReading = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await rapi.remove(current.id);
      setPhase({ kind: 'idle' });
      setCorrection('');
      setNotice('حُذفت القراءة المشتقة وحدها؛ كتابتك باقية كما هي.');
    } catch (e) {
      setNotice(errorMessage(e, 'تعذّر حذف القراءة.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(correction);
      setNotice('نُسخ النص.');
    } catch {
      setNotice('تعذّر النسخ تلقائيًا؛ حدّد النص في الحقل وانسخه.');
    }
  };

  const prepareAsk = async () => {
    if (!target || !pageAnchor) return;
    setBusy(true);
    setNotice(null);
    try {
      const usable = current && (current.status === 'recognized' || current.corrected_text !== null) ? current : null;
      const ctx = await rapi.askContext({
        anchor: { type: 'page', source_id: pageAnchor.source_id, version_id: pageAnchor.version_id, page_id: pageAnchor.page_id, page_index: pageAnchor.page_index },
        bbox: target.bbox,
        recognition_id: usable?.id ?? null,
        typed_text: usable ? null : typed.trim() || null,
      });
      setQuestion(ctx.question_ar);
      setPhase({ kind: 'ask', ctx, rec: current });
    } catch (e) {
      setNotice(errorMessage(e, 'تعذّر تجهيز السؤال.'));
    } finally {
      setBusy(false);
    }
  };

  const handoff = () => {
    if (phase.kind !== 'ask' || !pageAnchor) return;
    onAsk({ anchor: phase.ctx.anchor, text: phase.ctx.paragraph?.text ?? '', question: question.trim(), pageIndex: pageAnchor.page_index });
    onClose();
  };

  if (!target) return null;
  const isAsk = target.mode === 'ask';
  const readDisabledReason = !recognition.available ? recognition.reason : !online ? 'قراءة الخط تحتاج اتصالًا بالخادم.' : pictureError;
  const title = isAsk ? 'اسأل عن المحدد' : 'تحويل الكتابة إلى نص';

  return (
    <Dialog open={!!target} onClose={onClose} title={title} size="md" description={isAsk ? 'كتابتك + الفقرة المجاورة → سؤال واضح في لوحة الدراسة. لا يُرسل شيء قبل أن ترسله أنت.' : 'قراءة مشتقة لكتابتك: لا تمحو الحبر ولا تغيّره، وتقبل التصحيح.'}>
      <div className="hw-dialog" dir="rtl">
        {phase.kind !== 'ask' && (
          <>
            <figure className="hw-picture">
              {picture ? (
                <img src={picture.dataUrl} alt="الكتابة المحددة كما تُرسل للقراءة (خطوطك وحدها بالأسود على الأبيض)" width={picture.width} height={picture.height} />
              ) : (
                <p className="hw-muted">{pictureError ?? 'جارٍ رسم الكتابة المحددة…'}</p>
              )}
              <figcaption className="hw-muted">تُرسل هذه الصورة وحدها (خطوطك المحددة فقط، دون الصفحة) إلى مزود الرؤية على الخادم عند ضغطك «اقرأ الخط».</figcaption>
            </figure>

            {(phase.kind === 'idle' || phase.kind === 'error') && !current && (
              <div className="hw-row">
                <SegmentedControl<RecognitionLang>
                  label="لغة الكتابة"
                  showLabel
                  options={RECOGNITION_LANGS.map((l) => ({ value: l, label: RECOGNITION_LANG_LABELS_AR[l] }))}
                  value={lang}
                  onValueChange={setLang}
                />
                <Button variant="primary" icon={<ScanText size={16} />} loading={busy} disabled={!!readDisabledReason || !picture} aria-describedby={readDisabledReason ? 'hw-read-why' : undefined} onClick={() => void read()}>
                  اقرأ الخط
                </Button>
                {readDisabledReason && (
                  <p id="hw-read-why" className="hw-reason" role="note">
                    {readDisabledReason}
                  </p>
                )}
              </div>
            )}

            {phase.kind === 'reading' && (
              <p className="hw-status" role="status" aria-live="polite">
                <Spinner size={14} /> {phase.rec?.status_label_ar ?? 'تُرسل الكتابة…'}
              </p>
            )}

            {phase.kind === 'error' && (
              <div className="hw-error" role="alert">
                <p>{phase.message}</p>
                {phase.rec && (phase.rec.status === 'failed' || phase.rec.status === 'unreadable') && (
                  <Button variant="secondary" icon={<RotateCcw size={16} />} loading={busy} disabled={!recognition.available || !online} onClick={() => void retry()}>
                    أعد المحاولة
                  </Button>
                )}
              </div>
            )}

            {current && phase.kind === 'result' && (
              <section className="hw-result" aria-labelledby="hw-result-h">
                <h3 id="hw-result-h" className="hw-subhead">
                  {current.status === 'unreadable' && current.corrected_text === null ? 'تعذّرت القراءة' : 'القراءة'}
                </h3>
                <StatusPill tone={current.origin === 'owner_corrected' ? 'accent' : 'info'} icon={<ScanText size={14} />}>
                  {current.origin === 'owner_corrected' ? 'صحّحته بنفسك' : 'مقروء آليًا'}
                </StatusPill>
                <p className="hw-muted">{current.origin_label_ar}</p>
                {current.status === 'unreadable' && current.error_ar && <p className="hw-reason">{current.error_ar}</p>}
                {current.origin === 'recognized' && <RecognizedLines lines={current.lines} />}
                {current.origin === 'recognized' && uncertainSummaryAr(current.uncertain_count) && <p className="hw-reason">{uncertainSummaryAr(current.uncertain_count)}</p>}
                <TextArea
                  label={current.status === 'unreadable' ? 'اكتب ما كتبته بخط يدك' : 'صحّح النص إن لزم'}
                  hint="يُحفظ تصحيحك بجانب القراءة الآلية (لا يمحوها) ويُستخدم في البحث والسؤال."
                  rows={3}
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
                  dir="auto"
                />
                <div className="hw-actions">
                  <Button
                    variant="secondary"
                    loading={busy}
                    disabled={!online || correction.trim() === current.effective_text.trim()}
                    onClick={() => void saveCorrection(correction.trim() ? correction : null)}
                  >
                    احفظ التصحيح
                  </Button>
                  {current.corrected_text !== null && (
                    <Button variant="plain" disabled={!online || busy} onClick={() => void saveCorrection(null)}>
                      أرجع القراءة الآلية
                    </Button>
                  )}
                  <Button variant="plain" icon={<Copy size={16} />} disabled={!correction.trim()} onClick={() => void copy()}>
                    انسخ النص
                  </Button>
                  <Button variant="plain" icon={<Trash2 size={16} />} disabled={!online || busy} onClick={() => void removeReading()}>
                    احذف القراءة
                  </Button>
                </div>
              </section>
            )}

            {isAsk && (
              <section className="hw-ask" aria-labelledby="hw-ask-h">
                <h3 id="hw-ask-h" className="hw-subhead">
                  السؤال عن الكتابة
                </h3>
                {!pageAnchor ? (
                  <p className="hw-reason">السؤال عن المحدد يعمل على صفحات المحاضرة (للفقرة المجاورة)؛ هذه صفحة ملاحظات.</p>
                ) : (
                  <>
                    {!(current && (current.status === 'recognized' || current.corrected_text !== null)) && (
                      <TextField_ typed={typed} setTyped={setTyped} recognitionAvailable={recognition.available} />
                    )}
                    <Button
                      variant="primary"
                      icon={<MessageCircleQuestion size={16} />}
                      loading={busy}
                      disabled={!online || phase.kind === 'reading' || (!(current && (current.status === 'recognized' || current.corrected_text !== null)) && !typed.trim())}
                      onClick={() => void prepareAsk()}
                    >
                      جهّز السؤال مع الفقرة المجاورة
                    </Button>
                  </>
                )}
              </section>
            )}
          </>
        )}

        {phase.kind === 'ask' && (
          <section className="hw-ask" aria-labelledby="hw-askq-h">
            <h3 id="hw-askq-h" className="hw-subhead">
              راجع السؤال
            </h3>
            {phase.ctx.paragraph ? (
              <blockquote className="hw-quote" dir="auto">
                {phase.ctx.paragraph.text.length > 400 ? `${phase.ctx.paragraph.text.slice(0, 400)}…` : phase.ctx.paragraph.text}
              </blockquote>
            ) : null}
            <TextArea label="سؤالك (يمكنك تعديله)" rows={5} value={question} onChange={(e) => setQuestion(e.target.value)} dir="auto" />
            {phase.ctx.notes_ar.map((n, i) => (
              <p key={i} className="hw-muted">
                {n}
              </p>
            ))}
            {!chat.available && (
              <p className="hw-reason" role="note">
                المحادثة: {chat.reason}
              </p>
            )}
            <div className="hw-actions">
              <Button variant="primary" icon={<MessageCircleQuestion size={16} />} disabled={!question.trim()} onClick={handoff}>
                ضع السؤال في لوحة الدراسة
              </Button>
              <Button variant="plain" onClick={() => setPhase(phase.rec ? { kind: 'result', rec: phase.rec } : { kind: 'idle' })}>
                رجوع
              </Button>
            </div>
          </section>
        )}

        {notice && (
          <p className="hw-muted" role="status" aria-live="polite">
            {notice}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function TextField_({ typed, setTyped, recognitionAvailable }: { typed: string; setTyped: (v: string) => void; recognitionAvailable: boolean }) {
  return (
    <TextArea
      label="ما الذي كتبته بخط يدك؟"
      hint={recognitionAvailable ? 'اقرأ الخط أولًا، أو اكتب ما كتبته هنا.' : 'قراءة الخط غير متاحة الآن؛ اكتب ما كتبته بنفسك.'}
      rows={2}
      value={typed}
      onChange={(e) => setTyped(e.target.value)}
      dir="auto"
    />
  );
}
