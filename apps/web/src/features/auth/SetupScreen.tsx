import { useEffect, useState, type FormEvent } from 'react';
import { useLoaderData, useNavigate } from 'react-router-dom';
import type { SetupResponse } from '@medlevo/shared';
import { Bidi, Button, ErrorState, PasswordField, TextField } from '../../design';
import { api, errorMessage, fieldErrors, isApiError } from '../../lib/api';
import { fetchAuthStatus, invalidateAuthStatus, setupOwner } from '../../lib/auth';
import { describeDevice, getDeviceId } from '../../lib/deviceId';
import { usePageTitle } from '../../lib/usePageTitle';
import type { PublicGateData } from '../../app/guards';
import { AuthLayout, PasswordChecklist } from './AuthLayout';
import { RecoveryCodes } from './RecoveryCodes';

const USERNAME_RE = /^[\p{L}\p{N}._-]{3,64}$/u;

export function SetupScreen() {
  const gate = useLoaderData() as PublicGateData;
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<{ list: string[]; notice: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(false);
  // track D1: a server reachable from the network asks for a one-time setup token (printed in its log at boot)
  const [tokenRequired, setTokenRequired] = useState(false);
  const [setupToken, setSetupToken] = useState('');
  usePageTitle(codes ? 'رموز الاسترداد' : 'الإعداد الأولي');

  useEffect(() => {
    if (gate.offline) return;
    let alive = true;
    void fetchAuthStatus()
      .then((r) => {
        if (alive && r.kind === 'online') setTokenRequired(r.status.setup_token_required === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [gate.offline]);

  const min = gate.passwordMinLength;
  const rules = [
    { ok: password.length >= min, label: `${min} حرفًا على الأقل` },
    { ok: password.length > 0 && password.trim().toLowerCase() !== username.trim().toLowerCase(), label: 'تختلف عن اسم المستخدم' },
    { ok: confirm.length > 0 && confirm === password, label: 'التأكيد مطابق لكلمة المرور' },
  ];
  const usernameError = touched && !USERNAME_RE.test(username.trim()) ? 'من 3 إلى 64 حرفًا أو رقمًا، ويمكن استخدام . _ - دون مسافات.' : fields.username;
  const canSubmit = USERNAME_RE.test(username.trim()) && rules.every((r) => r.ok) && !gate.offline && (!tokenRequired || setupToken.trim().length > 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = tokenRequired ? await setupWithToken(username.trim(), password, setupToken.trim()) : await setupOwner(username.trim(), password);
      setSetupToken('');
      setPassword('');
      setConfirm('');
      setCodes({ list: res.recovery_codes, notice: res.notice_ar });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
      // the server asks for a setup token we did not know about (status could not be read): show the field now
      if (isApiError(err) && (err.details as { setup_token_required?: unknown } | null | undefined)?.setup_token_required === true) setTokenRequired(true);
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <AuthLayout
        title="احفظ رموز الاسترداد"
        intro={<p>أُنشئ حسابك وسُجّل دخولك على هذا الجهاز. هذه الرموز هي طريقتك الوحيدة لاستعادة الحساب إن نسيت كلمة المرور.</p>}
        wide
      >
        <RecoveryCodes codes={codes.list} notice={codes.notice} confirmed={saved} onConfirmedChange={setSaved} />
        <div className="ml-auth__actions">
          <Button variant="primary" size="lg" fullWidth disabled={!saved} onClick={() => navigate('/', { replace: true })}>
            متابعة إلى MedLevo
          </Button>
          {!saved && <p className="ml-auth__hint">فعّل خانة التأكيد بعد حفظ الرموز للمتابعة.</p>}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="إنشاء حساب المالك"
      intro={
        <p>
          MedLevo لك وحدك: حساب واحد، دون تسجيل عام أو مستخدمين آخرين. اختر اسم مستخدم وكلمة مرور قوية؛ ستحصل بعدها على رموز استرداد تحفظها
          بنفسك.
        </p>
      }
    >
      {gate.offline && (
        <ErrorState inline title="لا يمكن إكمال الإعداد دون اتصال" message={gate.message ?? 'تعذّر الوصول إلى الخادم.'} onRetry={() => navigate(0)} />
      )}
      <form className="ml-auth__form" onSubmit={submit} noValidate>
        <TextField
          label="اسم المستخدم"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          dir="auto"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onBlur={() => setTouched(true)}
          error={usernameError}
          hint="حروف أو أرقام، ويمكن استخدام . _ - دون مسافات."
          required
        />
        <PasswordField
          label="كلمة المرور"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          hint="عبارة من عدة كلمات تتذكرها أقوى وأسهل من كلمة قصيرة معقدة."
          required
        />
        <PasswordField
          label="تأكيد كلمة المرور"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <PasswordChecklist rules={rules} />
        {tokenRequired && (
          <TextField
            label="رمز الإعداد"
            name="setup-token"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            dir="ltr"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            error={fields.setup_token}
            hint={
              <>
                الخادم متاح من الشبكة، لذلك يطلب الإعداد الأول رمزًا لمرة واحدة يُطبع في سجل تشغيل الخادم (أو قيمة <Bidi dir="ltr">MEDLEVO_SETUP_TOKEN</Bidi> إن
                ضبطتها). هذا يمنع أي شخص آخر من إنشاء الحساب قبلك.
              </>
            }
            required
          />
        )}
        {error && <ErrorState inline title="تعذّر إنشاء الحساب" message={error} />}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel="جارٍ إنشاء الحساب…" disabled={!canSubmit}>
          إنشاء الحساب
        </Button>
      </form>
    </AuthLayout>
  );
}

/** POST /api/auth/setup with the setup token (track D1). Same request as lib/auth setupOwner + `setup_token`. */
async function setupWithToken(username: string, password: string, setupToken: string): Promise<SetupResponse> {
  let device_id: string | undefined;
  try {
    device_id = await getDeviceId();
  } catch {
    device_id = undefined;
  }
  const res = await api.post<SetupResponse>(
    '/auth/setup',
    { username, password, device_id, device_label: describeDevice(), setup_token: setupToken },
    { skipAuthRedirect: true },
  );
  invalidateAuthStatus();
  return res;
}
