// AOS-21.45 (ARCHITECTURE_DELTA §14): «warnings at 80 % to the subject's moderators». system/quota.ts emits a warning when
// a member's upload takes a subject space across 80 % of its storage limit, and when an upload is refused at 100 %;
// this turns each into ONE quota_warning notification for the subject's moderators (Admins, Assistants and Subject
// Moderators of the subject or above; the platform admins when nobody holds such a role), once per subject, threshold
// and month (the notification's dedupe key). A failure to notify never fails the upload.
import type { AppContext } from '../../context';
import { notificationsOf } from '../notifications/service';

export function registerSpaceQuotaWarnings(ctx: AppContext): () => void {
  return ctx.quota.onSpaceStorageWarning((e) => {
    if (!e.subjectNodeId) return;
    try {
      notificationsOf(ctx).publish({
        content: { kind: 'quota_warning', payload: { quota: 'storage', percent: e.percent, subject_title: e.title } },
        target: { db: 'space', space_id: e.spaceId, type: 'space', id: e.spaceId },
        link: `/subjects/${encodeURIComponent(e.subjectNodeId)}`,
        access: 'moderate',
        scopeNodeId: e.subjectNodeId,
        dedupeKey: e.dedupeKey,
        audience: { kind: 'scope_moderators', node_id: e.subjectNodeId },
      });
    } catch (err) {
      ctx.log.warn({ err, spaceId: e.spaceId }, 'space storage warning could not be queued');
    }
  });
}
