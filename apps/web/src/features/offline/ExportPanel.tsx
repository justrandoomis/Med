// Export (§46): a source, a Study Book, notes, questions or everything — Markdown, print-ready HTML (PDF via the
// browser's print dialog, said plainly) or JSON with a manifest. Citations are text (source, page, version + quote);
// generated content is labelled; an internal location never becomes a fake link.
import { useEffect, useMemo, useState } from 'react';
import { FileDown, Printer } from 'lucide-react';
import type { ExportFormat, ExportFormatsResponse, SourceSummary } from '@medlevo/shared';
import { Bidi, Button, Checkbox, EmptyState, ErrorState, LoadingState, SegmentedControl, Select, useToast } from '../../design';
import { Mixed } from './Mixed';
import { errorMessage } from '../../lib/api';
import { useOnline } from '../../lib/useOnline';
import { dataApi, exportUrl, fetchExport, saveBlob, type ExportTarget } from './api';

type Kind = 'source' | 'book' | 'notes' | 'questions' | 'all';
const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: 'source', label: 'مصدر: نصه صفحة صفحة مع كتاباتك عليه' },
  { value: 'book', label: 'كتاب الدراسة لمصدر (محتوى مولَّد مع أدلته)' },
  { value: 'notes', label: 'ملاحظاتي' },
  { value: 'questions', label: 'الأسئلة' },
  { value: 'all', label: 'كل بياناتي المنظمة (JSON كامل)' },
];

export function ExportPanel() {
  const online = useOnline();
  const toast = useToast();
  const [formats, setFormats] = useState<ExportFormatsResponse | null>(null);
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('source');
  const [sourceId, setSourceId] = useState('');
  const [format, setFormat] = useState<ExportFormat>('md');
  const [solutions, setSolutions] = useState(true);
  const [busy, setBusy] = useState<null | 'file' | 'print'>(null);

  useEffect(() => {
    if (!online) return;
    let alive = true;
    Promise.all([dataApi.exportFormats(), dataApi.libraryTree()])
      .then(([f, t]) => {
        if (!alive) return;
        setFormats(f);
        setSources(t.sources.filter((s) => !s.deleted_at));
      })
      .catch((e: unknown) => alive && setError(errorMessage(e, 'تعذّر تحميل خيارات التصدير.')));
    return () => {
      alive = false;
    };
  }, [online]);

  const pickable = useMemo(() => {
    const all = sources ?? [];
    if (kind === 'questions') return all.filter((s) => ['question_source', 'previous_exam', 'lecture'].includes(s.source_type));
    if (kind === 'book') return all.filter((s) => s.source_type === 'lecture' || s.source_type === 'course_reference' || s.source_type === 'textbook');
    return all;
  }, [sources, kind]);
  useEffect(() => {
    if (sourceId && !pickable.some((s) => s.id === sourceId)) setSourceId('');
  }, [pickable, sourceId]);

  const needsSource = kind === 'source' || kind === 'book';
  const effectiveFormat: ExportFormat = kind === 'all' ? 'json' : format;

  const resolveTarget = async (): Promise<ExportTarget | null> => {
    const src = sources?.find((s) => s.id === sourceId) ?? null;
    switch (kind) {
      case 'source':
        return src ? { kind: 'source', sourceId: src.id } : null;
      case 'book': {
        if (!src) return null;
        const st = await dataApi.bookForSource(src.id);
        if (!st.book) {
          toast.show({ title: 'لا يوجد كتاب دراسة منشور لهذا المصدر بعد.', tone: 'warning' });
          return null;
        }
        return { kind: 'artifact', artifactId: st.book.artifact.id };
      }
      case 'notes':
        return { kind: 'notes', sourceId: src?.id ?? null };
      case 'questions':
        return {
          kind: 'questions',
          sourceId: src && src.source_type !== 'lecture' ? src.id : null,
          lectureSourceId: src && src.source_type === 'lecture' ? src.id : null,
          includeSolutions: solutions,
        };
      case 'all':
        return { kind: 'all' };
    }
  };

  const run = async (mode: 'file' | 'print') => {
    // the print tab is opened synchronously (a user gesture) and filled when the export arrives
    const printWindow = mode === 'print' ? window.open('', '_blank') : null;
    setBusy(mode);
    try {
      const target = await resolveTarget();
      if (!target) {
        printWindow?.close();
        return;
      }
      const f = await fetchExport(exportUrl(target, mode === 'print' ? 'html' : effectiveFormat));
      if (mode === 'print') {
        const url = URL.createObjectURL(new Blob([await f.text()], { type: 'text/html' }));
        if (printWindow) printWindow.location.href = url;
        else saveBlob(f.blob, f.fileName); // pop-up blocked: the file itself, to open and print
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
      } else {
        saveBlob(f.blob, f.fileName);
        toast.show({ title: 'جُهّز الملف للحفظ على جهازك.', tone: 'success' });
      }
    } catch (e) {
      printWindow?.close();
      toast.show({ title: errorMessage(e, 'تعذّر التصدير.'), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  if (!online) {
    return <EmptyState headingLevel={3} title="التصدير يحتاج اتصالًا بالخادم" description="يُجهَّز ملف التصدير على الخادم من أحدث نسخة من بياناتك." />;
  }
  if (error) return <ErrorState inline message={error} />;
  if (!formats || !sources) return <LoadingState inline stage="جارٍ تحميل خيارات التصدير…" />;
  const canRun = !needsSource || !!sourceId;
  return (
    <div className="dl-stack">
      <p className="dl-lede">
        كل تصدير يحفظ اسم المصدر والصفحة (المطبوعة ورقمها في الملف) والإصدار ونص الدليل نصًّا مقروءًا، ويعلّم المحتوى المولَّد، ولا يحوّل موضعًا داخليًا إلى رابط.
      </p>
      <Select label="ما الذي تصدّره" options={KIND_OPTIONS} value={kind} onValueChange={(v) => setKind(v)} />
      {kind !== 'all' && (
        <Select
          label={needsSource ? 'المصدر' : kind === 'questions' ? 'من أي مصدر (اختياري)' : 'ملاحظات مصدر معيّن (اختياري)'}
          options={[{ value: '', label: needsSource ? 'اختر مصدرًا…' : kind === 'questions' ? 'كل الأسئلة' : 'كل الملاحظات' }, ...pickable.map((s) => ({ value: s.id, label: s.title }))]}
          value={sourceId}
          onValueChange={setSourceId}
          hint={kind === 'questions' ? 'محاضرة: الأسئلة المرتبطة بها. مصدر أسئلة: أسئلته كما في الملف.' : undefined}
        />
      )}
      {kind !== 'all' && (
        <SegmentedControl
          label="الصيغة"
          showLabel
          options={formats.formats.map((f) => ({ value: f.format, label: f.label_ar }))}
          value={format}
          onValueChange={(v) => setFormat(v as ExportFormat)}
        />
      )}
      <p className="dl-meta">{kind === 'all' ? 'JSON كامل مع manifest للمعرّفات والإصدارات وبصمات المحتوى. الملفات نفسها في النسخة الاحتياطية.' : formats.formats.find((f) => f.format === format)?.note_ar}</p>
      {kind === 'questions' && (
        <Checkbox checked={solutions} onCheckedChange={setSolutions} label="مع الحلول ومفاتيح الإجابة" description="يذكر لكل سؤال من يقف خلف مفتاحه: مفتاح المصدر، أو مفتاحك، أو حل مولَّد (ليس مفتاحًا رسميًا)." />
      )}
      <div className="dl-actions">
        <Button variant="primary" icon={<FileDown size={16} />} loading={busy === 'file'} disabled={!canRun || busy !== null} onClick={() => void run('file')}>
          نزّل الملف
        </Button>
        {kind !== 'all' && (
          <Button variant="secondary" icon={<Printer size={16} />} loading={busy === 'print'} disabled={!canRun || busy !== null} onClick={() => void run('print')}>
            افتح نسخة الطباعة (PDF)
          </Button>
        )}
      </div>
      <p className="dl-meta">{formats.pdf_note_ar}</p>
      <ul className="dl-notes">
        {formats.other.map((o) => (
          <li key={o.key}>
            <Mixed text={o.label_ar} />: {o.available ? o.reason_ar ?? 'متاح.' : `غير متاح — ${o.reason_ar ?? 'لم يُبنَ بعد.'}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
