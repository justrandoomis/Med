// Offline download entry points for other screens (integration I1): the «على هذا الجهاز» badge for library rows and
// a menu action (library row menu, workspace overflow) that opens the Download Manager dialog for one source — or,
// when the source is already on this device, the Download Manager itself. Offline, downloading is disabled with the
// reason (it needs the server); the badge keeps working.
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudDownload, HardDriveDownload } from 'lucide-react';
import { MenuItem, StatusPill } from '../../design';
import { useDownloadRecord } from '../../lib/offline';
import { useOnline } from '../../lib/useOnline';
import { DownloadDialog } from './DownloadDialog';

export const DOWNLOAD_NEEDS_CONNECTION_AR = 'يحتاج التنزيل اتصالًا بالخادم.';

/** «على هذا الجهاز» when the Download Manager holds this source (nothing otherwise). */
export function OnDeviceBadge({ sourceId }: { sourceId: string }) {
  const rec = useDownloadRecord(sourceId);
  if (!rec) return null;
  return (
    <StatusPill tone="success" icon={<HardDriveDownload size={14} />}>
      {`على هذا الجهاز (الإصدار ${rec.versionNo})`}
    </StatusPill>
  );
}

/**
 * A menu item + its dialog for one source. Render `item` inside a `<Menu>` and `dialog` anywhere outside it (the
 * menu closes before the dialog opens).
 */
export function useOfflineDownloadAction(sourceId: string, title: string): { item: ReactNode; dialog: ReactNode } {
  const online = useOnline();
  const rec = useDownloadRecord(sourceId);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const item = rec ? (
    <MenuItem icon={<HardDriveDownload size={16} />} hint={`الإصدار ${rec.versionNo}`} onSelect={() => navigate('/offline')}>
      على هذا الجهاز — إدارة التنزيلات
    </MenuItem>
  ) : (
    <MenuItem icon={<CloudDownload size={16} />} onSelect={() => setOpen(true)} disabled={!online} disabledReason={online ? undefined : DOWNLOAD_NEEDS_CONNECTION_AR}>
      نزّل للعمل دون اتصال…
    </MenuItem>
  );
  const dialog = open ? <DownloadDialog open sourceId={sourceId} title={title} onClose={() => setOpen(false)} /> : null;
  return { item, dialog };
}
