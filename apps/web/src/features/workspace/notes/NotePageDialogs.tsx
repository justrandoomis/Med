// Dialogs of the notebook track (F1): a new note page (paper template, optional title, a section divider in a
// notebook), renaming, choosing where a page link leads, and the explicit confirmation before an external link of a
// PDF opens (the server never fetches it).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import {
  COVER_COLORS,
  COVER_COLOR_LABELS_AR,
  NOTE_PAGE_TEMPLATE_LABELS_AR,
  NOTE_PAGE_TEMPLATES,
  type CoverColor,
  type LinkTarget,
  type NotePageTemplate,
  type SourcePageView,
} from '@medlevo/shared';
import { Button, ConfirmDialog, Dialog, SegmentedControl, Select, TextField, cx, isRtl, navKeyFor, stepIndex } from '../../../design';
import type { LinkChoice } from '../ink';
import { paperStyle } from '../model/paper';
import { fullPageLabel, resolveGoTo } from '../model/pages';

// ───────────────────────────── paper template picker ─────────────────────────────
export function TemplatePicker({ value, onChange, label = 'نوع الورق' }: { value: NotePageTemplate; onChange: (t: NotePageTemplate) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const selected = Math.max(0, NOTE_PAGE_TEMPLATES.indexOf(value));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(ref.current), orientation: 'both' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(selected, step, NOTE_PAGE_TEMPLATES.length, () => false);
    onChange(NOTE_PAGE_TEMPLATES[next]!);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="wk-paper-picker">
      <span className="ml-field__label" id={labelId}>
        {label}
      </span>
      <div ref={ref} role="radiogroup" aria-labelledby={labelId} className="wk-paper-picker__grid" onKeyDown={onKeyDown}>
        {NOTE_PAGE_TEMPLATES.map((t, i) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={t === value}
            tabIndex={i === selected ? 0 : -1}
            className={cx('wk-paper-picker__option', t === value && 'is-selected')}
            onClick={() => onChange(t)}
          >
            <span className="wk-paper-picker__sheet" style={paperStyle(t, 0.11, { pageWidth: 595 })} aria-hidden="true" />
            <span className="wk-paper-picker__name">{NOTE_PAGE_TEMPLATE_LABELS_AR[t]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── new note page ─────────────────────────────
export interface NewNotePageChoice {
  template: NotePageTemplate;
  title: string | null;
  kind: 'page' | 'divider';
  color: CoverColor | null;
}

export function NewNotePageDialog({
  open,
  onClose,
  onCreate,
  where,
  allowDivider = false,
  defaultKind = 'page',
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (c: NewNotePageChoice) => void | Promise<void>;
  /** where it goes, e.g. «بعد ص 12» / «في نهاية الدفتر» */
  where: string;
  allowDivider?: boolean;
  defaultKind?: 'page' | 'divider';
}) {
  const [template, setTemplate] = useState<NotePageTemplate>('ruled');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'page' | 'divider'>(defaultKind);
  const [color, setColor] = useState<CoverColor>('teal');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle('');
      setKind(defaultKind);
      setBusy(false);
    }
  }, [open, defaultKind]);
  const divider = kind === 'divider';
  const submit = async () => {
    if (divider && !title.trim()) return;
    setBusy(true);
    try {
      await onCreate({ template: divider ? 'blank' : template, title: title.trim() || null, kind, color: divider ? color : null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={divider ? 'قسم جديد في الدفتر' : 'صفحة ملاحظات جديدة'}
      description={`${where}. تُحفظ على هذا الجهاز فورًا وتُزامَن عند الاتصال.`}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || (divider && !title.trim())}>
            {divider ? 'أضف القسم' : 'أضف الصفحة'}
          </Button>
        </>
      }
    >
      <form
        className="wk-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {allowDivider && (
          <SegmentedControl<'page' | 'divider'>
            label="النوع"
            showLabel
            options={[
              { value: 'page', label: 'صفحة للكتابة' },
              { value: 'divider', label: 'فاصل قسم (تبويب)' },
            ]}
            value={kind}
            onValueChange={setKind}
          />
        )}
        {!divider && <TemplatePicker value={template} onChange={setTemplate} />}
        <TextField
          label={divider ? 'اسم القسم' : 'عنوان الصفحة (اختياري)'}
          value={title}
          maxLength={200}
          required={divider}
          dir="auto"
          onChange={(e) => setTitle(e.target.value)}
          hint={divider ? 'يظهر القسم تبويبًا في أعلى الدفتر.' : undefined}
        />
        {divider && (
          <Select<CoverColor>
            label="لون التبويب"
            options={COVER_COLORS.map((c) => ({ value: c, label: COVER_COLOR_LABELS_AR[c] }))}
            value={color}
            onValueChange={setColor}
          />
        )}
      </form>
    </Dialog>
  );
}

// ───────────────────────────── rename ─────────────────────────────
export function RenameNotePageDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (title: string | null) => void | Promise<void> }) {
  const [title, setTitle] = useState(initial);
  useEffect(() => {
    if (open) setTitle(initial);
  }, [open, initial]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="إعادة تسمية صفحة الملاحظات"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={() => void onSave(title.trim() || null)}>
            حفظ
          </Button>
        </>
      }
    >
      <form
        className="wk-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(title.trim() || null);
        }}
      >
        <TextField label="العنوان" value={title} maxLength={200} dir="auto" onChange={(e) => setTitle(e.target.value)} hint="اتركه فارغًا لصفحة بلا عنوان." />
      </form>
    </Dialog>
  );
}

// ───────────────────────────── link target ─────────────────────────────
export interface LinkSourceOption {
  sourceId: string;
  versionId: string | null;
  title: string;
  /** pages of the version the link points into (null → page number only, resolved on arrival) */
  pages: readonly SourcePageView[] | null;
  /** the page to preselect */
  current?: number;
}
export interface LinkNoteOption {
  id: string;
  label: string;
}

export interface LinkTargetDialogProps {
  open: boolean;
  /** pages of this source (reader) or of sources near the notebook */
  sources: readonly LinkSourceOption[];
  notePages: readonly LinkNoteOption[];
  onCancel: () => void;
  onChoose: (c: LinkChoice) => void;
}

/** «إلى أين يقود الرابط؟»: a page of a source (printed label or file position) or one of the owner's note pages. */
export function LinkTargetDialog({ open, sources, notePages, onCancel, onChoose }: LinkTargetDialogProps) {
  const [kind, setKind] = useState<'source' | 'note'>(sources.length ? 'source' : 'note');
  const [sourceId, setSourceId] = useState(sources[0]?.sourceId ?? '');
  const [pageText, setPageText] = useState('');
  const [noteId, setNoteId] = useState(notePages[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setKind(sources.length ? 'source' : 'note');
    setSourceId(sources[0]?.sourceId ?? '');
    const cur = sources[0]?.current;
    const pg = cur != null ? sources[0]?.pages?.[cur] : undefined;
    setPageText(pg ? (pg.printed_label ?? `#${pg.page_index + 1}`) : '');
    setNoteId(notePages[0]?.id ?? '');
    setLabel('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const src = useMemo(() => sources.find((s) => s.sourceId === sourceId) ?? null, [sources, sourceId]);

  const choose = () => {
    setError(null);
    if (kind === 'note') {
      const n = notePages.find((x) => x.id === noteId);
      if (!n) {
        setError('اختر صفحة الملاحظات التي يفتحها الرابط.');
        return;
      }
      onChoose({ target: { type: 'note_page', note_page_id: n.id }, label: label.trim() || null, targetLabel: n.label });
      return;
    }
    if (!src) {
      setError('اختر المصدر.');
      return;
    }
    let target: LinkTarget;
    let targetLabel: string;
    if (src.pages && src.pages.length) {
      const r = resolveGoTo(pageText, src.pages);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const pg = src.pages[r.index]!;
      target = { type: 'source_page', source_id: src.sourceId, version_id: src.versionId, page_id: pg.id, page_index: pg.page_index };
      targetLabel = `${fullPageLabel(pg)} — ${src.title}`;
    } else {
      const n = Number(pageText.replace(/[^\d]/g, ''));
      if (!Number.isInteger(n) || n < 1) {
        setError('اكتب رقم الصفحة في الملف (1 أو أكثر).');
        return;
      }
      target = { type: 'source_page', source_id: src.sourceId, version_id: src.versionId, page_id: null, page_index: n - 1 };
      targetLabel = `الصفحة ${n} في الملف — ${src.title}`;
    }
    onChoose({ target, label: label.trim() || null, targetLabel });
  };

  const kinds = [
    ...(sources.length ? [{ value: 'source' as const, label: 'صفحة من مصدر' }] : []),
    ...(notePages.length ? [{ value: 'note' as const, label: 'صفحة ملاحظات' }] : []),
  ];
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="إلى أين يقود الرابط؟"
      description="يفتح الرابط الصفحة المختارة، و«العودة إلى موضعك» يرجعك إلى هنا. لا يتغيّر شيء في الصفحتين."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={choose} disabled={kinds.length === 0}>
            أنشئ الرابط
          </Button>
        </>
      }
    >
      <form
        className="wk-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          choose();
        }}
      >
        {kinds.length === 0 && <p className="wk-muted">لا توجد صفحات يمكن الربط بها هنا بعد.</p>}
        {kinds.length > 1 && <SegmentedControl<'source' | 'note'> label="نوع الصفحة" showLabel options={kinds} value={kind} onValueChange={setKind} />}
        {kind === 'source' && src && (
          <>
            {sources.length > 1 && (
              <Select label="المصدر" options={sources.map((s) => ({ value: s.sourceId, label: s.title }))} value={sourceId} onValueChange={setSourceId} />
            )}
            <TextField
              label="الصفحة"
              value={pageText}
              dir="auto"
              onChange={(e) => setPageText(e.target.value)}
              hint={src.pages ? 'الرقم المطبوع في الكتاب (مثل 12) أو #رقمها في الملف.' : 'رقم الصفحة في الملف.'}
              inputMode="text"
            />
          </>
        )}
        {kind === 'note' && notePages.length > 0 && (
          <Select label="صفحة الملاحظات" options={notePages.map((n) => ({ value: n.id, label: n.label }))} value={noteId} onValueChange={setNoteId} />
        )}
        <TextField label="نص الرابط على الصفحة (اختياري)" value={label} maxLength={200} dir="auto" onChange={(e) => setLabel(e.target.value)} hint="مثل «انظر الجدول». يُعرض اسم الصفحة إن تُرك فارغًا." />
        {error && (
          <p className="wk-dialog-form__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

// ───────────────────────────── external link of a PDF ─────────────────────────────
/** Only web and mail links open (javascript:, data:, file: … never). */
export function safeExternalUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function ExternalLinkDialog({ url, onClose }: { url: string | null; onClose: () => void }) {
  const safe = url ? safeExternalUrl(url) : null;
  return (
    <ConfirmDialog
      open={!!url}
      title="فتح رابط خارجي؟"
      impact={
        safe
          ? 'هذا الرابط موجود في ملف المحاضرة ويقود إلى خارج MedLevo. سيُفتح في نافذة جديدة من متصفحك فقط إذا أكّدت؛ الخادم لا يزوره ولا يجلب محتواه.'
          : 'هذا الرابط ليس رابط ويب أو بريد؛ لن يُفتح.'
      }
      confirmLabel={safe ? 'افتح في نافذة جديدة' : 'حسنًا'}
      onCancel={onClose}
      onConfirm={() => {
        if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
        onClose();
      }}
    >
      {url && (
        <p className="wk-external-url">
          <ExternalLink size={16} aria-hidden="true" />
          {/* the address that would really open (normalized: an IDN host as punycode, bidi / invisible characters
              percent-encoded), so the file cannot dress a link up as another site */}
          <bdi dir="ltr">{safe ?? url}</bdi>
        </p>
      )}
    </ConfirmDialog>
  );
}
