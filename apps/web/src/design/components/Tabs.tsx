import { createContext, useContext, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx, isRtl, navKeyFor, stepIndex } from '../utils';

interface TabsContextValue {
  baseId: string;
  value: string;
  select: (value: string) => void;
  activation: 'automatic' | 'manual';
  orientation: 'horizontal' | 'vertical';
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tab / TabList / TabPanel must be used inside <Tabs>');
  return ctx;
}

const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, '_');

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  /** automatic: arrow keys select; manual: arrow keys move focus, Enter/Space selects. */
  activation?: 'automatic' | 'manual';
  orientation?: 'horizontal' | 'vertical';
  children: ReactNode;
  className?: string;
}

/**
 * WAI-ARIA tabs with roving tabindex. In RTL contexts ArrowLeft moves to the next tab
 * (reading order) and ArrowRight to the previous one; Home/End jump to the ends.
 */
export function Tabs({ value, onValueChange, activation = 'automatic', orientation = 'horizontal', children, className }: TabsProps) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ baseId: `t${safe(baseId)}`, value, select: onValueChange, activation, orientation }}>
      <div className={cx('ml-tabs', `ml-tabs--${orientation}`, className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const { activation, orientation, select } = useTabs();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;
    const step = navKeyFor(e.key, { rtl: isRtl(list), orientation });
    if (!step) return;
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = tabs.findIndex((t) => t === document.activeElement);
    const next = stepIndex(current === -1 ? 0 : current, step, tabs.length, (i) => tabs[i]!.disabled);
    const target = tabs[next];
    if (!target) return;
    e.preventDefault();
    target.focus();
    if (activation === 'automatic') {
      const v = target.dataset.value;
      if (v != null) select(v);
    } else {
      // manual activation: roving focus only — tabindex follows focus
      tabs.forEach((t) => (t.tabIndex = t === target ? 0 : -1));
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={cx('ml-tablist', className)}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children, disabled, icon, className }: { value: string; children: ReactNode; disabled?: boolean; icon?: ReactNode; className?: string }) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${safe(value)}`}
      aria-controls={`${ctx.baseId}-panel-${safe(value)}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      data-value={value}
      className={cx('ml-tab', className)}
      onClick={() => ctx.select(value)}
      onKeyDown={(e) => {
        if (ctx.activation === 'manual' && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          ctx.select(value);
        }
      }}
    >
      {icon && (
        <span className="ml-btn__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </button>
  );
}

export function TabPanel({ value, children, className, keepMounted = false }: { value: string; children: ReactNode; className?: string; keepMounted?: boolean }) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  if (!selected && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${safe(value)}`}
      aria-labelledby={`${ctx.baseId}-tab-${safe(value)}`}
      hidden={!selected}
      tabIndex={0}
      className={cx('ml-tabpanel', className)}
    >
      {children}
    </div>
  );
}
