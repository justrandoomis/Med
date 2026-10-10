// التعارضات والمزامنة (§47): this device's writes that did not reach the server as they were — what conflicted,
// what the server did, and what each owner action does before it is taken. Nothing here deletes writing:
// «اطّلعت» keeps both copies (or keeps the change on this device), «أعد الإرسال» queues the same change as a new op.
import { useCallback, useEffect, useState } from 'react';
import { GitCompare, RefreshCw } from 'lucide-react';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, SaveStatus, StatusPill } from '../../design';
import type { OutboxRecord } from '../../lib/localdb';
import { describeSyncSnapshot, getSyncEngine, useSyncSnapshot, type SyncEngine } from '../../lib/sync';
import { formatDateTime } from '../../lib/time';
import { BidiText } from '../evidence/BidiText';
import { describeSyncIssue, type SyncIssueView } from './model';
import { SectionHeader } from './shared';

function IssueCard({ issue, onAck, onRetry }: { issue: SyncIssueView; onAck: () => Promise<void>; onRetry: () => Promise<void> }) {
  const [confirm, setConfirm] = useState<'ack' | 'retry' | null>(null);
  return (
    <li className="cc-issue" data-kind={issue.kind}>
      <div className="cc-issue__head">
        <StatusPill tone={issue.kind === 'conflict' ? 'warning' : 'danger'}>{issue.kind === 'conflict' ? 'تعارض' : 'رفضه الخادم'}</StatusPill>
        <span className="cc-issue__what">
          {issue.opLabel} {issue.entityLabel}
        </span>
        <span className="cc-issue__time">{formatDateTime(issue.at)}</span>
      </div>
      {issue.preview && <BidiText as="p" className="cc-issue__preview" text={issue.preview} />}
      <p className="cc-issue__happened">{issue.happened}</p>
      {issue.serverReason && (
        <p className="cc-issue__reason">
          <span className="cc-label">سبب الخادم: </span>
          <BidiText as="span" dir="rtl" text={issue.serverReason} />
        </p>
      )}
      <dl className="cc-issue__effects">
        <div>
          <dt>{issue.acknowledgeLabel}</dt>
          <dd>{issue.acknowledgeEffect}</dd>
        </div>
        {issue.canRetry && (
          <div>
            <dt>أعد الإرسال</dt>
            <dd>{issue.retryEffect}</dd>
          </div>
        )}
      </dl>
      <div className="cc-issue__actions">
        <Button variant="secondary" onClick={() => setConfirm('ack')}>
          {issue.acknowledgeLabel}
        </Button>
        {issue.canRetry && (
          <Button variant="plain" icon={<RefreshCw size={16} />} onClick={() => setConfirm('retry')}>
            أعد الإرسال
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'ack'}
        title={issue.acknowledgeLabel}
        impact={issue.acknowledgeEffect}
        confirmLabel="تأكيد"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await onAck();
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'retry'}
        title="إعادة إرسال التغيير"
        impact={issue.retryEffect}
        confirmLabel="أعد الإرسال"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await onRetry();
          setConfirm(null);
        }}
      />
    </li>
  );
}

export function SyncScreen({ engine = getSyncEngine() }: { engine?: SyncEngine }) {
  const snap = useSyncSnapshot(engine);
  const [issues, setIssues] = useState<OutboxRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setIssues(await engine.openIssues());
      setError(null);
    } catch {
      setError('تعذّر قراءة سجل المزامنة على هذا الجهاز (التخزين المحلي غير متاح في هذا المتصفح أو هذه النافذة).');
    }
  }, [engine]);
  useEffect(() => {
    void load();
  }, [load, snap.conflicts, snap.errors, snap.pending]);

  return (
    <div className="cc-section">
      <SectionHeader
        title="التعارضات والمزامنة"
        lede="ما كتبته على هذا الجهاز يُحفظ هنا أولًا ثم يُرسل. إن تغيّرت النسخة نفسها في مكان آخر، يحتفظ الخادم بالنسختين ولا يكتب فوق أي منهما."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={16} />} onClick={() => void engine.syncNow()} disabled={!snap.online}>
            زامن الآن
          </Button>
        }
      />
      <div className="cc-syncstate" role="status" aria-live="polite">
        <SaveStatus state={snap.state} />
        <p>{describeSyncSnapshot(snap)}</p>
        {snap.lastSyncedAt && <p className="cc-muted">آخر مزامنة ناجحة: {formatDateTime(snap.lastSyncedAt)}</p>}
      </div>
      {notice && (
        <p className="cc-outcome" role="status">
          {notice}
        </p>
      )}
      {error ? (
        <ErrorState inline message={error} onRetry={() => void load()} />
      ) : !issues ? (
        <LoadingState inline stage="جارٍ قراءة سجل المزامنة على هذا الجهاز…" />
      ) : issues.length === 0 ? (
        <EmptyState
          icon={<GitCompare size={28} />}
          title="لا تعارضات ولا تغييرات مرفوضة"
          description="كل ما كتبته على هذا الجهاز إما وصل إلى الخادم أو ينتظر الإرسال. هذه القائمة تخص هذا الجهاز فقط؛ لكل جهاز سجله."
        />
      ) : (
        <ul role="list" className="cc-issues" aria-label="مشكلات المزامنة على هذا الجهاز">
          {issues.map((op) => {
            const issue = describeSyncIssue(op);
            return (
              <IssueCard
                key={op.op_id}
                issue={issue}
                onAck={async () => {
                  await engine.acknowledge(op.op_id);
                  setNotice(issue.kind === 'conflict' ? 'أُغلق التنبيه. النسختان باقيتان كما هما.' : 'أُغلق التنبيه. التغيير باقٍ على هذا الجهاز ولن يُرسل.');
                  await load();
                }}
                onRetry={async () => {
                  const created = await engine.retry(op.op_id);
                  setNotice(created ? 'أُضيف التغيير إلى قائمة الإرسال كعملية جديدة؛ ستعرف نتيجته عند المزامنة التالية.' : 'لا يوجد ما يُعاد إرساله لهذا التغيير.');
                  await load();
                }}
              />
            );
          })}
        </ul>
      )}
      <p className="ml-group-footer">هذه القائمة من سجل هذا الجهاز (IndexedDB). تغييرات جهاز آخر تظهر في مركز التحكم على ذلك الجهاز.</p>
    </div>
  );
}
