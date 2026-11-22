// The chat composer: a textarea that grows with its text (up to a cap, then scrolls), Enter sends / Shift+Enter is a
// new line (never while an IME is composing), context chips for the attached page / selection (removable), the
// model + effort picker, and one round button that is «أرسل» or — while an answer streams — «أوقف».
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUp, FileText, Square, TextQuote, X } from 'lucide-react';
import { IconButton } from '../../../design';
import { BidiText } from '../../evidence/BidiText';

export interface ContextChip {
  key: string;
  kind: 'page' | 'selection';
  label: string;
  /** a selection's text (shown shortened) */
  quote?: string;
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  chips: ContextChip[];
  onRemoveChip: (key: string) => void;
  /** e.g. «أرفق الصفحة الحالية» when nothing is attached */
  attachActions?: ReactNode;
  picker?: ReactNode;
  label?: string;
  placeholder?: string;
  /** (smart chat) the «/» command menu, shown above the text */
  menu?: ReactNode;
  /** the menu's keyboard (arrows / Enter / Tab / Escape): return true when the key was handled */
  onMenuKey?: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** the textarea's combobox wiring while the menu is open */
  menuProps?: { 'aria-controls'?: string; 'aria-activedescendant'?: string; 'aria-expanded'?: boolean };
}

export interface ComposerHandle {
  focus: () => void;
}

const MAX_ROWS_PX = 240;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(p, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);
  // grows with the text (layout effect: no visible jump between renders)
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [p.value]);
  const canSend = !p.disabled && p.value.trim().length > 0;
  const reasonId = 'ch-composer-reason';
  return (
    <form
      className="ch-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (p.streaming) p.onStop();
        else if (canSend) p.onSend();
      }}
    >
      {p.chips.length > 0 && (
        <ul className="ch-chips" aria-label="السياق المرفق بالرسالة">
          {p.chips.map((c) => (
            <li key={c.key} className="ch-chip">
              {c.kind === 'page' ? <FileText size={14} aria-hidden="true" /> : <TextQuote size={14} aria-hidden="true" />}
              <span className="ch-chip__label">{c.label}</span>
              {c.quote && <BidiText as="span" className="ch-chip__quote" text={c.quote} />}
              <IconButton size="sm" variant="plain" label={`أزل «${c.label}» من السياق`} icon={<X size={12} />} onClick={() => p.onRemoveChip(c.key)} />
            </li>
          ))}
        </ul>
      )}
      {p.menu}
      <textarea
        ref={ta}
        className="ch-composer__input"
        dir="auto"
        rows={1}
        aria-label={p.label ?? 'رسالتك'}
        placeholder={p.placeholder ?? (p.onMenuKey ? 'اكتب سؤالك، أو / للمهارات… (Enter للإرسال)' : 'اكتب سؤالك… (Enter للإرسال، Shift+Enter لسطر جديد)')}
        value={p.value}
        disabled={p.disabled && !p.streaming}
        aria-describedby={p.disabled && p.disabledReason ? reasonId : undefined}
        aria-autocomplete={p.onMenuKey ? 'list' : undefined}
        {...p.menuProps}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && p.onMenuKey?.(e)) return;
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (!p.streaming && canSend) p.onSend();
        }}
      />
      <div className="ch-composer__bar">
        <div className="ch-composer__tools">
          {p.attachActions}
          {p.picker}
        </div>
        {p.streaming ? (
          <IconButton type="submit" variant="secondary" className="ch-send" label="أوقف الإجابة" icon={<Square size={16} />} />
        ) : (
          <IconButton type="submit" variant="primary" className="ch-send" label="أرسل" icon={<ArrowUp size={18} />} disabled={!canSend} />
        )}
      </div>
      {p.disabled && p.disabledReason && (
        <p id={reasonId} className="ch-composer__reason" role="note">
          {p.disabledReason}
        </p>
      )}
    </form>
  );
});
