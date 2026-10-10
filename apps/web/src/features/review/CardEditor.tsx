// /review/cards/new and /review/cards/:cardId — the card editor (§43): basic, cloze ({{c1::…}}, one card per index),
// image occlusion (masks drawn over the original picture), from a selection in the book (an exact evidence excerpt is
// created by the server), from a mistake (the server builds front/back from the question version and keeps its
// provenance). Editing keeps the review history; a stale edit is never written over another device's edit.
// Offline: the owner's own basic / cloze cards and edits are saved locally and synced later; what needs the server
// (evidence from a selection, a mistake, a picture) says so.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, CheckCircle2, CircleAlert, FileQuestion, History, PauseCircle, PlayCircle, RotateCcw, Save, SkipForward, Trash2, Wand2 } from 'lucide-react';
import {
  REVIEW_RATING_LABELS_AR,
  clozeIndexes,
  newId,
  richTextFromPlain,
  richTextToPlain,
  parseRichText,
  type CardCreateResponse,
  type CardDetailResponse,
  type FlashcardView,
  type RichText,
} from '@medlevo/shared';
import { liveQuery } from 'dexie';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, SegmentedControl, StatusPill, TextArea, TextField, buttonClass, useToast } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { formatDate, formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { regionsUnder } from '../studybook/model';
import { fetchRegions } from '../workspace/data/api';
import { learningApi } from './api';
import { CardEvidenceList, StateLabel, useCardImage } from './components/CardBits';
import { CardFace } from './components/CardFace';
import { FigurePicker, type PickedFigure } from './components/FigurePicker';
import { OcclusionEditor, type MaskDraft } from './components/OcclusionEditor';
import { useLearningSync, useLocalCards, useSrsConfig } from './local/hooks';
import { scheduleOf, tomorrowStart } from './local/queue';
import { createCardsLocal, deleteCardLocal, editCardLocal, hasPendingCardOps, putServerCards, setBuriedLocal, setSuspendedLocal, type LocalCardRow } from './local/store';
import { cardsAr } from './local/time';
import { cardUrl, replayUrl, questionUrl, safeBack, studyUrl } from './links';
import { clearSelectionDraft, readSelectionDraft, regionForQuote, type SelectionCardDraft } from './selectionDraft';
import './learning.css';

type Kind = 'basic' | 'cloze' | 'occlusion';
const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'basic', label: 'سؤال وجواب' },
  { value: 'cloze', label: 'إكمال فراغ' },
  { value: 'occlusion', label: 'إخفاء في صورة' },
];

const rich = (text: string): RichText => richTextFromPlain(text.replace(/\r\n/g, '\n'));
const plain = (v: unknown): string => richTextToPlain(parseRichText(v));

/** Wraps the textarea's selection as the next cloze {{cN::…}} (keyboard-friendly helper). */
function wrapCloze(el: HTMLTextAreaElement | null, value: string): { text: string; caret: number } | null {
  if (!el) return null;
  const s = el.selectionStart ?? 0;
  const e = el.selectionEnd ?? 0;
  if (e <= s) return null;
  const next = Math.max(0, ...clozeIndexes(value)) + 1;
  const inner = value.slice(s, e);
  const wrapped = `{{c${next}::${inner}}}`;
  return { text: value.slice(0, s) + wrapped + value.slice(e), caret: s + wrapped.length };
}

function previewRow(kind: 'basic' | 'cloze', front: string, back: string, clozeIndex: number | null): LocalCardRow {
  return { id: 'preview', kind, front: rich(front), back: rich(back), origin: 'owner', clozeIndex, updatedAt: 0, syncState: 'saved_locally' } as LocalCardRow;
}

function CreatedPanel({ res, back, onAnother }: { res: { cards: Array<Pick<FlashcardView, 'id'>>; created: boolean; notes_ar: string[]; duplicates: CardCreateResponse['duplicates']; offline?: boolean }; back: string | null; onAnother: () => void }) {
  return (
    <section className="lw-sheet lw-created" role="status" aria-live="polite">
      <h2 className="lw-sheet__title">
        <CheckCircle2 size={20} aria-hidden="true" /> {res.created ? `حُفظت ${cardsAr(res.cards.length)}` : 'كانت هذه البطاقة محفوظة من قبل'}
      </h2>
      <p className="lw-muted">{res.offline ? 'حُفظت على هذا الجهاز وتُزامَن عند عودة الاتصال.' : 'حُفظت على الخادم وعلى هذا الجهاز، وتعمل دون اتصال.'}</p>
      {res.notes_ar.map((n) => (
        <p key={n} className="lw-note" role="note">
          {n}
        </p>
      ))}
      {res.duplicates.length > 0 && (
        <div className="lw-note lw-note--warn" role="note">
          <p>قد تكون مكررة مع بطاقات موجودة (اقتراح فقط، لم يُدمج شيء):</p>
          <ul>
            {res.duplicates.map((d) => (
              <li key={`${d.card_a_id}-${d.card_b_id}`}>{d.reason_ar}</li>
            ))}
          </ul>
          <Link className="lw-link" to="/review/cards">
            راجع التكرارات من مكتبة البطاقات
          </Link>
        </div>
      )}
      <div className="ml-cluster">
        {back && (
          <Link to={back} className={buttonClass({ variant: 'primary' })}>
            <ArrowRight size={16} aria-hidden="true" />
            {back.startsWith('/study/') ? 'عُد إلى الكتاب' : 'رجوع'}
          </Link>
        )}
        <Button variant="secondary" onClick={onAnother}>
          بطاقة أخرى
        </Button>
        {res.cards[0] && (
          <Link to={cardUrl(res.cards[0].id)} className={buttonClass({ variant: 'plain' })}>
            افتح البطاقة
          </Link>
        )}
      </div>
    </section>
  );
}

// ───────── new card ─────────
function TextCardForm({ kind, draft, back }: { kind: 'basic' | 'cloze'; draft: SelectionCardDraft | null; back: string | null }) {
  const caps = useCapabilities();
  const toast = useToast();
  const [front, setFront] = useState(() => (kind === 'cloze' && draft ? draft.quote : ''));
  const [backText, setBackText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Parameters<typeof CreatedPanel>[0]['res'] | null>(null);
  const clientId = useRef(newId());
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const indexes = kind === 'cloze' ? clozeIndexes(front) : [];
  const flashcards = caps.feature('flashcards');
  const needsServer = !!draft;
  const offlineBlocked = needsServer && !caps.online;

  const validation =
    !front.trim()
      ? kind === 'cloze'
        ? 'اكتب النص وحدّد فيه فراغًا واحدًا على الأقل.'
        : 'اكتب السؤال (وجه البطاقة).'
      : kind === 'cloze' && indexes.length === 0
        ? 'لا يوجد فراغ بعد: حدّد كلمة في النص ثم اضغط «اجعل التحديد فراغًا».'
        : kind === 'basic' && !draft && !backText.trim()
          ? 'اكتب الجواب (ظهر البطاقة).'
          : null;

  const save = async () => {
    if (validation || saving) return;
    setSaving(true);
    setError(null);
    const db = getDb();
    try {
      if (draft) {
        let at: ReturnType<typeof regionForQuote> = null;
        try {
          const r = await fetchRegions(draft.page_id);
          at = regionForQuote(r.regions, regionsUnder(r.regions, draft.rects), draft.quote);
        } catch {
          at = null;
        }
        if (!at) throw new Error('تعذّر تحديد موضع النص المحدد في صفحة المصدر؛ أعد تحديد النص في الكتاب ثم حاول مرة أخرى.');
        const res = await learningApi.fromSelection({
          id: clientId.current,
          source_id: draft.source_id,
          version_id: draft.version_id,
          quote: draft.quote,
          region_id: at.region_id,
          start: at.start,
          end: at.end,
          kind,
          front,
          back: backText.trim() ? backText : null,
        });
        await putServerCards(db, res.cards);
        clearSelectionDraft();
        setDone({ ...res, notes_ar: [...(at.whole ? ['يمتد التحديد على أكثر من فقرة؛ رُبطت البطاقة بالفقرة الأولى كاملة دليلًا.'] : []), ...res.notes_ar] });
      } else if (caps.online) {
        const res = await learningApi.createCards({ id: clientId.current, kind, front, back: backText.trim() ? backText : null });
        await putServerCards(db, res.cards);
        setDone(res);
      } else {
        const rows = await createCardsLocal(db, { kind, front: rich(front), back: rich(backText) });
        setDone({ cards: rows, created: true, notes_ar: [], duplicates: [], offline: true });
      }
    } catch (e) {
      if (isApiError(e) && e.offline && !draft) {
        const rows = await createCardsLocal(db, { kind, front: rich(front), back: rich(backText) });
        setDone({ cards: rows, created: true, notes_ar: [], duplicates: [], offline: true });
      } else {
        setError(errorMessage(e, 'تعذّر حفظ البطاقة.'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (done)
    return (
      <CreatedPanel
        res={done}
        back={back}
        onAnother={() => {
          clientId.current = newId();
          setFront('');
          setBackText('');
          setDone(null);
          toast.show({ title: 'جاهز لبطاقة جديدة.', tone: 'info' });
        }}
      />
    );

  const pv = previewRow(kind, front, backText, indexes[0] ?? null);
  return (
    <form
      className="lw-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="lw-editor__fields">
        <TextArea
          ref={frontRef}
          label={kind === 'cloze' ? 'النص مع الفراغات' : 'السؤال (وجه البطاقة)'}
          hint={
            kind === 'cloze' ? (
              <>
                كل فراغ بالصيغة <bdi dir="ltr">{'{{c1::الجواب}}'}</bdi> أو <bdi dir="ltr">{'{{c1::الجواب::تلميح}}'}</bdi>. كل رقم يصبح بطاقة مستقلة.
              </>
            ) : (
              'سؤال واحد واضح يمكن استرجاع جوابه؛ تجنّب نسخ فقرة كاملة.'
            )
          }
          value={front}
          onChange={(e) => setFront(e.target.value)}
          rows={kind === 'cloze' ? 5 : 3}
          dir="auto"
        />
        {kind === 'cloze' && (
          <div className="ml-cluster">
            <Button
              size="sm"
              variant="secondary"
              icon={<Wand2 size={16} />}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const r = wrapCloze(frontRef.current, front);
                if (!r) {
                  toast.show({ title: 'حدّد كلمة أو عبارة في النص أولًا.', tone: 'info' });
                  return;
                }
                setFront(r.text);
                requestAnimationFrame(() => {
                  frontRef.current?.focus();
                  frontRef.current?.setSelectionRange(r.caret, r.caret);
                });
              }}
            >
              اجعل التحديد فراغًا
            </Button>
            <span className="lw-muted" aria-live="polite">
              {indexes.length ? `${cardsAr(indexes.length)}: ${indexes.map((i) => `c${i}`).join('، ')}` : 'لا فراغات بعد'}
            </span>
          </div>
        )}
        <TextArea
          label={kind === 'cloze' ? 'ملاحظة على الظهر (اختيارية)' : draft ? 'الجواب (ظهر البطاقة) — اختياري' : 'الجواب (ظهر البطاقة)'}
          hint={draft && kind === 'basic' ? 'إن تركته فارغًا يكون الجواب هو النص المحدد كما في المصدر، مع رابطه.' : undefined}
          value={backText}
          onChange={(e) => setBackText(e.target.value)}
          rows={3}
          dir="auto"
        />
        {validation && front.length > 0 && <p className="lw-muted">{validation}</p>}
        {error && <ErrorState inline message={error} onRetry={() => void save()} />}
        <div className="ml-cluster">
          <Button type="submit" variant="primary" icon={<Save size={16} />} loading={saving} disabled={!!validation || offlineBlocked || !flashcards.available}>
            احفظ البطاقة
          </Button>
          {offlineBlocked && <span className="lw-muted">ربط البطاقة بنص المصدر يحتاج اتصالًا (يُنشئ الخادم الاقتباس الدقيق ودليله).</span>}
          {!flashcards.available && flashcards.reason && <span className="lw-muted">{flashcards.reason}</span>}
          {!caps.online && !draft && <span className="lw-muted">دون اتصال: تُحفظ على هذا الجهاز وتُزامَن لاحقًا.</span>}
        </div>
      </div>
      <aside className="lw-editor__preview" aria-label="معاينة البطاقة">
        <h2 className="lw-sheet__subtitle">معاينة {kind === 'cloze' && indexes.length > 1 ? `(البطاقة c${indexes[0]})` : ''}</h2>
        {front.trim() ? (
          <div className="lw-card lw-card--preview">
            <CardFace card={pv} side="front" />
            <hr className="lw-card__rule" />
            {kind === 'basic' && !backText.trim() && draft ? <BidiText as="blockquote" className="lw-evidence__quote" text={draft.quote} /> : <CardFace card={pv} side="back" />}
          </div>
        ) : (
          <p className="lw-muted">تظهر المعاينة هنا كما ستراها في المراجعة.</p>
        )}
      </aside>
    </form>
  );
}

function OcclusionForm({ back, initialSourceId }: { back: string | null; initialSourceId: string | null }) {
  const caps = useCapabilities();
  const [picked, setPicked] = useState<PickedFigure | null>(null);
  const [masks, setMasks] = useState<MaskDraft[]>([]);
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CardCreateResponse | null>(null);
  const noteId = useRef(newId());
  useEffect(() => setMasks([]), [picked?.imageAssetId]);
  const unnamed = masks.filter((m) => !m.label.trim()).length;
  const validation = !picked ? 'اختر صورة من مصادرك.' : masks.length === 0 ? 'ارسم منطقة واحدة على الأقل لإخفائها.' : unnamed ? `اكتب اسم كل منطقة (${unnamed} بلا اسم).` : null;
  if (!caps.online) return <EmptyState title="بطاقات الصور تحتاج اتصالًا" description="اختيار الصورة من مصدرك وإنشاء البطاقات يتم على الخادم. بعد إنشائها تُراجع دون اتصال (احفظ صورها على هذا الجهاز من صفحة المراجعة)." headingLevel={2} />;
  if (done) return <CreatedPanel res={done} back={back} onAnother={() => { noteId.current = newId(); setPicked(null); setMasks([]); setDone(null); }} />;
  return (
    <div className="lw-editor lw-editor--occl">
      <div className="lw-editor__fields">
        <FigurePicker onPick={setPicked} initialSourceId={initialSourceId} />
        <TextField label="سؤال يظهر مع الصورة (اختياري)" placeholder="ما اسم الجزء المخفي في المنطقة المحددة؟" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} />
        <p className="lw-muted">كل منطقة تصبح بطاقة: تُخفى المناطق كلها ويُسأل عن واحدة. لا يظهر اسم المنطقة ولا اسم الملف في وجه البطاقة.</p>
        {validation && picked && <p className="lw-muted">{validation}</p>}
        {error && <ErrorState inline message={error} />}
        <Button
          variant="primary"
          icon={<Save size={16} />}
          loading={saving}
          disabled={!!validation}
          onClick={async () => {
            if (!picked || validation) return;
            setSaving(true);
            setError(null);
            try {
              const res = await learningApi.occlusion({ note_id: noteId.current, image_asset_id: picked.imageAssetId, masks: masks.map((m) => ({ id: m.id, box: m.box, label: m.label.trim() })), prompt: prompt.trim() || null });
              await putServerCards(getDb(), res.cards);
              setDone(res);
            } catch (e) {
              setError(errorMessage(e, 'تعذّر إنشاء بطاقات الصورة.'));
            } finally {
              setSaving(false);
            }
          }}
        >
          أنشئ {masks.length > 0 ? cardsAr(masks.length) : 'البطاقات'}
        </Button>
      </div>
      <div className="lw-editor__canvas">{picked ? <OcclusionEditor imageUrl={picked.imageUrl} masks={masks} onChange={setMasks} /> : <p className="lw-muted">تظهر الصورة هنا بعد اختيارها.</p>}</div>
    </div>
  );
}

function FromMistake({ attemptId, back }: { attemptId: string; back: string | null }) {
  const caps = useCapabilities();
  const [res, setRes] = useState<CardCreateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const id = useRef(newId());
  useEffect(() => {
    if (!caps.online) return;
    let cancelled = false;
    setError(null);
    void learningApi
      .fromMistake({ attempt_id: attemptId, id: id.current })
      .then(async (r) => {
        await putServerCards(getDb(), r.cards);
        if (!cancelled) setRes(r);
      })
      .catch((e) => !cancelled && setError(errorMessage(e, 'تعذّر إنشاء البطاقة من هذا الخطأ.')));
    return () => {
      cancelled = true;
    };
  }, [attemptId, caps.online, tick]);
  if (!caps.online) return <EmptyState title="البطاقة من خطأ تحتاج اتصالًا" description="يبني الخادم البطاقة من نسخة السؤال ومفتاحه وشرحه وأدلته. عُد إلى هذه الصفحة عند الاتصال." headingLevel={2} />;
  if (error) return <ErrorState message={error} onRetry={() => setTick((n) => n + 1)} />;
  if (!res) return <LoadingState stage="جارٍ بناء البطاقة من السؤال الذي أخطأت فيه…" />;
  const card = res.cards[0];
  return (
    <div className="lw-stack">
      <CreatedPanel res={res} back={back} onAnother={() => undefined} />
      {card && (
        <section className="lw-sheet" aria-label="البطاقة">
          <div className="lw-card lw-card--preview">
            <CardFace card={{ ...(card as unknown as LocalCardRow), clozeIndex: null }} side="front" />
            <hr className="lw-card__rule" />
            <CardFace card={{ ...(card as unknown as LocalCardRow), clozeIndex: null }} side="back" />
            <CardEvidenceList snapshots={card.evidence} />
          </div>
          <p className="lw-muted">{card.origin_label_ar}. الوجه والظهر مأخوذان من نسخة السؤال ومفتاحه كما هما؛ تستطيع تعديل الصياغة من صفحة البطاقة.</p>
        </section>
      )}
    </div>
  );
}

function NewCard() {
  const [params, setParams] = useSearchParams();
  const from = params.get('from');
  const back = params.get('back') ? safeBack(params.get('back'), '/review') : null;
  const draft = useMemo(() => (from === 'selection' ? readSelectionDraft() : null), [from]);
  const kind = (KIND_OPTIONS.some((k) => k.value === params.get('kind')) ? params.get('kind') : 'basic') as Kind;
  usePageTitle(from === 'mistake' ? 'بطاقة من خطأ' : 'بطاقة جديدة');

  if (from === 'mistake') {
    const attempt = params.get('attempt');
    return (
      <div className="ml-page lw-page">
        <header className="ml-page__header">
          <h1 className="ml-page__title">بطاقة من سؤال أخطأت فيه</h1>
          <p className="ml-page__lede">الوجه: السؤال وخياراته. الظهر: الإجابة ومصدرها وشرحها واختيارك — مع أدلتها.</p>
        </header>
        {attempt ? <FromMistake attemptId={attempt} back={back} /> : <ErrorState message="لم تُحدَّد المحاولة التي تُصنع منها البطاقة." />}
      </div>
    );
  }

  const options = draft ? KIND_OPTIONS.filter((k) => k.value !== 'occlusion') : KIND_OPTIONS;
  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">{draft ? 'بطاقة من نص حددته' : 'بطاقة جديدة'}</h1>
          <p className="ml-page__lede">بطاقة واحدة لفكرة واحدة يمكن استرجاعها — لا نسخ لكل جملة.</p>
        </div>
        {back && (
          <Link to={back} className={buttonClass({ variant: 'plain' })}>
            <ArrowRight size={16} aria-hidden="true" />
            رجوع
          </Link>
        )}
      </header>
      {from === 'selection' && !draft && <ErrorState inline message="لم يُعثر على النص المحدد (ربما أُعيد تحميل الصفحة في نافذة أخرى). حدّد النص في الكتاب مرة أخرى." />}
      {draft && (
        <section className="lw-sheet lw-quote" aria-label="النص المحدد">
          <p className="lw-quote__where">
            <BookOpen size={16} aria-hidden="true" /> <BidiText as="span" text={[draft.source_title, draft.page_label].filter(Boolean).join(' — ')} />
          </p>
          <BidiText as="blockquote" className="lw-evidence__quote" text={draft.quote} />
          <p className="lw-muted">سيُنشئ الخادم من هذا النص اقتباسًا دقيقًا من الصفحة ويربطه بالبطاقة دليلًا.</p>
        </section>
      )}
      <SegmentedControl<Kind>
        label="نوع البطاقة"
        options={options}
        value={kind}
        onValueChange={(v) => {
          const next = new URLSearchParams(params);
          next.set('kind', v);
          setParams(next, { replace: true });
        }}
      />
      <div className="lw-editor-wrap">
        {kind === 'occlusion' ? <OcclusionForm back={back} initialSourceId={params.get('source_id')} /> : <TextCardForm key={kind} kind={kind} draft={draft} back={back} />}
      </div>
    </div>
  );
}

// ───────── edit an existing card ─────────
function useCardRow(id: string): LocalCardRow | null | undefined {
  const [row, setRow] = useState<LocalCardRow | null | undefined>(undefined);
  useEffect(() => {
    const sub = liveQuery(() => getDb().flashcards.get(id)).subscribe({ next: (r) => setRow((r as LocalCardRow) ?? null), error: () => setRow(null) });
    return () => sub.unsubscribe();
  }, [id]);
  return row;
}

function EditCard({ cardId }: { cardId: string }) {
  usePageTitle('البطاقة');
  useLearningSync();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const back = safeBack(params.get('back'), '/review/cards');
  const caps = useCapabilities();
  const toast = useToast();
  const row = useCardRow(cardId);
  const cfg = useSrsConfig();
  const local = useLocalCards();
  const [detail, setDetail] = useState<CardDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [backText, setBackText] = useState<string | null>(null);
  const [mask, setMask] = useState<MaskDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const img = useCardImage(row && row.kind === 'image_occlusion' ? row : null);

  useEffect(() => {
    if (!caps.online) return;
    let cancelled = false;
    void learningApi
      .card(cardId)
      .then(async (d) => {
        await putServerCards(getDb(), [d.card]);
        if (!cancelled) setDetail(d);
      })
      .catch((e) => !cancelled && setDetailError(errorMessage(e, 'تعذّر تحميل البطاقة من الخادم.')));
    return () => {
      cancelled = true;
    };
  }, [cardId, caps.online]);

  // the form starts from the stored card (and follows it while untouched)
  useEffect(() => {
    if (!row) return;
    setFront((f) => (f === null ? plain(row.front) : f));
    setBackText((b) => (b === null ? plain(row.back) : b));
    if (row.kind === 'image_occlusion' && row.image) setMask((m) => m ?? row.image!.masks.map((x) => ({ id: x.id, box: { ...x.box }, label: x.label })));
  }, [row]);

  if (row === undefined) return <LoadingState stage="جارٍ فتح البطاقة…" />;
  if (row === null && !detail) {
    return (
      <div className="ml-page lw-page">
        {detailError ? <ErrorState message={detailError} /> : caps.online ? <LoadingState stage="جارٍ تحميل البطاقة…" /> : <ErrorState message="هذه البطاقة غير محفوظة على هذا الجهاز بعد، والخادم غير متاح الآن." />}
      </div>
    );
  }
  const card: LocalCardRow = row ?? ({} as LocalCardRow);
  if (!row) return <LoadingState stage="جارٍ حفظ البطاقة على هذا الجهاز…" />;

  const sched = cfg.config && cfg.parity?.ok ? scheduleOf({ params: cfg.config.params }, card, local.events.get(card.id), Date.now()) : null;
  const events = detail?.events ?? (local.events.get(card.id) ?? []).map((e) => ({ id: e.id, card_id: e.cardId, rating: e.rating, reviewed_at: e.reviewedAt, duration_ms: e.durationMs ?? null, device_id: null }));
  const frontChanged = front !== null && front !== plain(card.front);
  const backChanged = backText !== null && backText !== plain(card.back);
  const activeMaskId = card.image?.active_mask_id ?? null;
  const maskNow = mask?.find((m) => m.id === activeMaskId) ?? null;
  const maskStored = card.image?.masks.find((m) => m.id === activeMaskId) ?? null;
  const maskChanged = !!maskNow && !!maskStored && (maskNow.label !== maskStored.label || JSON.stringify(maskNow.box) !== JSON.stringify(maskStored.box));
  const dirty = frontChanged || backChanged || maskChanged;
  const deleted = !!card.deletedAt;
  const impacts = (detail?.card.impacts ?? card.impacts ?? []).filter((i) => i.active && i.resolved_at === null);
  const serverKnows = card.rev != null;

  const save = async () => {
    if (!dirty || saving) return;
    if (frontChanged && !front!.trim()) {
      setError('وجه البطاقة لا يكون فارغًا.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // a local change still on its way (e.g. a suspend made offline) → this edit joins it in the outbox, so the
      // server never sees an older full copy arriving after a newer direct edit
      const pending = await hasPendingCardOps(getDb(), card.id);
      if (caps.online && serverKnows && !pending) {
        const r = await learningApi.updateCard(card.id, {
          base_rev: card.rev!,
          ...(frontChanged ? { front: front! } : {}),
          ...(backChanged ? { back: backText! } : {}),
          ...(maskChanged && maskNow ? { mask: { id: maskNow.id, box: maskNow.box, label: maskNow.label.trim() } } : {}),
        });
        await putServerCards(getDb(), [r.card]);
        toast.show({ title: 'حُفظ التعديل. سجل المراجعات لم يتغير.', tone: 'success' });
        r.notes_ar.forEach((n) => toast.show({ title: n, tone: 'info' }));
      } else {
        if (maskChanged) throw new Error('تصحيح منطقة الصورة يحتاج اتصالًا.');
        await editCardLocal(getDb(), card, { front: frontChanged ? rich(front!) : parseRichText(card.front), back: backChanged ? rich(backText!) : parseRichText(card.back) });
        toast.show({ title: 'حُفظ التعديل على هذا الجهاز ويُزامَن لاحقًا. إن عُدّلت البطاقة على جهاز آخر يُحتفظ بالنسختين.', tone: 'success' });
      }
      setFront(null);
      setBackText(null);
      setMask(null);
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        const server = (e.details as { card?: FlashcardView } | null)?.card;
        if (server) await putServerCards(getDb(), [server]);
        setError('عُدّلت هذه البطاقة على جهاز آخر بعد أن فتحتها؛ لم يُكتب تعديلك فوقها. حُدّثت النسخة المعروضة — راجعها ثم أعد تعديلك. (نصك ما زال في الحقول.)');
      } else setError(errorMessage(e, 'تعذّر حفظ التعديل.'));
    } finally {
      setSaving(false);
    }
  };

  const resolve = async (resolution: 'keep' | 'relearn' | 'move_to_current_version') => {
    try {
      const r = await learningApi.resolveImpact(card.id, resolution);
      await putServerCards(getDb(), [r.card]);
      setDetail((d) => (d ? { ...d, card: r.card } : d));
      toast.show({ title: resolution === 'relearn' ? 'ستبدأ جدولة البطاقة من جديد؛ بقيت مراجعاتك السابقة في السجل.' : resolution === 'keep' ? 'أُبقيت البطاقة كما هي.' : 'أصبحت البطاقة تشير إلى النسخة الحالية من المصدر.', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر حفظ القرار.'), tone: 'danger' });
    }
  };

  const ref = card.originRef as { question_id?: string; question_attempt_id?: string } | null;
  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">{card.kindLabelAr ?? 'البطاقة'}</h1>
          <p className="ml-page__lede">{card.originLabelAr}</p>
        </div>
        <Link to={back} className={buttonClass({ variant: 'plain' })}>
          <ArrowRight size={16} aria-hidden="true" />
          رجوع
        </Link>
      </header>

      {deleted && (
        <div className="lw-note lw-note--warn" role="note">
          <span>حُذفت هذه البطاقة في {formatDate(card.deletedAt!)}. سجل مراجعاتها محفوظ.</span>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={16} />}
            disabled={!caps.online}
            onClick={async () => {
              try {
                const r = await learningApi.restoreCard(card.id);
                await putServerCards(getDb(), [r.card]);
                toast.show({ title: 'استُرجعت البطاقة.', tone: 'success' });
              } catch (e) {
                toast.show({ title: errorMessage(e, 'تعذّر الاسترجاع.'), tone: 'danger' });
              }
            }}
          >
            استرجعها
          </Button>
        </div>
      )}

      {impacts.map((i) => (
        <section key={`${i.kind}-${i.ref}`} className="lw-note lw-note--warn lw-impact" aria-label="تغيّر في مصدر البطاقة">
          <p>
            <CircleAlert size={16} aria-hidden="true" /> {i.reason_ar}
          </p>
          <p className="lw-muted">قرّر ما يحدث للبطاقة. لا يُحذف شيء من سجل مراجعاتك في أي خيار.</p>
          <div className="ml-cluster">
            <Button size="sm" variant="secondary" disabled={!caps.online} onClick={() => void resolve('keep')}>
              أبقها كما هي
            </Button>
            <Button size="sm" variant="secondary" disabled={!caps.online} onClick={() => void resolve('relearn')}>
              أعد تعلّمها من البداية
            </Button>
            {(i.kind === 'source_changed' || i.kind === 'newer_version') && (
              <Button size="sm" variant="secondary" disabled={!caps.online} onClick={() => void resolve('move_to_current_version')}>
                انقلها إلى النسخة الحالية
              </Button>
            )}
            <span className="lw-muted">أو عدّل نص البطاقة أدناه.</span>
          </div>
        </section>
      ))}

      <div className="lw-editor">
        <div className="lw-editor__fields">
          {card.kind === 'image_occlusion' ? (
            <>
              {img.url && mask ? <OcclusionEditor imageUrl={img.url} masks={mask} onChange={setMask} onlyMaskId={activeMaskId} disabled={deleted || !caps.online} /> : <p className="lw-muted">{img.reason_ar ?? 'جارٍ تحميل الصورة…'}</p>}
              {!caps.online && <p className="lw-muted">تصحيح المنطقة يحتاج اتصالًا.</p>}
              <TextArea label="السؤال المعروض مع الصورة" value={front ?? ''} onChange={(e) => setFront(e.target.value)} rows={2} disabled={deleted} dir="auto" />
            </>
          ) : (
            <>
              <TextArea
                label={card.kind === 'cloze' ? 'النص مع الفراغات' : 'الوجه'}
                hint={card.kind === 'cloze' ? 'تعديل النص يصل إلى كل بطاقات الفراغات نفسها؛ فراغ جديد يصبح بطاقة جديدة.' : undefined}
                value={front ?? ''}
                onChange={(e) => setFront(e.target.value)}
                rows={card.kind === 'mistake' ? 8 : 4}
                disabled={deleted}
                dir="auto"
              />
              <TextArea label={card.kind === 'cloze' ? 'ملاحظة على الظهر' : 'الظهر'} value={backText ?? ''} onChange={(e) => setBackText(e.target.value)} rows={card.kind === 'mistake' ? 8 : 4} disabled={deleted} dir="auto" />
            </>
          )}
          {error && <ErrorState inline message={error} />}
          <div className="ml-cluster">
            <Button variant="primary" icon={<Save size={16} />} loading={saving} disabled={!dirty || deleted} onClick={() => void save()}>
              احفظ التعديل
            </Button>
            {dirty && (
              <Button
                variant="plain"
                onClick={() => {
                  setFront(null);
                  setBackText(null);
                  setMask(null);
                }}
              >
                تراجع عن التغييرات
              </Button>
            )}
          </div>
          {(frontChanged || backChanged) && <p className="lw-muted">التعديل النصي يحفظ نصًا عاديًا؛ أدلة البطاقة تبقى مرتبطة بها كما هي.</p>}
        </div>

        <aside className="lw-editor__preview" aria-label="حالة البطاقة">
          <h2 className="lw-sheet__subtitle">الحالة والجدولة</h2>
          {sched ? (
            <div className="lw-stack-sm">
              <StateLabel state={sched.view.state} mastered={sched.mastered} />
              <p className="lw-muted">
                {sched.fold.eventCount === 0 ? 'لم تُراجع بعد.' : `الموعد التالي: ${formatDateTime(sched.view.due_at)} — ${sched.view.reps} مراجعة، ${sched.view.lapses} نسيان.`}
                {sched.view.retrievability !== null && ` احتمال التذكّر الآن (تقدير): ${Math.round(sched.view.retrievability * 100)}٪.`}
              </p>
            </div>
          ) : (
            <p className="lw-muted">{cfg.config ? 'لا يمكن حساب الجدولة على هذا الجهاز الآن.' : 'إعدادات الجدولة غير محفوظة على هذا الجهاز بعد.'}</p>
          )}
          {!deleted && (
            <div className="ml-cluster">
              <Button
                size="sm"
                variant="secondary"
                icon={card.suspended ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
                onClick={async () => {
                  await setSuspendedLocal(getDb(), card, !card.suspended);
                  toast.show({ title: card.suspended ? 'أُعيد تفعيل البطاقة.' : 'أُوقفت البطاقة؛ لا تظهر في المراجعة حتى تعيد تفعيلها.', tone: 'success' });
                }}
              >
                {card.suspended ? 'أعد تفعيلها' : 'أوقفها'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<SkipForward size={16} />}
                onClick={async () => {
                  const buried = card.buriedUntil != null && card.buriedUntil > Date.now();
                  await setBuriedLocal(getDb(), card, buried ? null : tomorrowStart(Date.now(), cfg.config?.timezone ?? 'Asia/Baghdad'));
                  toast.show({ title: buried ? 'أُلغي التأجيل.' : 'أُجّلت إلى يومك التالي.', tone: 'success' });
                }}
              >
                {card.buriedUntil != null && card.buriedUntil > Date.now() ? `ألغِ التأجيل (حتى ${formatDate(card.buriedUntil)})` : 'أجّلها إلى الغد'}
              </Button>
              <Button size="sm" variant="destructive" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
                احذف
              </Button>
            </div>
          )}

          <h2 className="lw-sheet__subtitle">المصادر</h2>
          <CardEvidenceList snapshots={detail?.card.evidence ?? card.evidence ?? []} hasSource={!!card.sourceId} />
          {card.sourceId && (
            <Link className="lw-link" to={studyUrl(card.sourceId, { versionId: card.sourceVersionId })}>
              <BookOpen size={16} aria-hidden="true" /> افتح المصدر
            </Link>
          )}
          {ref?.question_id && (
            <p className="ml-cluster">
              <Link className="lw-link" to={questionUrl(ref.question_id)}>
                <FileQuestion size={16} aria-hidden="true" /> السؤال في خزنة الأسئلة
              </Link>
              <Link className="lw-link" to={replayUrl(ref.question_id, ref.question_attempt_id)}>
                لماذا هذه الإجابة؟
              </Link>
            </p>
          )}

          <h2 className="lw-sheet__subtitle">
            <History size={16} aria-hidden="true" /> سجل المراجعات
          </h2>
          {events.length === 0 ? (
            <p className="lw-muted">لا مراجعات بعد.</p>
          ) : (
            <ol className="lw-history" reversed>
              {[...events]
                .sort((a, b) => b.reviewed_at - a.reviewed_at)
                .slice(0, 12)
                .map((e) => (
                  <li key={e.id}>
                    <span>{formatDateTime(e.reviewed_at)}</span> — <strong>{REVIEW_RATING_LABELS_AR[e.rating]}</strong>
                  </li>
                ))}
            </ol>
          )}
          <p className="lw-muted">السجل لا يُحذف ولا يُعدَّل: التعديل والحذف وإعادة التعلّم تحفظه كما هو.</p>
          {detail && detail.siblings.length > 0 && <p className="lw-muted">{`لهذه البطاقة ${cardsAr(detail.siblings.length)} أخرى من النص أو الصورة نفسها.`}</p>}
          {detailError && !detail && <p className="lw-muted">{detailError}</p>}
          {card.syncState !== 'synced' && <StatusPill tone="info">محفوظة على هذا الجهاز — تنتظر المزامنة</StatusPill>}
        </aside>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="حذف البطاقة؟"
        impact={<p>تُحذف البطاقة من المراجعة (حذف قابل للاسترجاع). يبقى سجل مراجعاتها محفوظًا تحت معرّفها، ويمكن استرجاعها من «المحذوفة» في مكتبة البطاقات.</p>}
        confirmLabel="احذف البطاقة"
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await deleteCardLocal(getDb(), card);
          setConfirmDelete(false);
          toast.show({ title: 'حُذفت البطاقة. سجلها محفوظ ويمكن استرجاعها.', tone: 'success' });
          navigate(back);
        }}
      />
    </div>
  );
}

export function CardEditor() {
  const { cardId } = useParams();
  return cardId ? <EditCard cardId={cardId} /> : <NewCard />;
}
