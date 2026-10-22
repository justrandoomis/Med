// «الخصوصية والبيانات» — /me/privacy (P1-T4 step 3; IA §4.14; PRD Q14; P1-T1's /api/accounts/me/export(s), /me/delete).
//  * «نسخة من بياناتي»: an archive of the student's OWN vault, built on the server, downloadable while it is kept;
//  * deleting the account: an impact preview first (what is deleted, that the name shows «طالب سابق», that forks
//    others already made stay), then the password — nothing is deleted by the preview;
//  * the operator note of IA §4.14, said plainly.
// AI-processing and transcription consents arrive with the features that need them; they are not shown before.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Trash2 } from 'lucide-react';
import type { AccountExportsResponse, AccountExportView, DeletionPreview, JobStatus } from '@medlevo/shared';
import { Breadcrumbs, Button, Dialog, ErrorState, LoadingState, PasswordField, StatusPill, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { forgetAuth } from '../../lib/auth';
import { formatDateTime } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { useOnline } from '../../lib/useOnline';
import { ReasonedButton } from '../channels/ui';
import { countAr, formatSize, meApi } from './api';
import './me.css';

const STATUS_AR: Record<JobStatus, string> = {
  queued: 'في الانتظار',
  running: 'قيد الإنشاء',
  waiting_for_input: 'بانتظار إجراء',
  partial: 'اكتملت مع نقص',
  completed: 'جاهزة',
  failed: 'تعذّر إنشاؤها',
  cancelled: 'أُلغيت',
};
const RUNNING: ReadonlySet<JobStatus> = new Set(['queued', 'running']);

export function PrivacyScreen() {
  usePageTitle('الخصوصية والبيانات');
  const toast = useToast();
  const online = useOnline();
  const [data, setData] = useState<AccountExportsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const load = useCallback(() => {
    meApi
      .exports()
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  const running = data?.exports.some((x) => RUNNING.has(x.status)) ?? false;
  // while an archive is being built, ask again every few seconds (stops when it is done or the screen closes)
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running, load]);

  const start = async () => {
    setStarting(true);
    try {
      const r = await meApi.startExport();
      setData((d) => (d ? { ...d, exports: [r.export, ...d.exports.filter((x) => x.job_id !== r.job_id)] } : d));
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="ml-page ml-page--narrow me-screen">
      <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'الخصوصية والبيانات' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">الخصوصية والبيانات</h1>
      </header>

      <section className="me-section" aria-labelledby="me-export-h">
        <h2 id="me-export-h" className="me-section__title">
          نسخة من بياناتي
        </h2>
        {error && !data ? (
          <ErrorState inline message={error} onRetry={load} />
        ) : !data ? (
          <LoadingState inline stage="جارٍ التحميل…" />
        ) : (
          <div className="ml-stack">
            <ul className="me-bullets">
              {data.included_ar.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p className="me-note">{data.note_ar}</p>
            <ReasonedButton
              variant="primary"
              icon={<Download size={18} />}
              loading={starting}
              reason={!online ? 'إنشاء النسخة يحتاج اتصالًا بالخادم.' : running ? 'هناك نسخة قيد الإنشاء الآن. انتظر اكتمالها.' : null}
              onClick={() => void start()}
            >
              أنشئ نسخة من بياناتي
            </ReasonedButton>
            {data.exports.length > 0 && (
              <ul role="list" className="ml-list">
                {data.exports.map((x) => (
                  <ExportRow key={x.job_id} x={x} />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="me-section" aria-labelledby="me-delete-h">
        <h2 id="me-delete-h" className="me-section__title">
          حذف الحساب
        </h2>
        <p className="me-note">يُعرض لك أولًا ما سيُحذف وما لا يمكن حذفه، ثم يُطلب منك تأكيد كلمة المرور.</p>
        <ReasonedButton variant="destructive" icon={<Trash2 size={18} />} reason={online ? null : 'حذف الحساب يحتاج اتصالًا بالخادم.'} onClick={() => setDeleteOpen(true)}>
          احذف حسابي…
        </ReasonedButton>
      </section>

      <section className="me-section" aria-labelledby="me-operator-h">
        <h2 id="me-operator-h" className="me-section__title">
          من يرى بياناتك
        </h2>
        <p className="me-note">
          لا تعرض أي شاشة في التطبيق بياناتك الخاصة لمستخدم آخر أو لمشرف. من يدير الخادم يستطيع تقنيًا الوصول إلى الملفات والنسخ الاحتياطية، وتُشفَّر النسخ قبل خروجها من الخادم.
        </p>
      </section>

      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}

function ExportRow({ x }: { x: AccountExportView }) {
  const tone = x.status === 'completed' ? 'success' : x.status === 'failed' ? 'danger' : x.status === 'partial' ? 'warning' : 'info';
  return (
    <li className="ml-list__row me-export">
      <div className="me-export__text">
        <span>{formatDateTime(x.created_at)}</span>
        <span className="me-export__meta">
          {x.size !== null ? formatSize(x.size) : ''}
          {x.missing_files ? ` · ${x.missing_files} ملفات ناقصة` : ''}
        </span>
        {x.warning_ar && <span className="me-export__warn">{x.warning_ar}</span>}
        {x.error_ar && <span className="me-export__warn">{x.error_ar}</span>}
      </div>
      <StatusPill tone={tone}>{STATUS_AR[x.status]}</StatusPill>
      {x.download_url && (
        <a className="ml-btn ml-btn--secondary ml-btn--sm" href={x.download_url} download={x.file_name ?? undefined}>
          نزّل النسخة
        </a>
      )}
    </li>
  );
}

/** The impact preview first (POST {preview:true} deletes nothing), then the password. */
function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    meApi
      .deletePreview()
      .then(setPreview)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const v = preview?.vault;
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await meApi.deleteConfirm(preview.confirm_token, password);
      forgetAuth();
      navigate('/login', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="حذف الحساب"
      description="لا يُحذف شيء قبل أن تكتب كلمة المرور وتؤكد."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <ReasonedButton
            variant="destructive"
            loading={busy}
            reason={!preview ? (error ? 'تعذّر حساب ما سيُحذف.' : 'جارٍ حساب ما سيُحذف…') : (preview.blocked_ar ?? (password.length === 0 ? 'اكتب كلمة المرور أولًا.' : null))}
            onClick={() => void confirm()}
          >
            احذف حسابي نهائيًا
          </ReasonedButton>
        </>
      }
    >
      {!preview && !error && <LoadingState inline stage="جارٍ حساب ما سيُحذف…" />}
      {error && <ErrorState inline message={error} />}
      {preview && v && (
        <div className="ml-stack">
          <p>
            سيُحذف: {countAr(v.sources, { one: 'مصدر', two: 'مصدران', few: 'مصادر', many: 'مصدرًا' })} ·{' '}
            {countAr(v.notes, { one: 'ملاحظة', two: 'ملاحظتان', few: 'ملاحظات', many: 'ملاحظة' })} ·{' '}
            {countAr(v.annotations, { one: 'تعليق', two: 'تعليقان', few: 'تعليقات', many: 'تعليقًا' })} ·{' '}
            {countAr(v.recordings, { one: 'تسجيل', two: 'تسجيلان', few: 'تسجيلات', many: 'تسجيلًا' })} ·{' '}
            {countAr(v.cards, { one: 'بطاقة', two: 'بطاقتان', few: 'بطاقات', many: 'بطاقة' })} ({formatSize(v.bytes)})
          </p>
          {preview.publications.total > 0 && (
            <p>
              منشوراتك: {preview.publications.total} — تخرج من القوائم. النسخ المستقلة التي أخذها غيرك ({preview.publications.forked_by_others}) لا تُحذف.
            </p>
          )}
          <ul className="me-bullets">
            {preview.policy_ar.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {preview.blocked_ar ? (
            <p className="me-export__warn">{preview.blocked_ar}</p>
          ) : (
            <PasswordField label="كلمة المرور للتأكيد" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </div>
      )}
    </Dialog>
  );
}
