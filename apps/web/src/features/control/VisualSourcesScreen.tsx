// المصادر البصرية المسموح بها (§32 «أنشئ سجلًا للمصادر البصرية التي أسمح بها», Round 7 H4): the owner's list of
// external sites an image may come from — name, domain (+ optional atlas path), the owner's licence note, enabled.
// An external picture is accepted as an example only from an ENABLED entry; fetching stays off unless the server
// allows it AND a provider exists (none in this version) — the screen says so plainly, never implying a search runs.
import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { VISUAL_SOURCE_KINDS, VISUAL_SOURCE_KIND_LABELS_AR, type VisualSourceKind, type VisualSourceListResponse, type VisualSourceView } from '@medlevo/shared';
import { Bidi, Button, ConfirmDialog, ErrorState, LoadingState, Select, StatusPill, Switch, TextArea, TextField, useToast } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { controlApi } from './api';
import { SectionHeader, useLoad } from './shared';

interface Draft {
  name: string;
  domain: string;
  path_prefix: string;
  kind: VisualSourceKind;
  licence_note: string;
}
const EMPTY: Draft = { name: '', domain: '', path_prefix: '', kind: 'atlas', licence_note: '' };
const KIND_OPTIONS = VISUAL_SOURCE_KINDS.map((k) => ({ value: k, label: VISUAL_SOURCE_KIND_LABELS_AR[k] }));

function place(v: VisualSourceView): string {
  return `${v.domain}${v.path_prefix ?? ''}`;
}

function draftOf(editing: VisualSourceView | null): Draft {
  return editing ? { name: editing.name, domain: editing.domain, path_prefix: editing.path_prefix ?? '', kind: editing.kind, licence_note: editing.licence_note ?? '' } : EMPTY;
}

function SourceForm({ editing, onSaved, onCancel }: { editing: VisualSourceView | null; onSaved: (v: VisualSourceView) => void; onCancel: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>(() => draftOf(editing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // another row to edit (or none) starts the form over (adjusted while rendering instead of in an effect)
  const [formFor, setFormFor] = useState(editing);
  if (formFor !== editing) {
    setFormFor(editing);
    setErrors({});
    setFormError(null);
    setDraft(draftOf(editing));
  }
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError(null);
    const body = { name: draft.name, domain: draft.domain, path_prefix: draft.path_prefix.trim() || null, kind: draft.kind, licence_note: draft.licence_note.trim() || null };
    try {
      const r = editing ? await controlApi.patchVisualSource(editing.id, body) : await controlApi.addVisualSource(body);
      toast.show({ title: editing ? 'حُفظ التعديل.' : `أُضيف «${r.item.name}» إلى المصادر المسموح بها.`, tone: 'success' });
      if (!editing) setDraft(EMPTY);
      onSaved(r.item);
    } catch (err) {
      const f = fieldErrors(err);
      setErrors(f);
      if (Object.keys(f).length === 0) setFormError(errorMessage(err, 'تعذّر الحفظ.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cc-vs-form" onSubmit={(e) => void submit(e)} aria-labelledby="cc-vs-form-h" noValidate>
      <h2 id="cc-vs-form-h" className="cc-block__title">
        {editing ? `تعديل «${editing.name}»` : 'أضف مصدرًا بصريًا'}
      </h2>
      <TextField label="الاسم" value={draft.name} onChange={(e) => set('name')(e.target.value)} error={errors.name} required maxLength={120} />
      <TextField
        label="النطاق"
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="example.org"
        value={draft.domain}
        onChange={(e) => set('domain')(e.target.value)}
        error={errors.domain}
        hint="اسم الموقع فقط، أو رابط صفحة الأطلس. النطاقات الفرعية منه مشمولة."
        required
      />
      <TextField
        label="مسار الأطلس (اختياري)"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        placeholder="/cases/"
        value={draft.path_prefix}
        onChange={(e) => set('path_prefix')(e.target.value)}
        error={errors.path_prefix}
        hint="يحصر القبول في قسم واحد من الموقع."
      />
      <Select label="النوع" options={KIND_OPTIONS} value={draft.kind} onValueChange={(v) => set('kind')(v)} />
      <TextArea
        label="ملاحظة الترخيص"
        rows={2}
        value={draft.licence_note}
        onChange={(e) => set('licence_note')(e.target.value)}
        error={errors.licence_note}
        hint="شروط استخدام الصور كما قرأتها (مثل CC BY-NC). للتذكير فقط؛ لا يتحقق منها MedLevo."
        maxLength={1000}
      />
      {formError && (
        <p className="cc-vs-error" role="alert">
          {formError}
        </p>
      )}
      <div className="cc-vs-actions">
        <Button type="submit" variant="primary" icon={editing ? undefined : <Plus size={16} />} loading={busy}>
          {editing ? 'احفظ التعديل' : 'أضف'}
        </Button>
        {editing && (
          <Button type="button" variant="plain" onClick={onCancel}>
            إلغاء
          </Button>
        )}
      </div>
    </form>
  );
}

export function VisualSourcesScreen() {
  const toast = useToast();
  const data = useLoad<VisualSourceListResponse>(() => controlApi.visualSources(), []);
  const d = data.data;
  const [editing, setEditing] = useState<VisualSourceView | null>(null);
  const [removing, setRemoving] = useState<VisualSourceView | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const replace = (v: VisualSourceView) => {
    if (!d) return;
    const exists = d.items.some((i) => i.id === v.id);
    data.setData({ ...d, items: exists ? d.items.map((i) => (i.id === v.id ? v : i)) : [...d.items, v] });
  };
  const toggle = async (v: VisualSourceView, enabled: boolean) => {
    setToggling(v.id);
    try {
      replace((await controlApi.patchVisualSource(v.id, { enabled })).item);
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر تغيير الحالة.'), tone: 'danger' });
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="cc-section">
      <SectionHeader
        title="المصادر البصرية المسموح بها"
        lede="المواقع التي تقبل منها صورًا خارجية مثالًا لما تدرسه. صور مصادرك تأتي أولًا دائمًا؛ وصورة خارجية من موقع غير مفعّل هنا لا تُقبل."
      />
      {data.error ? (
        <ErrorState inline message={data.error} onRetry={data.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ تحميل المصادر البصرية…" />
      ) : (
        <>
          <section className="cc-block" aria-labelledby="cc-vs-fetch-h">
            <h2 id="cc-vs-fetch-h" className="cc-block__title">
              الجلب من الإنترنت
            </h2>
            <p>
              <StatusPill tone={d.fetch.state === 'disabled' ? 'neutral' : 'warning'}>{d.fetch.state === 'disabled' ? 'معطّل على الخادم' : 'لا يوجد مزود صور'}</StatusPill>
            </p>
            <p className="cc-muted">{d.fetch.reason_ar}</p>
          </section>

          <section className="cc-block" aria-labelledby="cc-vs-list-h">
            <h2 id="cc-vs-list-h" className="cc-block__title">
              السجل
            </h2>
            {d.items.length === 0 ? (
              <p className="cc-muted">لا مصادر بصرية في سجلك بعد، فلا تُقبل أي صورة خارجية. أضف أول مصدر من النموذج أدناه.</p>
            ) : (
              <ul role="list" className="cc-vs-list">
                {d.items.map((v) => (
                  <li key={v.id} className="cc-vs-item">
                    <div className="cc-vs-item__head">
                      <h3 className="cc-vs-item__name">{v.name}</h3>
                      <StatusPill tone={v.enabled ? 'success' : 'neutral'}>{v.enabled ? 'مفعّل' : 'معطّل'}</StatusPill>
                    </div>
                    <p className="cc-muted">
                      {v.kind_label_ar} · <Bidi dir="ltr">{place(v)}</Bidi>
                    </p>
                    {v.licence_note && <p className="cc-muted">الترخيص (ملاحظتك): {v.licence_note}</p>}
                    <Switch
                      checked={v.enabled}
                      disabled={toggling === v.id}
                      onCheckedChange={(on) => void toggle(v, on)}
                      label="يُقبل منه"
                      description={v.enabled ? 'الصور الخارجية من هذا الموقع تمر ببقية فحوص المطابقة.' : 'لا تُقبل منه صورة حتى تفعّله.'}
                    />
                    <div className="cc-vs-actions">
                      <Button size="sm" variant="plain" icon={<Pencil size={16} />} onClick={() => setEditing(v)} aria-label={`عدّل «${v.name}»`}>
                        عدّل
                      </Button>
                      <Button size="sm" variant="plain" icon={<Trash2 size={16} />} onClick={() => setRemoving(v)} aria-label={`احذف «${v.name}»`}>
                        احذف
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cc-block">
            <SourceForm
              editing={editing}
              onSaved={(v) => {
                replace(v);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          </section>

          <ul className="cc-notes">
            {d.notes_ar.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={!!removing}
        title={removing ? `حذف «${removing.name}» من السجل؟` : ''}
        impact="لن تُقبل بعد الآن صور خارجية من هذا الموقع. لا تُحذف أي صورة من مصادرك. يمكنك تعطيله بدل حذفه."
        confirmLabel="احذف من السجل"
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing || !d) return;
          await controlApi.deleteVisualSource(removing.id);
          data.setData({ ...d, items: d.items.filter((i) => i.id !== removing.id) });
          if (editing?.id === removing.id) setEditing(null);
          setRemoving(null);
        }}
      />
    </div>
  );
}
