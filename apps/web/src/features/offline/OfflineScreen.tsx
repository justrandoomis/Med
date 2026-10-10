// «التنزيلات والنسخ الاحتياطي» — /offline (§47 Download Manager, §49 backups, §46 export).
import { useSearchParams } from 'react-router-dom';
import { Archive, CloudDownload, FileOutput } from 'lucide-react';
import { Tab, TabList, TabPanel, Tabs } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { BackupsPanel } from './BackupsPanel';
import { DownloadsPanel } from './DownloadsPanel';
import { ExportPanel } from './ExportPanel';
import './offline.css';

const TABS = ['downloads', 'backups', 'export'] as const;
type TabKey = (typeof TABS)[number];

export function OfflineScreen() {
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as TabKey) : 'downloads';
  usePageTitle(tab === 'backups' ? 'النسخ الاحتياطي' : tab === 'export' ? 'التصدير' : 'التنزيلات للعمل دون اتصال');
  return (
    <div className="ml-page ml-page--narrow dl-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">بياناتك على هذا الجهاز وخارجه</h1>
        <p className="ml-page__lede">نزّل ما تدرسه للعمل دون اتصال، واحتفظ بنسخة احتياطية مختبرة، وصدّر كتبك وملاحظاتك وأسئلتك مع مصادرها.</p>
      </header>
      <Tabs value={tab} onValueChange={(v) => setParams((p) => {
        const n = new URLSearchParams(p);
        if (v === 'downloads') n.delete('tab');
        else n.set('tab', v);
        return n;
      }, { replace: true })}>
        <TabList label="أقسام البيانات">
          <Tab value="downloads" icon={<CloudDownload size={16} />}>
            التنزيلات
          </Tab>
          <Tab value="backups" icon={<Archive size={16} />}>
            النسخ الاحتياطي
          </Tab>
          <Tab value="export" icon={<FileOutput size={16} />}>
            التصدير
          </Tab>
        </TabList>
        <TabPanel value="downloads" className="dl-panel">
          <DownloadsPanel />
        </TabPanel>
        <TabPanel value="backups" className="dl-panel">
          <BackupsPanel />
        </TabPanel>
        <TabPanel value="export" className="dl-panel">
          <ExportPanel />
        </TabPanel>
      </Tabs>
    </div>
  );
}
