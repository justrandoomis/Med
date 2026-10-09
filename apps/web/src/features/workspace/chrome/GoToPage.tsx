// Page indicator + "go to page" (AC-04): shows the printed label and the file position; accepts either
// («12», «ص 12», «#14», «الصفحة 14 في الملف»), and offers the other reading when both exist.
import { useId, useState } from 'react';
import type { SourcePageView } from '@medlevo/shared';
import { Button, Popover, cx } from '../../../design';
import { folio, resolveGoTo, fullPageLabel } from '../model/pages';

export function GoToPage({ pages, pageIndex, onGo, compact }: { pages: readonly SourcePageView[]; pageIndex: number; onGo: (index: number) => void; compact?: boolean }) {
  const page = pages[pageIndex];
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [alt, setAlt] = useState<{ index: number; label: string } | null>(null);
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const f = page ? folio(page) : null;
  const total = pages.length;

  const submit = (close: () => void) => {
    const r = resolveGoTo(value, pages);
    if (!r.ok) {
      setError(r.error);
      setAlt(null);
      return;
    }
    onGo(r.index);
    if (r.alternative && pages[r.alternative.index]) {
      setAlt({ index: r.alternative.index, label: fullPageLabel(pages[r.alternative.index]!) });
      setError(null);
      return; // keep open to offer the other reading
    }
    setValue('');
    setError(null);
    close();
  };

  return (
    <Popover
      label="الانتقال إلى صفحة"
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setError(null);
          setAlt(null);
        }
      }}
      trigger={
        <button type="button" className={cx('wk-pageind', compact && 'wk-pageind--compact')} aria-label={page ? `${fullPageLabel(page)}، ${pageIndex + 1} من ${total}. الانتقال إلى صفحة` : 'الانتقال إلى صفحة'}>
          <span className="wk-pageind__primary">{f?.primary ?? '—'}</span>
          {!compact && f?.secondary && <span className="wk-pageind__secondary">{f.secondary}</span>}
          <span className="wk-pageind__count" aria-hidden="true">
            {pageIndex + 1}/{total}
          </span>
        </button>
      }
    >
      {(close) => (
        <form
          className="wk-goto"
          onSubmit={(e) => {
            e.preventDefault();
            submit(close);
          }}
        >
          <label htmlFor={inputId} className="ml-field__label">
            انتقل إلى صفحة
          </label>
          <p id={hintId} className="ml-field__hint">
            اكتب الرقم المطبوع في الكتاب (مثل 12)، أو #رقمها في الملف (مثل #14).
          </p>
          <div className="wk-goto__row">
            <input
              id={inputId}
              className="ml-input"
              value={value}
              inputMode="text"
              dir="auto"
              autoComplete="off"
              aria-describedby={hintId}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
                setAlt(null);
              }}
            />
            <Button type="submit" variant="primary" size="md">
              انتقال
            </Button>
          </div>
          {error && (
            <p className="ml-field__error" role="alert">
              {error}
            </p>
          )}
          {alt && (
            <div className="wk-goto__alt" role="status">
              <span>فُتحت الصفحة المطبوع عليها هذا الرقم. هل تقصد</span>
              <Button
                size="sm"
                variant="plain"
                onClick={() => {
                  onGo(alt.index);
                  setAlt(null);
                  setValue('');
                  close();
                }}
              >
                {alt.label}
              </Button>
            </div>
          )}
        </form>
      )}
    </Popover>
  );
}
