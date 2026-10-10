// Before downloading: what exactly will be stored, its real size, the questions-with-solutions choice, what an
// offline copy cannot do, and the browser's storage estimate. During: real byte progress. Cancel at any time.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CloudDownload } from 'lucide-react';
import type { OfflineManifestResponse } from '@medlevo/shared';
import { Bidi, Button, buttonClass, Checkbox, Dialog, ErrorState, LoadingState, ProgressBar } from '../../design';
import { Title } from './Mixed';
import { errorMessage } from '../../lib/api';
import { fetchOfflineManifest, formatBytes, storageInfo, type DownloadProgress, type OfflineDownload } from '../../lib/offline';
import { downloadForStudy } from './download';
import { manifestLines, storageSummary } from './model';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; manifest: OfflineManifestResponse }
  | { kind: 'downloading'; manifest: OfflineManifestResponse; progress: DownloadProgress | null }
  | { kind: 'done'; record: OfflineDownload }
  | { kind: 'error'; message: string; manifest: OfflineManifestResponse | null };

const PHASE_AR: Record<DownloadProgress['phase'], string> = {
  manifest: 'جارٍ تجهيز قائمة المحتوى…',
  space: 'جارٍ التحقق من المساحة المتاحة…',
  files: 'جارٍ تنزيل الملفات والتحقق من بصماتها…',
  data: 'جارٍ تنزيل الصفحات والملاحظات وكتاب الدراسة…',
  seed: 'جارٍ حفظ كتاباتك على هذا الجهاز…',
  done: 'اكتمل التنزيل.',
};

export function DownloadDialog({ sourceId, title, open, onClose }: { sourceId: string; title: string; open: boolean; onClose: () => void }) {
  const [includeSolutions, setIncludeSolutions] = useState(true);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ kind: 'loading' });
    void storageInfo().then((s) => alive && setEstimate(s));
    fetchOfflineManifest(sourceId, { includeSolutions })
      .then((manifest) => alive && setState({ kind: 'ready', manifest }))
      .catch((e: unknown) => alive && setState({ kind: 'error', message: errorMessage(e, 'تعذّر تجهيز قائمة المحتوى.'), manifest: null }));
    return () => {
      alive = false;
    };
  }, [open, sourceId, includeSolutions]);

  useEffect(() => () => ctrl.current?.abort(), []);

  const start = async (manifest: OfflineManifestResponse) => {
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ kind: 'downloading', manifest, progress: null });
    try {
      const record = await downloadForStudy(sourceId, {
        versionId: manifest.version.id,
        includeSolutions,
        signal: ac.signal,
        onProgress: (p) => setState((s) => (s.kind === 'downloading' ? { ...s, progress: p } : s)),
      });
      setState({ kind: 'done', record });
    } catch (e) {
      setState({ kind: 'error', message: errorMessage(e, 'تعذّر التنزيل.'), manifest });
    } finally {
      ctrl.current = null;
    }
  };

  const busy = state.kind === 'downloading';
  const manifest = state.kind === 'ready' || state.kind === 'downloading' ? state.manifest : state.kind === 'error' ? state.manifest : null;
  const storage = storageSummary(estimate);

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) ctrl.current?.abort();
        onClose();
      }}
      title={<>نزّل للعمل دون اتصال: <Title text={title} /></>}
      size="md"
      footer={
        state.kind === 'done' ? (
          <>
            <Link to={`/study/${encodeURIComponent(sourceId)}`} className={buttonClass({ variant: 'primary' })}>
              <BookOpen size={16} aria-hidden="true" /> افتح للدراسة
            </Link>
            <Button variant="plain" onClick={onClose}>
              إغلاق
            </Button>
          </>
        ) : busy ? (
          <Button variant="secondary" onClick={() => ctrl.current?.abort()}>
            أوقف التنزيل
          </Button>
        ) : (
          <>
            <Button variant="primary" icon={<CloudDownload size={16} />} disabled={state.kind !== 'ready'} onClick={() => state.kind === 'ready' && void start(state.manifest)}>
              {manifest ? <>نزّل (<Bidi dir="ltr">{formatBytes(manifest.totals.bytes)}</Bidi>)</> : 'نزّل'}
            </Button>
            <Button variant="plain" onClick={onClose}>
              إلغاء
            </Button>
          </>
        )
      }
    >
      {state.kind === 'loading' && <LoadingState inline stage="جارٍ تجهيز قائمة المحتوى وحجمه…" />}
      {state.kind === 'error' && <ErrorState inline title="لم يكتمل التنزيل" message={state.message} />}
      {manifest && state.kind !== 'done' && (
        <div className="dl-manifest">
          <p className="dl-meta">
            الإصدار {manifest.version.version_no}
            {manifest.version.is_active ? '' : ' (ليس الإصدار الذي تدرسه حاليًا)'} · حجم التنزيل الفعلي <Bidi dir="ltr">{formatBytes(manifest.totals.bytes)}</Bidi>
          </p>
          <h3 className="dl-subhead">ما سيُحفظ على هذا الجهاز</h3>
          <ul className="dl-lines">
            {manifestLines(manifest).map((l) => (
              <li key={l.key}>
                <span>{l.text}</span>
                {l.bytes !== undefined && (
                  <span className="dl-size">
                    <Bidi dir="ltr">{formatBytes(l.bytes)}</Bidi>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {manifest.contents.questions.linked > 0 && (
            <Checkbox
              checked={includeSolutions}
              onCheckedChange={setIncludeSolutions}
              disabled={busy}
              label="نزّل الأسئلة مع حلولها"
              description="إن أطفأته تُحفظ قائمة الأسئلة المرتبطة دون مفاتيح الإجابة وتفاصيلها."
            />
          )}
          <h3 className="dl-subhead">ما لا يعمل دون اتصال</h3>
          <ul className="dl-notes">
            {manifest.not_included_ar.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {storage && (
            <p className="dl-meta">
              يستخدم هذا الموقع الآن <Bidi dir="ltr">{storage.used}</Bidi> من نحو <Bidi dir="ltr">{storage.quota}</Bidi> يسمح بها المتصفح (تقدير المتصفح نفسه).
            </p>
          )}
        </div>
      )}
      {state.kind === 'downloading' && (
        <div className="dl-progress" aria-live="polite">
          <p>{PHASE_AR[state.progress?.phase ?? 'manifest']}</p>
          {state.progress && state.progress.bytesTotal > 0 ? (
            <ProgressBar
              label="تقدّم التنزيل"
              value={state.progress.bytesDone}
              max={state.progress.bytesTotal}
              valueText={`${formatBytes(state.progress.bytesDone)} من ${formatBytes(state.progress.bytesTotal)}`}
            />
          ) : (
            <ProgressBar label="تقدّم التنزيل" />
          )}
          {state.progress && state.progress.filesTotal > 0 && (
            <p className="dl-meta">
              الملفات: {state.progress.filesDone} من {state.progress.filesTotal}
            </p>
          )}
        </div>
      )}
      {state.kind === 'done' && (
        <div className="dl-done" role="status">
          <p>
            <strong>صار المصدر متاحًا دون اتصال على هذا الجهاز.</strong>
          </p>
          <p className="dl-meta">
            حُفظ <Bidi dir="ltr">{formatBytes(state.record.sizeBytes)}</Bidi>. يمكنك فتحه وقراءة صفحاته وكتابة الملاحظات والحبر دون اتصال؛ تُزامَن كتاباتك عند عودة الاتصال.
          </p>
        </div>
      )}
    </Dialog>
  );
}
