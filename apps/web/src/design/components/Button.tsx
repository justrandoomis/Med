import type { ButtonHTMLAttributes, ReactNode, Ref, MouseEvent } from 'react';
import { cx } from '../utils';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export function buttonClass(opts: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}): string {
  const { variant = 'secondary', size = 'md', fullWidth, className } = opts;
  return cx('ml-btn', `ml-btn--${variant}`, `ml-btn--${size}`, fullWidth && 'ml-btn--full', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks activation while keeping focus on the button. */
  loading?: boolean;
  /** Announced while loading, e.g. «جارٍ الحفظ…». */
  loadingLabel?: string;
  /** Icon before the label (inline-start). */
  icon?: ReactNode;
  /** Icon after the label (inline-end). */
  iconEnd?: ReactNode;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Button. Variants: primary (one per view), secondary, plain (text-like), destructive.
 * Uses aria-disabled while loading so keyboard focus is not lost mid-action.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel = 'جارٍ التنفيذ…',
  icon,
  iconEnd,
  fullWidth,
  className,
  children,
  type = 'button',
  onClick,
  disabled,
  ref,
  ...rest
}: ButtonProps) {
  const blocked = loading || disabled;
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, fullWidth, className })}
      disabled={disabled && !loading ? true : undefined}
      aria-disabled={blocked ? true : undefined}
      aria-busy={loading ? true : undefined}
      data-loading={loading ? '' : undefined}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : icon ? <span className="ml-btn__icon">{icon}</span> : null}
      {children != null && <span className="ml-btn__label">{children}</span>}
      {loading && <span className="ml-visually-hidden">{loadingLabel}</span>}
      {!loading && iconEnd ? <span className="ml-btn__icon">{iconEnd}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required accessible name (Arabic). Icon-only controls must always be named. */
  label: string;
  icon: ReactNode;
  variant?: 'plain' | 'secondary' | 'primary' | 'destructive';
  size?: ButtonSize;
  /** Pressed state for toggle buttons (aria-pressed). */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon, variant = 'plain', size = 'md', pressed, className, type = 'button', ref, ...rest }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      className={cx('ml-icon-btn', `ml-btn--${variant}`, `ml-icon-btn--${size}`, className)}
      {...rest}
    >
      <span className="ml-btn__icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}
