import { useEffect, useRef, type RefObject } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { House, Layers, Library, Search, Settings } from 'lucide-react';
import { IconButton, Kbd } from '../design';
import { BrandMark } from './BrandMark';
import { GlobalSaveStatus, OfflineIndicator } from './SyncIndicators';
import { isSearchShortcut } from './shortcuts';

export const PRIMARY_DESTINATIONS = [
  { to: '/', label: 'الرئيسية', icon: House, end: true },
  { to: '/library', label: 'المكتبة', icon: Library, end: false },
  { to: '/review', label: 'المراجعة', icon: Layers, end: false },
  { to: '/settings', label: 'الإعدادات', icon: Settings, end: false },
] as const;

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
 * Home-first shell (§23). Phones: compact top bar + bottom tab bar (الرئيسية / المكتبة / المراجعة /
 * الإعدادات). Tablets & desktop: one slim top bar with the same destinations, search, save status
 * and the offline indicator. No permanent sidebar. The study workspace (/study/…) does not use it.
 */
export function AppShell() {
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
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
            {PRIMARY_DESTINATIONS.map(({ to, label, icon: Icon, end }) => (
              <NavLink key={to} to={to} end={end} className="ml-topnav__link">
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-topbar__end">
            <Link to="/search" className="ml-search-entry" aria-label="البحث في مكتبتك (اختصار: /)">
              <Search size={18} aria-hidden="true" />
              <span className="ml-search-entry__text">ابحث في مكتبتك</span>
              <Kbd>/</Kbd>
            </Link>
            <IconButton className="ml-search-icon" label="البحث" icon={<Search size={20} />} onClick={() => navigate('/search')} />
            <OfflineIndicator />
            <GlobalSaveStatus />
          </div>
        </div>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className="ml-main">
        <Outlet />
      </main>

      <nav aria-label="التنقل الرئيسي" className="ml-tabbar ml-no-print">
        {PRIMARY_DESTINATIONS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="ml-tabbar__link">
            <Icon size={24} aria-hidden="true" strokeWidth={1.75} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      {/* the PWA update prompt is mounted in RootLayout (layouts.tsx) so it also shows on /study and /login */}
    </div>
  );
}
