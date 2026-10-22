// «الإشراف» — Phase 1 (P1-T4 step 3; IA §4.10, J12; PRD AOS-18.7/18.8 Phase 1 part): reports on publications in the
// viewer's scope → «أبقِ (لا مخالفة)» / «أخفِ مع السبب», and later «أعِد الإظهار». Every decision carries an Arabic
// reason the author and the reporter read in their inbox, and an audit entry. Hiding never deletes anything and never
// touches anyone's copy. Phase 2 actions («اطلب تعديلًا», «راجعه مشرف المادة», appeals) are not shown before their phase.
// Who reported is shown only when the server gives it (never to a moderator who wrote the content).
import { useState } from 'react';
import { Flag } from 'lucide-react';
import {
  MODERATION_ACTION_LABELS_AR,
  REPORT_REASON_LABELS_AR,
  REPORT_STATUS_LABELS_AR,
  type ModerationAction,
  type ReportStatus,
  type ReportView,
} from '@medlevo/shared';
import { Button, EmptyState, ErrorState, LoadingState, SegmentedControl, StatusPill, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { formatRelative } from '../../lib/time';
import { ReasonedButton } from '../channels/ui';
import { useFetched } from '../channels/useFetched';
import { adminApi } from './api';
import { ReasonDialog } from './MembersSection';
import { ScopeBar, useAdminScope, useAdminViewer } from './viewer';

const CONFIRM_AR: Record<'hide' | 'restore' | 'dismiss', string> = { hide: 'أخفِ', restore: 'أعِد الإظهار', dismiss: 'أبقِ' };

export function ModerationSection() {
  const v = useAdminViewer();
  const toast = useToast();
  const scope = useAdminScope(['admin', 'assistant', 'subject_moderator']);
  const nodeId = scope.current?.node.id ?? null;
  const [status, setStatus] = useState<ReportStatus>('open');
  const list = useFetched(nodeId ? `queue.${nodeId}.${status}` : null, () => adminApi.queue(nodeId!, { status }));
  const rows = list.data ? { items: list.data.items, next: list.data.next_cursor } : null;
  const error = list.error;
  const load = list.reload;
  const [acting, setActing] = useState<{ report: ReportView; action: 'hide' | 'restore' | 'dismiss' } | null>(null);
  const offline = v.cachedAt !== null;


  const items = rows?.items ?? [];
  return (
    <div className="ml-page ml-page--narrow ad-section">
      <h1 className="ml-page__title">الإشراف</h1>
      <ScopeBar scope={scope} />
      {!nodeId ? (
        <EmptyState icon={<Flag size={28} />} title="لا توجد مادة تشرف عليها" />
      ) : (
        <>
          <div className="ad-actions">
            <SegmentedControl
              label="البلاغات"
              value={status}
              onValueChange={setStatus}
              options={[
                { value: 'open', label: REPORT_STATUS_LABELS_AR.open },
                { value: 'actioned', label: REPORT_STATUS_LABELS_AR.actioned },
                { value: 'dismissed', label: REPORT_STATUS_LABELS_AR.dismissed },
              ]}
            />
          </div>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : !rows ? (
            <LoadingState stage="جارٍ تحميل البلاغات…" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Flag size={28} />}
              title={status === 'open' ? 'لا توجد بلاغات مفتوحة في هذا النطاق' : 'لا توجد بلاغات بهذه الحالة'}
              description="يصل البلاغ عندما يضغط عضو «أبلغ» على شرح منشور في المادة، ويصلك تنبيه به."
            />
          ) : (
            <ul role="list" className="ml-list">
              {items.map((r) => (
                <li key={r.id} className="ml-list__row ad-report">
                  <div className="ad-member__text">
                    <span className="ad-member__name">{r.target.title ?? 'المحتوى لم يعد موجودًا'}</span>
                    <span className="ad-member__meta">
                      <StatusPill tone="warning">{REPORT_REASON_LABELS_AR[r.reason]}</StatusPill> {r.scope.title} · {formatRelative(r.created_at)}
                      {r.reporter ? ` · من ${r.reporter.display_name}` : ''}
                    </span>
                    {r.note && <span className="ad-report__note">ملاحظة المُبلِّغ: {r.note}</span>}
                  </div>
                  {!offline && (
                    <div className="ad-member__actions">
                      {r.status === 'open' && (
                        <>
                          <Button size="sm" onClick={() => setActing({ report: r, action: 'dismiss' })}>
                            {MODERATION_ACTION_LABELS_AR.dismiss}
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => setActing({ report: r, action: 'hide' })}>
                            {MODERATION_ACTION_LABELS_AR.hide}
                          </Button>
                        </>
                      )}
                      {r.status === 'actioned' && (
                        <Button size="sm" onClick={() => setActing({ report: r, action: 'restore' })}>
                          {MODERATION_ACTION_LABELS_AR.restore}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rows?.next && (
            <ReasonedButton
              className="ch-more"
              reason={offline ? 'يحتاج اتصالًا بالإنترنت.' : null}
              onClick={async () => {
                try {
                  const r = await adminApi.queue(nodeId, { status, cursor: rows.next });
                  list.update((x) => ({ items: [...x.items, ...r.items], next_cursor: r.next_cursor }));
                } catch (e) {
                  toast.show({ title: errorMessage(e), tone: 'danger' });
                }
              }}
            >
              المزيد
            </ReasonedButton>
          )}
          <p className="ml-group-footer">الإخفاء لا يحذف شيئًا: من تابع الشرح أو أخذ نسخة مستقلة منه يحتفظ بما لديه. يصل قرارك وسببه إلى الكاتب وإلى المُبلِّغ، ويُسجَّل في «سجل الإجراءات».</p>
        </>
      )}
      {acting && (
        <ReasonDialog
          title={MODERATION_ACTION_LABELS_AR[acting.action as ModerationAction]}
          confirm={CONFIRM_AR[acting.action]}
          label="السبب (يقرؤه الكاتب والمُبلِّغ)"
          onCancel={() => setActing(null)}
          onConfirm={async (reason) => {
            const a = acting;
            await adminApi.act({ report_id: a.report.id, action: a.action, reason_ar: reason });
            setActing(null);
            toast.show({ title: a.action === 'hide' ? 'أُخفي المحتوى وأُبلغ الكاتب والمُبلِّغ.' : a.action === 'restore' ? 'أُعيد إظهار المحتوى.' : 'أُغلق البلاغ دون مخالفة.', tone: 'success' });
            load();
          }}
        />
      )}
    </div>
  );
}

export const Component = ModerationSection;
