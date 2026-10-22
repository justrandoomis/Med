// «الخصوصية والبيانات» — /me/privacy (P1-T4 step 3; IA §4.14; PRD Q14; P1-T1's /api/accounts/me/export(s), /me/delete).
//  * «نسخة من بياناتي»: an archive of the student's OWN vault, built on the server, downloadable while it is kept;
//  * deleting the account: an impact preview first (what is deleted, that the name shows «طالب سابق», that forks
//    others already made stay), then the password — nothing is deleted by the preview;
//  * the operator note of IA §4.14, said plainly.
//  * (AOS-21.42) «معالجة الذكاء الاصطناعي»: the consent naming the provider configured on the server, its exact text and
//    version, «أوافق» / «اسحب موافقتي» and the record of earlier consents; the written policy is its own page
//    (/me/privacy/policy). Transcription consent arrives with the feature that needs it (Phase 3); it is not shown before.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, Download, Trash2 } from 'lucide-react';
import type { AccountExportsResponse, AccountExportView, AiConsentView, DeletionPreview, JobStatus } from '@medlevo/shared';
import { Breadcrumbs, Button, Checkbox, ConfirmDialog, Dialog, ErrorState, LoadingState, PasswordField, StatusPill, useToast } from '../../design';
import { afterClear, clearAccountDeviceData, clearOnSignOutPreference, setClearOnSignOutPreference } from '../../lib/signOut';
import { getSyncEngine } from '../../lib/sync';
import { storageAccount } from '../../lib/userStorage';
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

      <AiConsentSection />

      <DeviceDataSection />

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

/** AOS-21.42: the ai_processing consent of this account (nothing of its content leaves for a provider without it). */
function AiConsentSection() {
  const toast = useToast();
  const online = useOnline();
  const [view, setView] = useState<AiConsentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const load = useCallback(() => {
    meApi
      .aiConsent()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const agree = async () => {
    if (!view?.provider) return;
    setBusy(true);
    try {
      setView(await meApi.setAiConsent({ granted: true, provider: view.provider.id, text_version: view.current_text_version }));
      toast.show({ title: 'سُجّلت موافقتك.', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
      load();
    } finally {
      setBusy(false);
    }
  };

  const p = view?.provider ?? null;
  return (
    <section className="me-section" aria-labelledby="me-ai-h">
      <h2 id="me-ai-h" className="me-section__title">
        معالجة الذكاء الاصطناعي
      </h2>
      <p className="me-note">لا يُرسل شيء من ملاحظاتك وملفاتك إلى مزوّد خارجي دون موافقتك.</p>
      {error && !view ? (
        <ErrorState inline message={error} onRetry={load} />
      ) : !view ? (
        <LoadingState inline stage="جارٍ التحميل…" />
      ) : !p ? (
        <p className="me-note">لا يوجد مزوّد ذكاء اصطناعي مضبوط على هذا الخادم، فلا يُرسل شيء من محتواك إلى أي جهة.</p>
      ) : !p.leaves_deployment ? (
        <p className="me-note">مزوّد الذكاء الاصطناعي المضبوط ({p.label_ar}) يعمل داخل هذا الخادم، فلا يخرج شيء من محتواك ولا تلزم موافقة.</p>
      ) : (
        <div className="ml-stack">
          <p>
            المزوّد المضبوط على الخادم: <strong>{p.label_ar}</strong>
          </p>
          {view.granted ? (
            <p className="me-consent__state">
              <Check size={18} aria-hidden="true" /> وافقت على إرسال محتواك إلى {p.label_ar} منذ {formatDateTime(view.granted_at!)}.
            </p>
          ) : (
            <p className="me-consent__state">لم توافق بعد؛ ميزات الذكاء الاصطناعي متوقفة لحسابك، وباقي الميزات تعمل.</p>
          )}
          <p className="me-note">نص الموافقة (الإصدار <bdi dir="ltr">{view.current_text_version}</bdi>):</p>
          <ul className="me-bullets">
            {view.text_ar.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {view.granted ? (
            <ReasonedButton variant="secondary" reason={online ? null : 'سحب الموافقة يحتاج اتصالًا بالخادم.'} onClick={() => setWithdrawing(true)}>
              اسحب موافقتي
            </ReasonedButton>
          ) : (
            <ReasonedButton variant="primary" loading={busy} reason={online ? null : 'تسجيل الموافقة يحتاج اتصالًا بالخادم.'} onClick={() => void agree()}>
              أوافق على الإرسال إلى {p.label_ar}
            </ReasonedButton>
          )}
        </div>
      )}
      {view && view.history.length > 0 && (
        <>
          <h3 className="me-consent__h">سجل موافقاتك</h3>
          <ul role="list" className="ml-list">
            {view.history.map((h) => (
              <li key={`${h.granted_at}-${h.text_version}`} className="ml-list__row me-export">
                <span className="me-export__text">
                  <span>
                    {h.providers.join('، ')} — منذ {formatDateTime(h.granted_at)}
                  </span>
                  <span className="me-export__meta">{h.revoked_at ? `سُحبت في ${formatDateTime(h.revoked_at)}` : 'سارية'}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="ml-group-footer">
        <Link to="/me/privacy/policy">اقرأ سياسة استخدام البيانات</Link>
      </p>
      <ConfirmDialog
        open={withdrawing}
        title="سحب الموافقة"
        impact="يتوقف إرسال أي شيء من محتواك إلى مزوّد الذكاء الاصطناعي فورًا، وتتوقف ميزاته لحسابك. ما عولج قبل السحب لا يمكن استرجاعه."
        confirmLabel="اسحب الموافقة"
        destructive
        onCancel={() => setWithdrawing(false)}
        onConfirm={async () => {
          setView(await meApi.setAiConsent({ granted: false }));
          setWithdrawing(false);
          toast.show({ title: 'سُحبت موافقتك.', tone: 'success' });
        }}
      />
    </section>
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
      const account = storageAccount();
      forgetAuth();
      if (account) {
        // (C3 review R6) the account is gone: its copy on THIS device goes with it (nobody could sign in to clear it
        // later); nothing of another account here is touched. A full load leaves nothing of it in memory either.
        getSyncEngine().stop();
        await clearAccountDeviceData(account).catch(() => undefined);
        afterClear.go('/login');
        return;
      }
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
            <li>تُمسح أيضًا نسخة حسابك المحفوظة على هذا الجهاز. ما حُفظ منها على أجهزتك الأخرى يبقى فيها حتى يُمسح من إعدادات المتصفح هناك.</li>
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

/**
 * AOS-4.7 / Q26 (track C3, IA §4.14): «امسح بيانات هذا الجهاز عند الخروج» — the same per-account option as next to
 * «تسجيل الخروج» (Settings › الأمان), where the sign-out itself happens. A device registered as shared («أجهزتي»)
 * always clears.
 */
function DeviceDataSection() {
  const [clear, setClear] = useState(() => clearOnSignOutPreference());
  return (
    <section className="me-section" aria-labelledby="me-device-data-h">
      <h2 id="me-device-data-h" className="me-section__title">
        بياناتك على هذا الجهاز
      </h2>
      <p className="me-note">
        يحفظ هذا الجهاز نسخة من بياناتك لتعمل دون اتصال، في مساحة خاصة بحسابك لا يعرضها التطبيق لحساب آخر يستخدم المتصفح نفسه. هي غير مشفّرة على الجهاز، وتبقى بعد تسجيل
        الخروج ما لم تطلب مسحها.
      </p>
      <Checkbox
        checked={clear}
        onCheckedChange={(on) => {
          setClear(on);
          setClearOnSignOutPreference(on);
        }}
        label="امسح بيانات هذا الجهاز عند الخروج"
        description="عند تسجيل الخروج تُحذف من هذا الجهاز ملاحظاتك وكتابتك ونسخك المحفوظة للعمل دون اتصال وتفضيلات حسابك، بعد التأكد من وصول كل شيء إلى الخادم. لا يُحذف شيء من الخادم ولا من أجهزتك الأخرى."
      />
      <p className="me-note">
        على جهاز مشترك (مكتبة، قاعة، جهاز صديق) سجّله «جهازًا مشتركًا» من <Link to="/me/devices">أجهزتي</Link>: تُمسح بياناتك منه عند كل خروج.
      </p>
    </section>
  );
}
