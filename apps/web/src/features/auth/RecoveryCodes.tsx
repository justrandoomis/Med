import { useEffect, useId, useState } from 'react';
import { Copy, Download, Printer, ShieldCheck } from 'lucide-react';
import { Button, Checkbox, useToast } from '../../design';
import { formatDateTime } from '../../lib/time';

export interface RecoveryCodesProps {
  codes: string[];
  /** server notice (Arabic) */
  notice?: string;
  confirmed: boolean;
  onConfirmedChange: (v: boolean) => void;
  /** warn before closing the tab while the codes are unconfirmed */
  guardUnload?: boolean;
}

/**
 * Shows one-time recovery codes ONCE (they are never stored in the browser). Copy / print /
 * download, then an explicit confirmation is required before continuing.
 */
export function RecoveryCodes({ codes, notice, confirmed, onConfirmedChange, guardUnload = true }: RecoveryCodesProps) {
  const toast = useToast();
  const listId = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!guardUnload || confirmed) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [guardUnload, confirmed]);

  const asText = () =>
    ['MedLevo AI — رموز الاسترداد', `أُنشئت: ${formatDateTime(Date.now())}`, 'كل رمز يُستخدم مرة واحدة فقط.', '', ...codes].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      toast.show({ tone: 'success', title: 'نُسخت رموز الاسترداد', description: 'الصقها في مكان آمن خارج هذا الجهاز، ثم امسح الحافظة.' });
    } catch {
      toast.show({ tone: 'warning', title: 'تعذّر النسخ تلقائيًا', description: 'حدّد الرموز وانسخها يدويًا، أو استخدم الطباعة أو التنزيل.' });
    }
  };

  const download = () => {
    const blob = new Blob([asText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'medlevo-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="ml-codes">
      <div className="ml-codes__notice">
        <ShieldCheck size={20} aria-hidden="true" />
        <p>{notice ?? 'احفظ رموز الاسترداد الآن في مكان آمن خارج هذا الجهاز. لن تظهر مرة أخرى، وكل رمز يُستخدم مرة واحدة فقط.'}</p>
      </div>
      <div className="ml-codes__print-area">
        <p className="ml-codes__print-title">MedLevo AI — رموز الاسترداد</p>
        <ul id={listId} className="ml-codes__list" aria-label={`رموز الاسترداد (${codes.length})`} dir="ltr">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
      </div>
      <div className="ml-codes__actions">
        <Button icon={<Copy size={16} />} onClick={() => void copy()}>
          {copied ? 'نُسخت' : 'نسخ الرموز'}
        </Button>
        <Button icon={<Printer size={16} />} onClick={() => window.print()}>
          طباعة
        </Button>
        <Button icon={<Download size={16} />} onClick={download}>
          تنزيل ملف نصي
        </Button>
      </div>
      <Checkbox
        checked={confirmed}
        onCheckedChange={onConfirmedChange}
        label="حفظت رموز الاسترداد في مكان آمن خارج هذا الجهاز"
        description="بدونها لا يمكن استعادة الحساب إن نسيت كلمة المرور."
      />
    </div>
  );
}
