// «هذه الصفحة غير موجودة» — the one not-found page of the app: a missing route, and every place the viewer may not see
// (e.g. /admin without a channel role — the same page as a missing route, AOS-18.1). Its own file so screens can use it
// without the layouts' service-worker prompt (P1-T4 step 3).
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { EmptyState, buttonClass } from '../design';
import { usePageTitle } from '../lib/usePageTitle';

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
