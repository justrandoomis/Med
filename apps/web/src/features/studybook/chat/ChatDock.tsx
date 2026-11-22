// Phone: the explain & chat panel as a NON-modal bottom dock (the modal sheet would freeze the reader behind it, and the
// page sync needs the page visible and scrollable above the chat). Two heights («أكبر» / «أصغر»), Escape or «أغلق»
// closes it; focus is not trapped — the reader above stays reachable.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { IconButton } from '../../../design';
import './chat.css';

export function ChatDock({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const [tall, setTall] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <section
      ref={ref}
      className="ch-dock"
      data-size={tall ? 'tall' : 'half'}
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="ch-dock__bar">
        <span className="ch-dock__title">{title}</span>
        <span>
          <IconButton size="sm" variant="plain" label={tall ? 'صغّر اللوحة' : 'كبّر اللوحة'} icon={tall ? <ChevronDown size={16} /> : <ChevronUp size={16} />} onClick={() => setTall((v) => !v)} />
          <IconButton size="sm" variant="plain" label="أغلق اللوحة" icon={<X size={16} />} onClick={onClose} />
        </span>
      </div>
      <div className="ch-dock__body">{children}</div>
    </section>
  );
}
