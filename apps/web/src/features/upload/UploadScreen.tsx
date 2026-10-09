// رفع المصادر (§13 upload part, §49): choose where, drop files, see per-file results with reasons,
// real byte progress while sending, then real processing counts per accepted file.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CopyPlus, FileUp, FolderInput, RotateCcw, X } from 'lucide-react';
import {
  SOURCE_TYPE_LABELS_AR,
  SOURCE_TYPES,
  type SourceType,
  type UploadFileResult,
  type UploadInfoResponse,
  type UploadResponse,
} from '@medlevo/shared';
import { Bidi, Button, buttonClass, EmptyState, ErrorState, IconButton, LoadingState, ProgressBar, Select, StatusPill, Term } from '../../design';
import { errorMessage } from '../../lib/api';
import { FeatureGate, useCapabilities } from '../../lib/capabilities';
import { usePageTitle } from '../../lib/usePageTitle';
import { invalidate, useQuery } from '../library/data';
import { MoveDialog } from '../library/components/FolderPicker';
import { Bytes, countAr, formatBytes, NOUN } from '../library/labels';
import { pathOf } from '../library/model';
import { useLibrary } from '../library/useLibrary';
import { ProcessingStatusView, useProcessingStatus } from '../sources/ProcessingStatus';
import { batchSummary, describeItem, type QueueItem } from './results';
import { postMultipart } from './uploadXhr';
import '../library/library.css';
import './upload.css';

const ACCEPT = '.pdf,.docx,.pptx,.doc,.ppt,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.zip,.mp3,.m4a,.wav,.ogg,application/pdf,image/*,audio/*';
let keySeq = 0;

export function UploadScreen() {
  usePageTitle('رفع مصادر');
  const [params] = useSearchParams();
  // archived folders are valid destinations too (the folder screen of an archived folder links here)
  const lib = useLibrary('archived');
  const info = useQuery<UploadInfoResponse>('/sources/upload-info');
  const [nodeId, setNodeId] = useState<string | null>(params.get('node'));
  const [type, setType] = useState<'' | SourceType>('');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<string, () => void>());
  const node = nodeId && lib.index ? lib.index.nodes.get(nodeId) : undefined;
  const path = node && lib.index ? pathOf(lib.index, node.id) : [];
  // only a folder that exists in the (non-trashed) library is a destination — a stale ?node= (trashed
  // or deleted folder) must not be used silently while the screen says «no folder chosen»
  const targetId = node ? node.id : null;

  useEffect(() => () => aborts.current.forEach((a) => a()), []);

  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list);
    if (files.length === 0) return;
    setItems((cur) => [...cur, ...files.map((file) => ({ key: `f${++keySeq}`, file, status: 'waiting' as const, sent: 0, total: file.size }))]);
  };
  const update = (key: string, patch: Partial<QueueItem>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const uploadOne = async (item: QueueItem) => {
    if (!targetId) return;
    const form = new FormData();
    form.append('node_id', targetId);
    if (type) form.append('source_type', type);
    if (item.forceCopy) form.append('on_duplicate', 'create');
    form.append('files', item.file, item.file.name);
    update(item.key, { status: 'uploading', sent: 0, total: item.file.size, error: undefined, result: undefined });
    const h = postMultipart<UploadResponse>('/sources/upload', form, (sent, total) => update(item.key, { sent, total, status: sent >= total ? 'checking' : 'uploading' }));
    aborts.current.set(item.key, h.abort);
    try {
      const res = await h.promise;
      const r = res.results[0];
      if (!r) update(item.key, { status: 'error', error: 'لم يُرجع الخادم نتيجة لهذا الملف.' });
      else update(item.key, { status: r.status, result: r });
    } catch (e) {
      update(item.key, { status: 'error', error: errorMessage(e) });
    } finally {
      aborts.current.delete(item.key);
    }
  };

  const start = async () => {
    if (!targetId || running) return;
    setRunning(true);
    try {
      // one file per request: real per-file progress, and one failure never blocks the others
      for (const item of items.filter((i) => i.status === 'waiting')) await uploadOne(item);
    } finally {
      setRunning(false);
      invalidate('/library');
    }
  };

  const retry = async (item: QueueItem, forceCopy = false) => {
    if (running) return;
    setRunning(true);
    try {
      await uploadOne({ ...item, forceCopy });
    } finally {
      setRunning(false);
      invalidate('/library');
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const waiting = items.filter((i) => i.status === 'waiting').length;
  const summary = batchSummary(items);
  const typeOptions = useMemo(
    () => [{ value: '' as const, label: 'اقتراح تلقائي من اسم كل ملف' }, ...SOURCE_TYPES.map((t) => ({ value: t, label: SOURCE_TYPE_LABELS_AR[t] }))],
    [],
  );

  if (lib.loading && !lib.data) return <LoadingState stage="جارٍ تحميل المكتبة…" />;
  return (
    <div className="ml-page ml-page--narrow ml-upload">
      <header className="ml-page__header">
        <h1 className="ml-page__title">رفع مصادر</h1>
        <p className="ml-page__lede">ارفع محاضراتك ومراجعك ومصادر أسئلتك. يُفحص كل ملف من محتواه لا من امتداده، ويُذكر سبب أي رفض.</p>
      </header>

      {lib.error && !lib.data && <ErrorState message={lib.error.message} onRetry={() => void lib.refresh()} />}
      {lib.index && lib.index.nodes.size === 0 && (
        <EmptyState
          title="أنشئ دفترًا أولًا"
          description="كل مصدر يُحفظ داخل دفتر أو مجلد في مكتبتك."
          actions={
            <Link to="/library" className={buttonClass({ variant: 'primary' })}>
              إلى المكتبة
            </Link>
          }
        />
      )}

      {lib.index && lib.index.nodes.size > 0 && (
        <FeatureGate feature="upload">
          <div className="ml-stack">
            <section className="ml-group" aria-label="إعدادات الرفع">
              <div className="ml-group__row ml-upload__dest">
                <div className="ml-row__text">
                  <span className="ml-field__label" id="dest-label">
                    مكان الحفظ
                  </span>
                  <span className="ml-row__sub" aria-labelledby="dest-label">
                    {node ? <bdi>{path.map((p) => p.title).join(' / ')}</bdi> : 'لم تختر مجلدًا بعد'}
                  </span>
                </div>
                <Button icon={<FolderInput size={18} />} onClick={() => setPicking(true)} disabled={running}>
                  {node ? 'تغيير' : 'اختر مجلدًا'}
                </Button>
              </div>
              <div className="ml-group__row">
                <Select<'' | SourceType>
                  label="نوع المصدر"
                  hint="اترك الاقتراح التلقائي إن رفعت أنواعًا مختلفة معًا؛ يمكنك تصحيح نوع أي مصدر لاحقًا."
                  options={typeOptions}
                  value={type}
                  onValueChange={setType}
                  disabled={running}
                />
              </div>
            </section>

            <div
              className="ml-dropzone ml-paper"
              data-over={dragOver ? 'true' : undefined}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <FileUp size={28} aria-hidden="true" />
              <p className="ml-dropzone__title">اسحب الملفات إلى هنا</p>
              <Button variant="secondary" onClick={() => inputRef.current?.click()}>
                اختر ملفات من جهازك
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="ml-visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <p className="ml-dropzone__formats">
                الصيغ المقبولة: <Term>PDF</Term>، <Term>DOCX</Term>، <Term>PPTX</Term>، الصور بصيغ <Term>PNG</Term> و<Term>JPEG</Term> و<Term>WebP</Term> و<Term>GIF</Term> و<Term>TIFF</Term>، ملف <Term>ZIP</Term> لمجموعة صور مرتبة، والتسجيلات الصوتية.
                {info.data && (
                  <>
                    {' '}
                    الحد الأقصى لكل ملف: <Bidi dir="ltr">{formatBytes(info.data.max_upload_bytes)}</Bidi>.
                    {info.data.legacy_office ? (
                      <>
                        {' '}
                        ملفات <Term>DOC</Term> و<Term>PPT</Term> القديمة تُحوَّل عبر <Term>LibreOffice</Term>.
                      </>
                    ) : (
                      <>
                        {' '}
                        ملفات <Term>DOC</Term> و<Term>PPT</Term> القديمة غير مدعومة على هذا الخادم (يلزم <Term>LibreOffice</Term>).
                      </>
                    )}
                  </>
                )}
              </p>
              {info.data && !info.data.processing_available && (
                <p className="ml-proc__warn">وحدة معالجة المستندات غير متاحة على هذا الخادم الآن: ستُحفظ الملفات، وتبدأ معالجتها عند توفرها.</p>
              )}
            </div>

            {items.length > 0 && (
              <section aria-labelledby="queue-title">
                <div className="ml-library__section-head">
                  <h2 id="queue-title" className="ml-library__section-title">
                    الملفات ({countAr(items.length, NOUN.file)})
                  </h2>
                  {summary && (
                    <span className="ml-library__section-note" role="status">
                      {summary}
                    </span>
                  )}
                </div>
                <ul className="ml-list ml-upload__list" role="list">
                  {items.map((item) => (
                    <UploadRow
                      key={item.key}
                      item={item}
                      busy={running}
                      onRemove={() => setItems((cur) => cur.filter((i) => i.key !== item.key))}
                      onCancel={() => aborts.current.get(item.key)?.()}
                      onRetry={() => void retry(item)}
                      onAddAnyway={() => void retry(item, true)}
                    />
                  ))}
                </ul>
                <div className="ml-upload__actions">
                  {(waiting > 0 || running) && (
                    <Button variant="primary" icon={<FileUp size={18} />} onClick={() => void start()} disabled={!targetId} loading={running} loadingLabel="جارٍ الرفع…">
                      رفع {countAr(Math.max(waiting, 1), NOUN.file)}
                    </Button>
                  )}
                  {!targetId && <span className="ml-field__hint">اختر مكان الحفظ أولًا.</span>}
                  {node && !running && waiting === 0 && (
                    <Link to={`/library/${node.id}`} className={buttonClass({ variant: 'plain' })}>
                      فتح المجلد
                    </Link>
                  )}
                </div>
              </section>
            )}
          </div>
        </FeatureGate>
      )}

      {lib.index && (
        <MoveDialog
          open={picking}
          title="اختر مكان حفظ الملفات"
          index={lib.index}
          initial={targetId}
          allowRoot={false}
          confirmLabel="اختيار هذا المجلد"
          onConfirm={async (target) => {
            if (target) setNodeId(target);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

export function UploadRow({
  item,
  busy,
  onRemove,
  onCancel,
  onRetry,
  onAddAnyway,
}: {
  item: QueueItem;
  busy: boolean;
  onRemove: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onAddAnyway: () => void;
}) {
  const view = describeItem(item);
  const r = item.result;
  return (
    <li className="ml-upload__item">
      <div className="ml-upload__head">
        <span className="ml-row__text">
          <span className="ml-row__title"><bdi>{item.file.name}</bdi></span>
          {item.status === 'waiting' ? (
            <span className="ml-row__sub ml-upload__detail">
              <Bytes n={item.file.size} />
            </span>
          ) : item.status === 'uploading' ? (
            <span className="ml-row__sub ml-upload__detail">
              <Bytes n={item.sent} /> من <Bytes n={item.total || item.file.size} />
            </span>
          ) : (
            view.detail && <span className="ml-row__sub ml-upload__detail">{view.detail}</span>
          )}
        </span>
        <StatusPill tone={view.tone}>{view.label}</StatusPill>
        {item.status === 'waiting' && <IconButton label={`إزالة «${item.file.name}» من القائمة`} icon={<X size={18} />} size="sm" onClick={onRemove} />}
        {item.status === 'uploading' && <IconButton label={`إلغاء رفع «${item.file.name}»`} icon={<X size={18} />} size="sm" onClick={onCancel} />}
      </div>
      {(item.status === 'uploading' || item.status === 'checking') && (
        <ProgressBar
          label={`رفع «${item.file.name}»`}
          value={item.status === 'uploading' ? item.sent : undefined}
          max={item.status === 'uploading' ? item.total || item.file.size : undefined}
          valueText={view.detail ?? undefined}
        />
      )}
      {item.status === 'error' && (
        <div className="ml-upload__row-actions">
          <Button size="sm" icon={<RotateCcw size={16} />} onClick={onRetry} disabled={busy}>
            إعادة المحاولة
          </Button>
        </div>
      )}
      {r?.status === 'duplicate' && r.duplicate_of && (
        <div className="ml-upload__row-actions">
          <Link to={`/sources/${r.duplicate_of.source_id}`} className={buttonClass({ size: 'sm', variant: 'secondary' })}>
            فتح الموجود: <bdi>{r.duplicate_of.title}</bdi>
          </Link>
          <Button size="sm" variant="plain" icon={<CopyPlus size={16} />} onClick={onAddAnyway} disabled={busy}>
            أضفه نسخةً مستقلة
          </Button>
        </div>
      )}
      {r?.rejected_entries && r.rejected_entries.length > 0 && (
        <details className="ml-upload__entries">
          <summary>عناصر استُبعدت من الأرشيف ({r.rejected_entries.length})</summary>
          <ul>
            {r.rejected_entries.map((e) => (
              <li key={e.name}>
                <Bidi dir="ltr">{e.name}</Bidi>: {e.reason_ar}
              </li>
            ))}
          </ul>
        </details>
      )}
      {r?.status === 'accepted' && r.version_id && r.source_id && <AcceptedProcessing sourceId={r.source_id} versionId={r.version_id} format={r.detected_format} />}
    </li>
  );
}

function AcceptedProcessing({ sourceId, versionId, format }: { sourceId: string; versionId: string; format: UploadFileResult['detected_format'] }) {
  const { status, error } = useProcessingStatus(versionId);
  const reader = useCapabilities().feature('workspace.reader');
  const fmt = format === 'zip' ? 'image_set' : format === 'doc' || format === 'ppt' || format === 'unknown' ? 'pdf' : format;
  const ready = status?.summary?.pages_ready ?? 0;
  return (
    <div className="ml-upload__processing">
      <ProcessingStatusView status={status} format={fmt ?? null} error={error} />
      <div className="ml-upload__row-actions">
        <Link to={`/sources/${sourceId}`} className={buttonClass({ size: 'sm', variant: 'secondary' })}>
          التفاصيل والصفحات
        </Link>
        {ready > 0 && reader.available && (
          <Link to={`/study/${sourceId}`} className={buttonClass({ size: 'sm', variant: 'plain' })}>
            افتح للقراءة ({countAr(ready, NOUN.page)} جاهزة)
          </Link>
        )}
      </div>
    </div>
  );
}
