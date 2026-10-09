import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { newId } from '@medlevo/shared';
import { cx } from '../utils';
import { Portal } from './Portal';

export type ToastTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms; null = stays until dismissed. Defaults: danger → null, warning → 8000, others → 5000. */
  duration?: number | null;
}

interface ToastItem extends ToastOptions {
  id: string;
}

interface ToastApi {
  show: (opts: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const TONE_ICON: Record<ToastTone, ReactNode> = {
  neutral: <Info size={18} />,
  info: <Info size={18} />,
  success: <CircleCheck size={18} />,
  warning: <TriangleAlert size={18} />,
  danger: <CircleAlert size={18} />,
};

/**
 * Toasts announce through two always-mounted live regions: polite (role="status") for
 * confirmations and assertive (role="alert") for errors. Errors stay until dismissed.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: string) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback((opts: ToastOptions) => {
    const id = newId();
    setItems((list) => [...list.slice(-3), { ...opts, id }]);
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const polite = items.filter((t) => t.tone !== 'danger');
  const assertive = items.filter((t) => t.tone === 'danger');
  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        <div className="ml-toasts ml-no-print">
          <div role="status" aria-live="polite" aria-atomic="false" className="ml-toasts__region">
            {polite.map((t) => (
              <ToastView key={t.id} item={t} onDismiss={dismiss} />
            ))}
          </div>
          <div role="alert" aria-live="assertive" aria-atomic="false" className="ml-toasts__region">
            {assertive.map((t) => (
              <ToastView key={t.id} item={t} onDismiss={dismiss} />
            ))}
          </div>
        </div>
      </Portal>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const tone = item.tone ?? 'neutral';
  const duration = item.duration !== undefined ? item.duration : tone === 'danger' ? null : tone === 'warning' ? 8000 : 5000;
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration ?? 0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (duration == null || paused) return;
    startedAt.current = Date.now();
    const t = window.setTimeout(() => onDismiss(item.id), remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [duration, paused, item.id, onDismiss]);

  return (
    <div
      className={cx('ml-toast', `ml-toast--${tone}`)}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="ml-toast__icon" aria-hidden="true">
        {TONE_ICON[tone]}
      </span>
      <div className="ml-toast__text">
        <p className="ml-toast__title">{item.title}</p>
        {item.description && <p className="ml-toast__desc">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          className="ml-toast__action"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="ml-toast__close" aria-label="إغلاق الإشعار" onClick={() => onDismiss(item.id)}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
