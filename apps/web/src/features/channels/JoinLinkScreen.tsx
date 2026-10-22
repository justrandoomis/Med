// /join/:token — the invite-link landing (P1-T4 step 3; IA §3.3, J9; PRD AOS-2.13, Q2/Q3). The ONLY screen of the
// Academic OS reachable before sign-in. It shows nothing but the channel's title, read from the rate-limited public
// preview; a wrong, expired, revoked or exhausted link gets one generic message (the server answers them all alike).
// Then: a signed-in person joins with one tap; anyone else signs in (and comes back here) or creates an account WITH
// this invitation — there is no open sign-up (accounts come from class codes, invite links or the platform admin).
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { JOIN_POLICY_LABELS_AR, type JoinPreviewResponse, type JoinResponse, type RegisterWithJoinResponse } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, PasswordField, TextField, buttonClass } from '../../design';
import { api, errorMessage, fieldErrors, isApiError } from '../../lib/api';
import { typed } from '../../lib/typedText';
import { activateAccount, fetchAuthStatus, invalidateAuthStatus } from '../../lib/auth';
import { describeDevice } from '../../lib/deviceId';
import { usePageTitle } from '../../lib/usePageTitle';
import { BrandMark } from '../../app/BrandMark';
import { RecoveryCodes } from '../auth/RecoveryCodes';
import { channelsApi } from './api';
import { JoinResult } from './JoinSheet';
import { ReasonedButton } from './ui';
import './channels.css';

type Who = { kind: 'loading' } | { kind: 'signed_in' } | { kind: 'signed_out'; minPassword: number } | { kind: 'offline'; message: string } | { kind: 'setup' };

export function JoinLinkScreen() {
  const { token = '' } = useParams();
  usePageTitle('دعوة للانضمام');
  // 'invalid' only when the server says the link is not usable (404); a preview that could not be ASKED (no connection,
  // rate limit, server error) says that instead — never «الرابط غير صالح» for a link that may be fine (review R2)
  const [preview, setPreview] = useState<JoinPreviewResponse | null | 'invalid' | { problem: string }>(null);
  const [attempt, setAttempt] = useState(0);
  const [who, setWho] = useState<Who>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResponse | null>(null);
  const [registering, setRegistering] = useState(false);
  const [codes, setCodes] = useState<RegisterWithJoinResponse | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let alive = true;
    channelsApi
      .preview(token)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setPreview(isApiError(e) && e.status === 404 ? 'invalid' : { problem: errorMessage(e) }));
    fetchAuthStatus({ force: true })
      .then(async (r) => {
        if (!alive) return;
        if (r.kind === 'offline') return setWho({ kind: 'offline', message: r.message });
        if (r.status.setup_required) return setWho({ kind: 'setup' });
        if (r.status.authenticated) {
          // this page now belongs to the signed-in account (its requests carry it — lib/api.ts clientHeaders)
          if (r.status.user && (await activateAccount(r.status.user)) === 'reload') window.location.reload();
          return setWho({ kind: 'signed_in' });
        }
        setWho({ kind: 'signed_out', minPassword: r.status.password_min_length });
      })
      .catch((e) => alive && setWho({ kind: 'offline', message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await channelsApi.joinWithLink(token));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const next = `/join/${token}`;
  const body = () => {
    if (preview === null || who.kind === 'loading') return <LoadingState stage="جارٍ فتح الدعوة…" />;
    if (preview === 'invalid')
      return (
        <ErrorState
          title="لا يمكن استخدام هذه الدعوة"
          message="الرابط غير صالح أو انتهت صلاحيته أو أُلغي. اطلب رابطًا جديدًا أو رمز انضمام من مشرف المادة."
          actions={
            <Link to="/" className={buttonClass({ variant: 'plain' })}>
              الرئيسية
            </Link>
          }
        />
      );
    if ('problem' in preview)
      return (
        <ErrorState
          title="تعذّر فتح الدعوة الآن"
          message={`${preview.problem} الرابط نفسه لم يُرفض؛ حاول مرة أخرى بعد قليل.`}
          onRetry={() => {
            setPreview(null);
            setAttempt((a) => a + 1);
          }}
        />
      );
    if (codes)
      return (
        <div className="ml-stack">
          <p>أُنشئ حسابك. احفظ رموز الاسترداد: تحتاجها إن نسيت كلمة المرور.</p>
          <RecoveryCodes codes={codes.recovery_codes} confirmed={confirmed} onConfirmedChange={setConfirmed} />
          {codes.membership && <JoinResult result={{ membership: codes.membership, message_ar: codes.membership.status === 'pending' ? 'طلبك بانتظار موافقة مشرف المادة.' : `انضممت إلى ${codes.membership.node.title}.` }} />}
          {/* a full page load: this page was opened signed out, and the new account's own local data (IndexedDB,
              keys, drafts) opens cleanly only on a fresh load (lib/auth activateAccount → the route gate would reload
              THIS address otherwise, and the codes would be gone) */}
          <ReasonedButton variant="primary" reason={confirmed ? null : 'أكّد أولًا أنك حفظت رموز الاسترداد.'} onClick={() => window.location.assign('/channels')}>
            متابعة إلى القنوات
          </ReasonedButton>
        </div>
      );
    return (
      <div className="ml-stack">
        <p>
          دعوة للانضمام إلى: <strong className="ch-landing__title">{preview.title_ar}</strong>
        </p>
        <p className="ml-group-footer">{preview.requires_approval ? JOIN_POLICY_LABELS_AR.approval : 'تنضم مباشرة بعد تسجيل الدخول.'}</p>
        {error && <ErrorState inline message={error} />}
        {result ? (
          <JoinResult result={result} />
        ) : who.kind === 'signed_in' ? (
          <Button variant="primary" loading={busy} onClick={() => void join()}>
            {`انضم إلى ${preview.title_ar}`}
          </Button>
        ) : who.kind === 'offline' ? (
          <ErrorState inline title="لا اتصال بالخادم" message={`${who.message} الانضمام يحتاج اتصالًا.`} />
        ) : who.kind === 'setup' ? (
          <ErrorState inline title="لم يُعدّ هذا الخادم بعد" message="لا توجد حسابات على هذا الخادم بعد؛ اطلب من مسؤول المنصة إكمال الإعداد." />
        ) : registering ? (
          <RegisterForm token={token} minPassword={who.minPassword} onDone={setCodes} onCancel={() => setRegistering(false)} />
        ) : (
          <div className="ch-landing__actions">
            <Link to={`/login?next=${encodeURIComponent(next)}`} className={buttonClass({ variant: 'primary' })}>
              لدي حساب — سجّل الدخول
            </Link>
            <Button onClick={() => setRegistering(true)}>أنشئ حسابًا بهذه الدعوة</Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="ch-landing">
      <main id="main" className="ch-landing__card">
        <div className="ch-landing__actions">
          <BrandMark size={32} />
          <span dir="ltr" lang="en">
            MedLevo AI
          </span>
        </div>
        <h1 className="ch-landing__title">دعوة للانضمام</h1>
        {body()}
      </main>
    </div>
  );
}

/** A new account WITH this invitation (POST /api/auth/register; the invite token is the proof — PRD Q3). */
function RegisterForm({ token, minPassword, onDone, onCancel }: { token: string; minPassword: number; onDone: (r: RegisterWithJoinResponse) => void; onCancel: () => void }) {
  const id = useId();
  const [form, setForm] = useState({ display_name: '', username: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!form.display_name.trim()) local.display_name = 'اكتب الاسم الذي يراه زملاؤك.';
    if (form.username.trim().length < 3) local.username = 'اسم المستخدم 3 أحرف على الأقل.';
    if (form.password.length < minPassword) local.password = `اختر كلمة مرور من ${minPassword} أحرف على الأقل.`;
    if (form.password !== form.confirm) local.confirm = 'كلمتا المرور غير متطابقتين.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<RegisterWithJoinResponse>(
        '/auth/register',
        { username: form.username.trim(), display_name: form.display_name.trim(), password: form.password, join: { invite_token: token }, device_label: describeDevice() },
        { skipAuthRedirect: true, timeoutMs: 30_000 },
      );
      invalidateAuthStatus();
      onDone(r);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="ch-section__title">
        حساب جديد بهذه الدعوة
      </h2>
      <TextField label="الاسم الظاهر" autoComplete="name" value={form.display_name} onChange={typed((v) => setForm((f) => ({ ...f, display_name: v })))} error={errors.display_name} />
      <TextField label="اسم المستخدم" dir="ltr" autoComplete="username" autoCapitalize="none" value={form.username} onChange={set('username')} error={errors.username} />
      <PasswordField label="كلمة المرور" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} hint={`${minPassword} أحرف على الأقل.`} />
      <PasswordField label="تأكيد كلمة المرور" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} />
      {error && <ErrorState inline message={error} />}
      <div className="ch-landing__actions">
        <Button type="submit" variant="primary" loading={busy}>
          أنشئ الحساب وانضم
        </Button>
        <Button onClick={onCancel}>رجوع</Button>
      </div>
    </form>
  );
}
