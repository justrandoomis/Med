// The official state of library rows (Phase 1 completion C2 — AOS-19H.3 «the library offers the link», 19I.2):
//   * «رسمي · المادة» on the viewer's copy of an official lecture;
//   * «مرتبطة بالنسخة الرسمية» (+ «n تنتظر المراجعة») on a private lecture linked with «اربط بالمحاضرة الرسمية»;
//   * «موجودة رسميًا في المادة» on a private lecture with an official twin, and the row menu's «اربط بالمحاضرة الرسمية…».
// One request per batch of visible rows (`GET /api/copies/link-status`, ≤ 30 ids), answered from the viewer's own vault;
// cached for the session and dropped after a link. Offline nothing is asked and nothing is claimed.
import { useEffect, useState, type ReactNode } from 'react';
import { BadgeCheck, Link2 } from 'lucide-react';
import type { OfficialLinkCandidate } from '@medlevo/shared';
import { MenuItem, StatusPill } from '../../design';
import { useOnline } from '../../lib/useOnline';
import { copiesApi } from './api';
import { LinkToOfficialDialog } from './LinkToOfficialDialog';
import { dropLinkStatus, useLinkStatus } from './linkStatusStore';

export { dropLinkStatus, resetLinkStatusCache, useLinkStatus } from './linkStatusStore';

/** «رسمي · …» / «مرتبطة بالنسخة الرسمية» / «موجودة رسميًا في …» for a library row (nothing when there is nothing to say). */
export function OfficialRowBadge({ sourceId }: { sourceId: string }) {
  const s = useLinkStatus(sourceId);
  if (!s) return null;
  if (s.official) {
    return (
      <StatusPill tone="accent" icon={<BadgeCheck size={14} />}>
        {s.official.subject_title ? `رسمي · ${s.official.subject_title}` : 'رسمي'}
      </StatusPill>
    );
  }
  if (s.linked) {
    return (
      <StatusPill tone={s.linked.pending > 0 ? 'warning' : 'success'} icon={<Link2 size={14} />}>
        {s.linked.pending > 0 ? `مرتبطة بالنسخة الرسمية · ${s.linked.pending} تنتظر المراجعة` : 'مرتبطة بالنسخة الرسمية'}
      </StatusPill>
    );
  }
  if (s.candidate) {
    return (
      <StatusPill tone="info" icon={<Link2 size={14} />}>
        {s.candidate.subject_title ? `موجودة رسميًا في ${s.candidate.subject_title}` : 'موجودة رسميًا'}
      </StatusPill>
    );
  }
  return null;
}

/**
 * The row menu's «اربط بالمحاضرة الرسمية…» for a private lecture with an official twin: render `item` inside the
 * `<Menu>` and `dialog` outside it. Nothing for any other row.
 */
export function useLinkToOfficialAction(sourceId: string): { item: ReactNode; dialog: ReactNode } {
  const s = useLinkStatus(sourceId);
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<OfficialLinkCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || candidates) return;
    let alive = true;
    copiesApi
      .linkCandidates(sourceId)
      .then((r) => alive && setCandidates(r.candidates))
      .catch(() => alive && setError('تعذّر جلب المحاضرة الرسمية الآن؛ حاول مرة أخرى.'));
    return () => {
      alive = false;
    };
  }, [open, candidates, sourceId]);
  // the item only while the row has an official twin; the dialog as long as it is open — linking refreshes the row's
  // status to «مرتبطة», and the result («رُبطت …», «راجع ما لم يُنسخ») must stay on screen (found by the C2 E2E run)
  const item = s?.candidate ? (
    <MenuItem icon={<Link2 size={16} />} onSelect={() => setOpen(true)} disabled={!online} disabledReason={online ? undefined : 'الربط يحتاج اتصالًا بالخادم.'}>
      اربط بالمحاضرة الرسمية…
    </MenuItem>
  ) : null;
  const close = () => {
    setOpen(false);
    setCandidates(null);
    setError(null);
    dropLinkStatus([sourceId]);
  };
  const dialog =
    open && candidates && candidates.length > 0 ? (
      <LinkToOfficialDialog open onClose={close} sourceId={sourceId} candidates={candidates} />
    ) : open && (error || (candidates && candidates.length === 0)) ? (
      <LinkToOfficialDialog open onClose={close} sourceId={sourceId} candidates={[]} unavailable={error ?? 'لم تعد لهذه المحاضرة نسخة رسمية تطابقها في موادك.'} />
    ) : null;
  return { item, dialog };
}
