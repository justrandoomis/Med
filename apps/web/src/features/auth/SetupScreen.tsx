import { useState, type FormEvent } from 'react';
import { useLoaderData, useNavigate } from 'react-router-dom';
import { Button, ErrorState, PasswordField, TextField } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { setupOwner } from '../../lib/auth';
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
  usePageTitle(codes ? 'رموز الاسترداد' : 'الإعداد الأولي');

  const min = gate.passwordMinLength;
  const rules = [
    { ok: password.length >= min, label: `${min} حرفًا على الأقل` },
    { ok: password.length > 0 && password.trim().toLowerCase() !== username.trim().toLowerCase(), label: 'تختلف عن اسم المستخدم' },
    { ok: confirm.length > 0 && confirm === password, label: 'التأكيد مطابق لكلمة المرور' },
  ];
  const usernameError = touched && !USERNAME_RE.test(username.trim()) ? 'من 3 إلى 64 حرفًا أو رقمًا، ويمكن استخدام . _ - دون مسافات.' : fields.username;
  const canSubmit = USERNAME_RE.test(username.trim()) && rules.every((r) => r.ok) && !gate.offline;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await setupOwner(username.trim(), password);
      setPassword('');
      setConfirm('');
      setCodes({ list: res.recovery_codes, notice: res.notice_ar });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
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
        {error && <ErrorState inline title="تعذّر إنشاء الحساب" message={error} />}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel="جارٍ إنشاء الحساب…" disabled={!canSubmit}>
          إنشاء الحساب
        </Button>
      </form>
    </AuthLayout>
  );
}
