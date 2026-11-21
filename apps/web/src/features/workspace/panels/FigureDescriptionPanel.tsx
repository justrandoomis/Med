// Automatic figure descriptions in «المصادر» (image-heavy lectures: histology, gross specimens, radiology, graphs,
// clinical photos). The server describes every cropped figure / image-only page after processing — only with an AI
// key AND the owner's ai_processing consent — and stores a DERIVED description beside the picture (the picture and the
// page never change). Here the owner sees it under the figure, labelled «وصف آلي — راجعه», with an unconfirmed
// diagnosis marked «اقتراح — غير مؤكد»; confirms, corrects (the correction wins on every re-run) or rejects it; runs
// «صف كل الصور» with real progress; makes an image flashcard (one now, or drafts for the whole lecture to accept
// first) and asks for an image question (published only when the lecture text supports its answer).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookPlus, CheckCheck, Images, Layers, ListChecks, PencilLine, RefreshCw, X } from 'lucide-react';
import {
  FIGURE_DIAGNOSIS_BASIS_LABELS_AR,
  FIGURE_IMAGE_TYPE_LABELS_AR,
  FIGURE_OWNER_STATUS_LABELS_AR,
  type CardCreateResponse,
  type FigureDescribeRequest,
  type FigureDescriptionResponse,
  type FigureDescriptionReviewRequest,
  type FigureDescriptionRunView,
  type FigureDescriptionsResponse,
  type FigureDescriptionView,
  type FlashcardView,
  type GenerateQuestionsResponse,
} from '@medlevo/shared';
import { Button, Checkbox, ErrorState, ProgressBar, StatusPill, TextArea, TextField } from '../../../design';
import { api, errorMessage } from '../../../lib/api';

const enc = encodeURIComponent;
export const figuresApi = {
  list: (versionId: string) => api.get<FigureDescriptionsResponse>(`/processing/versions/${enc(versionId)}/figure-descriptions`),
  describe: (versionId: string, body: FigureDescribeRequest) => api.post<{ run: FigureDescriptionRunView }>(`/processing/versions/${enc(versionId)}/figure-descriptions/describe`, body, { timeoutMs: 30_000 }),
  review: (id: string, body: FigureDescriptionReviewRequest) => api.post<FigureDescriptionResponse>(`/processing/figure-descriptions/${enc(id)}/review`, body),
  cardFromFigure: (id: string, hideLabels: boolean) => api.post<CardCreateResponse>('/learning/cards/from-figure', { description_id: id, hide_labels: hideLabels }),
  cardsFromFigures: (versionId: string) => api.post<CardCreateResponse>('/learning/cards/from-figures', { version_id: versionId }),
  drafts: (versionId: string) => api.get<{ items: FlashcardView[] }>(`/learning/cards/figure-drafts?version_id=${enc(versionId)}`),
  decideDraft: (cardId: string, decision: 'accept' | 'discard') => api.post<{ card: FlashcardView }>(`/learning/cards/${enc(cardId)}/draft`, { decision }),
  question: (sourceId: string, descriptionId: string) =>
    api.post<GenerateQuestionsResponse>('/exams/generate', { lecture_source_id: sourceId, figure: { description_id: descriptionId }, count: 1, difficulty: 'medium', language: 'ar' }, { timeoutMs: 30_000 }),
};

const RUNNING = new Set(['queued', 'running']);

/** The descriptions of one lecture version (polls while a describe run is in progress). */
export function useFigureDescriptions(versionId: string | null, online: boolean) {
  const [data, setData] = useState<FigureDescriptionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const load = useCallback(() => {
    if (!versionId) return Promise.resolve();
    const poll = (): Promise<void> =>
      figuresApi
        .list(versionId)
        .then((r) => {
          setData(r);
          setError(null);
          window.clearTimeout(timer.current);
          if (r.run && RUNNING.has(r.run.status)) timer.current = window.setTimeout(() => void poll(), 2000);
        })
        .catch((e: unknown) => setError(errorMessage(e, 'تعذّر تحميل أوصاف الصور.')));
    return poll();
  }, [versionId]);
  useEffect(() => {
    if (!online || !versionId) return;
    void load();
    return () => window.clearTimeout(timer.current);
  }, [load, online, versionId]);
  const replace = (d: FigureDescriptionView) => setData((x) => (x ? { ...x, items: x.items.map((i) => (i.id === d.id ? d : i)) } : x));
  return { data, error, reload: load, replace };
}

// ───────── lecture bar: «صف كل الصور», progress, drafts ─────────
export function FigureDescribeBar({ versionId, data, error, reload, online }: { versionId: string; data: FigureDescriptionsResponse | null; error: string | null; reload: () => Promise<void>; online: boolean }) {
  const [busy, setBusy] = useState<'describe' | 'cards' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<FlashcardView[] | null>(null);
  const run = data?.run ?? null;
  const running = run ? RUNNING.has(run.status) : false;
  const can = data?.can_describe ?? { available: false, reason_ar: null, consent_required: false };
  const reasonId = `figdesc-why-${versionId}`;

  const describeAll = async () => {
    setBusy('describe');
    setActionError(null);
    try {
      await figuresApi.describe(versionId, { force: (data?.counts.described ?? 0) > 0 });
      await reload();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر طلب وصف الصور.'));
    } finally {
      setBusy(null);
    }
  };
  const loadDrafts = async () => setDrafts((await figuresApi.drafts(versionId)).items);
  const cardsAll = async () => {
    setBusy('cards');
    setActionError(null);
    try {
      const r = await figuresApi.cardsFromFigures(versionId);
      setNote(r.notes_ar.join(' ') || 'لا توجد صور موصوفة بلا بطاقة.');
      await loadDrafts();
      await reload();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر صنع البطاقات من الصور.'));
    } finally {
      setBusy(null);
    }
  };
  const decide = async (cardId: string, decision: 'accept' | 'discard') => {
    try {
      await figuresApi.decideDraft(cardId, decision);
      await loadDrafts();
      await reload();
    } catch (e) {
      setActionError(errorMessage(e, 'تعذّر حفظ قرارك في المسودة.'));
    }
  };

  if (!online) return <p className="wk-muted">أوصاف الصور تحتاج اتصالًا بالخادم.</p>;
  if (error) return <ErrorState inline message={error} onRetry={() => void reload()} />;
  if (!data) return null;
  if (data.candidates === 0) return null;
  return (
    <div className="wk-figread" role="group" aria-label="صور المحاضرة">
      <p className="wk-figread__label" role="note">
        {data.notice_ar}
      </p>
      <p className="wk-muted">{`${data.candidates} صورة في هذه النسخة؛ وُصف ${data.counts.described}، راجعتَ ${data.counts.reviewed}${data.counts.skipped ? `، لم تُرسل ${data.counts.skipped}` : ''}${data.counts.failed ? `، تعذّر ${data.counts.failed}` : ''}. الحد ${data.max_images} صورة للمحاضرة.`}</p>
      {run && (
        <div className="wk-figdesc__run" aria-live="polite">
          <StatusPill tone={running ? 'info' : run.status === 'completed' ? 'success' : run.status === 'failed' || run.status === 'skipped' ? 'danger' : 'warning'}>{run.status_label_ar}</StatusPill>
          {running && run.total > 0 && <ProgressBar value={run.done} max={run.total} label="تقدّم وصف الصور" valueText={`وُصفت ${run.done} من ${run.total}`} />}
          {running && run.total > 0 && <span className="wk-muted">{`وُصفت ${run.done} من ${run.total}`}</span>}
          {run.reason_ar && <p className="wk-muted">{run.reason_ar}</p>}
        </div>
      )}
      <div className="wk-rail-actions">
        <Button size="sm" variant="secondary" icon={<Images size={16} />} loading={busy === 'describe'} disabled={!can.available || running || !!busy} aria-describedby={!can.available ? reasonId : undefined} onClick={() => void describeAll()}>
          صف كل الصور
        </Button>
        <Button size="sm" variant="plain" icon={<Layers size={16} />} loading={busy === 'cards'} disabled={data.counts.described === 0 || !!busy} onClick={() => void cardsAll()}>
          بطاقات من كل صور المحاضرة
        </Button>
        {data.counts.draft_cards > 0 && drafts === null && (
          <Button size="sm" variant="plain" icon={<ListChecks size={16} />} onClick={() => void loadDrafts()}>
            {`راجع المسودات (${data.counts.draft_cards})`}
          </Button>
        )}
      </div>
      {!can.available && (
        <p id={reasonId} className="wk-muted" role="note">
          {can.reason_ar}
          {can.consent_required && (
            <>
              {' '}
              <Link to="/me/privacy">فعّل الموافقة من صفحة الخصوصية</Link>
            </>
          )}
        </p>
      )}
      {note && <p className="wk-muted">{note}</p>}
      {actionError && <ErrorState inline message={actionError} />}
      {drafts && drafts.length > 0 && (
        <ul className="wk-figread__list" aria-label="مسودات البطاقات من الصور">
          {drafts.map((c) => (
            <li key={c.id}>
              <bdi>{(c.back.paragraphs[1] ?? c.back.paragraphs[0])?.runs.map((r) => r.t).join('') ?? 'بطاقة من صورة'}</bdi>{' '}
              <Button size="sm" variant="plain" icon={<CheckCheck size={14} />} onClick={() => void decide(c.id, 'accept')}>
                اقبلها
              </Button>
              <Button size="sm" variant="plain" icon={<X size={14} />} onClick={() => void decide(c.id, 'discard')}>
                احذفها
              </Button>
            </li>
          ))}
        </ul>
      )}
      {drafts && drafts.length === 0 && <p className="wk-muted">لا توجد مسودات تنتظر مراجعتك.</p>}
    </div>
  );
}

// ───────── one picture ─────────
export function FigureDescriptionCard({ description, sourceId, canDescribe, onChanged, onRedescribe }: { description: FigureDescriptionView; sourceId: string; canDescribe: boolean; onChanged: (d: FigureDescriptionView) => void; onRedescribe: (id: string) => Promise<void> }) {
  const d = description;
  const c = d.content;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideLabels, setHideLabels] = useState(false);

  const act = async (key: string, fn: () => Promise<void>, fail: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, fail));
    } finally {
      setBusy(null);
    }
  };
  const review = (body: FigureDescriptionReviewRequest) => act(body.decision, async () => onChanged((await figuresApi.review(d.id, body)).description), 'تعذّر حفظ مراجعتك.');
  const makeCard = () =>
    act(
      'card',
      async () => {
        const r = await figuresApi.cardFromFigure(d.id, hideLabels);
        setNote(['صُنعت بطاقة من الصورة وأُضيفت إلى المراجعة.', ...r.notes_ar].join(' '));
      },
      'تعذّر صنع البطاقة.',
    );
  const makeQuestion = () =>
    act(
      'question',
      async () => {
        await figuresApi.question(sourceId, d.id);
        setNote('طُلب سؤال من الصورة. يُنشر في بنك الأسئلة فقط إذا كان نص المحاضرة أو وصف أكدته يدعم إجابته؛ وإلا يبقى في قائمة المراجعة.');
      },
      'تعذّر طلب سؤال من الصورة.',
    );

  return (
    <div className="wk-figread wk-figdesc" role="group" aria-label="وصف الصورة">
      <div className="ml-cluster">
        <StatusPill tone={d.owner_reviewed ? 'success' : d.owner_status === 'rejected' ? 'neutral' : 'warning'}>{d.owner_status ? FIGURE_OWNER_STATUS_LABELS_AR[d.owner_status] : d.label_ar}</StatusPill>
        {d.status !== 'described' && <span className="wk-muted">{d.status_label_ar}</span>}
      </div>
      {d.reason_ar && <p className="wk-muted">{d.reason_ar}</p>}
      {c && !editing && (
        <>
          {c.caption_ar && <p className="wk-figdesc__caption">{c.caption_ar}</p>}
          {c.caption_en && (
            <p className="wk-figdesc__caption" dir="ltr" lang="en">
              {c.caption_en}
            </p>
          )}
          <p className="wk-muted">
            {FIGURE_IMAGE_TYPE_LABELS_AR[c.image_type]}
            {c.stain ? ` · ${c.stain}` : ''}
            {c.magnification ? ` · ${c.magnification}` : ''}
          </p>
          {c.diagnosis && (
            <p>
              <span>التشخيص / الموضوع: </span>
              <bdi>{c.diagnosis.text}</bdi>{' '}
              <StatusPill tone={c.diagnosis.basis === 'suggestion' ? 'warning' : 'info'}>{FIGURE_DIAGNOSIS_BASIS_LABELS_AR[c.diagnosis.basis]}</StatusPill>
            </p>
          )}
          {c.findings.length > 0 && (
            <ul className="wk-figread__list" aria-label="الموجودات">
              {c.findings.map((f) => (
                <li key={f} dir="auto">
                  {f}
                </li>
              ))}
            </ul>
          )}
          {c.labels.length > 0 && (
            <ul className="wk-figread__list" aria-label="التسميات والأسهم المقروءة">
              {c.labels.map((l) => (
                <li key={l.text} dir="auto">
                  <bdi>{l.text}</bdi>
                  {l.points_to ? ` ← ${l.points_to}` : ''}
                </li>
              ))}
            </ul>
          )}
          {c.graph && <p className="wk-muted">{`المحور الأفقي: ${c.graph.x_axis ?? '—'} · العمودي: ${c.graph.y_axis ?? '—'} · الاتجاه: ${c.graph.trend ?? '—'}`}</p>}
        </>
      )}
      {editing && (
        <EditForm
          description={d}
          onCancel={() => setEditing(false)}
          onSave={async (content) => {
            await review({ decision: 'edit', content });
            setEditing(false);
          }}
        />
      )}
      {!editing && (
        <div className="wk-rail-actions">
          {c && !d.owner_reviewed && (
            <Button size="sm" variant="secondary" icon={<CheckCheck size={16} />} loading={busy === 'confirm'} disabled={!!busy} onClick={() => void review({ decision: 'confirm' })}>
              أكّد الوصف
            </Button>
          )}
          {(c || d.status !== 'pending') && (
            <Button size="sm" variant="plain" icon={<PencilLine size={16} />} disabled={!!busy} onClick={() => setEditing(true)}>
              صحّح الوصف
            </Button>
          )}
          {c && d.owner_status !== 'rejected' && (
            <Button size="sm" variant="plain" icon={<X size={16} />} loading={busy === 'reject'} disabled={!!busy} onClick={() => void review({ decision: 'reject' })}>
              ارفض الوصف
            </Button>
          )}
          {d.owner_status && (
            <Button size="sm" variant="plain" loading={busy === 'reset'} disabled={!!busy} onClick={() => void review({ decision: 'reset' })}>
              عُد إلى الوصف الآلي
            </Button>
          )}
          <Button size="sm" variant="plain" icon={<RefreshCw size={16} />} loading={busy === 'again'} disabled={!canDescribe || !!busy} onClick={() => void act('again', () => onRedescribe(d.id), 'تعذّر طلب إعادة الوصف.')}>
            أعد وصف هذه الصورة
          </Button>
        </div>
      )}
      {c && !editing && (
        <div className="wk-rail-actions">
          <Checkbox label="أخفِ التسميات والأسهم في وجه البطاقة" checked={hideLabels} onCheckedChange={setHideLabels} />
          <Button size="sm" variant="secondary" icon={<BookPlus size={16} />} loading={busy === 'card'} disabled={!!busy} onClick={() => void makeCard()}>
            اصنع بطاقة من الصورة
          </Button>
          <Button size="sm" variant="plain" loading={busy === 'question'} disabled={!!busy} onClick={() => void makeQuestion()}>
            سؤال من الصورة
          </Button>
        </div>
      )}
      {d.cards > 0 && <p className="wk-muted">{d.cards === 1 ? 'لهذه الصورة بطاقة واحدة.' : `لهذه الصورة ${d.cards} بطاقات.`}</p>}
      {note && (
        <p className="wk-muted" role="status">
          {note}
        </p>
      )}
      {error && <ErrorState inline message={error} />}
    </div>
  );
}

function EditForm({ description, onSave, onCancel }: { description: FigureDescriptionView; onSave: (content: NonNullable<FigureDescriptionReviewRequest['content']>) => Promise<void>; onCancel: () => void }) {
  const c = description.content ?? description.machine;
  const [captionAr, setCaptionAr] = useState(c?.caption_ar ?? '');
  const [captionEn, setCaptionEn] = useState(c?.caption_en ?? '');
  const [findings, setFindings] = useState((c?.findings ?? []).join('\n'));
  const [diagnosis, setDiagnosis] = useState(c?.diagnosis?.text ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="wk-figread__review"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSave({
          caption_ar: captionAr.trim(),
          caption_en: captionEn.trim(),
          findings: findings
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          diagnosis: diagnosis.trim() ? { text: diagnosis.trim() } : null,
        }).finally(() => setBusy(false));
      }}
    >
      <TextField label="التعليق بالعربية" value={captionAr} maxLength={400} onChange={(e) => setCaptionAr(e.target.value)} />
      <TextField label="التعليق بالإنجليزية" dir="ltr" value={captionEn} maxLength={400} onChange={(e) => setCaptionEn(e.target.value)} />
      <TextArea label="الموجودات (سطر لكل موجودة)" dir="auto" rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} />
      <TextField label="التشخيص أو الموضوع (اتركه فارغًا إن لم تكن متأكدًا)" dir="auto" value={diagnosis} maxLength={200} onChange={(e) => setDiagnosis(e.target.value)} />
      <div className="wk-rail-actions">
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={busy}>
          احفظ تصحيحي
        </Button>
        <Button size="sm" variant="plain" disabled={busy} onClick={onCancel}>
          إلغاء
        </Button>
      </div>
    </form>
  );
}
