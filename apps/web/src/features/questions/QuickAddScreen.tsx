// إضافة سريعة (§33): one question from a photo / screenshot or from pasted text — no full-file workflow, a few
// fields only. A key typed here is YOUR key (owner key), never shown as the source's key.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Camera, Type } from 'lucide-react';
import type { QuickAddResponse } from '@medlevo/shared';
import { Breadcrumbs, Button, buttonClass, ErrorState, SegmentedControl, Select, TextArea, TextField, type SelectOption } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { FeatureGate } from '../../lib/capabilities';
import { usePageTitle } from '../../lib/usePageTitle';
import { useLibrary } from '../library/useLibrary';
import { questionsApi } from './api';
import './questions.css';

type Mode = 'image' | 'text';

export function QuickAddScreen() {
  usePageTitle('إضافة سؤال سريعة');
  const [params] = useSearchParams();
  const lectureId = params.get('lecture');
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'text' ? 'text' : 'image');
  const lib = useLibrary();
  const nodes = useMemo<SelectOption[]>(() => {
    const all = [...(lib.index?.nodes.values() ?? [])].filter((n) => !n.deleted_at && !n.archived_at);
    const courses = all.filter((n) => n.kind === 'course');
    const rest = all.filter((n) => n.kind !== 'course');
    return [...courses, ...rest].map((n) => ({ value: n.id, label: n.kind === 'course' ? `${n.title} (كورس)` : n.title }));
  }, [lib.index]);
  // text mode links the question to a COURSE (its lectures are matched); only courses can be chosen there
  const courseOptions = useMemo<SelectOption[]>(
    () => [...(lib.index?.nodes.values() ?? [])].filter((n) => n.kind === 'course' && !n.deleted_at && !n.archived_at).map((n) => ({ value: n.id, label: n.title })),
    [lib.index],
  );
  const lecture = lectureId ? lib.index?.sources.get(lectureId) : null;
  const defaultCourse = lecture?.course_node_id ?? params.get('course') ?? '';
  const [nodeId, setNodeId] = useState<string>(defaultCourse);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuickAddResponse | null>(null);
  const effectiveNode = nodeId || defaultCourse;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (mode === 'image') {
        if (!file) throw new Error('اختر صورة السؤال أولًا.');
        if (!effectiveNode) throw new Error('اختر المجلد أو الكورس الذي يُحفظ فيه السؤال.');
        const form = new FormData();
        form.set('node_id', effectiveNode);
        if (title.trim()) form.set('title', title.trim());
        form.set('file', file, file.name);
        setResult(await questionsApi.quickAddImage(form));
      } else {
        setResult(
          await questionsApi.quickAddText({
            text,
            key_label: keyLabel.trim() || null,
            course_node_id: effectiveNode && lib.index?.nodes.get(effectiveNode)?.kind === 'course' ? effectiveNode : null,
            lecture_source_id: lectureId,
          }),
        );
      }
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="ml-page ml-page--narrow qv-page">
        <h1 className="ml-page__title">{result.mode === 'image' ? 'حُفظت الصورة' : 'أُضيف السؤال'}</h1>
        <p className="qv-result" role="status">
          {result.message_ar}
        </p>
        <div className="ml-cluster">
          {result.question_id && (
            <Link to={`/questions/${result.question_id}`} className={buttonClass({ variant: 'primary' })}>
              افتح السؤال
            </Link>
          )}
          {result.source_id && (
            <Link to={`/questions?source_id=${encodeURIComponent(result.source_id)}`} className={buttonClass({ variant: 'primary' })}>
              أسئلة هذه الصورة
            </Link>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setFile(null);
              setText('');
              setKeyLabel('');
              setTitle('');
            }}
          >
            إضافة سؤال آخر
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-page ml-page--narrow qv-page">
      <Breadcrumbs items={[{ label: 'خزنة أسئلتي', to: '/questions' }, { label: 'إضافة سريعة' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">إضافة سؤال سريعة</h1>
        <p className="ml-page__lede">سؤال واحد من صورة أو نص، دون إنشاء ملف كامل.</p>
      </header>
      <form className="ml-stack qv-quick" onSubmit={(e) => void submit(e)} noValidate>
        <SegmentedControl<Mode>
          label="مصدر السؤال"
          showLabel
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'image', label: 'صورة أو لقطة شاشة', icon: <Camera size={16} /> },
            { value: 'text', label: 'نص ألصقه', icon: <Type size={16} /> },
          ]}
        />
        {lecture && (
          <p className="qv-muted">
            سيُربط السؤال بمحاضرة «<bdi>{lecture.title}</bdi>» كرابط حددته بنفسك.
          </p>
        )}
        {mode === 'image' ? (
          <FeatureGate feature="processing.images">
            <div className="ml-stack">
              <div className="ml-field qv-filepick">
                <span className="ml-field__label" id="qv-file-label">
                  صورة السؤال
                </span>
                <div className="ml-cluster">
                  <input
                    id="qv-file"
                    className="ml-visually-hidden"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/tiff,application/pdf"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    aria-labelledby="qv-file-label qv-file-name"
                    aria-describedby="qv-file-hint"
                  />
                  <label htmlFor="qv-file" className={buttonClass({ variant: 'secondary' })}>
                    <Camera size={16} aria-hidden="true" />
                    اختر صورة…
                  </label>
                  <span id="qv-file-name" className="qv-muted">
                    {file ? <bdi>{file.name}</bdi> : 'لم تُختر صورة بعد'}
                  </span>
                </div>
                <span id="qv-file-hint" className="ml-field__hint">
                  تُحفظ كمصدر أسئلة، وتُقرأ بالتعرف الضوئي ثم يُستخرج السؤال. الدائرة أو العلامة بالقلم على خيار لا تُعد مفتاحًا رسميًا.
                </span>
              </div>
              <Select label="يُحفظ في" value={effectiveNode} onValueChange={setNodeId} options={[{ value: '', label: 'اختر مجلدًا أو كورسًا' }, ...nodes]} error={fields.node_id} />
              <TextField label="اسم مختصر (اختياري)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="سؤال مضاف سريعًا" maxLength={300} />
            </div>
          </FeatureGate>
        ) : (
          <div className="ml-stack">
            <TextArea
              label="نص السؤال وخياراته"
              hint="مثال: «1. Which nerve supplies the diaphragm?» ثم كل خيار في سطر: «A. Vagus»."
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              required
              error={fields.text}
            />
            <TextField
              label="الإجابة الصحيحة حسب علمك (اختياري)"
              hint="تسمية الخيار كما كتبتها (A أو أ). تُحفظ كمفتاح حددته أنت، لا كمفتاح مصدر."
              value={keyLabel}
              onChange={(e) => setKeyLabel(e.target.value)}
              maxLength={4}
              dir="ltr"
            />
            <Select
              label="الكورس (اختياري، للربط بمحاضراته)"
              value={courseOptions.some((o) => o.value === effectiveNode) ? effectiveNode : ''}
              onValueChange={setNodeId}
              options={[{ value: '', label: 'بلا كورس' }, ...courseOptions]}
            />
          </div>
        )}
        {error && <ErrorState inline message={error} />}
        <div className="ml-cluster">
          <Button type="submit" variant="primary" loading={busy} disabled={mode === 'text' ? !text.trim() : !file}>
            {mode === 'image' ? 'حفظ الصورة واستخراج السؤال' : 'إضافة السؤال'}
          </Button>
          <Link to="/questions" className={buttonClass({ variant: 'plain' })}>
            إلغاء
          </Link>
        </div>
      </form>
    </div>
  );
}
