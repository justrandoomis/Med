// Download Manager (§47): what is on this device, add a source, storage (browser estimate + persistence on the
// owner's request only), unsynced writes, the storage policy, and the server-restore notice from sync.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, CloudDownload, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import type { SourceSummary } from '@medlevo/shared';
import { Bidi, Button, buttonClass, ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusPill, TextField, useToast } from '../../design';
import { Title } from './Mixed';
import { errorMessage } from '../../lib/api';
import {
  checkForUpdate,
  dismissServerRestoreNotice,
  formatBytes,
  removeDownload,
  requestPersistence,
  storageInfo,
  unsyncedCount,
  useDownloads,
  useServerRestoreNotice,
  type OfflineDownload,
} from '../../lib/offline';
import { formatDateTime } from '../../lib/time';
import { useOnline } from '../../lib/useOnline';
import { useSyncSnapshot } from '../../lib/sync';
import { dataApi } from './api';
import { DownloadDialog } from './DownloadDialog';
import { cardsAr, changesAr, downloadableSources, notesAr, pagesAr, questionsAr, STORAGE_POLICY_AR, storageSummary } from './model';

function partsText(d: OfflineDownload): string {
  const p: string[] = [];
  if (d.contents?.has_display_pdf) p.push('ملف PDF');
  p.push(pagesAr(d.pageCount ?? d.contents?.pages ?? 0));
  if (d.contents && (d.contents.annotations || d.contents.notes)) p.push(`كتاباتك (${notesAr(d.contents.notes)})`);
  if (d.contents?.study_book) p.push('كتاب الدراسة');
  if (d.contents?.questions.linked) p.push(d.includeSolutions ? `${questionsAr(d.contents.questions.linked)} مع الحلول` : `${questionsAr(d.contents.questions.linked)} دون حلول`);
  if (d.contents?.flashcards) p.push(cardsAr(d.contents.flashcards));
  return p.join(' · ');
}

function DownloadRow({ d, online }: { d: OfflineDownload; online: boolean }) {
  const toast = useToast();
  const [check, setCheck] = useState<null | 'checking' | 'current' | 'changed' | 'version_changed' | 'error'>(null);
  const [removing, setRemoving] = useState(false);
  const [updating, setUpdating] = useState(false);
  return (
    <li className="dl-row">
      <div className="dl-row__text">
        <span className="dl-row__title">
          <Title text={d.title ?? d.sourceId} />
        </span>
        <span className="dl-row__meta">
          الإصدار {d.versionNo} · <Bidi dir="ltr">{formatBytes(d.sizeBytes)}</Bidi> · نُزّل {formatDateTime(d.downloadedAt)}
        </span>
        <span className="dl-row__meta">{partsText(d)}</span>
        {check === 'current' && <StatusPill tone="success">مطابق لما في الخادم الآن</StatusPill>}
        {check === 'changed' && <StatusPill tone="warning">تغيّر المحتوى على الخادم منذ التنزيل — حدّث التنزيل</StatusPill>}
        {check === 'version_changed' && <StatusPill tone="warning">صار للمصدر إصدار آخر تدرسه — نزّله من جديد</StatusPill>}
        {check === 'error' && <StatusPill tone="danger">تعذّر التحقق الآن</StatusPill>}
      </div>
      <div className="dl-row__actions">
        <Link to={`/study/${encodeURIComponent(d.sourceId)}`} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
          <BookOpen size={16} aria-hidden="true" /> افتح
        </Link>
        <Button
          size="sm"
          variant="plain"
          icon={<RefreshCw size={16} />}
          loading={check === 'checking'}
          disabled={!online}
          title={online ? undefined : 'يحتاج اتصالًا'}
          onClick={async () => {
            setCheck('checking');
            try {
              setCheck(await checkForUpdate(d));
            } catch {
              setCheck('error');
            }
          }}
        >
          تحقّق من التحديث
        </Button>
        {(check === 'changed' || check === 'version_changed') && (
          <Button size="sm" variant="primary" disabled={!online} onClick={() => setUpdating(true)}>
            حدّث التنزيل
          </Button>
        )}
        <Button size="sm" variant="plain" icon={<Trash2 size={16} />} onClick={() => setRemoving(true)}>
          أزِل من الجهاز
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        title="إزالة التنزيل من هذا الجهاز؟"
        impact={
          <>
            ستُحذف من هذا الجهاز نسخة الملف والصفحات وكتاب الدراسة والأسئلة المحمّلة (<Bidi dir="ltr">{formatBytes(d.sizeBytes)}</Bidi>). كتاباتك وملاحظاتك
            ومحاولاتك تبقى، وما لم يُزامَن منها لا يُحذف أبدًا. يمكنك تنزيله من جديد عند توفر الاتصال.
          </>
        }
        confirmLabel="أزِل التنزيل"
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          try {
            await removeDownload(d.sourceId);
            toast.show({ title: 'أُزيل التنزيل من هذا الجهاز.', tone: 'success' });
          } catch {
            toast.show({ title: 'تعذّرت إزالة التنزيل الآن (تخزين المتصفح). لم يُحذف شيء من كتاباتك؛ أعد المحاولة.', tone: 'danger' });
          } finally {
            setRemoving(false);
          }
        }}
      />
      {updating && <DownloadDialog open sourceId={d.sourceId} title={d.title ?? ''} onClose={() => setUpdating(false)} />}
    </li>
  );
}

function StorageSection() {
  const sync = useSyncSnapshot();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof storageInfo>> | undefined>(undefined);
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const [asked, setAsked] = useState<null | 'granted' | 'refused' | 'unsupported'>(null);
  const refresh = () => {
    void storageInfo().then(setInfo);
    void unsyncedCount().then(setUnsynced).catch(() => setUnsynced(null));
  };
  useEffect(refresh, [sync.pending]);
  const s = storageSummary(info ?? null);
  return (
    <section className="dl-section" aria-labelledby="dl-storage">
      <h2 id="dl-storage" className="dl-section__title">
        <HardDrive size={18} aria-hidden="true" /> التخزين على هذا الجهاز
      </h2>
      {info === undefined ? (
        <LoadingState inline stage="جارٍ قراءة تقدير المتصفح…" />
      ) : s ? (
        <p>
          يستخدم هذا الموقع <Bidi dir="ltr">{s.used}</Bidi> من نحو <Bidi dir="ltr">{s.quota}</Bidi> يسمح بها المتصفح. (الأرقام تقدير يعطيه المتصفح نفسه.)
        </p>
      ) : (
        <p>هذا المتصفح لا يعطي تقديرًا للمساحة المستخدمة.</p>
      )}
      {unsynced !== null && (
        <p>
          {unsynced > 0 ? (
            <>على هذا الجهاز {changesAr(unsynced)} لم يصل إلى الخادم بعد. مدير التنزيلات لا يحذف شيئًا منها أبدًا.</>
          ) : (
            'كل ما كتبته على هذا الجهاز وصل إلى الخادم.'
          )}
        </p>
      )}
      <div className="dl-persist">
        {info?.persisted === true || asked === 'granted' ? (
          <>
            <StatusPill tone="success">التخزين الدائم مفعّل</StatusPill>
            <span className="dl-meta">لن يحذف المتصفح بيانات هذا الموقع تلقائيًا عند امتلاء الجهاز.</span>
          </>
        ) : (
          <>
            <StatusPill tone="warning">التخزين غير دائم</StatusPill>
            <span className="dl-meta">قد يحذف المتصفح بيانات هذا الموقع كلها عند امتلاء الجهاز.</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const r = await requestPersistence();
                setAsked(r === true ? 'granted' : r === null ? 'unsupported' : 'refused');
                refresh();
              }}
            >
              اطلب التخزين الدائم
            </Button>
          </>
        )}
        {asked === 'refused' && <p className="dl-meta">لم يمنحه المتصفح الآن. القرار للمتصفح؛ بعضها يمنحه للتطبيقات المثبّتة على الشاشة الرئيسية أو كثيرة الاستخدام.</p>}
        {asked === 'unsupported' && <p className="dl-meta">هذا المتصفح لا يدعم طلب التخزين الدائم.</p>}
      </div>
      <ul className="dl-notes">
        {STORAGE_POLICY_AR.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </section>
  );
}

function AddSourceSection({ online, downloaded }: { online: boolean; downloaded: Set<string> }) {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<SourceSummary | null>(null);
  useEffect(() => {
    if (!online) return;
    let alive = true;
    dataApi
      .libraryTree()
      .then((t) => alive && setSources(t.sources))
      .catch((e: unknown) => alive && setError(errorMessage(e, 'تعذّر تحميل المكتبة.')));
    return () => {
      alive = false;
    };
  }, [online]);
  const list = useMemo(() => (sources ? downloadableSources(sources, q).slice(0, 50) : []), [sources, q]);
  return (
    <section className="dl-section" aria-labelledby="dl-add">
      <h2 id="dl-add" className="dl-section__title">
        <CloudDownload size={18} aria-hidden="true" /> نزّل مصدرًا من مكتبتك
      </h2>
      {!online ? (
        <p>يحتاج التنزيل اتصالًا بالخادم. ما نُزّل سابقًا يبقى متاحًا أعلاه.</p>
      ) : error ? (
        <ErrorState inline message={error} />
      ) : !sources ? (
        <LoadingState inline stage="جارٍ تحميل المكتبة…" />
      ) : (
        <>
          <TextField label="ابحث عن مصدر" hideLabel placeholder="ابحث بعنوان المحاضرة أو المرجع" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          {list.length === 0 ? (
            <p className="dl-meta">لا توجد مصادر جاهزة للتنزيل{q ? ' تطابق البحث' : ''}.</p>
          ) : (
            <ul className="dl-list" role="list">
              {list.map((s) => (
                <li key={s.id} className="dl-pick">
                  <span className="dl-pick__title">
                    <Title text={s.title} />
                    <span className="dl-row__meta">{s.page_count ? pagesAr(s.page_count) : s.format ?? ''}</span>
                  </span>
                  {downloaded.has(s.id) ? (
                    <StatusPill tone="success">على هذا الجهاز</StatusPill>
                  ) : (
                    <Button size="sm" variant="secondary" icon={<CloudDownload size={16} />} onClick={() => setPicked(s)}>
                      تنزيل
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {picked && <DownloadDialog open sourceId={picked.id} title={picked.title} onClose={() => setPicked(null)} />}
    </section>
  );
}

export function DownloadsPanel() {
  const online = useOnline();
  const downloads = useDownloads();
  const notice = useServerRestoreNotice();
  const downloadedIds = useMemo(() => new Set((downloads ?? []).map((d) => d.sourceId)), [downloads]);
  const total = (downloads ?? []).reduce((a, d) => a + d.sizeBytes, 0);
  return (
    <div className="dl-stack">
      <p className="dl-lede">
        التنزيل يجعل المحاضرة تُفتح وتُقرأ ويُكتب عليها دون اتصال، مع كتاب الدراسة والأسئلة المرتبطة. هو نسخة مؤقتة على هذا الجهاز، وليس نسخة احتياطية.
      </p>
      {notice && (
        <div className="dl-notice" role="status">
          <p>
            <strong>استُعيدت بيانات الخادم من نسخة احتياطية.</strong> اكتُشف ذلك في {formatDateTime(notice.at)}، فجُلبت البيانات من جديد
            {notice.resent > 0 ? ` وأُعيد إرسال ${changesAr(notice.resent)} من كتاباتك على هذا الجهاز لم تكن في تلك النسخة.` : '؛ لم يكن على هذا الجهاز ما يلزم إعادة إرساله.'}
          </p>
          <Button size="sm" variant="plain" onClick={() => void dismissServerRestoreNotice()}>
            فهمت
          </Button>
        </div>
      )}
      <section className="dl-section" aria-labelledby="dl-here">
        <h2 id="dl-here" className="dl-section__title">
          على هذا الجهاز {downloads && downloads.length > 0 && <span className="dl-row__meta">(<Bidi dir="ltr">{formatBytes(total)}</Bidi>)</span>}
        </h2>
        {downloads === null ? (
          <LoadingState inline stage="جارٍ قراءة التنزيلات…" />
        ) : downloads.length === 0 ? (
          <EmptyState headingLevel={3} title="لا يوجد مصدر محمّل على هذا الجهاز بعد" description="اختر محاضرة من القائمة أدناه لتنزيلها مع كتاباتك عليها وكتاب الدراسة والأسئلة المرتبطة." />
        ) : (
          <ul className="dl-list" role="list">
            {downloads.map((d) => (
              <DownloadRow key={d.sourceId} d={d} online={online} />
            ))}
          </ul>
        )}
      </section>
      <AddSourceSection online={online} downloaded={downloadedIds} />
      <StorageSection />
    </div>
  );
}
