import type { CSSProperties, ReactNode } from 'react';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { cx } from '../utils';
import { Button } from './Button';
import { Spinner } from './Spinner';

/** Placeholder shape while content loads. Decorative (aria-hidden); pair with a LoadingState or hidden text. */
export function Skeleton({ width, height = '1em', radius, lines, className }: { width?: string; height?: string; radius?: string; lines?: number; className?: string }) {
  if (lines && lines > 1) {
    return (
      <div className={cx('ml-skeleton-lines', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="ml-skeleton" style={{ width: i === lines - 1 ? '62%' : '100%', height }} />
        ))}
      </div>
    );
  }
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className={cx('ml-skeleton', className)} style={style} aria-hidden="true" />;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** One clear next step (an empty screen is an invitation to act). */
  actions?: ReactNode;
  className?: string;
  /** heading level for the title inside the page outline (1 when the empty state IS the page, e.g. «not found») */
  headingLevel?: 1 | 2 | 3;
}

export function EmptyState({ icon, title, description, actions, className, headingLevel = 2 }: EmptyStateProps) {
  const H = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className={cx('ml-state', 'ml-state--empty', className)}>
      {icon && (
        <span className="ml-state__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <H className="ml-state__title">{title}</H>
      {description && <div className="ml-state__desc">{description}</div>}
      {actions && <div className="ml-state__actions">{actions}</div>}
    </section>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  /** What happened and what to do next (Arabic, specific). */
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Extra actions (e.g. "open offline copy"). */
  actions?: ReactNode;
  className?: string;
  /** compact inline variant (inside forms / panels) */
  inline?: boolean;
}

export function ErrorState({ title = 'تعذّر إكمال العملية', message, onRetry, retryLabel = 'إعادة المحاولة', retrying, actions, className, inline }: ErrorStateProps) {
  return (
    <section role="alert" className={cx('ml-state', 'ml-state--error', inline && 'ml-state--inline', className)}>
      <span className="ml-state__icon" aria-hidden="true">
        <CircleAlert size={inline ? 20 : 28} />
      </span>
      <div className="ml-state__content">
        <p className="ml-state__title">{title}</p>
        <div className="ml-state__desc">{message}</div>
        {(onRetry || actions) && (
          <div className="ml-state__actions">
            {onRetry && (
              <Button variant="secondary" size={inline ? 'sm' : 'md'} icon={<RotateCcw size={16} />} onClick={onRetry} loading={retrying} loadingLabel="جارٍ إعادة المحاولة…">
                {retryLabel}
              </Button>
            )}
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}

export interface ProgressBarProps {
  /** Accessible name, e.g. «معالجة الصفحات». */
  label: string;
  /** Completed units. Omit when unknown → indeterminate bar (no fake percentage). */
  value?: number;
  /** Total units. Omit when unknown → indeterminate. */
  max?: number;
  /** Human-readable value text, e.g. «12 من 40 صفحة». */
  valueText?: string;
  className?: string;
}

export function ProgressBar({ label, value, max, valueText, className }: ProgressBarProps) {
  const determinate = typeof value === 'number' && typeof max === 'number' && max > 0;
  const ratio = determinate ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? max : undefined}
      aria-valuenow={determinate ? value : undefined}
      aria-valuetext={valueText}
      className={cx('ml-progress', !determinate && 'ml-progress--indeterminate', className)}
    >
      <span className="ml-progress__bar" style={determinate ? { transform: `scaleX(${ratio})` } : undefined} />
    </div>
  );
}

export interface LoadingStateProps {
  /** Real stage name, e.g. «استخراج النص». */
  stage: string;
  /** Real counts only. Without a known total no percentage is shown. */
  done?: number;
  total?: number;
  /** Unit label, e.g. «صفحة». */
  unit?: string;
  className?: string;
  inline?: boolean;
}

/** Long-running work: stage name + real counts (never a fake percentage). */
export function LoadingState({ stage, done, total, unit, className, inline }: LoadingStateProps) {
  const hasTotal = typeof total === 'number' && total > 0;
  const counts =
    typeof done === 'number'
      ? hasTotal
        ? `${done} من ${total}${unit ? ` ${unit}` : ''}`
        : `${done}${unit ? ` ${unit}` : ''}`
      : undefined;
  return (
    <div role="status" aria-live="polite" className={cx('ml-loading', inline && 'ml-loading--inline', className)}>
      <div className="ml-loading__row">
        <Spinner size={18} />
        <span className="ml-loading__stage">{stage}</span>
        {counts && <span className="ml-loading__counts">{counts}</span>}
      </div>
      {(hasTotal || typeof done === 'number') && <ProgressBar label={stage} value={hasTotal ? done : undefined} max={hasTotal ? total : undefined} valueText={counts} />}
    </div>
  );
}
