// التخزين ودون اتصال (§48 Storage & Offline, §47): what the server's data directory holds (measured), what this
// device stores for offline study, writes not yet synced, and the way to the Download Manager / backups / export.
import { useEffect, useState } from 'react';
import { Archive, CloudDownload, FileOutput } from 'lucide-react';
import { Bidi, ErrorState, ListItem, LoadingState } from '../../design';
import { storageInfo, unsyncedCount, useDownloads } from '../../lib/offline';
import { formatDateTime } from '../../lib/time';
import { controlApi } from './api';
import { formatBytes, formatCount } from './model';
import { SectionHeader, useLoad } from './shared';

function DeviceStorage() {
  const downloads = useDownloads();
  const [est, setEst] = useState<{ usage: number; quota: number; persisted: boolean | null } | null | undefined>(undefined);
  const [unsynced, setUnsynced] = useState<number | null>(null);
  useEffect(() => {
    void storageInfo()
      .then(setEst)
      .catch(() => setEst(null));
    void unsyncedCount()
      .then(setUnsynced)
      .catch(() => setUnsynced(null));
  }, []);
  const downloadedBytes = downloads?.reduce((n, d) => n + d.sizeBytes, 0) ?? 0;
  return (
    <section className="cc-block" aria-labelledby="cc-device-h">
      <h2 id="cc-device-h" className="cc-block__title">
        هذا الجهاز
      </h2>
      <dl className="cc-facts">
        <div className="cc-facts__row">
          <dt>مساحة المتصفح المستخدمة (تقدير المتصفح)</dt>
          <dd>
            {est === undefined ? '…' : est ? (
              <>
                <Bidi dir="ltr">{formatBytes(est.usage)}</Bidi> من <Bidi dir="ltr">{formatBytes(est.quota)}</Bidi> متاحة
              </>
            ) : (
              'لا يتيح هذا المتصفح قياسها'
            )}
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>التخزين الدائم</dt>
          <dd>{est?.persisted === true ? 'مفعّل: لن يحذف المتصفح بياناتك تلقائيًا عند ضيق المساحة' : est?.persisted === false ? 'غير مفعّل: قد يحذف المتصفح التنزيلات عند ضيق المساحة (كتابتك غير المتزامنة تبقى في قائمة الإرسال)' : 'غير معروف في هذا المتصفح'}</dd>
        </div>
        <div className="cc-facts__row">
          <dt>مصادر منزّلة للعمل دون اتصال</dt>
          <dd>
            {downloads === null ? '…' : downloads.length === 0 ? 'لا شيء' : <>{formatCount(downloads.length)} (<Bidi dir="ltr">{formatBytes(downloadedBytes)}</Bidi>)</>}
          </dd>
        </div>
        <div className="cc-facts__row">
          <dt>تغييرات لم تُزامَن بعد</dt>
          <dd>{unsynced === null ? 'غير معروف' : unsynced === 0 ? 'لا شيء' : `${formatCount(unsynced)} — لا تُحذف لتوفير المساحة`}</dd>
        </div>
      </dl>
      <ul role="list" className="ml-list cc-links">
        <ListItem to="/offline" leading={<CloudDownload size={20} />} title="التنزيلات للعمل دون اتصال" subtitle="ما على هذا الجهاز، وتنزيل مصادر جديدة، وإزالتها." />
        <ListItem to="/offline?tab=backups" leading={<Archive size={20} />} title="النسخ الاحتياطي" subtitle="إنشاء نسخة مختبرة واستعادتها." />
        <ListItem to="/offline?tab=export" leading={<FileOutput size={20} />} title="التصدير" subtitle="كتبك وملاحظاتك وأسئلتك مع مصادرها." />
      </ul>
    </section>
  );
}

export function StorageScreen() {
  const s = useLoad(() => controlApi.storage(), []);
  const d = s.data;
  return (
    <div className="cc-section">
      <SectionHeader title="التخزين ودون اتصال" lede="مساحة الخادم مقيسة من مجلد بياناته، ومساحة هذا الجهاز كما يقدّرها المتصفح. النسخة المنزّلة ليست نسخة احتياطية." />
      {s.error ? (
        <ErrorState inline message={s.error} onRetry={s.reload} />
      ) : !d ? (
        <LoadingState inline stage="جارٍ قياس مساحة الخادم…" />
      ) : (
        <section className="cc-block" aria-labelledby="cc-server-h">
          <h2 id="cc-server-h" className="cc-block__title">
            الخادم
          </h2>
          <p className="cc-storage__total">
            المجموع: <Bidi dir="ltr">{formatBytes(d.total_bytes)}</Bidi>
            <span className="cc-muted"> — قيس {formatDateTime(d.measured_at)}</span>
          </p>
          <div className="cc-table-wrap" role="region" aria-label="مساحة الخادم حسب الفئة" tabIndex={0}>
            <table className="cc-table">
              <thead>
                <tr>
                  <th scope="col">الفئة</th>
                  <th scope="col">ملفات</th>
                  <th scope="col">الحجم</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">قاعدة البيانات</th>
                  <td>{formatCount(d.database.files)}</td>
                  <td>
                    <Bidi dir="ltr">{formatBytes(d.database.bytes)}</Bidi>
                  </td>
                </tr>
                {d.files.categories.map((c) => (
                  <tr key={c.key}>
                    <th scope="row">
                      {c.label_ar}
                      {c.note_ar && <span className="cc-table__note">{c.note_ar}</span>}
                    </th>
                    <td>{formatCount(c.files)}</td>
                    <td>
                      <Bidi dir="ltr">{formatBytes(c.bytes)}</Bidi>
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">النسخ الاحتياطية</th>
                  <td>{formatCount(d.backups.count)}</td>
                  <td>
                    <Bidi dir="ltr">{formatBytes(d.backups.bytes)}</Bidi>
                  </td>
                </tr>
                {d.other.map((c) => (
                  <tr key={c.key}>
                    <th scope="row">
                      {c.label_ar}
                      {c.note_ar && <span className="cc-table__note">{c.note_ar}</span>}
                    </th>
                    <td>{formatCount(c.files)}</td>
                    <td>
                      <Bidi dir="ltr">{formatBytes(c.bytes)}</Bidi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="cc-notes">
            {d.notes_ar.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}
      <DeviceStorage />
    </div>
  );
}
