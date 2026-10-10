// Accessible horizontal bar list (dataviz method): one series → one validated hue (no legend box; the caption names
// what is plotted), thin bars (12px) growing from the inline-start baseline with a rounded data end, the track is the
// row's DENOMINATOR (so «3 من 9» reads as a part of a stated whole — never a percentage without its base), every value
// is written next to its bar (text tokens, not the bar colour), and a table view holds the same numbers.
// Bars are aria-hidden; the label + value text carries the information (status / identity never by colour alone).
import { useId, useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { Button, cx } from '../../../design';

export interface BarDatum {
  key: string;
  label: ReactNode;
  /** plain text of the label (table / screen readers) */
  labelText: string;
  value: number;
  denominator: number;
  /** extra words after the value («ظهر 4 مرات») */
  note?: string | null;
}

export interface BarListProps {
  caption: string;
  description?: ReactNode;
  data: BarDatum[];
  /** column header for the value («أسئلة فريدة») */
  valueHeader: string;
  /** «3 من 9» by default */
  valueText?: (d: BarDatum) => string;
  emptyText?: string;
  /** start in the table view */
  initialView?: 'chart' | 'table';
  className?: string;
}

export const ofText = (d: Pick<BarDatum, 'value' | 'denominator'>) => `${d.value} من ${d.denominator}`;

export function BarList({ caption, description, data, valueHeader, valueText = ofText, emptyText = 'لا بيانات بعد.', initialView = 'chart', className }: BarListProps) {
  const [view, setView] = useState<'chart' | 'table'>(initialView);
  const capId = useId();
  return (
    <figure className={cx('lw-bars', className)} aria-labelledby={capId}>
      <div className="lw-bars__head">
        <figcaption id={capId} className="lw-bars__caption">
          {caption}
        </figcaption>
        {data.length > 0 && (
          <Button size="sm" variant="plain" icon={view === 'chart' ? <Table2 size={16} /> : <BarChart3 size={16} />} onClick={() => setView((v) => (v === 'chart' ? 'table' : 'chart'))} aria-pressed={view === 'table'}>
            {view === 'chart' ? 'اعرض كجدول' : 'اعرض كمخطط'}
          </Button>
        )}
      </div>
      {description && <div className="lw-bars__desc">{description}</div>}
      {data.length === 0 ? (
        <p className="lw-muted">{emptyText}</p>
      ) : view === 'chart' ? (
        <ul className="lw-bars__list">
          {data.map((d) => {
            const frac = d.denominator > 0 ? Math.min(1, Math.max(0, d.value / d.denominator)) : 0;
            return (
              <li key={d.key} className="lw-bars__row">
                <span className="lw-bars__label">
                  {d.label}
                  {d.note ? <span className="lw-bars__note">{d.note}</span> : null}
                </span>
                <span className="lw-bars__track" aria-hidden="true">
                  <span className="lw-bars__fill" style={{ width: `${frac * 100}%` }} data-zero={d.value === 0 || undefined} />
                </span>
                <span className="lw-bars__value">{valueText(d)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="lw-table-wrap">
          <table className="lw-table">
            <caption className="ml-visually-hidden">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">البند</th>
                <th scope="col">{valueHeader}</th>
                <th scope="col">المقام</th>
                <th scope="col">ملاحظة</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.key}>
                  <th scope="row">{d.labelText}</th>
                  <td>{d.value}</td>
                  <td>{d.denominator}</td>
                  <td>{d.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
