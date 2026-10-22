import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useRouteLoaderData } from 'react-router-dom';
import { KeyRound, LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { SessionInfo } from '@medlevo/shared';
import { Button, Checkbox, ConfirmDialog, Dialog, ErrorState, PasswordField, Skeleton, StatusPill, useToast } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { changePassword, listSessions, regenerateRecoveryCodes, revokeSession } from '../../lib/auth';
import { afterClear, clearOnSignOutPreference, currentDeviceIsShared, setClearOnSignOutPreference, signOutThisDevice, unsentAr, type Unsent } from '../../lib/signOut';
import { getSyncEngine } from '../../lib/sync';
import { formatDateTime, formatRelative } from '../../lib/time';
import type { OwnerGateData } from '../../app/routeTypes';
import { RecoveryCodes } from '../auth/RecoveryCodes';

function deviceIcon(s: SessionInfo) {
  const t = `${s.device_label ?? ''} ${s.user_agent ?? ''}`;
  if (/iPad|لوحي|Tablet/i.test(t)) return <Tablet size={20} />;
  if (/iPhone|هاتف|Mobile/i.test(t)) return <Smartphone size={20} />;
  return <Monitor size={20} />;
}

export function SessionsGroup() {
  const toast = useToast();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<SessionInfo | null>(null);

  // the request: state is set only when it settles (no synchronous setState on the effect path)
  const fetchSessions = useCallback(
    () =>
      listSessions()
        .then((res) => setSessions([...res.sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_at - a.last_seen_at)))
        .catch((e: unknown) => setError(errorMessage(e)))
        .finally(() => setLoading(false)),
    [],
  );
  // a retry / refresh shows loading and clears the previous error at once (the first load starts in that state)
  const load = () => {
    setLoading(true);
    setError(null);
    return fetchSessions();
  };

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const revoke = async () => {
    if (!target) return;
    const res = await revokeSession(target.id);
    setTarget(null);
    if (res.current) {
      getSyncEngine().stop();
      navigate('/login', { replace: true });
      return;
    }
    toast.show({ tone: 'success', title: 'أُنهيت الجلسة', description: target.device_label ?? undefined });
    await load();
  };

  return (
    <div>
      <h3 className="ml-group-header">الأجهزة المسجّل دخولها</h3>
      {error ? (
        <ErrorState inline title="تعذّر تحميل الجلسات" message={error} onRetry={() => void load()} />
      ) : loading && !sessions ? (
        <div className="ml-group" aria-busy="true">
          <div className="ml-group__row">
            <Skeleton lines={2} />
          </div>
          <span className="ml-visually-hidden" role="status">
            جارٍ تحميل الجلسات…
          </span>
        </div>
      ) : (
        <ul className="ml-list" role="list">
          {(sessions ?? []).map((s) => (
            <li key={s.id} className="ml-list__row">
              <div className="ml-list-item ml-session">
                <span className="ml-list-item__leading" aria-hidden="true">
                  {deviceIcon(s)}
                </span>
                <span className="ml-list-item__text">
                  <span className="ml-list-item__title">
                    {s.device_label || 'جهاز غير معروف'}
                    {s.current && (
                      <>
                        {' '}
                        <StatusPill tone="accent" icon={false}>
                          هذا الجهاز
                        </StatusPill>
                      </>
                    )}
                  </span>
                  <span className="ml-list-item__subtitle">
                    آخر نشاط {formatRelative(s.last_seen_at)}، وبدأت {formatDateTime(s.created_at)}
                  </span>
                </span>
                {!s.current && (
                  <span className="ml-list-item__trailing">
                    <Button size="sm" variant="plain" onClick={() => setTarget(s)}>
                      إنهاء الجلسة
                    </Button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="ml-group-footer">إنهاء جلسة جهاز آخر يسجّل خروجه فورًا. لا يُحذف شيء مما كُتب عليه؛ يُزامَن عند دخوله مجددًا.</p>
      <ConfirmDialog
        open={target != null}
        title={target?.current ? 'تسجيل الخروج من هذا الجهاز؟' : 'إنهاء جلسة هذا الجهاز؟'}
        destructive={!target?.current}
        confirmLabel={target?.current ? 'تسجيل الخروج' : 'إنهاء الجلسة'}
        impact={
          target?.current ? (
            <p>ستحتاج إلى كلمة المرور للدخول مجددًا. ما كتبته ولم يُزامَن بعد يبقى محفوظًا على هذا الجهاز ويُرسل بعد الدخول.</p>
          ) : (
            <p>
              سيُسجَّل خروج «{target?.device_label || 'هذا الجهاز'}» فورًا ولن يستطيع المزامنة حتى يسجّل الدخول من جديد. ما كُتب عليه ولم يُزامَن يبقى
              محفوظًا عليه.
            </p>
          )
        }
        onCancel={() => setTarget(null)}
        onConfirm={revoke}
      />
    </div>
  );
}

export function ChangePasswordGroup({ minLength }: { minLength: number }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < minLength;
  const can = !!current && next.length >= minLength && confirm === next && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await changePassword({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.show({
        tone: 'success',
        title: 'تم تغيير كلمة المرور',
        description: res.revoked_sessions > 0 ? `أُنهيت الجلسات على الأجهزة الأخرى: ${res.revoked_sessions}.` : undefined,
      });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="ml-group-header">كلمة المرور</h3>
      <form className="ml-group ml-group__row ml-group__row--stack" onSubmit={submit} noValidate>
        <PasswordField label="كلمة المرور الحالية" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={fields.current_password} />
        <PasswordField
          label="كلمة المرور الجديدة"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`${minLength} حرفًا على الأقل.`}
          error={fields.new_password ?? (tooShort ? `أقصر من ${minLength} حرفًا.` : undefined)}
        />
        <PasswordField
          label="تأكيد كلمة المرور الجديدة"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? 'التأكيد لا يطابق كلمة المرور الجديدة.' : undefined}
        />
        {error && <ErrorState inline title="لم تتغير كلمة المرور" message={error} />}
        <div>
          <Button type="submit" variant="primary" loading={busy} loadingLabel="جارٍ التغيير…" disabled={!can}>
            تغيير كلمة المرور
          </Button>
        </div>
      </form>
      <p className="ml-group-footer">بعد التغيير تُنهى الجلسات على الأجهزة الأخرى، ويبقى هذا الجهاز مسجّلًا.</p>
    </div>
  );
}

export function RecoveryCodesGroup() {
  const gate = useRouteLoaderData('owner') as OwnerGateData | undefined;
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<{ list: string[]; notice: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(gate?.remainingRecoveryCodes ?? null);

  const close = () => {
    if (codes && !saved) return; // codes must be confirmed before closing
    setOpen(false);
    setPassword('');
    setError(null);
    setCodes(null);
    setSaved(false);
  };

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await regenerateRecoveryCodes(password);
      setPassword('');
      setCodes({ list: res.recovery_codes, notice: res.notice_ar });
      setRemaining(res.recovery_codes.length);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="ml-group-header">رموز الاسترداد</h3>
      <div className="ml-group ml-group__row ml-settings-row">
        <div className="ml-settings-row__text">
          <span>الرموز المتبقية</span>
          <span className="ml-settings-row__desc">
            {remaining == null ? 'غير معروف دون اتصال.' : remaining <= 3 ? `بقي ${remaining} فقط. أنشئ رموزًا جديدة واحفظها.` : `${remaining} رموز صالحة، كل منها يُستخدم مرة واحدة.`}
          </span>
        </div>
        <Button icon={<KeyRound size={16} />} onClick={() => setOpen(true)}>
          إنشاء رموز جديدة
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        dismissible={!codes || saved}
        title={codes ? 'رموز الاسترداد الجديدة' : 'إنشاء رموز استرداد جديدة'}
        size="md"
        footer={
          codes ? (
            <Button variant="primary" disabled={!saved} onClick={close}>
              تم
            </Button>
          ) : (
            <>
              <Button onClick={close}>إلغاء</Button>
              <Button variant="destructive" type="submit" form="regen-codes" loading={busy} disabled={!password}>
                إبطال القديمة وإنشاء جديدة
              </Button>
            </>
          )
        }
      >
        {codes ? (
          <RecoveryCodes codes={codes.list} notice={codes.notice} confirmed={saved} onConfirmedChange={setSaved} />
        ) : (
          <form id="regen-codes" className="ml-stack" onSubmit={generate}>
            <div className="ml-impact ml-impact--destructive">
              <p>ستتوقف كل رموز الاسترداد الحالية عن العمل فورًا، وتظهر الرموز الجديدة مرة واحدة فقط.</p>
            </div>
            <PasswordField label="كلمة المرور الحالية للتأكيد" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <ErrorState inline title="لم تُنشأ رموز جديدة" message={error} />}
          </form>
        )}
      </Dialog>
    </div>
  );
}

export function LogoutGroup() {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // AOS-4.7 / Q26: «امسح بيانات هذا الجهاز عند الخروج» (this account, this device); a device registered as shared
  // («جهاز مشترك», «أنا › أجهزتي») always clears
  const [clear, setClear] = useState(() => clearOnSignOutPreference());
  const [shared, setShared] = useState<boolean | null>(null);
  const [unsent, setUnsent] = useState<Unsent | null>(null);
  useEffect(() => {
    let alive = true;
    void currentDeviceIsShared().then((v) => alive && setShared(v));
    return () => {
      alive = false;
    };
  }, []);
  const clearing = shared === true || clear;

  const signOut = async (opts: { clear: boolean; keep?: boolean }) => {
    setBusy(true);
    try {
      // stop syncing only once the server confirmed the sign-out: if it fails (e.g. offline) the account stays signed
      // in here and unsynced writes must keep syncing (signOutThisDevice stops the engine after the server's answer)
      const r = await signOutThisDevice(opts);
      if (r.kind === 'unsent') {
        setUnsent(r.unsent);
        setBusy(false);
        return;
      }
      setUnsent(null);
      // a clearing sign-out leaves through a full load: nothing of this account stays in the page's memory
      if (r.cleared) afterClear.go('/login');
      else navigate('/login', { replace: true });
    } catch (e) {
      toast.show({ tone: 'danger', title: 'تعذّر تسجيل الخروج', description: errorMessage(e) });
      setBusy(false);
    }
  };

  return (
    <div className="ml-group">
      <div className="ml-group__row ml-settings-row">
        <div className="ml-settings-row__text">
          <span>تسجيل الخروج من هذا الجهاز</span>
          <span className="ml-settings-row__desc">
            {clearing ? 'تُمسح بيانات حسابك من هذا الجهاز بعد الخروج، بعد التأكد من وصول كل ما كتبته إلى الخادم.' : 'ما كتبته ولم يُزامَن يبقى محفوظًا هنا ويُرسل بعد الدخول مجددًا.'}
          </span>
        </div>
        <Button icon={<LogOut size={16} />} loading={busy} onClick={() => void signOut({ clear: clearing })}>
          تسجيل الخروج
        </Button>
      </div>
      <div className="ml-group__row">
        <Checkbox
          checked={clearing}
          disabled={shared === true}
          onCheckedChange={(on) => {
            setClear(on);
            setClearOnSignOutPreference(on);
          }}
          label="امسح بيانات هذا الجهاز عند الخروج"
          description={
            shared === true
              ? 'هذا الجهاز مسجّل جهازًا مشتركًا: تُمسح بيانات حسابك منه عند كل خروج. غيّر ذلك من «أنا › أجهزتي».'
              : 'يحذف من هذا الجهاز ملاحظاتك وكتابتك ونسخك المحفوظة للعمل دون اتصال وتفضيلات حسابك. لا يُحذف شيء من الخادم ولا من أجهزتك الأخرى، ولا يُمسح ما لم يصل إلى الخادم بعد.'
          }
        />
      </div>
      <Dialog
        open={unsent !== null}
        onClose={() => setUnsent(null)}
        title="لم تصل كل بياناتك إلى الخادم"
        description={unsent ? `على هذا الجهاز ${unsentAr(unsent)}. مسح بيانات الجهاز الآن يفقدها، لذلك لم يُمسح شيء ولم يُسجَّل خروجك.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setUnsent(null)}>
              ابقَ مسجّلًا وأرسلها أولًا
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void signOut({ clear: false, keep: true })}>
              اخرج واحتفظ بها على هذا الجهاز
            </Button>
          </>
        }
      >
        <p className="ml-settings-row__desc">
          اتصل بالإنترنت وانتظر حتى تصل (تراجع التعارضات في «مركز التحكم › التعارضات والمزامنة»، وتُرفع التسجيلات والصور تلقائيًا عند الاتصال)، ثم سجّل الخروج مرة أخرى
          لتُمسح البيانات. إن خرجت الآن تبقى كلها على هذا الجهاز في مساحة حسابك وتُرسل عند دخولك مجددًا.
        </p>
      </Dialog>
    </div>
  );
}
