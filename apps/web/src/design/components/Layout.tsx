import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx, getFocusable, isRtl, navKeyFor, stepIndex } from '../utils';

/** Keyboard key. Rendered LTR so combinations like Ctrl K read in the right order. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd dir="ltr" className={cx('ml-kbd', className)}>
      {children}
    </kbd>
  );
}

export interface ToolbarProps {
  label: string;
  children: ReactNode;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

/**
 * role="toolbar" with a single tab stop: arrow keys move between controls (RTL-aware),
 * Home/End jump to the ends. Tab leaves the toolbar.
 */
export function Toolbar({ label, children, orientation = 'horizontal', className }: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const activeIndex = useRef(0);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = getFocusable(root).concat(Array.from(root.querySelectorAll<HTMLElement>('[data-toolbar-item][tabindex="-1"]')));
    const unique = Array.from(new Set(items));
    if (activeIndex.current >= unique.length) activeIndex.current = 0;
    unique.forEach((el, i) => {
      el.setAttribute('data-toolbar-item', '');
      el.tabIndex = i === activeIndex.current ? 0 : -1;
    });
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = ref.current;
    if (!root) return;
    const step = navKeyFor(e.key, { rtl: isRtl(root), orientation });
    if (!step) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-toolbar-item]')).filter((el) => !(el as HTMLButtonElement).disabled);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = stepIndex(current === -1 ? 0 : current, step, items.length, () => false);
    const target = items[next];
    if (!target) return;
    e.preventDefault();
    items.forEach((el) => (el.tabIndex = el === target ? 0 : -1));
    activeIndex.current = next;
    target.focus();
  };

  return (
    <div ref={ref} role="toolbar" aria-label={label} aria-orientation={orientation} className={cx('ml-toolbar', `ml-toolbar--${orientation}`, className)} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** Location trail. The last crumb is the current page (aria-current). */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  const rtl = typeof document !== 'undefined' ? document.documentElement.dir !== 'ltr' : true;
  const Sep = rtl ? ChevronLeft : ChevronRight;
  return (
    <nav aria-label="مسار التنقل" className={cx('ml-breadcrumbs', className)}>
      <ol>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i}>
              {c.to && !last ? (
                <Link to={c.to}>{c.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined}>{c.label}</span>
              )}
              {!last && <Sep size={14} aria-hidden="true" className="ml-breadcrumbs__sep" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface ListItemProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading visual (icon) at the inline-start. */
  leading?: ReactNode;
  /** Trailing content at the inline-end (status, meta, chevron). */
  trailing?: ReactNode;
  /** Router link target → renders a link row. */
  to?: string;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
}

/** A list row (≥ 44px). Renders as a link, a button, or static content. Use inside <ul role="list" className="ml-list">. */
export function ListItem({ title, subtitle, leading, trailing, to, onClick, selected, disabled, className }: ListItemProps) {
  const body = (
    <>
      {leading && (
        <span className="ml-list-item__leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="ml-list-item__text">
        <span className="ml-list-item__title">{title}</span>
        {subtitle && <span className="ml-list-item__subtitle">{subtitle}</span>}
      </span>
      {trailing && <span className="ml-list-item__trailing">{trailing}</span>}
    </>
  );
  const cls = cx('ml-list-item', (to || onClick) && 'ml-list-item--interactive', selected && 'ml-list-item--selected', disabled && 'ml-list-item--disabled', className);
  return (
    <li className="ml-list__row">
      {to && !disabled ? (
        <Link to={to} className={cls} aria-current={selected ? 'page' : undefined}>
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-pressed={selected ? true : undefined}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
