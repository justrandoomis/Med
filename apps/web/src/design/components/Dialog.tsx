import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { cx, useFocusTrap, useInertAppRoot, useScrollLock } from '../utils';
import { Portal } from './Portal';
import { usePresence } from './presence';
import { Button, IconButton } from './Button';
import { TextField } from './Fields';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** false: Escape / scrim / close button do nothing (use only while an irreversible step runs). */
  dismissible?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  role?: 'dialog' | 'alertdialog';
  className?: string;
  /** Hide the × button (e.g. when the footer already offers a clear way out). */
  hideCloseButton?: boolean;
}

/**
 * Modal dialog: role="dialog" + aria-modal, labelled by its title, focus trapped inside, the app
 * root made inert, Escape closes (when dismissible), focus returns to the opener.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  initialFocusRef,
  role = 'dialog',
  className,
  hideCloseButton,
}: DialogProps) {
  const { mounted, state } = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, open, { initialFocus: initialFocusRef });
  useScrollLock(open);
  useInertAppRoot(open);

  if (!mounted) return null;
  return (
    <Portal>
      <div
        className="ml-overlay"
        data-state={state}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && dismissible && open) onClose();
        }}
      >
        <div
          ref={panelRef}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          className={cx('ml-dialog', `ml-dialog--${size}`, className)}
          data-state={state}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (dismissible) onClose();
            }
          }}
        >
          <header className="ml-dialog__header">
            <h2 id={titleId} className="ml-dialog__title">
              {title}
            </h2>
            {!hideCloseButton && dismissible && <IconButton label="إغلاق" icon={<X size={20} />} onClick={onClose} className="ml-dialog__close" />}
          </header>
          {description && (
            <div id={descId} className="ml-dialog__description">
              {description}
            </div>
          )}
          {children && <div className="ml-dialog__body">{children}</div>}
          {footer && <footer className="ml-dialog__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /**
   * Explicit consequence of confirming, in plain Arabic (§49: destructive changes show their impact).
   * e.g. «ستتوقف رموز الاسترداد القديمة عن العمل فورًا.»
   */
  impact: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Runs the action. The dialog stays open (busy) until it resolves; errors are shown inline. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Optional typed confirmation for irreversible actions (e.g. the item title). */
  requireText?: string;
  children?: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  impact,
  confirmLabel,
  cancelLabel = 'إلغاء',
  destructive = false,
  onConfirm,
  onCancel,
  requireText,
  children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typedOk = !requireText || typed.trim() === requireText;

  const run = async () => {
    if (!typedOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setTyped('');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'تعذّر تنفيذ الإجراء. حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy) return;
    setError(null);
    setTyped('');
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      role="alertdialog"
      size="sm"
      dismissible={!busy}
      // Destructive actions start on the safe choice.
      initialFocusRef={destructive ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'primary'}
            loading={busy}
            disabled={!typedOk}
            onClick={run}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={cx('ml-impact', destructive && 'ml-impact--destructive')}>
        {destructive && <TriangleAlert size={20} aria-hidden="true" className="ml-impact__icon" />}
        <div className="ml-impact__text">{impact}</div>
      </div>
      {children}
      {requireText && (
        <TextField
          label={
            <>
              للتأكيد اكتب: <bdi className="ml-confirm-text">{requireText}</bdi>
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      )}
      {error && (
        <p className="ml-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
