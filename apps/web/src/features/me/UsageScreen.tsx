// «الاستهلاك» — /me/usage (P1-T4 step 3; IA §3.2, §8.2 QuotaMeter; P1-T1's /api/accounts/me/quota). Each allowance with
// its real numbers: a determinate bar only when the server has a limit, otherwise the plain fact that there is none.
import type { QuotaView } from '@medlevo/shared';
import { Breadcrumbs, ErrorState, LoadingState, ProgressBar } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { useFetched } from '../channels/useFetched';
import { formatSize, meApi } from './api';
import './me.css';

const NO_LIMIT = 'بلا حد شهري مضبوط على هذا الخادم.';
/** storage is not a monthly allowance (review P1-T4 step 3, R10) */
const NO_STORAGE_LIMIT = 'بلا حد للمساحة مضبوط على هذا الخادم.';

function Meter({ title, label, used, limit, text, noLimit = NO_LIMIT }: { title: string; label: string; used: number; limit: number | null; text: string; noLimit?: string }) {
  return (
    <div className="ml-group__row ml-group__row--stack me-meter">
      <div className="me-meter__head">
        <span className="me-meter__title">{title}</span>
        <span className="me-meter__value">{text}</span>
      </div>
      {limit !== null && limit > 0 ? <ProgressBar label={label} value={Math.min(used, limit)} max={limit} valueText={text} /> : <p className="me-meter__note">{noLimit}</p>}
    </div>
  );
}

export function UsageScreen() {
  usePageTitle('الاستهلاك');
  const q = useFetched('quota', () => meApi.quota());
  const quota: QuotaView | null = q.data;
  const error = q.error;
  const load = q.reload;

  return (
    <div className="ml-page ml-page--narrow me-screen">
      <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'الاستهلاك' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">الاستهلاك</h1>
        <p className="ml-page__lede">ما استخدمته من مساحة الخادم ومن رصيد هذا الشهر. الكتابة والتسجيل لا يتوقفان بسبب رصيد الذكاء الاصطناعي.</p>
      </header>
      {error && !quota ? (
        <ErrorState message={error} onRetry={load} />
      ) : !quota ? (
        <LoadingState stage="جارٍ تحميل الاستهلاك…" />
      ) : (
        <div className="ml-group">
          <Meter
            title="التخزين"
            label="مساحة التخزين"
            used={quota.storage.used_bytes}
            limit={quota.storage.limit_bytes}
            text={quota.storage.limit_bytes !== null ? `${formatSize(quota.storage.used_bytes)} من ${formatSize(quota.storage.limit_bytes)}` : formatSize(quota.storage.used_bytes)}
            noLimit={NO_STORAGE_LIMIT}
          />
          <Meter
            title={`الذكاء الاصطناعي (${quota.ai.month})`}
            label="رصيد الذكاء الاصطناعي"
            used={quota.ai.used_usd_est}
            limit={quota.ai.limit_usd}
            text={`${quota.ai.limit_usd !== null ? `$${quota.ai.used_usd_est.toFixed(2)} من $${quota.ai.limit_usd.toFixed(2)}` : `$${quota.ai.used_usd_est.toFixed(2)}`} (تقديري)`}
          />
          <Meter
            title={`التفريغ الصوتي (${quota.asr.month})`}
            label="دقائق التفريغ الصوتي"
            used={quota.asr.used_minutes}
            limit={quota.asr.limit_minutes}
            text={quota.asr.limit_minutes !== null ? `${quota.asr.used_minutes} من ${quota.asr.limit_minutes} دقيقة` : `${quota.asr.used_minutes} دقيقة`}
          />
        </div>
      )}
      <p className="ml-group-footer">المساحة التي يشغلها التطبيق على هذا الجهاز نفسه معروضة في الإعدادات › حول التطبيق.</p>
    </div>
  );
}
