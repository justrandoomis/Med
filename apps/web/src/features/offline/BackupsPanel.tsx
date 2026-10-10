// Backups (§49, AC-30): create (server job), list with real sizes and contents, authenticated download, restore
// verification in a separate directory on the server, delete (with impact). The CLI commands are shown too.
import { useCallback, useEffect, useState } from 'react';
import { Archive, Download, ShieldCheck, Trash2 } from 'lucide-react';
import type { BackupsListResponse, BackupView } from '@medlevo/shared';
import { Bidi, Button, buttonClass, ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusPill, useToast } from '../../design';
import { Mixed } from './Mixed';
import { errorMessage } from '../../lib/api';
import { formatBytes } from '../../lib/offline';
import { formatDateTime } from '../../lib/time';
import { useOnline } from '../../lib/useOnline';
import { dataApi } from './api';
import { backupTone, filesAr } from './model';

const STAGE_AR: Record<string, string> = {
  snapshot: 'لقطة متسقة من قاعدة البيانات',
  database: 'نسخ قاعدة البيانات',
  files: 'نسخ الملفات والتحقق من بصماتها',
  verify: 'استعادة تجريبية في مجلد منفصل',
};

function BackupRow({ b, onChanged }: { b: BackupView; onChanged: () => void }) {
  const online = useOnline();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const job = b.job && (b.job.status === 'queued' || b.job.status === 'running') ? b.job : null;
  return (
    <li className="dl-row">
      <div className="dl-row__text">
        <span className="dl-row__title">نسخة {formatDateTime(b.created_at)}</span>
        <span className="dl-row__meta">
          <StatusPill tone={backupTone(b)}>{b.status_label_ar}</StatusPill>
          {b.size !== null && (
            <>
              {' '}
              · <Bidi dir="ltr">{formatBytes(b.size)}</Bidi>
            </>
          )}
          {b.summary && <> · {filesAr(b.summary.files)} · {b.summary.rows} صفًّا في {b.summary.tables} جدولًا</>}
          {b.origin === 'cli' && ' · من سطر الأوامر'}
        </span>
        {job && (
          <LoadingState inline stage={`${STAGE_AR[job.progress?.stage ?? ''] ?? job.status_label_ar}…`} done={job.progress?.done} total={job.progress?.total} unit={job.progress?.unit === 'files' ? 'ملف' : undefined} />
        )}
        {b.error_ar && <p className="dl-error">{b.error_ar}</p>}
        {b.warnings_ar.map((w) => (
          <p key={w} className="dl-warn">
            {w}
          </p>
        ))}
        {b.verification ? (
          <p className={b.verification.status === 'passed' ? 'dl-ok' : 'dl-error'}>
            {b.verification.status === 'passed' ? 'اختُبرت الاستعادة: ' : 'فشلت الاستعادة التجريبية: '}
            {b.verification.summary_ar} ({formatDateTime(b.verification.verified_at)})
          </p>
        ) : (
          (b.status === 'completed' || b.status === 'completed_with_warnings') && <p className="dl-meta">لم تُختبر استعادة هذه النسخة بعد. النسخة غير المختبرة ليست ضمانًا.</p>
        )}
        {b.sha256 && (
          <p className="dl-meta dl-hash">
            SHA-256: <code dir="ltr">{b.sha256}</code>
          </p>
        )}
      </div>
      <div className="dl-row__actions">
        {b.download_url && (
          <a className={buttonClass({ variant: 'secondary', size: 'sm' })} href={b.download_url} download={b.file_name}>
            <Download size={16} aria-hidden="true" /> نزّل النسخة
          </a>
        )}
        {(b.status === 'completed' || b.status === 'completed_with_warnings') && b.download_url && (
          <Button
            size="sm"
            variant="plain"
            icon={<ShieldCheck size={16} />}
            loading={busy || !!job}
            disabled={!online}
            onClick={async () => {
              setBusy(true);
              try {
                await dataApi.verifyBackup(b.id);
                onChanged();
              } catch (e) {
                toast.show({ title: errorMessage(e), tone: 'danger' });
              } finally {
                setBusy(false);
              }
            }}
          >
            تحقّق من الاستعادة
          </Button>
        )}
        {b.status !== 'running' && (
          <Button size="sm" variant="plain" icon={<Trash2 size={16} />} disabled={!online} onClick={() => setDeleting(true)}>
            احذف
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={deleting}
        destructive
        title="حذف ملف هذه النسخة الاحتياطية؟"
        impact="سيُحذف ملف النسخة من الخادم نهائيًا. بياناتك الحالية لا تتأثر، لكن لن تستطيع الاستعادة من هذه النسخة إلا إن كنت نزّلتها وحفظتها في مكان آخر."
        confirmLabel="احذف النسخة"
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await dataApi.deleteBackup(b.id);
            onChanged();
          } catch (e) {
            toast.show({ title: errorMessage(e, 'تعذّر حذف النسخة.'), tone: 'danger' });
          } finally {
            setDeleting(false);
          }
        }}
      />
    </li>
  );
}

export function BackupsPanel() {
  const online = useOnline();
  const toast = useToast();
  const [data, setData] = useState<BackupsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await dataApi.backups());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر تحميل قائمة النسخ الاحتياطية.'));
    }
  }, []);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  // poll while a backup or a verification is running (real job state, no invented progress)
  const active = (data?.backups ?? []).some((b) => b.status === 'running' || (b.job && (b.job.status === 'queued' || b.job.status === 'running')));
  useEffect(() => {
    if (!active || !online) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [active, online, load]);

  if (!online && !data) {
    return <EmptyState headingLevel={3} icon={<Archive size={24} />} title="النسخ الاحتياطي يحتاج اتصالًا بالخادم" description="النسخ تُنشأ وتُحفظ على الخادم. عند عودة الاتصال يمكنك إنشاء نسخة وتنزيلها." />;
  }
  return (
    <div className="dl-stack">
      <p className="dl-lede">النسخة الاحتياطية ملف واحد يحوي قاعدة البيانات كاملة وكل الملفات مع بصماتها. أنشئ نسخة، ثم نزّلها واحتفظ بها خارج هذا الجهاز، واختبر استعادتها.</p>
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
      <div className="dl-actions">
        <Button
          variant="primary"
          icon={<Archive size={16} />}
          loading={creating}
          disabled={!online || active}
          onClick={async () => {
            setCreating(true);
            try {
              await dataApi.createBackup();
              await load();
            } catch (e) {
              toast.show({ title: errorMessage(e), tone: 'danger' });
            } finally {
              setCreating(false);
            }
          }}
        >
          أنشئ نسخة احتياطية الآن
        </Button>
        {!online && <span className="dl-meta">يحتاج اتصالًا.</span>}
      </div>
      {data && (
        <>
          {data.backups.length === 0 ? (
            <EmptyState headingLevel={3} title="لا توجد نسخ احتياطية بعد" description="أنشئ أول نسخة الآن؛ تستغرق ثوانيَ أو دقائق بحسب حجم مكتبتك." />
          ) : (
            <ul className="dl-list" role="list">
              {data.backups.map((b) => (
                <BackupRow key={b.id} b={b} onChanged={() => void load()} />
              ))}
            </ul>
          )}
          <section className="dl-section" aria-labelledby="bk-what">
            <h2 id="bk-what" className="dl-section__title">ما الذي تحويه النسخة</h2>
            <ul className="dl-notes">
              {data.included_ar.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <h3 className="dl-subhead">ما لا تحويه أبدًا</h3>
            <ul className="dl-notes">
              {data.excluded_ar.map((x) => (
                <li key={x}>
                  <Mixed text={x} />
                </li>
              ))}
            </ul>
            <p className="dl-meta">{data.storage_note_ar}</p>
            <h3 className="dl-subhead">من سطر الأوامر على الخادم</h3>
            <pre className="dl-code" dir="ltr">
              {'npm run backup\nnpm run restore:verify -- <archive.tar.gz>\nnpm run restore:verify -- <archive.tar.gz> -- --target <empty-dir>'}
            </pre>
            <p className="dl-meta">الاستعادة لا تكتب فوق بيانات قائمة: تتم في مجلد فارغ فقط، بعد نجاح كل الفحوص. التفاصيل في docs/BACKUP_RESTORE.md.</p>
          </section>
        </>
      )}
      {!data && !error && <LoadingState inline stage="جارٍ تحميل النسخ الاحتياطية…" />}
    </div>
  );
}
