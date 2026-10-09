import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { cx, getFocusable, useOutsidePointer } from '../utils';
import { Portal, useFloatingPosition } from './Portal';

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  'aria-haspopup'?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
};

interface MenuContextValue {
  close: (returnFocus?: boolean) => void;
}
const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  /** The trigger element (Button / IconButton). Receives ref, aria-* and handlers. */
  trigger: ReactElement<TriggerProps>;
  /** Accessible name of the menu (defaults to the trigger's name via aria-labelledby). */
  label?: string;
  align?: 'start' | 'end';
  children: ReactNode;
  className?: string;
}

/**
 * Action menu (role="menu"). Opens with click / Enter / Space / ArrowDown (first item) / ArrowUp
 * (last item). ArrowUp/Down, Home/End move; Escape closes and returns focus to the trigger;
 * Tab closes. Items are activated with Enter/Space/click.
 */
export function Menu({ trigger, label, align = 'start', children, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [focusLast, setFocusLast] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const triggerId = useId();
  const pos = useFloatingPosition(triggerRef, menuRef, open, { align });

  const items = () => (menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')) : []);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useOutsidePointer([menuRef, triggerRef], open, () => close(false));

  useEffect(() => {
    if (!open || !pos.ready) return;
    const list = items();
    (focusLast ? list[list.length - 1] : list[0])?.focus();
  }, [open, pos.ready, focusLast]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    switch (e.key) {
      case 'ArrowDown':
        next = (i + 1) % list.length;
        break;
      case 'ArrowUp':
        next = (i - 1 + list.length) % list.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab': {
        // The menu is portaled to the end of <body>: move on from the TRIGGER's position, as if the
        // menu were not there (WAI-ARIA menu button: Tab closes the menu and moves to the next control).
        e.preventDefault();
        const trigger = triggerRef.current;
        close(false);
        if (trigger) {
          const scope = getFocusable(document.getElementById('root') ?? document.body);
          const at = scope.indexOf(trigger);
          const target = at >= 0 ? scope[at + (e.shiftKey ? -1 : 1)] : undefined;
          (target ?? trigger).focus();
        }
        return;
      }
      default: {
        // typeahead: first item whose text starts with the typed character
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLocaleLowerCase();
          const start = i + 1;
          for (let k = 0; k < list.length; k++) {
            const el = list[(start + k) % list.length]!;
            if ((el.textContent ?? '').trim().toLocaleLowerCase().startsWith(ch)) {
              el.focus();
              break;
            }
          }
        }
        return;
      }
    }
    e.preventDefault();
    list[next]?.focus();
  };

  if (!isValidElement(trigger)) throw new Error('Menu trigger must be a React element');
  const triggerEl = cloneElement(trigger, {
    ref: triggerRef as Ref<HTMLElement>,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      trigger.props.onClick?.(e);
      setFocusLast(false);
      setOpen((o) => !o);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      trigger.props.onKeyDown?.(e);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusLast(e.key === 'ArrowUp');
        setOpen(true);
      }
    },
  });

  return (
    <>
      <span id={triggerId} className="ml-menu-anchor">
        {triggerEl}
      </span>
      {open && (
        <Portal>
          <MenuContext.Provider value={{ close }}>
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              aria-labelledby={label ? undefined : triggerId}
              className={cx('ml-menu', className)}
              data-placement={pos.placement}
              style={{ top: pos.top, left: pos.left, visibility: pos.ready ? 'visible' : 'hidden' }}
              onKeyDown={onMenuKeyDown}
            >
              {children}
            </div>
          </MenuContext.Provider>
        </Portal>
      )}
    </>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  children: ReactNode;
  icon?: ReactNode;
  /** Short hint shown at the inline-end (e.g. a keyboard shortcut). */
  hint?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** Reason shown when disabled (never a silent no-op). */
  disabledReason?: string;
}

export function MenuItem({ onSelect, children, icon, hint, destructive, disabled, disabledReason }: MenuItemProps) {
  const ctx = useContext(MenuContext);
  const activate = () => {
    if (disabled) return;
    ctx?.close(true);
    onSelect();
  };
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled ? true : undefined}
      className={cx('ml-menu__item', destructive && 'ml-menu__item--destructive')}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      {icon && (
        <span className="ml-menu__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="ml-menu__label">
        {children}
        {disabled && disabledReason && <span className="ml-menu__reason">{disabledReason}</span>}
      </span>
      {hint && <span className="ml-menu__hint">{hint}</span>}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="ml-menu__separator" />;
}

export interface PopoverProps {
  trigger: ReactElement<TriggerProps>;
  /** Accessible name of the popover content. */
  label: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end' | 'center';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Non-modal popover (role="dialog"). Focus moves inside on open; Escape or an outside click
 * closes it and focus returns to the trigger.
 */
export function Popover({ trigger, label, children, align = 'start', className, open: openProp, onOpenChange }: PopoverProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback(
    (v: boolean) => {
      if (openProp === undefined) setOpenState(v);
      onOpenChange?.(v);
    },
    [openProp, onOpenChange],
  );
  const triggerRef = useRef<HTMLElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const pos = useFloatingPosition(triggerRef, popRef, open, { align });

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [setOpen],
  );
  useOutsidePointer([popRef, triggerRef], open, () => close(false));

  useEffect(() => {
    if (!open || !pos.ready || !popRef.current) return;
    const first = getFocusable(popRef.current)[0];
    (first ?? popRef.current).focus();
  }, [open, pos.ready]);

  if (!isValidElement(trigger)) throw new Error('Popover trigger must be a React element');
  const triggerEl = cloneElement(trigger, {
    ref: triggerRef as Ref<HTMLElement>,
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? popId : undefined,
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      trigger.props.onClick?.(e);
      setOpen(!open);
    },
  });

  return (
    <>
      {triggerEl}
      {open && (
        <Portal>
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            className={cx('ml-popover', className)}
            data-placement={pos.placement}
            style={{ top: pos.top, left: pos.left, visibility: pos.ready ? 'visible' : 'hidden' }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(true);
                return;
              }
              // The popover is portaled to the end of <body>, so the browser's own Tab order would leave
              // it for the page end (Tab) or the page's last control (Shift+Tab). Keep the logical order:
              // Shift+Tab from the start → back to the trigger; Tab from the end → the control after it.
              if (e.key === 'Tab' && popRef.current) {
                const items = getFocusable(popRef.current);
                const active = document.activeElement;
                const atStart = active === popRef.current || active === items[0];
                const atEnd = items.length === 0 || active === items[items.length - 1];
                if (e.shiftKey ? atStart : atEnd) {
                  e.preventDefault();
                  const trigger = triggerRef.current;
                  close(!!e.shiftKey);
                  if (!e.shiftKey && trigger) {
                    const scope = getFocusable(document.getElementById('root') ?? document.body);
                    const at = scope.indexOf(trigger);
                    const next = at >= 0 ? scope[at + 1] : undefined;
                    (next ?? trigger).focus();
                  }
                }
              }
            }}
            onBlur={(e) => {
              // non-modal: close when keyboard focus moves elsewhere (not into the trigger)
              const next = e.relatedTarget as Node | null;
              if (next && !popRef.current?.contains(next) && !triggerRef.current?.contains(next)) close(false);
            }}
          >
            {typeof children === 'function' ? children(() => close(true)) : children}
          </div>
        </Portal>
      )}
    </>
  );
}
