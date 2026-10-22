// «انشر شرحك» / «انشر إصدارًا جديدًا» (P1-T5 step 3; PRD AOS-2.8, 5.12 course-only, 5.27; ARCHITECTURE_DELTA §6.4).
// The author chooses their OWN layers on their copy of the lecture; the server copies what is in them NOW into an
// immutable version of the explanation (ink, highlights, shapes, text boxes, sticky notes — pictures, bookmarks and links
// stay in the author's vault). Published for the subject only: only its members can read it. The idempotency key is
// fixed for the dialog's life, so a retry after a lost answer returns the same publication instead of a second one.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send } from 'lucide-react';
import { itemsCountAr, LAYER_KIND_LABELS_AR, newId, PUBLICATION_MAX_LAYERS, type LayerView, type PublicationView } from '@medlevo/shared';
import { Button, Checkbox, Dialog, LoadingState, TextArea, TextField, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { typed } from '../../lib/typedText';
import { useOnline } from '../../lib/useOnline';
import { publicationsApi, publicationUrl } from './api';
import './publications.css';

/** The author's own layers (a followed copy's or a fork's layer is someone else's writing: never republished). */
const OWN_KINDS = new Set<LayerView['kind']>(['personal', 'explanation', 'answers']);

/** The author's writable layers with writing on them (plus `keep`: the layers a republish starts from, even if emptied). */
export function publishableLayers(layers: readonly LayerView[], keep: readonly string[] = []): LayerView[] {
  return layers.filter((l) => OWN_KINDS.has(l.kind) && l.access === 'write' && (l.item_count > 0 || keep.includes(l.id)));
}

export interface RepublishTarget {
  id: string;
  title: string;
  headVersionNo: number;
  /** the layers the head was taken from (preselected) */
  layerIds: string[];
}

export function PublishDialog({
  open,
  onClose,
  spaceId,
  lecture,
  sourceId,
  republish = null,
  onPublished,
}: {
  open: boolean;
  onClose: () => void;
  spaceId: string;
  lecture: { id: string; title: string };
  /** the author's copy of the lecture (its layers are offered) */
  sourceId: string;
  republish?: RepublishTarget | null;
  onPublished?: (v: PublicationView) => void;
}) {
  const online = useOnline();
  const navigate = useNavigate();
  const toast = useToast();
  const [key] = useState(() => newId());
  const [layers, setLayers] = useState<LayerView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(republish?.layerIds ?? []);
  const [startIds] = useState<string[] | null>(() => republish?.layerIds ?? null);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    publicationsApi
      .myLayers(sourceId)
      .then((r) => {
        if (cancelled) return;
        const own = publishableLayers(r.layers, startIds ?? []);
        setLayers(own);
        // a republish starts from the head's layers (those still there); a new explanation from the layers of kind «شرح»
        setChosen(startIds ? startIds.filter((id) => own.some((l) => l.id === id)) : own.filter((l) => l.kind === 'explanation').map((l) => l.id).slice(0, PUBLICATION_MAX_LAYERS));
      })
      .catch((e) => !cancelled && setLoadError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [sourceId, startIds]);

  const toggle = (id: string, on: boolean) => setChosen((c) => (on ? [...c.filter((x) => x !== id), id] : c.filter((x) => x !== id)));

  const submit = async () => {
    if (chosen.length === 0) {
      setError('اختر طبقة واحدة على الأقل لنشرها.');
      return;
    }
    if (!republish && !title.trim()) {
      setError('اكتب عنوانًا للشرح.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (republish) {
        const v = await publicationsApi.republish(spaceId, republish.id, { layer_ids: chosen, change_note: changeNote.trim() || null });
        toast.show(
          v.head_version_no === republish.headVersionNo
            ? { tone: 'info', title: `لا تغيير منذ الإصدار ${v.head_version_no}؛ لم يُنشر إصدار جديد.` }
            : { tone: 'success', title: `نُشر الإصدار ${v.head_version_no} من شرحك.` },
        );
        onPublished?.(v);
        onClose();
        return;
      }
      const v = await publicationsApi.publish(spaceId, { lecture_id: lecture.id, layer_ids: chosen, title: title.trim(), summary: summary.trim() || null, kind: 'explanation', visibility: 'course' }, key);
      toast.show({ tone: 'success', title: 'نُشر شرحك في المادة.', description: 'يراه أعضاء المادة وحدهم، وتستطيع سحبه متى شئت.' });
      onPublished?.(v);
      onClose();
      navigate(publicationUrl(spaceId, v.id));
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
      title={republish ? 'انشر إصدارًا جديدًا' : 'انشر شرحك'}
      description={republish ? `«${republish.title}» — الإصدار ${republish.headVersionNo + 1}` : `«${lecture.title}» — يراه أعضاء المادة وحدهم`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button icon={<Send size={18} />} onClick={submit} loading={busy} disabled={!online || !layers || layers.length === 0}>
            {republish ? 'انشر الإصدار' : 'انشر'}
          </Button>
        </>
      }
    >
      <div className="cp-sheet">
        {loadError ? (
          <p className="cp-sheet__error" role="alert">
            {loadError}
          </p>
        ) : !layers ? (
          <LoadingState stage="جارٍ قراءة طبقاتك…" />
        ) : layers.length === 0 ? (
          <p className="cp-sheet__line" role="status">
            لا توجد على نسختك من المحاضرة طبقة فيها كتابة لتنشرها. اكتب شرحك على المحاضرة أولًا، ثم عد إلى هنا.
          </p>
        ) : (
          <fieldset className="pb-choices">
            <legend className="pb-choices__legend">الطبقات التي تُنشر</legend>
            {layers.map((l) => (
              <Checkbox
                key={l.id}
                checked={chosen.includes(l.id)}
                onCheckedChange={(on) => toggle(l.id, on)}
                disabled={!chosen.includes(l.id) && chosen.length >= PUBLICATION_MAX_LAYERS}
                label={l.title}
                description={`${LAYER_KIND_LABELS_AR[l.kind]} · ${itemsCountAr(l.item_count)}`}
              />
            ))}
          </fieldset>
        )}
        {republish ? (
          <TextArea label="ما الذي تغيّر؟ (اختياري)" hint="يقرؤها من يتابع شرحك قبل أن يطبّق التحديث." value={changeNote} maxLength={1000} rows={3} onChange={typed(setChangeNote, true)} />
        ) : (
          <>
            <TextField label="عنوان الشرح" required value={title} maxLength={120} onChange={typed(setTitle)} />
            <TextArea label="ملخص (اختياري)" value={summary} maxLength={1000} rows={3} onChange={typed(setSummary, true)} />
          </>
        )}
        <p className="cp-sheet__line cp-sheet__line--muted">
          يُنشر ما في الطبقات المختارة الآن كإصدار ثابت: الحبر والتظليل والأشكال والنصوص والملاحظات اللاصقة. الصور والإشارات المرجعية والروابط تبقى
          عندك، وطبقاتك الأخرى لا تُنشر.
        </p>
        <p className="pb-banner" role="note">
          تذكير: لا تنشر اسم مريض أو صورته أو رقم ملفه أو أي شيء يدل عليه.
        </p>
        {!online && (
          <p className="cp-sheet__line cp-sheet__line--muted" role="status">
            أنت غير متصل: النشر يحتاج الخادم.
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
