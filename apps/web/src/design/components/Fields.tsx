import {
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, ChevronDown, CircleAlert, Eye, EyeOff } from 'lucide-react';
import { cx, isRtl, navKeyFor, stepIndex } from '../utils';

interface FieldFrameProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Hide the label visually (still announced). Prefer visible labels. */
  hideLabel?: boolean;
  className?: string;
  children: (describedBy: string | undefined) => ReactNode;
}

function FieldFrame({ id, label, hint, error, required, hideLabel, className, children }: FieldFrameProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('ml-field', error ? 'ml-field--invalid' : undefined, className)}>
      <label htmlFor={id} className={cx('ml-field__label', hideLabel && 'ml-visually-hidden')}>
        {label}
        {required && (
          <span className="ml-field__required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {hint && (
        <p id={hintId} className="ml-field__hint">
          {hint}
        </p>
      )}
      {children(describedBy)}
      {error && (
        <p id={errorId} className="ml-field__error">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  id?: string;
  /** Content shown inside the field at its inline-end (e.g. a reveal button). */
  endAdornment?: ReactNode;
  fieldClassName?: string;
  ref?: Ref<HTMLInputElement>;
}

export function TextField({ label, hint, error, hideLabel, id, required, className, fieldClassName, endAdornment, ref, ...rest }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? `f${autoId}`;
  return (
    <FieldFrame id={inputId} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      {(describedBy) => (
        <div className={cx('ml-input-wrap', endAdornment ? 'ml-input-wrap--adorned' : undefined)}>
          <input
            ref={ref}
            id={inputId}
            className={cx('ml-input', className)}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            required={required}
            {...rest}
          />
          {endAdornment && <span className="ml-input-wrap__end">{endAdornment}</span>}
        </div>
      )}
    </FieldFrame>
  );
}

export interface PasswordFieldProps extends Omit<TextFieldProps, 'type' | 'endAdornment'> {
  showLabel?: string;
  hideLabelText?: string;
}

/** Password input with a reveal toggle. Always LTR (passwords are typed in logical order). */
export function PasswordField({ showLabel = 'إظهار كلمة المرور', hideLabelText = 'إخفاء كلمة المرور', ...rest }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...rest}
      type={visible ? 'text' : 'password'}
      dir="ltr"
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      endAdornment={
        <button
          type="button"
          className="ml-input-reveal"
          aria-label={visible ? hideLabelText : showLabel}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      }
    />
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  id?: string;
  fieldClassName?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({ label, hint, error, hideLabel, id, required, className, fieldClassName, rows = 4, ref, ...rest }: TextAreaProps) {
  const autoId = useId();
  const inputId = id ?? `f${autoId}`;
  return (
    <FieldFrame id={inputId} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      {(describedBy) => (
        <textarea
          ref={ref}
          id={inputId}
          rows={rows}
          className={cx('ml-input ml-textarea', className)}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          required={required}
          {...rest}
        />
      )}
    </FieldFrame>
  );
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'onChange' | 'value'> {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  hideLabel?: boolean;
  id?: string;
  options: ReadonlyArray<SelectOption<V>>;
  value: V;
  onValueChange: (value: V) => void;
  fieldClassName?: string;
}

/** Native select (best keyboard, screen reader and touch behaviour on every platform). */
export function Select<V extends string = string>({
  label,
  hint,
  error,
  hideLabel,
  id,
  options,
  value,
  onValueChange,
  required,
  className,
  fieldClassName,
  ...rest
}: SelectProps<V>) {
  const autoId = useId();
  const inputId = id ?? `f${autoId}`;
  return (
    <FieldFrame id={inputId} label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={fieldClassName}>
      {(describedBy) => (
        <div className="ml-select-wrap">
          <select
            id={inputId}
            className={cx('ml-input ml-select', className)}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            required={required}
            value={value}
            onChange={(e) => onValueChange(e.target.value as V)}
            {...rest}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown className="ml-select-wrap__chevron" size={18} aria-hidden="true" />
        </div>
      )}
    </FieldFrame>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** On/off setting that applies immediately (role="switch"). Label sits at inline-start, switch at inline-end. */
export function Switch({ checked, onCheckedChange, label, description, disabled, id, className }: SwitchProps) {
  const autoId = useId();
  const switchId = id ?? `s${autoId}`;
  const labelId = `${switchId}-label`;
  const descId = description ? `${switchId}-desc` : undefined;
  return (
    <div className={cx('ml-switch-row', disabled && 'ml-switch-row--disabled', className)}>
      <div className="ml-switch-row__text">
        <span id={labelId} className="ml-switch-row__label">
          {label}
        </span>
        {description && (
          <span id={descId} className="ml-switch-row__desc">
            {description}
          </span>
        )}
      </div>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        disabled={disabled}
        className="ml-switch"
        onClick={() => onCheckedChange(!checked)}
      >
        <span className="ml-switch__thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ checked, onCheckedChange, label, description, id, className, disabled, ref, ...rest }: CheckboxProps) {
  const autoId = useId();
  const boxId = id ?? `c${autoId}`;
  const descId = description ? `${boxId}-desc` : undefined;
  return (
    <div className={cx('ml-checkbox', disabled && 'ml-checkbox--disabled', className)}>
      <span className="ml-checkbox__box">
        <input
          ref={ref}
          id={boxId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={descId}
          onChange={(e) => onCheckedChange(e.target.checked)}
          {...rest}
        />
        <Check className="ml-checkbox__mark" size={14} strokeWidth={3} aria-hidden="true" />
      </span>
      <span className="ml-checkbox__text">
        <label htmlFor={boxId} className="ml-checkbox__label">
          {label}
        </label>
        {description && (
          <span id={descId} className="ml-checkbox__desc">
            {description}
          </span>
        )}
      </span>
    </div>
  );
}

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Accessible group name. */
  label: string;
  /** Show the group label above the control. */
  showLabel?: boolean;
  options: ReadonlyArray<SegmentedOption<V>>;
  value: V;
  onValueChange: (value: V) => void;
  size?: 'sm' | 'md';
  className?: string;
  fullWidth?: boolean;
}

/**
 * Mutually-exclusive choice among 2–5 short options (radiogroup semantics). Arrow keys move and
 * select, respecting RTL (ArrowLeft = next in Arabic).
 */
export function SegmentedControl<V extends string = string>({
  label,
  showLabel = false,
  options,
  value,
  onValueChange,
  size = 'md',
  className,
  fullWidth,
}: SegmentedControlProps<V>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(groupRef.current), orientation: 'horizontal' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(selectedIndex, step, options.length, (i) => !!options[i]?.disabled);
    const opt = options[next];
    if (!opt) return;
    onValueChange(opt.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[next]?.focus();
  };

  return (
    <div className={cx('ml-segmented-field', fullWidth && 'ml-segmented-field--full', className)}>
      {showLabel && (
        <span id={labelId} className="ml-field__label">
          {label}
        </span>
      )}
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? labelId : undefined}
        className={cx('ml-segmented', `ml-segmented--${size}`)}
        onKeyDown={onKeyDown}
      >
        {options.map((o, i) => {
          const checked = i === selectedIndex;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={o.disabled}
              className="ml-segmented__option"
              onClick={() => onValueChange(o.value)}
            >
              {o.icon && (
                <span className="ml-btn__icon" aria-hidden="true">
                  {o.icon}
                </span>
              )}
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
