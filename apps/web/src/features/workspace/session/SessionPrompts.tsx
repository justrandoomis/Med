// §46: a newer position from another device is offered, never applied silently.
import { MonitorSmartphone, X } from 'lucide-react';
import type { SourcePageView, SourceVersionView, StudyLocation } from '@medlevo/shared';
import { Button, Dialog, IconButton } from '../../../design';
import { formatDateTime } from '../../../lib/time';
import { fullPageLabel } from '../model/pages';

function placeLabel(location: StudyLocation, versionId: string | null, pages: readonly SourcePageView[], currentVersionId: string, versions: readonly SourceVersionView[]): string {
  const i = location.page_index ?? 0;
  if (versionId && versionId !== currentVersionId) {
    const v = versions.find((x) => x.id === versionId);
    return `الصفحة ${i + 1} في الملف${v ? ` (الإصدار ${v.version_no})` : ''}`;
  }
  const p = pages[i];
  return p ? fullPageLabel(p) : `الصفحة ${i + 1} في الملف`;
}

export function SessionConflictDialog({
  open,
  theirs,
  mine,
  pages,
  versions,
  currentVersionId,
  onTheirs,
  onMine,
}: {
  open: boolean;
  theirs: { location: StudyLocation; versionId: string | null; updatedAt: number };
  mine: { location: StudyLocation };
  pages: readonly SourcePageView[];
  versions: readonly SourceVersionView[];
  currentVersionId: string;
  onTheirs: () => void;
  onMine: () => void;
}) {
  const there = placeLabel(theirs.location, theirs.versionId, pages, currentVersionId, versions);
  const here = placeLabel(mine.location, currentVersionId, pages, currentVersionId, versions);
  return (
    <Dialog
      open={open}
      onClose={onMine}
      title="موضع أحدث من جهاز آخر"
      description={`على جهاز آخر وصلت إلى ${there} (${formatDateTime(theirs.updatedAt)}). أنت هنا عند ${here}. لم يُكتب أي موضع فوق الآخر.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onMine}>
            البقاء هنا
          </Button>
          <Button variant="primary" onClick={onTheirs}>
            {`الانتقال إلى ${there}`}
          </Button>
        </>
      }
    >
      <p className="wk-muted">إذا بقيت هنا فسيُحفظ موضعك الحالي كأحدث موضع لهذا المصدر.</p>
    </Dialog>
  );
}

export function RemoteMoveBanner({ label, onGo, onDismiss }: { label: string; onGo: () => void; onDismiss: () => void }) {
  return (
    <div className="wk-banner" role="status">
      <MonitorSmartphone size={18} aria-hidden="true" />
      <span>{`فُتح هذا المصدر على جهاز آخر عند ${label}.`}</span>
      <Button size="sm" variant="plain" onClick={onGo}>
        الانتقال إليه
      </Button>
      <IconButton label="تجاهل" icon={<X size={16} />} size="sm" onClick={onDismiss} />
    </div>
  );
}
