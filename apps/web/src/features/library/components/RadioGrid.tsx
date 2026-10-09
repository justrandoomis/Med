// Small radiogroup of visual options (colour swatches, symbols) with roving tabindex and
// RTL-aware arrow keys (design/utils navKeyFor). Each option is labelled for assistive tech.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx, isRtl, navKeyFor, stepIndex } from '../../../design';

export interface RadioGridOption<V extends string> {
  value: V;
  label: string;
  render: ReactNode;
  attrs?: Record<string, string>;
}

export function RadioGrid<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
  optionClassName,
}: {
  label: string;
  options: ReadonlyArray<RadioGridOption<V>>;
  value: V | null;
  onChange: (v: V) => void;
  className?: string;
  optionClassName: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = navKeyFor(e.key, { rtl: isRtl(ref.current), orientation: 'both' });
    if (!step) return;
    e.preventDefault();
    const next = stepIndex(selected, step, options.length, () => false);
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.label}
          title={o.label}
          tabIndex={i === selected ? 0 : -1}
          className={cx(optionClassName)}
          onClick={() => onChange(o.value)}
          {...o.attrs}
        >
          {o.render}
        </button>
      ))}
    </div>
  );
}
