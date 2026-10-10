import { useEffect } from 'react';
import { Link, Outlet, isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom';
import { CloudOff, Compass } from 'lucide-react';
import { Button, EmptyState, ErrorState, buttonClass } from '../design';
import { setUnauthenticatedHandler } from '../lib/api';
import { forgetAuth } from '../lib/auth';
import { capabilitiesStore } from '../lib/capabilities';
import { settingsStore } from '../lib/settings';
import { getDb } from '../lib/localdb';
import { installOfflineTransport } from '../lib/offline';
import { getSyncEngine } from '../lib/sync';
import { recoverNoteDrafts } from '../features/workspace/data/noteDrafts';
import { usePageTitle } from '../lib/usePageTitle';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';

// Track D1: GET requests the server cannot answer are served from the explicitly downloaded copy (Download Manager,
// lib/offline.ts). Installed before any route renders (child effects run before this layout's effects).
installOfflineTransport();

/** Root layout: wires the global "session expired" handler to the router. */
export function RootLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      forgetAuth();
      getSyncEngine().stop();
      const next = location.pathname + location.search;
      if (!location.pathname.startsWith('/login')) navigate(`/login?expired=1&next=${encodeURIComponent(next)}`, { replace: true });
    });
    return () => setUnauthenticatedHandler(null);
  }, [navigate, location.pathname, location.search]);
  // Track D1: the update prompt (and the service-worker registration it carries) lives here, so it is active on
  // EVERY route — the shell, the study workspace and the sign-in screens — not only inside the shell.
  return (
    <>
      <Outlet />
      <PwaUpdatePrompt />
    </>
  );
}

/**
 * Everything behind the owner session. Starts the sync engine and loads settings/capabilities.
 * Offline with a known session: the app opens from local data and syncs when the server returns.
 */
export function OwnerLayout() {
  useEffect(() => {
    const engine = getSyncEngine();
    engine.start();
    // note text typed right before a reload / crash is backed up synchronously; save it now (I2, noteDrafts.ts)
    void recoverNoteDrafts(getDb()).catch(() => undefined);
    void settingsStore.load();
    void capabilitiesStore.refresh();
    return () => engine.stop();
  }, []);
  return <Outlet />;
}

export function RouteErrorScreen() {
  const error = useRouteError();
  const navigate = useNavigate();
  usePageTitle('تعذّر فتح الصفحة');
  if (isRouteErrorResponse(error) && error.status === 503) {
    return (
      <div className="ml-standalone">
        <EmptyState
          icon={<CloudOff size={28} />}
          title="لا يمكن التحقق من تسجيل الدخول دون اتصال"
          description={
            <>
              <p>{typeof error.data === 'string' ? error.data : 'تعذّر الوصول إلى الخادم.'}</p>
              <p>لم يسبق تسجيل الدخول على هذا الجهاز، لذلك لا توجد نسخة محلية لفتحها. اتصل بالإنترنت ثم أعد المحاولة.</p>
            </>
          }
          actions={
            <Button variant="primary" onClick={() => navigate(0)}>
              إعادة المحاولة
            </Button>
          }
          headingLevel={2}
        />
      </div>
    );
  }
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  if (notFound) return <NotFoundScreen />;
  return (
    <div className="ml-standalone">
      <ErrorState
        title="حدث خطأ أثناء فتح هذه الصفحة"
        message="لم يُفقد شيء مما كتبته: الكتابة تُحفظ على هذا الجهاز أولًا. أعد تحميل الصفحة، وإن تكرر الخطأ فارجع إلى الرئيسية."
        onRetry={() => navigate(0)}
        retryLabel="إعادة التحميل"
        actions={
          <Link to="/" className={buttonClass({ variant: 'plain' })}>
            الرئيسية
          </Link>
        }
      />
    </div>
  );
}

export function NotFoundScreen() {
  usePageTitle('الصفحة غير موجودة');
  return (
    <div className="ml-page">
      <EmptyState
        headingLevel={1}
        icon={<Compass size={28} />}
        title="هذه الصفحة غير موجودة"
        description="ربما تغيّر الرابط أو نُقل العنصر. ابدأ من الرئيسية أو من المكتبة."
        actions={
          <>
            <Link to="/" className={buttonClass({ variant: 'primary' })}>
              الرئيسية
            </Link>
            <Link to="/library" className={buttonClass({ variant: 'secondary' })}>
              المكتبة
            </Link>
          </>
        }
      />
    </div>
  );
}
