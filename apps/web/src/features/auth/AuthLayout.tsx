import type { ReactNode } from 'react';
import { Circle, CircleCheck } from 'lucide-react';
import { BrandMark } from '../../app/BrandMark';
import './auth.css';

/**
 * A single sheet of warm paper on the neutral canvas, with a notebook margin rule — the one
 * deliberate flourish of the sign-in surfaces. Everything else stays quiet.
 */
export function AuthLayout({ title, intro, children, wide }: { title: string; intro?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="ml-auth">
      <main id="main" className={wide ? 'ml-auth__sheet ml-auth__sheet--wide ml-paper' : 'ml-auth__sheet ml-paper'}>
        <div className="ml-auth__brand">
          <BrandMark size={36} />
          <div>
            <p className="ml-auth__product" dir="ltr" lang="en">
              MedLevo AI
            </p>
            <p className="ml-auth__tagline">كتابك الطبي الشخصي</p>
          </div>
        </div>
        <h1 className="ml-auth__title">{title}</h1>
        {intro && <div className="ml-auth__intro">{intro}</div>}
        {children}
      </main>
    </div>
  );
}

/** Live checklist for password guidance: icon + text per rule (never colour alone). */
export function PasswordChecklist({ rules }: { rules: Array<{ ok: boolean; label: string }> }) {
  return (
    <ul className="ml-pw-rules" aria-label="شروط كلمة المرور">
      {rules.map((r) => (
        <li key={r.label} data-ok={r.ok ? 'true' : 'false'}>
          <span className="ml-pw-rules__mark" aria-hidden="true">
            {r.ok ? <CircleCheck size={16} /> : <Circle size={16} />}
          </span>
          <span>{r.label}</span>
          <span className="ml-visually-hidden">{r.ok ? ' (متحقق)' : ' (غير متحقق بعد)'}</span>
        </li>
      ))}
    </ul>
  );
}
