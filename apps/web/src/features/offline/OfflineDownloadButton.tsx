// Reusable «نزّل للعمل دون اتصال» control for other screens (source detail, library rows). Shows the real state
// of this device (downloaded or not) and opens the Download Manager dialog; disabled with the reason offline.
import { useState } from 'react';
import { CloudDownload, CloudOff } from 'lucide-react';
import { Button, StatusPill } from '../../design';
import { useDownloads } from '../../lib/offline';
import { useOnline } from '../../lib/useOnline';
import { DownloadDialog } from './DownloadDialog';

export function OfflineDownloadButton({ sourceId, title, size = 'sm' }: { sourceId: string; title: string; size?: 'sm' | 'md' }) {
  const online = useOnline();
  const downloads = useDownloads();
  const [open, setOpen] = useState(false);
  const here = downloads?.find((d) => d.sourceId === sourceId) ?? null;
  return (
    <>
      {here ? (
        <StatusPill tone="success">على هذا الجهاز (الإصدار {here.versionNo})</StatusPill>
      ) : (
        <Button
          size={size}
          variant="secondary"
          icon={online ? <CloudDownload size={16} /> : <CloudOff size={16} />}
          disabled={!online}
          title={online ? undefined : 'يحتاج التنزيل اتصالًا بالخادم.'}
          onClick={() => setOpen(true)}
        >
          نزّل للعمل دون اتصال
        </Button>
      )}
      {open && <DownloadDialog open sourceId={sourceId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}
