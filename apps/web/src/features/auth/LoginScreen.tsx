import { useState, type FormEvent } from 'react';
import { Link, useLoaderData, useNavigate, useSearchParams } from 'react-router-dom';
import { CircleCheck, Info } from 'lucide-react';
import { Button, ErrorState, PasswordField, TextField } from '../../design';
import { errorMessage } from '../../lib/api';
import { login } from '../../lib/auth';
import { usePageTitle } from '../../lib/usePageTitle';
import { safeNext, type PublicGateData } from '../../app/guards';
import { AuthLayout } from './AuthLayout';

export function LoginScreen() {
  const gate = useLoaderData() as PublicGateData;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePageTitle('تسجيل الدخول');

  const expired = params.get('expired') === '1';
  const recovered = params.get('recovered') === '1';
  const remaining = params.get('remaining');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="تسجيل الدخول">
      {expired && !recovered && (
        <p className="ml-auth__notice" role="status">
          <Info size={18} aria-hidden="true" />
          <span>انتهت الجلسة على هذا الجهاز. سجّل الدخول للمتابعة؛ ما كتبته محفوظ هنا وسيُزامَن بعد الدخول.</span>
        </p>
      )}
      {recovered && (
        <p className="ml-auth__notice ml-auth__notice--success" role="status">
          <CircleCheck size={18} aria-hidden="true" />
          <span>
            تم تعيين كلمة المرور الجديدة وإلغاء كل الجلسات. سجّل الدخول بها.
            {remaining != null && ` رموز الاسترداد المتبقية: ${remaining}.`}
            {remaining != null && Number(remaining) <= 3 && ' أنشئ رموزًا جديدة من الإعدادات بعد الدخول.'}
          </span>
        </p>
      )}
      {gate.offline && (
        <ErrorState
          inline
          title="تسجيل الدخول يحتاج اتصالًا بالخادم"
          message={`${gate.message ?? 'تعذّر الوصول إلى الخادم.'} إن سبق أن سجّلت الدخول على هذا الجهاز فستفتح نسختك المحلية تلقائيًا عند إعادة المحاولة.`}
          onRetry={() => navigate(0)}
        />
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
          required
          autoFocus
        />
        <PasswordField label="كلمة المرور" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <ErrorState inline title="لم يتم الدخول" message={error} />}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel="جارٍ التحقق…" disabled={gate.offline || !username.trim() || !password}>
          دخول
        </Button>
      </form>
      <p className="ml-auth__footer">
        نسيت كلمة المرور؟ <Link to="/recover">استخدم رمز استرداد</Link>
      </p>
    </AuthLayout>
  );
}
