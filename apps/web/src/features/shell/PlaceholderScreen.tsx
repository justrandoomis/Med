import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Construction } from 'lucide-react';
import { Bidi, buttonClass } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';

export interface PlaceholderScreenProps {
  title: string;
  /** one sentence: what this screen is for */
  purpose: string;
  /** what it will contain when built (honest list, no fake data) */
  willContain: ReactNode[];
  /** spec sections, e.g. "§45" */
  spec?: string;
  icon?: ReactNode;
  /** full-bleed routes have no shell, so they need their own way back */
  showHomeLink?: boolean;
}

/**
 * Honest placeholder for a screen another track is building (§61: unfinished features are shown
 * as unfinished, never as working). No sample data, no dead buttons.
 */
export function PlaceholderScreen({ title, purpose, willContain, spec, icon, showHomeLink }: PlaceholderScreenProps) {
  usePageTitle(title);
  return (
    <div className="ml-page ml-page--narrow">
      <header className="ml-page__header">
        <h1 className="ml-page__title">{title}</h1>
        <p className="ml-page__lede">{purpose}</p>
      </header>
      <section className="ml-placeholder ml-paper" aria-labelledby="placeholder-status">
        <div className="ml-placeholder__status">
          <span className="ml-placeholder__icon" aria-hidden="true">
            {icon ?? <Construction size={22} />}
          </span>
          <div>
            <h2 id="placeholder-status" className="ml-placeholder__title">
              هذه الشاشة قيد البناء
            </h2>
            <p className="ml-placeholder__note">لا تعرض بيانات تجريبية؛ ستُربط ببياناتك الحقيقية عند اكتمالها.</p>
          </div>
        </div>
        <h3 className="ml-placeholder__subtitle">ما ستحتويه</h3>
        <ul className="ml-placeholder__list">
          {willContain.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
        {spec && (
          <p className="ml-placeholder__spec">
            المرجع في وثيقة المتطلبات: <Bidi dir="ltr">{spec}</Bidi>
          </p>
        )}
        {showHomeLink && (
          <div className="ml-placeholder__actions">
            <Link to="/" className={buttonClass({ variant: 'secondary' })}>
              العودة إلى الرئيسية
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
