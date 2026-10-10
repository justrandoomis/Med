// Create / edit a notebook, folder, subject, course… Title, kind, cover (cloth colour, weave,
// symbol) with a live preview. Renaming keeps the node id, so every link and citation survives.
import { useEffect, useState, type FormEvent } from 'react';
import {
  COVER_COLOR_LABELS_AR,
  COVER_COLORS,
  COVER_STYLE_LABELS_AR,
  COVER_STYLES,
  LIBRARY_ICONS,
  LIBRARY_NODE_KIND_LABELS_AR,
  LIBRARY_NODE_KINDS,
  type CoverColor,
  type CreateNodeRequest,
  type LibraryNodeKind,
  type LibraryNodeView,
  type NodeCover,
  type NodeResponse,
} from '@medlevo/shared';
import { Button, Dialog, SegmentedControl, Select, TextField } from '../../../design';
import { api, errorMessage, fieldErrors } from '../../../lib/api';
import { mutate } from '../data';
import { Cover, coverOf, libraryIcon } from './Cover';
import { RadioGrid } from './RadioGrid';

const ICON_LABELS_AR: Record<(typeof LIBRARY_ICONS)[number], string> = {
  book: 'كتاب',
  stethoscope: 'سمّاعة طبيب',
  heart: 'قلب',
  brain: 'دماغ',
  bone: 'عظم',
  pill: 'دواء',
  microscope: 'مجهر',
  baby: 'طفل',
  scan: 'أشعة',
  flask: 'مختبر',
  syringe: 'جراحة',
  activity: 'تخطيط',
  eye: 'عين',
  folder: 'مجلد',
};

export type NodeDialogMode = { type: 'create'; parentId: string | null; kind?: LibraryNodeKind } | { type: 'edit'; node: LibraryNodeView };

export function NodeDialog({ open, mode, onClose, onSaved }: { open: boolean; mode: NodeDialogMode; onClose: () => void; onSaved?: (node: LibraryNodeView) => void }) {
  const editing = mode.type === 'edit' ? mode.node : null;
  const initialKind: LibraryNodeKind = editing?.kind ?? (mode.type === 'create' ? (mode.kind ?? (mode.parentId ? 'folder' : 'notebook')) : 'folder');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<LibraryNodeKind>(initialKind);
  const [cover, setCover] = useState<NodeCover>(() => coverOf({ cover: null, kind: initialKind, color: null, icon: null }));
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setKind(initialKind);
    setCover(editing ? coverOf(editing) : coverOf({ cover: null, kind: initialKind, color: null, icon: null }));
    setDescription(editing?.description ?? '');
    setErrors({});
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens: a parent re-render must not wipe what the owner typed
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrors({ title: 'اكتب اسمًا لهذا العنصر.' });
      return;
    }
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const body = { title: title.trim(), kind, cover, color: cover.color, icon: cover.symbol ?? null, description: description.trim() || null };
      const res = await mutate(() =>
        editing
          ? api.patch<NodeResponse>(`/library/nodes/${editing.id}`, body)
          : api.post<NodeResponse>('/library/nodes', { ...body, parent_id: mode.type === 'create' ? mode.parentId : null } satisfies CreateNodeRequest),
      );
      onSaved?.(res.node);
      onClose();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setFormError(Object.keys(fe).length ? null : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const kindOptions = LIBRARY_NODE_KINDS.map((k) => ({ value: k, label: LIBRARY_NODE_KIND_LABELS_AR[k] }));
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={editing ? `تعديل «${editing.title}»` : kind === 'notebook' ? 'دفتر جديد' : 'عنصر جديد في المكتبة'}
      size="lg"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button variant="primary" type="submit" form="ml-node-form" loading={busy} loadingLabel="جارٍ الحفظ…">
            {editing ? 'حفظ التغييرات' : 'إنشاء'}
          </Button>
        </>
      }
    >
      <form id="ml-node-form" className="ml-node-form" onSubmit={submit} noValidate>
        <div className="ml-node-form__preview" aria-hidden="true">
          <Cover cover={cover} title={title.trim() || LIBRARY_NODE_KIND_LABELS_AR[kind]} />
        </div>
        <div className="ml-stack">
          <TextField label="الاسم" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} required autoFocus maxLength={200} dir="auto" />
          <Select<LibraryNodeKind>
            label="النوع"
            hint="تنظيم شخصي فقط؛ يمكنك تغييره لاحقًا. الكورس يجمع المحاضرات والمراجع ومصادر الأسئلة."
            options={kindOptions}
            value={kind}
            onValueChange={setKind}
          />
          <fieldset className="ml-fieldset">
            <legend>لون الغلاف</legend>
            <RadioGrid<CoverColor>
              label="لون الغلاف"
              className="ml-swatches"
              optionClassName="ml-swatch"
              value={cover.color as CoverColor}
              onChange={(color) => setCover((c) => ({ ...c, color }))}
              options={COVER_COLORS.map((c) => ({ value: c, label: COVER_COLOR_LABELS_AR[c], render: null, attrs: { 'data-color': c } }))}
            />
          </fieldset>
          <SegmentedControl<NodeCover['style']>
            label="ملمس الغلاف"
            showLabel
            options={COVER_STYLES.map((s) => ({ value: s, label: COVER_STYLE_LABELS_AR[s] }))}
            value={cover.style}
            onValueChange={(style) => setCover((c) => ({ ...c, style }))}
          />
          <fieldset className="ml-fieldset">
            <legend>الرمز</legend>
            <RadioGrid<string>
              label="رمز الغلاف"
              className="ml-symbols"
              optionClassName="ml-symbol"
              value={cover.symbol ?? null}
              onChange={(symbol) => setCover((c) => ({ ...c, symbol }))}
              options={LIBRARY_ICONS.map((i) => ({ value: i, label: ICON_LABELS_AR[i], render: libraryIcon(i, 20) }))}
            />
          </fieldset>
          <TextField label="وصف قصير (اختياري)" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={2000} dir="auto" />
          {formError && (
            <p className="ml-field__error" role="alert">
              {formError}
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}
