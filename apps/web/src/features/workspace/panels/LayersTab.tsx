// «الطبقات» in the page panel (Academic OS P1-T2; PRD AOS-1.1, 1.4, 1.6, 1.9, 1.10, 4.15): the document's authorship
// layers. Per layer: show / hide in this study session, «اكتب هنا» (the layer new writing goes to) for layers the owner
// can write, read-only and locked badges, where a followed layer came from, and a menu — rename, lock, «سجل الطبقة»
// (read-only history), «انسخ الطبقة…» (preview first, then copy) and delete (an empty own layer only).
// Showing, hiding, creating, renaming and locking never wait for the network; history and copy need it and say so.
import { useEffect, useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, History, Lock, LockOpen, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { CLIENT_LAYER_KINDS, LAYER_KIND_LABELS_AR, LAYER_REASONS_AR, layerTitleSchema, type ClientLayerKind, type CopyLayersRequest, type CopyLayersResponse, type LayerHistoryEntry } from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, IconButton, LoadingState, Menu, MenuItem, MenuSeparator, Select, TextField, cx, useToast } from '../../../design';
import { errorMessage, OFFLINE_MESSAGE_AR } from '../../../lib/api';
import { getDb } from '../../../lib/localdb';
import { formatDateTime } from '../../../lib/time';
import { fetchRecentSessions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { COPY_KIND_LABELS_AR, copyLayer, fetchLayerHistory } from '../ink/layers/api';
import { useLayerViewContext } from '../ink/layers/LayerViewProvider';
import { canWriteTo, layerKindLabelAr, type LayerInfo } from '../ink/layers/model';
import { countLayerItems, createLayer, deleteLayer, updateLayer, useLayerItemCounts } from '../ink/layers/repo';
import '../ink/layers/layers.css';

const ONLINE_ONLY_AR = 'يحتاج اتصالًا بالخادم.';

export interface LayersTabProps {
  doc: SourceDocument;
  /** target keys of the document's pages (`source_page:<id>`), for the item counts */
  pageKeys: readonly string[];
  online: boolean;
}

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; layer: LayerInfo }
  | { kind: 'delete'; layer: LayerInfo }
  | { kind: 'history'; layer: LayerInfo }
  | { kind: 'copy'; layer: LayerInfo }
  | null;

export function LayersTab({ doc, pageKeys, online }: LayersTabProps) {
  const view = useLayerViewContext();
  const toast = useToast();
  const counts = useLayerItemCounts(view?.documentKey ?? null, pageKeys);
  const [dialog, setDialog] = useState<DialogState>(null);
  if (!view) return null;
  const { layers, hidden, activeId, documentKey } = view;
  const fail = (e: unknown) => toast.show({ title: errorMessage(e, 'تعذّر حفظ التغيير على هذا الجهاز.'), tone: 'danger' });

  return (
    <section className="ml-layers" aria-label="طبقات هذا المستند">
      <p className="wk-muted ml-layers__intro">كل طبقة كتابة لها صاحب. أخفِ طبقة في هذه الجلسة، أو اختر الطبقة التي تكتب عليها.</p>
      <ul className="ml-layers__list" role="list">
        {layers.map((l) => {
          const visible = !hidden.has(l.id);
          const writable = canWriteTo(l);
          const own = l.access === 'write';
          const count = counts.get(l.id) ?? 0;
          return (
            <li key={l.id} className={cx('ml-layer', !visible && 'ml-layer--hidden', l.id === activeId && 'ml-layer--active')} data-layer-id={l.id} data-layer-access={l.access}>
              <IconButton
                className="ml-layer__eye"
                label={visible ? `أخفِ طبقة «${l.title}» في هذه الجلسة` : `أظهر طبقة «${l.title}»`}
                pressed={visible}
                icon={visible ? <Eye size={18} /> : <EyeOff size={18} />}
                onClick={() => view.setVisible(l.id, !visible)}
              />
              <div className="ml-layer__main">
                <span className="ml-layer__title">
                  <bdi>{l.title}</bdi>
                </span>
                <span className="ml-layer__meta">
                  {layerKindLabelAr(l)} · {count} {count === 1 ? 'عنصر' : 'عناصر'}
                  {!visible && ' · مخفية'}
                </span>
                {(l.access !== 'write' || l.locked || l.originLabel) && (
                  <span className="ml-layer__badges">
                    {l.access !== 'write' && <span className="ml-layer__badge">للقراءة فقط</span>}
                    {l.locked && (
                      <span className="ml-layer__badge">
                        <Lock size={12} aria-hidden="true" /> مقفلة
                      </span>
                    )}
                    {l.originLabel && <span className="ml-layer__origin">{l.originLabel}</span>}
                  </span>
                )}
              </div>
              {writable ? (
                <label className="ml-layer__active">
                  <input type="radio" name={`ml-active-layer-${documentKey}`} checked={l.id === activeId} onChange={() => view.setActive(l.id)} aria-label={`اكتب في طبقة «${l.title}»`} />
                  <span aria-hidden="true">اكتب هنا</span>
                </label>
              ) : (
                <span className="ml-layer__active ml-layer__active--off" title={l.locked ? 'افتح قفل الطبقة لتكتب فيها.' : LAYER_REASONS_AR.layer_read_only}>
                  {l.locked ? 'مقفلة' : 'للقراءة'}
                </span>
              )}
              <Menu label={`خيارات طبقة «${l.title}»`} align="end" trigger={<IconButton label={`خيارات طبقة «${l.title}»`} icon={<MoreVertical size={18} />} />}>
                {own && (
                  <MenuItem icon={<Pencil size={16} />} onSelect={() => setDialog({ kind: 'rename', layer: l })}>
                    أعد التسمية…
                  </MenuItem>
                )}
                {own && (
                  <MenuItem
                    icon={l.locked ? <LockOpen size={16} /> : <Lock size={16} />}
                    hint={l.locked ? undefined : 'لا يُكتب فيها ولا يُمحى منها حتى تفتحها'}
                    onSelect={() =>
                      void updateLayer(getDb(), l, { locked: !l.locked })
                        .then(() => {
                          if (!l.locked && l.id === activeId) view.setActive(layers[0]!.id);
                        })
                        .catch(fail)
                    }
                  >
                    {l.locked ? 'افتح قفل الطبقة' : 'اقفل الطبقة'}
                  </MenuItem>
                )}
                <MenuItem icon={<History size={16} />} disabled={!online} disabledReason={ONLINE_ONLY_AR} onSelect={() => setDialog({ kind: 'history', layer: l })}>
                  سجل الطبقة
                </MenuItem>
                <MenuItem icon={<Copy size={16} />} disabled={!online || count === 0} disabledReason={!online ? ONLINE_ONLY_AR : 'لا عناصر في هذه الطبقة.'} onSelect={() => setDialog({ kind: 'copy', layer: l })}>
                  انسخ الطبقة…
                </MenuItem>
                {own && !l.isDefault && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 size={16} />}
                      destructive
                      disabled={count > 0}
                      disabledReason={LAYER_REASONS_AR.layer_not_empty}
                      onSelect={() =>
                        // (P1-T2 review) the counts above cover the pages in view; items on other versions or note pages
                        // of this document keep the layer too (the server would refuse the delete)
                        void countLayerItems(getDb(), l.id)
                          .then((n) => (n > 0 ? toast.show({ title: `${LAYER_REASONS_AR.layer_not_empty} (${n} ${n === 1 ? 'عنصر' : 'عناصر'} في صفحات أخرى من المستند)`, tone: 'warning' }) : setDialog({ kind: 'delete', layer: l })))
                          .catch(fail)
                      }
                    >
                      احذف الطبقة
                    </MenuItem>
                  </>
                )}
              </Menu>
            </li>
          );
        })}
      </ul>
      <Button icon={<Plus size={16} />} size="lg" onClick={() => setDialog({ kind: 'create' })} fullWidth>
        طبقة جديدة
      </Button>

      {dialog?.kind === 'create' && (
        <LayerTitleDialog
          title="طبقة جديدة"
          description="تُنشأ على هذا الجهاز فورًا وتُزامَن لاحقًا. ما تكتبه بعد ذلك يذهب إليها حتى تختار غيرها."
          initial=""
          withKind
          confirmLabel="أنشئ الطبقة"
          onClose={() => setDialog(null)}
          onSubmit={async (title, kind) => {
            const row = await createLayer(getDb(), { documentKey, title, kind: kind ?? 'personal' });
            view.setActive(row.id);
            toast.show({ title: `أُنشئت طبقة «${row.title}» وصارت الكتابة إليها.`, tone: 'success' });
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <LayerTitleDialog
          title="أعد تسمية الطبقة"
          initial={dialog.layer.title}
          confirmLabel="احفظ"
          onClose={() => setDialog(null)}
          onSubmit={async (title) => {
            await updateLayer(getDb(), dialog.layer, { title });
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          title={`احذف طبقة «${dialog.layer.title}»؟`}
          impact="الطبقة فارغة؛ لا يُحذف أي عنصر. تبقى قابلة للاسترجاع من نسخة احتياطية."
          confirmLabel="احذف الطبقة"
          cancelLabel="إلغاء"
          destructive
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const l = dialog.layer;
            setDialog(null);
            if (l.id === activeId) view.setActive(layers[0]!.id);
            void deleteLayer(getDb(), l).catch(fail);
          }}
        />
      )}
      {dialog?.kind === 'history' && <LayerHistoryDialog layer={dialog.layer} documentKey={documentKey} online={online} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'copy' && <LayerCopyDialog layer={dialog.layer} documentKey={documentKey} layers={layers} doc={doc} online={online} onClose={() => setDialog(null)} />}
    </section>
  );
}

// ───────────────────────────── create / rename ─────────────────────────────
function LayerTitleDialog(p: { title: string; description?: string; initial: string; withKind?: boolean; confirmLabel: string; onClose: () => void; onSubmit: (title: string, kind?: ClientLayerKind) => Promise<void> }) {
  const [value, setValue] = useState(p.initial);
  const [kind, setKind] = useState<ClientLayerKind>('personal');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const parsed = layerTitleSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'اسم غير صالح.');
      return;
    }
    setBusy(true);
    try {
      await p.onSubmit(parsed.data, p.withKind ? kind : undefined);
      p.onClose();
    } catch (e) {
      setError(errorMessage(e, 'تعذّر الحفظ على هذا الجهاز.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={p.onClose}
      title={p.title}
      description={p.description}
      size="sm"
      footer={
        <>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {p.confirmLabel}
          </Button>
          <Button onClick={p.onClose}>إلغاء</Button>
        </>
      }
    >
      <form
        className="ml-layers__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField label="اسم الطبقة" value={value} onChange={(e) => (setValue(e.target.value), setError(null))} error={error ?? undefined} maxLength={80} autoFocus dir="auto" />
        {p.withKind && <Select label="نوع الطبقة" value={kind} onValueChange={(v) => setKind(v as ClientLayerKind)} options={CLIENT_LAYER_KINDS.map((k) => ({ value: k, label: LAYER_KIND_LABELS_AR[k] }))} />}
      </form>
    </Dialog>
  );
}

// ───────────────────────────── history (read-only) ─────────────────────────────
function LayerHistoryDialog({ layer, documentKey, online, onClose }: { layer: LayerInfo; documentKey: string; online: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<LayerHistoryEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!online) return;
    const ctl = new AbortController();
    fetchLayerHistory(layer.id, { documentKey, signal: ctl.signal })
      .then((r) => {
        setEntries(r.entries);
        setNext(r.next_before);
        setError(null);
      })
      .catch((e: unknown) => !ctl.signal.aborted && setError(errorMessage(e, 'تعذّر تحميل سجل الطبقة.')));
    return () => ctl.abort();
  }, [layer.id, documentKey, online, attempt]);
  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await fetchLayerHistory(layer.id, { documentKey, before: next });
      setEntries((cur) => [...(cur ?? []), ...r.entries]);
      setNext(r.next_before);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل المزيد.'));
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`سجل طبقة «${layer.title}»`} description="من غيّر ماذا ومتى، الأحدث أولًا. السجل للعرض فقط في هذه المرحلة." size="md">
      {!online ? (
        <ErrorState message={OFFLINE_MESSAGE_AR} />
      ) : error && !entries ? (
        <ErrorState message={error} onRetry={() => (setError(null), setAttempt((a) => a + 1))} />
      ) : !entries ? (
        <LoadingState inline stage="جارٍ تحميل السجل" />
      ) : entries.length === 0 ? (
        <EmptyState headingLevel={3} icon={<History size={22} />} title="لا تغييرات بعد" description="لم يُكتب في هذه الطبقة شيء على الخادم بعد. ما كُتب على هذا الجهاز يظهر هنا بعد المزامنة." />
      ) : (
        <>
          <ol className="ml-layer-history" role="list">
            {entries.map((e) => (
              <li key={`${e.entity_id}:${e.rev}:${e.action}:${e.at}`} className="ml-layer-history__row" data-action={e.action}>
                <span className="ml-layer-history__summary">{e.summary_ar}</span>
                <span className="ml-layer-history__meta">
                  {e.actor_label_ar} · <time dateTime={new Date(e.at).toISOString()}>{formatDateTime(e.at)}</time>
                  {e.page_label_ar && <> · {e.page_label_ar}</>}
                </span>
              </li>
            ))}
          </ol>
          {error && <p className="ml-layers__error" role="alert">{error}</p>}
          {next && (
            <Button onClick={() => void more()} loading={loadingMore} fullWidth>
              الأقدم
            </Button>
          )}
        </>
      )}
    </Dialog>
  );
}

// ───────────────────────────── copy one layer ─────────────────────────────
interface CopyTarget {
  value: string;
  label: string;
  into: CopyLayersRequest['into'];
  needsTitle: boolean;
}

function LayerCopyDialog({ layer, documentKey, layers, doc, online, onClose }: { layer: LayerInfo; documentKey: string; layers: LayerInfo[]; doc: SourceDocument; online: boolean; onClose: () => void }) {
  const toast = useToast();
  const [recent, setRecent] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    fetchRecentSessions(10)
      .then((r) => !cancelled && setRecent(r.items.filter((i) => i.source.id !== doc.detail.id).map((i) => ({ id: i.source.id, title: i.source.title }))))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc.detail.id]);
  const targets = useMemo<CopyTarget[]>(() => {
    const linked = doc.detail.links.map((l) => ({ id: l.from_source_id === doc.detail.id ? l.to_source_id : l.from_source_id, title: l.other_title }));
    const others = [...linked, ...recent.filter((r) => !linked.some((l) => l.id === r.id))];
    return [
      { value: 'new', label: 'طبقة جديدة في هذا المستند', into: { new_title: '', document_key: documentKey }, needsTitle: true },
      ...layers.filter((l) => l.id !== layer.id && canWriteTo(l)).map((l) => ({ value: `layer:${l.id}`, label: `إلى طبقتي «${l.title}»`, into: { layer_id: l.id, document_key: documentKey }, needsTitle: false })),
      ...others.map((s) => ({ value: `doc:${s.id}`, label: `نسخة أخرى: «${s.title}» (طبقة جديدة)`, into: { new_title: '', document_key: `source:${s.id}` }, needsTitle: true })),
    ];
  }, [doc.detail, recent, layers, layer.id, documentKey]);
  const [target, setTarget] = useState('new');
  const [title, setTitle] = useState(`نسخة من «${layer.title}»`.slice(0, 80));
  const [preview, setPreview] = useState<CopyLayersResponse['preview'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'copy' | null>(null);
  const chosen = targets.find((t) => t.value === target) ?? targets[0]!;

  const request = (dry: boolean): CopyLayersRequest | null => {
    let into = chosen.into;
    if (chosen.needsTitle) {
      const t = layerTitleSchema.safeParse(title);
      if (!t.success) {
        setError(t.error.issues[0]?.message ?? 'اسم غير صالح.');
        return null;
      }
      into = { new_title: t.data, document_key: chosen.into.document_key };
    }
    return { from_layer_ids: [layer.id], document_key: documentKey, into, preview: dry };
  };
  const run = async (dry: boolean) => {
    const req = request(dry);
    if (!req) return;
    setBusy(dry ? 'preview' : 'copy');
    setError(null);
    try {
      const res = await copyLayer(req);
      if (dry) setPreview(res.preview);
      else {
        const n = res.result?.copied ?? 0;
        toast.show({ title: n > 0 ? `نُسخ ${n} عنصرًا. يبقى الأصل كما هو.` : 'لا جديد للنسخ: كل العناصر نُسخت من قبل.', tone: 'success' });
        onClose();
      }
    } catch (e) {
      setError(errorMessage(e, 'تعذّر النسخ.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`انسخ طبقة «${layer.title}»`}
      description="تُنسخ العناصر بمعرّفات جديدة مع نسبتها إلى صاحبها، ولا يتغيّر الأصل. اعرض المعاينة أولًا: لا يُكتب شيء قبل أن تؤكّد."
      size="md"
      dismissible={busy !== 'copy'}
      footer={
        <>
          <Button variant="primary" disabled={!online || !preview} loading={busy === 'copy'} loadingLabel="جارٍ النسخ…" onClick={() => void run(false)}>
            {preview ? `انسخ ${preview.items} عنصرًا` : 'انسخ'}
          </Button>
          <Button onClick={() => void run(true)} loading={busy === 'preview'} disabled={!online}>
            اعرض المعاينة
          </Button>
          <Button variant="plain" onClick={onClose} disabled={busy === 'copy'}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="ml-layers__form">
        {!online && <p className="ml-layers__error" role="alert">{OFFLINE_MESSAGE_AR}</p>}
        <Select label="إلى أين؟" value={target} onValueChange={(v) => (setTarget(v), setPreview(null))} options={targets.map((t) => ({ value: t.value, label: t.label }))} />
        {chosen.needsTitle && <TextField label="اسم الطبقة الجديدة" value={title} maxLength={80} dir="auto" onChange={(e) => (setTitle(e.target.value), setPreview(null), setError(null))} />}
        {error && <p className="ml-layers__error" role="alert">{error}</p>}
        {preview && <CopyPreviewView preview={preview} />}
      </div>
    </Dialog>
  );
}

function CopyPreviewView({ preview }: { preview: CopyLayersResponse['preview'] }) {
  const kinds = Object.entries(preview.by_kind).filter(([, n]) => n > 0);
  return (
    <div className="ml-copy-preview" role="status" aria-live="polite">
      <p className="ml-copy-preview__head">
        سيُنسخ <strong>{preview.items}</strong> {preview.items === 1 ? 'عنصر' : 'عنصرًا'} من {preview.pages} {preview.pages === 1 ? 'صفحة' : 'صفحات'}.
      </p>
      {kinds.length > 0 && (
        <ul className="ml-copy-preview__list" role="list">
          {kinds.map(([k, n]) => (
            <li key={k}>
              {COPY_KIND_LABELS_AR[k] ?? k}: {n}
            </li>
          ))}
        </ul>
      )}
      {preview.images > 0 && <p>الصور المرجعية: {preview.images} (تُشارَك ملفاتها ولا تُكرَّر).</p>}
      {preview.already_copied > 0 && <p>نُسخ من قبل: {preview.already_copied} — لن يُنسخ مرة ثانية.</p>}
      {preview.skipped.map((s, i) => (
        <p key={i} className="ml-copy-preview__skipped">
          لن يُنسخ {s.items}: {s.reason_ar}
        </p>
      ))}
      {preview.attributions.length > 0 && <p>يُنسب إلى: {preview.attributions.map((a) => a.display_name).join('، ')}</p>}
      {preview.by_page.length > 0 && (
        <details className="ml-copy-preview__pages">
          <summary>حسب الصفحة</summary>
          <ul role="list">
            {preview.by_page.map((p) => (
              <li key={p.target_key}>
                {p.label_ar}: {p.items}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
