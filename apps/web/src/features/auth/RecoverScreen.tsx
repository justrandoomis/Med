import { useState, type FormEvent } from 'react';
import { Link, useLoaderData, useNavigate } from 'react-router-dom';
import { Button, ErrorState, PasswordField, TextField } from '../../design';
import { errorMessage, fieldErrors } from '../../lib/api';
import { recoverAccount } from '../../lib/auth';
import { usePageTitle } from '../../lib/usePageTitle';
import type { PublicGateData } from '../../app/guards';
import { AuthLayout, PasswordChecklist } from './AuthLayout';

export function RecoverScreen() {
  const gate = useLoaderData() as PublicGateData;
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  usePageTitle('استعادة الحساب');

  const min = gate.passwordMinLength;
  const rules = [
    { ok: password.length >= min, label: `${min} حرفًا على الأقل` },
    { ok: confirm.length > 0 && confirm === password, label: 'التأكيد مطابق لكلمة المرور' },
  ];
  const canSubmit = !!username.trim() && !!code.trim() && rules.every((r) => r.ok) && !gate.offline;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const res = await recoverAccount({ username: username.trim(), recovery_code: code.trim(), new_password: password });
      navigate(`/login?recovered=1&remaining=${res.remaining_recovery_codes}`, { replace: true });
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="استعادة الحساب"
      intro={<p>استخدم أحد رموز الاسترداد التي حفظتها عند الإعداد. كل رمز يعمل مرة واحدة، وبعد الاستعادة تُلغى كل الجلسات على كل الأجهزة.</p>}
    >
      {gate.offline && <ErrorState inline title="الاستعادة تحتاج اتصالًا بالخادم" message={gate.message ?? 'تعذّر الوصول إلى الخادم.'} onRetry={() => navigate(0)} />}
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
          error={fields.username}
          required
        />
        <TextField
          label="رمز الاسترداد"
          name="recovery-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          dir="ltr"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={fields.recovery_code}
          hint="كما هو مكتوب في ورقة الرموز، مع الشرطات أو بدونها."
          required
        />
        <PasswordField
          label="كلمة المرور الجديدة"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.new_password}
          required
        />
        <PasswordField label="تأكيد كلمة المرور الجديدة" name="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <PasswordChecklist rules={rules} />
        {error && <ErrorState inline title="لم تتم الاستعادة" message={error} />}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel="جارٍ الاستعادة…" disabled={!canSubmit}>
          تعيين كلمة المرور الجديدة
        </Button>
      </form>
      <p className="ml-auth__footer">
        تذكّرت كلمة المرور؟ <Link to="/login">العودة إلى تسجيل الدخول</Link>
      </p>
    </AuthLayout>
  );
}
