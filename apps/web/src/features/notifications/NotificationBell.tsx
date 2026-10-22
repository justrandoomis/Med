// «التنبيهات» in the top bar (IA §3.1: a bell with a TEXT count, not a red blob; §8.4: no red numeric badges). The count
// is asked from the server when the shell opens, when the window regains focus or the network returns, and every two
// minutes while the page is visible; offline it keeps the last known value.
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { refreshUnreadCount, useUnreadCount } from './api';

const POLL_MS = 120_000;

export function NotificationBell() {
  const count = useUnreadCount();
  const { pathname } = useLocation();
  useEffect(() => {
    void refreshUnreadCount();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshUnreadCount();
    };
    const timer = setInterval(onFocus, POLL_MS);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  const n = count ?? 0;
  const shown = n > 99 ? '99+' : String(n);
  const label = n > 0 ? `التنبيهات، ${n} غير مقروءة` : 'التنبيهات';
  return (
    <Link to="/notifications" className="ml-bell" aria-label={label} aria-current={pathname === '/notifications' ? 'page' : undefined}>
      <Bell size={20} aria-hidden="true" />
      {n > 0 && (
        <span className="ml-bell__count" aria-hidden="true">
          {shown}
        </span>
      )}
    </Link>
  );
}
