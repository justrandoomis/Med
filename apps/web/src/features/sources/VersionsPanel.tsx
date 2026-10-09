// Versions + Source Freeze (§18) + replacement upload. The frozen version is never changed
// automatically: a new upload becomes the latest version, study tools keep using the frozen one.
import { useRef, useState } from 'react';
import { FileUp, Pin, PinOff } from 'lucide-react';
import type { SourceDetail, SourceVersionView, UploadResponse } from '@medlevo/shared';
import { Button, ProgressBar, StatusPill, TextField, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/time';
import { mutate } from '../library/data';
import { Bytes, extentLabel, formatBytes, FORMAT_LABELS_AR, IsolatedList, ProcessingPill } from '../library/labels';
import { describeResult } from '../upload/results';
import { postMultipart } from '../upload/uploadXhr';

const KIND_AR: Record<SourceVersionView['kind'], string> = {
  original: 'الملف الأصلي',
  replacement: 'نسخة بديلة',
  converted: 'نسخة محوّلة',
  ocr_correction: 'تصحيح تعرّف ضوئي',
  owner_correction: 'تصحيح منك',
};

export function VersionsPanel({ detail, readOnly }: { detail: SourceDetail; readOnly: boolean }) {
  const toast = useToast();
  const freeze = async (versionId: string | null) => {
    try {
      await mutate(() => api.post(`/sources/${detail.id}/freeze`, { version_id: versionId }));
      toast.show({ title: versionId ? 'ثُبّتت هذه النسخة للدراسة' : 'أُلغي التثبيت؛ تتبع أدوات الدراسة أحدث نسخة', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };
  return (
    <div className="ml-stack">
      <p className="ml-trash-note">
        تستخدم أدوات الدراسة النسخة المثبّتة إن وُجدت، وإلا أحدث نسخة. رفع نسخة جديدة لا يغيّر التثبيت تلقائيًا، وتبقى محاولاتك السابقة مرتبطة بالنسخة التي استُخدمت وقتها.
      </p>
      <ul className="ml-list" role="list">
        {detail.versions.map((v) => {
          const isCurrent = v.id === detail.current_version_id;
          const extent = extentLabel(v.format, v.page_count);
          return (
            <li key={v.id} className="ml-upload__item">
              <div className="ml-upload__head">
                <span className="ml-row__text">
                  <span className="ml-row__title">
                    النسخة {v.version_no}: {KIND_AR[v.kind]}
                  </span>
                  <span className="ml-row__sub ml-upload__detail">
                    <IsolatedList parts={[v.file_name, FORMAT_LABELS_AR[v.format], extent, formatDateTime(v.created_at)].filter(Boolean)} />
                  </span>
                  {v.note && <span className="ml-row__sub ml-upload__detail">{v.note}</span>}
                </span>
              </div>
              <div className="ml-upload__row-actions">
                <ProcessingPill status={v.processing_status} format={v.format} />
                {isCurrent && <StatusPill tone="accent">الأحدث</StatusPill>}
                {v.is_frozen && (
                  <StatusPill tone="success" icon={<Pin size={14} />}>
                    مثبّتة للدراسة
                  </StatusPill>
                )}
                {v.is_frozen ? (
                  <Button size="sm" variant="plain" icon={<PinOff size={16} />} onClick={() => void freeze(null)} disabled={readOnly}>
                    إلغاء التثبيت
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" icon={<Pin size={16} />} onClick={() => void freeze(v.id)} disabled={readOnly}>
                    تثبيت هذه النسخة للدراسة
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!readOnly && <ReplaceUpload sourceId={detail.id} />}
    </div>
  );
}

function ReplaceUpload({ sourceId }: { sourceId: string }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const send = async () => {
    if (!file) return;
    const form = new FormData();
    if (note.trim()) form.append('note', note.trim());
    form.append('file', file, file.name);
    setMessage(null);
    setProgress({ sent: 0, total: file.size });
    try {
      const res = await postMultipart<UploadResponse>(`/sources/${sourceId}/versions`, form, (sent, total) => setProgress({ sent, total })).promise;
      const r = res.results[0]!;
      const view = describeResult(r);
      if (r.status === 'accepted') {
        toast.show({ title: 'رُفعت نسخة جديدة؛ تبدأ معالجتها الآن', tone: 'success' });
        setFile(null);
        setNote('');
        await mutate(async () => undefined, ['/sources', '/library']);
      } else {
        setMessage(`${view.label}: ${view.detail ?? ''}`);
      }
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };
  return (
    <section className="ml-group" aria-labelledby="replace-title">
      <div className="ml-group__row ml-group__row--stack">
        <h3 id="replace-title" className="ml-field__label">
          رفع نسخة جديدة من هذا المصدر
        </h3>
        <p className="ml-field__hint">مثل محاضرة مصححة من المحاضر. تبقى النسخ السابقة كما هي، ويُنبَّه ما يعتمد عليها.</p>
        <div className="ml-cluster">
          <Button icon={<FileUp size={16} />} onClick={() => input.current?.click()} disabled={!!progress}>
            {file ? 'اختر ملفًا آخر' : 'اختر الملف'}
          </Button>
          {file && (
            <span className="ml-row__sub">
              <bdi>{file.name}</bdi> (<Bytes n={file.size} />)
            </span>
          )}
        </div>
        <input
          ref={input}
          type="file"
          className="ml-visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
        {file && <TextField label="ملاحظة عن هذه النسخة (اختياري)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} dir="auto" />}
        {progress && <ProgressBar label="رفع النسخة الجديدة" value={progress.sent} max={progress.total} valueText={`${formatBytes(progress.sent)} من ${formatBytes(progress.total)}`} />}
        {message && (
          <p className="ml-field__error" role="alert">
            {message}
          </p>
        )}
        {file && (
          <div>
            <Button variant="primary" onClick={() => void send()} loading={!!progress} loadingLabel="جارٍ الرفع…">
              رفع النسخة
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
