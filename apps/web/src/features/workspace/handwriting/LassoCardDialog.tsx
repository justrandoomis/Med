// «اصنع بطاقة من المحدد» / «اكتب سؤالًا من المحدد» on a lasso selection (Round 7 — H3 item 4, §28/§29 «حوّل المحدد إلى
// بطاقة … أو سؤال»).
//  * Card «سؤال وجواب»: the front can be filled from an existing reading of exactly these strokes («تحويل إلى نص») —
//    a DERIVED reading, labelled so. Without a configured vision provider (requires_configuration), offline, or with no
//    reading yet, that control is disabled with its reason and the owner types the front; nothing is guessed. The card
//    is saved on this device first (works offline; synced later), origin «بطاقة كتبتها بنفسك».
//  * Card «إخفاء في صورة»: the server cuts the source-page area under the selection out of the source file itself
//    (POST /api/annotations/page-crops — the picture is the page, not the ink); the owner draws and names the masks
//    over it → image-occlusion cards (POST /api/learning/cards/occlusion). Needs a connection and a source page.
//  * Question: a question the OWNER writes (origin 'owner'; a key given here is the owner's key, never a source key),
//    saved in the Question Vault and linked to this lecture (POST /api/questions/quick-add). Needs a connection.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileQuestion, ImageIcon, Layers, ScanText, Scissors } from 'lucide-react';
import {
  newId,
  richTextFromPlain,
  type AnnotationAnchor,
  type CardCreateResponse,
  type InkRecognitionView,
  type NormBox,
  type OcclusionCreateRequest,
  type PageCropRequest,
  type PageCropResponse,
  type PageCropView,
  type QuickAddResponse,
  type QuickAddTextRequest,
} from '@medlevo/shared';
import { Button, Dialog, ErrorState, SegmentedControl, StatusPill, TextArea, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import { questionsApi } from '../../questions/api';
import { learningApi } from '../../review/api';
import { OcclusionEditor, type MaskDraft } from '../../review/components/OcclusionEditor';
import { cardUrl } from '../../review/links';
import { createCardsLocal, putServerCards } from '../../review/local/store';
import type { InkItem } from '../ink/model';
import { recognitionApi } from './api';
import { matchingRecognition, writingIds, type Gate } from './RecognitionDialog';
import './handwriting.css';
// the occlusion editor's own styles (lw-occl-editor…) live with the review screens; the reader needs them here too
import '../../review/learning.css';

export interface LassoTarget {
  mode: 'card' | 'question';
  targetKey: string;
  anchor: AnnotationAnchor;
  items: InkItem[];
  bbox: NormBox;
  /** page height / page width (for «تحويل إلى نص» when the owner reads the strokes first) */
  ar: number;
}

export interface LassoCardDeps {
  recognitions?: (q: { page_id?: string; note_page_id?: string }) => Promise<InkRecognitionView[]>;
  crop?: (req: PageCropRequest) => Promise<PageCropResponse>;
  occlusion?: (body: OcclusionCreateRequest) => Promise<CardCreateResponse>;
  quickAdd?: (body: QuickAddTextRequest) => Promise<QuickAddResponse>;
}

export interface LassoCardDialogProps {
  target: LassoTarget | null;
  onClose: () => void;
  recognition: Gate;
  online: boolean;
  /** «اقرأها الآن…»: open «تحويل إلى نص» for the same selection (the reading is made there, by the owner's click) */
  onReadFirst: () => void;
  deps?: LassoCardDeps;
}

export const OCCLUSION_NEEDS_SOURCE_AR = 'بطاقة الإخفاء تُصنع من صفحة مصدر؛ هذه صفحة ملاحظات — اصنع بطاقة «سؤال وجواب».';
export const OCCLUSION_NEEDS_SERVER_AR = 'قص الصورة من صفحة المصدر يتم على الخادم ويحتاج اتصالًا.';
export const QUESTION_NEEDS_SERVER_AR = 'حفظ السؤال في خزنة الأسئلة يتم على الخادم ويحتاج اتصالًا.';
export const NO_WRITING_TO_READ_AR = 'لا توجد كتابة بالقلم في التحديد تُقرأ؛ اكتب النص بنفسك.';

type CardKind = 'basic' | 'occlusion';
type Reading = { kind: 'idle' } | { kind: 'loading' } | { kind: 'none' } | { kind: 'found'; rec: InkRecognitionView };
type Done = { kind: 'card'; ids: string[]; offline: boolean; count: number } | { kind: 'question'; res: QuickAddResponse };

const usable = (r: InkRecognitionView) => r.status === 'recognized' || r.corrected_text !== null;

export function LassoCardDialog({ target, onClose, recognition, online, onReadFirst, deps = {} }: LassoCardDialogProps) {
  const ids = useMemo(() => (target ? writingIds(target.items) : []), [target]);
  const pageAnchor = target?.anchor.type === 'page' ? target.anchor : null;
  const [kind, setKind] = useState<CardKind>('basic');
  const [reading, setReading] = useState<Reading>({ kind: 'idle' });
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [questionText, setQuestionText] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [crop, setCrop] = useState<PageCropView | null>(null);
  const [masks, setMasks] = useState<MaskDraft[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const cropId = useRef(newId());
  const noteId = useRef(newId());

  // a new selection: start over (reset while rendering; `null` = not seen yet, so the first selection starts too) and
  // look for an earlier reading of exactly these strokes (the request runs in the effect below)
  const a = target?.anchor;
  const lookup = target && online && recognition.available && ids.length > 0 && a ? (a.type === 'page' ? { page_id: a.page_id } : a.type === 'note_page' ? { note_page_id: a.note_page_id } : null) : null;
  const [shown, setShown] = useState<{ target: typeof target } | null>(null);
  if (!shown || shown.target !== target) {
    setShown({ target });
    setKind('basic');
    setFront('');
    setBack('');
    setQuestionText('');
    setKeyLabel('');
    setCrop(null);
    setMasks([]);
    setPrompt('');
    setError(null);
    setDone(null);
    setReading(lookup ? { kind: 'loading' } : { kind: 'idle' });
  }
  useEffect(() => {
    cropId.current = newId();
    noteId.current = newId();
    if (!lookup) return;
    const q = lookup;
    let alive = true;
    (deps.recognitions ?? recognitionApi.list)(q)
      .then((list) => {
        if (!alive) return;
        const hit = matchingRecognition(list, ids);
        setReading(hit ? { kind: 'found', rec: hit } : { kind: 'none' });
      })
      .catch(() => alive && setReading({ kind: 'none' }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (!target) return null;
  const isQuestion = target.mode === 'question';
  const rec = reading.kind === 'found' ? reading.rec : null;
  const readText = rec && usable(rec) ? rec.effective_text.trim() : '';
  const fillReason =
    ids.length === 0
      ? NO_WRITING_TO_READ_AR
      : !recognition.available
        ? (recognition.reason ?? 'قراءة الخط غير متاحة الآن.')
        : !online
          ? 'قراءة الخط تحتاج اتصالًا بالخادم.'
          : reading.kind === 'loading' || reading.kind === 'idle'
            ? 'جارٍ البحث عن قراءة لهذه الكتابة…'
            : reading.kind === 'none'
              ? 'لم تُقرأ هذه الكتابة بعد.'
              : !readText
                ? `${rec!.status_label_ar}${rec!.error_ar ? `: ${rec!.error_ar}` : ''} — صحّحها أو أعد قراءتها من «تحويل إلى نص».`
                : null;
  const occlusionReason = !pageAnchor ? OCCLUSION_NEEDS_SOURCE_AR : !online ? OCCLUSION_NEEDS_SERVER_AR : null;

  const fillFrom = (set: (s: string) => void) => () => {
    if (readText) set(readText);
  };

  const saveCard = async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = await createCardsLocal(getDb(), {
        kind: 'basic',
        front: richTextFromPlain(front.trim()),
        back: richTextFromPlain(back.trim()),
        sourceId: pageAnchor?.source_id ?? null,
        sourceVersionId: pageAnchor?.version_id ?? null,
      });
      setDone({ kind: 'card', ids: rows.map((r) => r.id), offline: !online, count: rows.length });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ البطاقة على هذا الجهاز.'));
    } finally {
      setBusy(false);
    }
  };

  const cutPicture = async () => {
    if (!pageAnchor) return;
    setBusy(true);
    setError(null);
    try {
      const res = await (deps.crop ?? ((req: PageCropRequest) => api.post<PageCropResponse>('/annotations/page-crops', req, { timeoutMs: 90_000 })))({
        id: cropId.current,
        page_id: pageAnchor.page_id,
        bbox: target.bbox,
      });
      setCrop(res.crop);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر قص الصورة من صفحة المصدر.'));
    } finally {
      setBusy(false);
    }
  };

  const unnamed = masks.filter((m) => !m.label.trim()).length;
  const maskReason = masks.length === 0 ? 'ارسم منطقة واحدة على الأقل لإخفائها (أو «أضف منطقة»).' : unnamed ? `اكتب اسم كل منطقة (${unnamed} بلا اسم).` : null;

  const saveOcclusion = async () => {
    if (!crop || maskReason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await (deps.occlusion ?? learningApi.occlusion)({
        note_id: noteId.current,
        image_asset_id: crop.image_asset_id,
        masks: masks.map((m) => ({ id: m.id, box: m.box, label: m.label.trim() })),
        prompt: prompt.trim() || null,
      });
      await putServerCards(getDb(), res.cards);
      setDone({ kind: 'card', ids: res.cards.map((c) => c.id), offline: false, count: res.cards.length });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر إنشاء بطاقات الصورة.'));
    } finally {
      setBusy(false);
    }
  };

  const saveQuestion = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await (deps.quickAdd ?? questionsApi.quickAddText)({
        text: questionText.trim(),
        lecture_source_id: pageAnchor?.source_id ?? null,
        key_label: keyLabel.trim() || null,
      });
      setDone({ kind: 'question', res });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ السؤال؛ نصك ما زال في الحقل.'));
    } finally {
      setBusy(false);
    }
  };

  const readingBlock = (set: (s: string) => void, label: string) => (
    <section className="hw-lasso__reading" aria-label="الخط المقروء">
      <div className="hw-row">
        <Button variant="secondary" size="sm" icon={<ScanText size={16} />} disabled={!!fillReason} aria-describedby={fillReason ? 'hw-lasso-fill-why' : undefined} onClick={fillFrom(set)}>
          {label}
        </Button>
        {reading.kind === 'none' && recognition.available && online && ids.length > 0 && (
          <Button variant="plain" size="sm" onClick={onReadFirst}>
            اقرأها الآن…
          </Button>
        )}
      </div>
      {fillReason && (
        <p id="hw-lasso-fill-why" className="hw-reason" role="note">
          {fillReason}
        </p>
      )}
      {readText && (
        <p className="hw-muted">
          <StatusPill tone={rec!.origin === 'owner_corrected' ? 'accent' : 'info'} icon={<ScanText size={14} />}>
            {rec!.origin === 'owner_corrected' ? 'صحّحته بنفسك' : 'قراءة آلية مشتقة'}
          </StatusPill>{' '}
          <bdi dir="auto">«{readText.length > 160 ? `${readText.slice(0, 160)}…` : readText}»</bdi>
        </p>
      )}
    </section>
  );

  const title = isQuestion ? 'سؤال من المحدد' : 'بطاقة من المحدد';
  const description = isQuestion
    ? 'سؤال تكتبه بنفسك (مصدره: أنت) يُحفظ في خزنة الأسئلة ويُربط بهذه المحاضرة؛ المفتاح إن كتبته مفتاحك أنت لا مفتاح مصدر.'
    : 'بطاقة واحدة لفكرة واحدة. لا يتغير الحبر ولا الصفحة.';

  return (
    <Dialog open={!!target} onClose={onClose} title={title} description={description} size="md">
      <div className="hw-dialog hw-lasso" dir="rtl">
        {done ? (
          <section className="hw-lasso__done" role="status" aria-live="polite">
            {done.kind === 'card' ? (
              <>
                <p className="hw-subhead">{done.count > 1 ? `حُفظت ${done.count} بطاقات.` : 'حُفظت البطاقة.'}</p>
                <p className="hw-muted">{done.offline ? 'حُفظت على هذا الجهاز وتُزامَن عند عودة الاتصال.' : 'تظهر في مراجعتك القادمة.'}</p>
                {done.ids[0] && (
                  <Link className="hw-link" to={cardUrl(done.ids[0])}>
                    افتح البطاقة
                  </Link>
                )}
              </>
            ) : (
              <>
                <p className="hw-subhead">{done.res.message_ar}</p>
                {done.res.question_id && (
                  <Link className="hw-link" to={`/questions/${encodeURIComponent(done.res.question_id)}`}>
                    افتح السؤال
                  </Link>
                )}
              </>
            )}
            <div className="hw-actions">
              <Button variant="primary" onClick={onClose}>
                تم
              </Button>
            </div>
          </section>
        ) : isQuestion ? (
          <>
            {readingBlock(setQuestionText, 'املأ السؤال من الخط المقروء')}
            <TextArea
              label="نص السؤال وخياراته"
              hint="سطر للسؤال ثم سطر لكل خيار، مثل: A. … B. … (أو اترك الخيارات لسؤال قصير)."
              rows={6}
              dir="auto"
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
            />
            <TextField label="مفتاح الإجابة (اختياري)" hint="تسمية الخيار الصحيح كما تعرفه، مثل B." value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} maxLength={4} dir="ltr" />
            {!online && (
              <p className="hw-reason" role="note">
                {QUESTION_NEEDS_SERVER_AR}
              </p>
            )}
            {error && <ErrorState inline message={error} />}
            <div className="hw-actions">
              <Button variant="primary" icon={<FileQuestion size={16} />} loading={busy} disabled={!online || !questionText.trim()} onClick={() => void saveQuestion()}>
                احفظ السؤال في الخزنة
              </Button>
            </div>
          </>
        ) : (
          <>
            <SegmentedControl<CardKind>
              label="نوع البطاقة"
              showLabel
              value={kind}
              onValueChange={(k) => {
                setKind(k);
                setError(null);
              }}
              options={[
                { value: 'basic', label: 'سؤال وجواب' },
                { value: 'occlusion', label: 'إخفاء في صورة', disabled: !!occlusionReason },
              ]}
            />
            {occlusionReason && (
              <p className="hw-reason" role="note">
                «إخفاء في صورة»: {occlusionReason}
              </p>
            )}
            {kind === 'basic' ? (
              <>
                {readingBlock(setFront, 'املأ الوجه من الخط المقروء')}
                <TextArea label="وجه البطاقة" rows={3} dir="auto" value={front} onChange={(e) => setFront(e.target.value)} />
                <TextArea label="ظهر البطاقة" rows={3} dir="auto" value={back} onChange={(e) => setBack(e.target.value)} />
                {error && <ErrorState inline message={error} />}
                <div className="hw-actions">
                  <Button variant="primary" icon={<Layers size={16} />} loading={busy} disabled={!front.trim() || !back.trim()} onClick={() => void saveCard()}>
                    احفظ البطاقة
                  </Button>
                </div>
              </>
            ) : !crop ? (
              <>
                <p className="hw-muted">
                  تُقص من صفحة المصدر نفسها المنطقةُ التي تحيط بها الكتابة المحددة (دون كتابتك)، ثم ترسم فوقها المناطق التي تُخفى وتسمّي كل واحدة: كل منطقة بطاقة.
                </p>
                {error && <ErrorState inline message={error} />}
                <div className="hw-actions">
                  <Button variant="primary" icon={<Scissors size={16} />} loading={busy} onClick={() => void cutPicture()}>
                    اقطع الصورة من الصفحة
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="hw-muted">
                  <ImageIcon size={14} aria-hidden="true" /> صورة من الصفحة {crop.page_index + 1} في المصدر (<bdi dir="ltr">{crop.width}×{crop.height}</bdi> بكسل).
                </p>
                <div className="hw-lasso__occlusion">
                  <OcclusionEditor imageUrl={crop.url} masks={masks} onChange={setMasks} disabled={busy} />
                </div>
                <TextField label="سؤال يظهر مع الصورة (اختياري)" placeholder="ما اسم الجزء المخفي في المنطقة المحددة؟" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} />
                {maskReason && <p className="hw-muted">{maskReason}</p>}
                {error && <ErrorState inline message={error} />}
                <div className="hw-actions">
                  <Button variant="primary" icon={<Layers size={16} />} loading={busy} disabled={!!maskReason || !online} onClick={() => void saveOcclusion()}>
                    {masks.length > 1 ? `أنشئ ${masks.length} بطاقات` : 'أنشئ البطاقة'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
