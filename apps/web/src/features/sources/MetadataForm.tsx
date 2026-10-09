// Source metadata (§06): only what the file or the owner provides. Empty bibliographic fields are
// shown as «غير معروف» — never filled by guessing.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  LECTURE_KIND_LABELS_AR,
  LECTURE_KINDS,
  SOURCE_TYPE_LABELS_AR,
  SOURCE_TYPES,
  type LectureKind,
  type PatchSourceRequest,
  type SourceDetail,
  type SourceType,
} from '@medlevo/shared';
import { Button, SegmentedControl, Select, StatusPill, TextArea, TextField, useToast } from '../../design';
import { api, errorMessage, fieldErrors } from '../../lib/api';
import { mutate } from '../library/data';

type Detail = SourceDetail & { source_type_origin?: 'auto' | 'owner' };

interface Draft {
  title: string;
  source_type: SourceType;
  lecture_kind: '' | LectureKind;
  language: '' | 'ar' | 'en' | 'mixed';
  edition: string;
  authors: string;
  publication_date: string;
  original_url: string;
  priority: string;
  selection_reason: string;
  metadata_status: SourceDetail['metadata_status'];
}

function draftOf(d: Detail): Draft {
  return {
    title: d.title,
    source_type: d.source_type,
    lecture_kind: d.lecture_kind ?? '',
    language: (d.language as Draft['language']) ?? '',
    edition: d.edition ?? '',
    authors: (d.authors ?? []).join('، '),
    publication_date: d.publication_date ?? '',
    original_url: d.original_url ?? '',
    priority: String(d.priority ?? 0),
    selection_reason: d.selection_reason ?? '',
    metadata_status: d.metadata_status,
  };
}

export function toPatch(before: Draft, after: Draft): PatchSourceRequest {
  const p: PatchSourceRequest = {};
  if (after.title !== before.title) p.title = after.title.trim();
  if (after.source_type !== before.source_type) p.source_type = after.source_type;
  if (after.lecture_kind !== before.lecture_kind) p.lecture_kind = after.lecture_kind || null;
  if (after.language !== before.language) p.language = after.language || null;
  if (after.edition !== before.edition) p.edition = after.edition.trim() || null;
  if (after.authors !== before.authors) {
    const list = after.authors
      .split(/[،,;\n]/)
      .map((a) => a.trim())
      .filter(Boolean);
    p.authors = list.length ? list : null;
  }
  if (after.publication_date !== before.publication_date) p.publication_date = after.publication_date.trim() || null;
  if (after.original_url !== before.original_url) p.original_url = after.original_url.trim() || null;
  if (after.priority !== before.priority) p.priority = Number(after.priority) || 0;
  if (after.selection_reason !== before.selection_reason) p.selection_reason = after.selection_reason.trim() || null;
  if (after.metadata_status !== before.metadata_status) p.metadata_status = after.metadata_status;
  return p;
}

const UNKNOWN = 'غير معروف';

export function MetadataForm({ detail, readOnly }: { detail: Detail; readOnly: boolean }) {
  const toast = useToast();
  const initial = useMemo(() => draftOf(detail), [detail]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setDraft(initial), [initial]);
  const patch = toPatch(initial, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const isLecture = draft.source_type === 'lecture' || draft.source_type === 'lecture_audio';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.title.trim()) {
      setErrors({ title: 'العنوان مطلوب.' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await mutate(() => api.patch(`/sources/${detail.id}`, patch));
      toast.show({ title: 'حُفظت بيانات المصدر', tone: 'success' });
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (Object.keys(fe).length === 0) toast.show({ title: errorMessage(err), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const typeHint =
    detail.source_type_origin === 'auto' ? (
      <>
        <StatusPill tone="info" icon={false}>
          مقترح تلقائيًا
        </StatusPill>{' '}
        اقتُرح هذا النوع من اسم الملف. اختر النوع الصحيح ثم احفظ لتأكيده.
      </>
    ) : undefined;

  return (
    <form onSubmit={save} className="ml-stack" noValidate>
      <section className="ml-group">
        <div className="ml-group__row ml-group__row--stack">
          <TextField label="العنوان" value={draft.title} onChange={(e) => set('title', e.target.value)} error={errors.title} disabled={readOnly} dir="auto" maxLength={300} />
          <Select<SourceType>
            label="نوع المصدر"
            hint={typeHint}
            options={SOURCE_TYPES.map((t) => ({ value: t, label: SOURCE_TYPE_LABELS_AR[t] }))}
            value={draft.source_type}
            onValueChange={(v) => set('source_type', v)}
            error={errors.source_type}
            disabled={readOnly}
          />
          {isLecture && (
            <Select<'' | LectureKind>
              label="طبيعة المحاضرة"
              hint={detail.lecture_kind_origin === 'auto' ? 'صُنّفت تلقائيًا؛ صحّحها إن لزم.' : undefined}
              options={[{ value: '', label: 'غير محددة' }, ...LECTURE_KINDS.map((k) => ({ value: k, label: LECTURE_KIND_LABELS_AR[k] }))]}
              value={draft.lecture_kind}
              onValueChange={(v) => set('lecture_kind', v)}
              disabled={readOnly}
            />
          )}
          <Select<Draft['language']>
            label="اللغة"
            options={[
              { value: '', label: UNKNOWN },
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'الإنجليزية' },
              { value: 'mixed', label: 'مختلطة' },
            ]}
            value={draft.language}
            onValueChange={(v) => set('language', v)}
            disabled={readOnly}
          />
        </div>
      </section>

      <section aria-labelledby="biblio-title">
        <h3 id="biblio-title" className="ml-group-header">
          بيانات المرجع
        </h3>
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <TextField label="الطبعة" placeholder={UNKNOWN} value={draft.edition} onChange={(e) => set('edition', e.target.value)} error={errors.edition} disabled={readOnly} dir="auto" />
            <TextField
              label="المؤلفون"
              hint="افصل بين الأسماء بفاصلة."
              placeholder={UNKNOWN}
              value={draft.authors}
              onChange={(e) => set('authors', e.target.value)}
              error={errors.authors ?? errors['authors.0']}
              disabled={readOnly}
              dir="auto"
            />
            <TextField
              label="تاريخ النشر"
              hint="سنة فقط أو بالصيغة YYYY-MM-DD."
              placeholder={UNKNOWN}
              value={draft.publication_date}
              onChange={(e) => set('publication_date', e.target.value)}
              error={errors.publication_date}
              disabled={readOnly}
              dir="ltr"
              inputMode="numeric"
            />
            <TextField
              label="الرابط الأصلي"
              placeholder={UNKNOWN}
              value={draft.original_url}
              onChange={(e) => set('original_url', e.target.value)}
              error={errors.original_url}
              disabled={readOnly}
              dir="ltr"
              type="url"
            />
            <SegmentedControl<SourceDetail['metadata_status']>
              label="حالة هذه البيانات"
              showLabel
              options={[
                { value: 'unknown', label: 'غير معروفة' },
                { value: 'partial', label: 'جزئية' },
                { value: 'owner_confirmed', label: 'أكّدتها بنفسي' },
              ]}
              value={draft.metadata_status}
              onValueChange={(v) => set('metadata_status', v)}
            />
          </div>
        </div>
        <p className="ml-group-footer">لا يملأ MedLevo هذه الحقول بالتخمين: ما لم تكتبه بنفسك أو يوجد في الملف يبقى «{UNKNOWN}».</p>
      </section>

      <section aria-labelledby="use-title">
        <h3 id="use-title" className="ml-group-header">
          استخدامه في الدراسة
        </h3>
        <div className="ml-group">
          <div className="ml-group__row ml-group__row--stack">
            <Select<string>
              label="الأولوية عند الشرح والاسترجاع"
              hint="تخص ملاءمة المصدر لدراستك، وليست حكمًا على دقة محتواه."
              options={[
                { value: '-1', label: 'منخفضة' },
                { value: '0', label: 'عادية' },
                { value: '1', label: 'مرتفعة' },
                { value: '2', label: 'الأعلى' },
              ]}
              value={['-1', '0', '1', '2'].includes(draft.priority) ? draft.priority : '0'}
              onValueChange={(v) => set('priority', v)}
              disabled={readOnly}
            />
            <TextArea
              label="لماذا اخترت هذا المصدر؟"
              rows={2}
              value={draft.selection_reason}
              onChange={(e) => set('selection_reason', e.target.value)}
              error={errors.selection_reason}
              disabled={readOnly}
              dir="auto"
            />
          </div>
        </div>
      </section>

      <div className="ml-cluster">
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty || readOnly} loadingLabel="جارٍ الحفظ…">
          حفظ البيانات
        </Button>
        {dirty && (
          <Button variant="plain" onClick={() => setDraft(initial)} disabled={busy}>
            تراجع عن التعديلات
          </Button>
        )}
      </div>
    </form>
  );
}
