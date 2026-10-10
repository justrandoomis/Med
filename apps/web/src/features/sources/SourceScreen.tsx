// تفاصيل المصدر (§06, §07, §13, §18): metadata, versions & freeze, links, per-page processing,
// and «open in the study workspace».
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpenText, FileQuestion } from 'lucide-react';
import type { SourceDetail } from '@medlevo/shared';
import { Breadcrumbs, Button, buttonClass, EmptyState, ErrorState, LoadingState, StatusPill, Tab, TabList, TabPanel, Tabs } from '../../design';
import { api } from '../../lib/api';
import { FeatureGate } from '../../lib/capabilities';
import { usePageTitle } from '../../lib/usePageTitle';
import { useQuery } from '../library/data';
import { SourceMenu } from '../library/components/ItemMenus';
import { formatIcon, ProcessingPill, SourceSubtitle } from '../library/labels';
import { OfflineNotice } from '../library/shared';
import { useLibrary } from '../library/useLibrary';
import { OfflineDownloadButton } from '../offline/OfflineDownloadButton';
import { LinksPanel } from './LinksPanel';
import { MetadataForm } from './MetadataForm';
import { PagesPanel } from './PagesPanel';
import { VersionsPanel } from './VersionsPanel';
import '../library/library.css';
import './sources.css';

type Detail = SourceDetail & { source_type_origin?: 'auto' | 'owner' };

export function SourceScreen() {
  const { sourceId = '' } = useParams();
  const q = useQuery<Detail>(`/sources/${sourceId}`, { cache: true });
  const lib = useLibrary();
  const [tab, setTab] = useState('pages');
  usePageTitle(q.data?.title ?? 'المصدر');

  if (q.loading && !q.data) return <LoadingState stage="جارٍ تحميل المصدر…" />;
  if (q.error && !q.data) {
    if (q.error.status === 404) {
      return (
        <div className="ml-page">
          <h1 className="ml-visually-hidden">مصدر غير موجود</h1>
          <EmptyState
            icon={<FileQuestion size={28} />}
            title="هذا المصدر غير موجود"
            description="ربما حُذف نهائيًا من سلة المحذوفات."
            actions={
              <Link to="/library" className={buttonClass({ variant: 'primary' })}>
                العودة إلى المكتبة
              </Link>
            }
          />
        </div>
      );
    }
    return (
      <div className="ml-page">
        <ErrorState message={q.error.message} onRetry={() => void q.refresh()} />
      </div>
    );
  }
  const d = q.data!;
  const readOnly = q.fromCache || d.deleted_at !== null;
  const active = d.versions.find((v) => v.id === d.active_version_id) ?? d.versions[0];
  const summary = lib.index?.sources.get(d.id);

  return (
    <div className="ml-page ml-library ml-source">
      <Breadcrumbs items={[{ label: 'المكتبة', to: '/library' }, ...d.path.map((p) => ({ label: <bdi>{p.title}</bdi>, to: `/library/${p.id}` })), { label: <bdi>{d.title}</bdi> }]} />
      {q.fromCache && <OfflineNotice cachedAt={q.cachedAt} />}
      <header className="ml-node-head">
        <span className="ml-row__icon ml-source__icon" aria-hidden="true">
          {formatIcon(d.format, 24)}
        </span>
        <div className="ml-node-head__text">
          <h1 className="ml-node-head__title">
            <bdi>{d.title}</bdi>
          </h1>
          <p className="ml-node-head__sub">
            <SourceSubtitle source={{ source_type: d.source_type, format: d.format, page_count: active?.page_count ?? d.page_count }} />
          </p>
          <div className="ml-node-head__actions">
            <ProcessingPill status={d.processing_status} format={d.format} />
            {d.source_type_origin === 'auto' && (
              <StatusPill tone="info" icon={false}>
                النوع مقترح تلقائيًا
              </StatusPill>
            )}
            {d.frozen_version_id && <StatusPill tone="success">نسخة مثبّتة للدراسة</StatusPill>}
            {d.deleted_at !== null && <StatusPill tone="danger">في سلة المحذوفات</StatusPill>}
          </div>
          <div className="ml-node-head__actions">
            <FeatureGate feature="workspace.reader">
              {(gate) =>
                gate.available && !d.deleted_at ? (
                  <Link to={`/study/${d.id}`} className={buttonClass({ variant: 'primary' })} onClick={() => void api.post(`/sources/${d.id}/open`).catch(() => undefined)}>
                    <BookOpenText size={18} aria-hidden="true" />
                    افتح في مساحة الدراسة
                  </Link>
                ) : (
                  <span className="ml-cluster">
                    <Button variant="primary" icon={<BookOpenText size={18} />} disabled>
                      افتح في مساحة الدراسة
                    </Button>
                    <span className="ml-field__hint">{d.deleted_at ? 'استعد المصدر من السلة أولًا.' : gate.reason}</span>
                  </span>
                )
              }
            </FeatureGate>
            {d.deleted_at === null && <OfflineDownloadButton sourceId={d.id} title={d.title} />}
            {!readOnly && summary && lib.index && <SourceMenu source={summary} index={lib.index} />}
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="أقسام المصدر">
          <Tab value="pages">الصفحات</Tab>
          <Tab value="meta">البيانات</Tab>
          <Tab value="versions">النسخ ({d.versions.length})</Tab>
          <Tab value="links">الروابط ({d.links.length})</Tab>
        </TabList>
        <div className="ml-source__panel">
          <TabPanel value="pages">{tab === 'pages' && <PagesPanel sourceId={d.id} versions={d.versions} activeVersionId={d.active_version_id} readOnly={readOnly} />}</TabPanel>
          <TabPanel value="meta">{tab === 'meta' && <MetadataForm detail={d} readOnly={readOnly} />}</TabPanel>
          <TabPanel value="versions">{tab === 'versions' && <VersionsPanel detail={d} readOnly={readOnly} />}</TabPanel>
          <TabPanel value="links">{tab === 'links' && <LinksPanel detail={d} index={lib.index} readOnly={readOnly} />}</TabPanel>
        </div>
      </Tabs>
    </div>
  );
}
