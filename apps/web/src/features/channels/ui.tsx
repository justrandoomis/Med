// Small pieces shared by the channel screens, «التنبيهات», «أنا» and «إدارة القنوات» (P1-T4 step 3; IA §8.2):
// RoleBadge, InlineBanner, CachedBanner, ReasonedButton (a control that cannot act says why — AOS-23.3) and useCopy.
// QrCard lives in QrCard.tsx (it loads the QR encoder). Tokens only; text + icon, never colour alone.
import { useId, type ReactNode } from 'react';
import { CloudOff, type LucideIcon } from 'lucide-react';
import { CHANNEL_ROLE_LABELS_AR, type ChannelRole } from '@medlevo/shared';
import { Button, useToast, type ButtonProps } from '../../design';
import { formatDateTime } from '../../lib/time';
import './channels.css';

/** «مشرف المادة» — shown only where the role matters (never «طالب»: a student is a member, not a role). */
export function RoleBadge({ role }: { role: ChannelRole }) {
  return <span className="ch-role">{CHANNEL_ROLE_LABELS_AR[role]}</span>;
}

/** A non-modal notice with one optional action (`role="status"`). */
export function InlineBanner({ icon: Icon, children, action, tone = 'neutral' }: { icon: LucideIcon; children: ReactNode; action?: ReactNode; tone?: 'neutral' | 'warning' }) {
  return (
    <div role="status" className={`ch-banner ch-banner--${tone}`}>
      <Icon size={18} aria-hidden="true" className="ch-banner__icon" />
      <div className="ch-banner__text">{children}</div>
      {action}
    </div>
  );
}

/** The banner of a channel screen shown from the copy saved on this device (AOS-20.17). */
export function CachedBanner({ at }: { at: number }) {
  return (
    <InlineBanner icon={CloudOff} tone="warning">
      <strong>غير متصل</strong> · تعرض نسخة محفوظة على هذا الجهاز من {formatDateTime(at)} — الانضمام والمتابعة والقرارات تحتاج اتصالًا.
    </InlineBanner>
  );
}

/** A button that, when it cannot act, is disabled and says why in its accessible description (and on screen). */
export function ReasonedButton({ reason, children, ...rest }: ButtonProps & { reason?: string | null }) {
  const id = useId();
  if (!reason) return <Button {...rest}>{children}</Button>;
  return (
    <span className="ch-reasoned">
      <Button {...rest} disabled aria-describedby={id}>
        {children}
      </Button>
      <span id={id} className="ch-reasoned__why">
        {reason}
      </span>
    </span>
  );
}

/** Copy a text to the clipboard with a toast either way. */
export function useCopy() {
  const toast = useToast();
  return async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ title: `نُسخ ${what}.`, tone: 'success' });
    } catch {
      toast.show({ title: `تعذّر النسخ تلقائيًا على هذا الجهاز: حدّد ${what} وانسخه يدويًا.`, tone: 'warning' });
    }
  };
}
