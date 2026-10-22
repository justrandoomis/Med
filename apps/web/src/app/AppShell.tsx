import { useEffect, useRef, type RefObject } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { IconButton, Kbd } from '../design';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { BrandMark } from './BrandMark';
import { activeDestination, PRIMARY_DESTINATIONS } from './navigation';
import { GlobalSaveStatus, OfflineIndicator } from './SyncIndicators';
import { isSearchShortcut } from './shortcuts';

export { PRIMARY_DESTINATIONS } from './navigation';

/** Moves focus to the new page's heading after client-side navigation (screen readers announce it). */
function useFocusOnNavigate(mainRef: RefObject<HTMLElement | null>) {
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = mainRef.current;
    if (!main) return;
    const raf = requestAnimationFrame(() => {
      const heading = main.querySelector<HTMLElement>('h1');
      const target = heading ?? main;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(raf);
  }, [location.pathname, mainRef]);
}

/**
 * Home-first shell (§23; Academic OS IA §3.1). Phones: compact top bar + bottom tab bar with the five destinations
 * (الرئيسية / المكتبة / القنوات / المراجعة / أنا — «الإعدادات» lives in «أنا»). Tablets & desktop: one slim top bar with
 * the same destinations, search, «التنبيهات» (a bell with a text count), save status and the offline indicator. No
 * permanent sidebar. The study workspace (/study/…) does not use it.
 */
export function AppShell() {
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const current = activeDestination(pathname);
  useFocusOnNavigate(mainRef);

  // "/" or Ctrl/⌘+K opens search (see isSearchShortcut)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isSearchShortcut(e)) {
        e.preventDefault();
        navigate('/search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="ml-shell">
      <a className="ml-skip-link" href="#main">
        تخطَّ إلى المحتوى
      </a>
      <header className="ml-topbar ml-no-print">
        <div className="ml-topbar__inner">
          <Link to="/" className="ml-brand" aria-label="MedLevo AI — الرئيسية">
            <BrandMark size={28} />
            <span className="ml-brand__name" dir="ltr" lang="en">
              MedLevo
            </span>
          </Link>
          <nav aria-label="التنقل الرئيسي" className="ml-topnav">
            {PRIMARY_DESTINATIONS.map((d) => (
              <Link key={d.to} to={d.to} className="ml-topnav__link" aria-current={current === d ? 'page' : undefined}>
                <d.icon size={18} aria-hidden="true" />
                <span>{d.label}</span>
              </Link>
            ))}
          </nav>
          <div className="ml-topbar__end">
            <Link to="/search" className="ml-search-entry" aria-label="البحث في مكتبتك (اختصار: /)">
              <Search size={18} aria-hidden="true" />
              <span className="ml-search-entry__text">ابحث في مكتبتك</span>
              <Kbd>/</Kbd>
            </Link>
            <IconButton className="ml-search-icon" label="البحث" icon={<Search size={20} />} onClick={() => navigate('/search')} />
            <NotificationBell />
            <OfflineIndicator />
            <GlobalSaveStatus />
          </div>
        </div>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="ml-main">
        <Outlet />
      </main>

      <nav aria-label="التنقل الرئيسي" className="ml-tabbar ml-no-print">
        {PRIMARY_DESTINATIONS.map((d) => (
          <Link key={d.to} to={d.to} className="ml-tabbar__link" aria-current={current === d ? 'page' : undefined}>
            <d.icon size={24} aria-hidden="true" strokeWidth={1.75} />
            <span>{d.label}</span>
          </Link>
        ))}
      </nav>
      {/* the PWA update prompt is mounted in RootLayout (layouts.tsx) so it also shows on /study and /login */}
    </div>
  );
}
