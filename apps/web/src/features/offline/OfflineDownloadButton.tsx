// Reusable «نزّل للعمل دون اتصال» control for other screens (source detail, library rows). Shows the real state
// of this device (downloaded or not) and opens the Download Manager dialog; disabled with the reason offline.
import { useId, useState } from 'react';
import { CloudDownload, CloudOff } from 'lucide-react';
import { Button, StatusPill } from '../../design';
import { useDownloads } from '../../lib/offline';
import { useOnline } from '../../lib/useOnline';
import { DownloadDialog } from './DownloadDialog';

export function OfflineDownloadButton({ sourceId, title, size = 'sm' }: { sourceId: string; title: string; size?: 'sm' | 'md' }) {
  const online = useOnline();
  const downloads = useDownloads();
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const here = downloads?.find((d) => d.sourceId === sourceId) ?? null;
  return (
    <>
      {here ? (
        <StatusPill tone="success">على هذا الجهاز (الإصدار {here.versionNo})</StatusPill>
      ) : (
        <>
          <Button
            size={size}
            variant="secondary"
            icon={online ? <CloudDownload size={16} /> : <CloudOff size={16} />}
            disabled={!online}
            title={online ? undefined : 'يحتاج التنزيل اتصالًا بالخادم.'}
            aria-describedby={online ? undefined : reasonId}
            onClick={() => setOpen(true)}
          >
            نزّل للعمل دون اتصال
          </Button>
          {/* a disabled button cannot be focused: the reason is visible text, not only a tooltip */}
          {!online && (
            <span id={reasonId} className="ml-field__hint">
              يحتاج التنزيل اتصالًا بالخادم.
            </span>
          )}
        </>
      )}
      {open && <DownloadDialog open sourceId={sourceId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}
