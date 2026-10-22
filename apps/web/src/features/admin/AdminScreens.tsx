// «إدارة القنوات» — /admin and /admin/:section (P1-T4 step 3; IA §4.10; PRD AOS-18.1). Reached from «أنا» only with a
// channel role; for anyone else /admin is the same page as a missing route. The index lists the sections the
// registry holds (P1-T4's: الشجرة، الأعضاء وطلبات الانضمام، الرموز والدعوات، الأدوار، الإشراف، سجل الإجراءات; P1-T5's:
// المحتوى الرسمي، الملفات المكررة) that the viewer's roles open; each section loads lazily and shows its own scope.
// Separate from the Personal Control Center, built from its patterns (grouped lists, impact preview, history).
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Breadcrumbs, ErrorState, ListItem, LoadingState } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { NotFoundScreen } from '../../app/NotFoundScreen';
import { CachedBanner } from '../channels/ui';
import { visibleAdminSections, type AdminSection } from './sections';
import { AdminViewerProvider, useLoadAdminViewer } from './viewer';
import './admin.css';

/** Loads a registered section's screen (its own chunk) and renders it. */
function SectionLoader({ section }: { section: AdminSection }) {
  const [loaded, setLoaded] = useState<{ id: string; Screen: ComponentType } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    section
      .lazy()
      .then((m) => alive && setLoaded({ id: section.id, Screen: m.Component }))
      .catch(() => alive && setFailed(section.id));
    return () => {
      alive = false;
    };
  }, [section]);
  if (failed === section.id) return <ErrorState message="تعذّر تحميل هذا القسم. تحقّق من الاتصال ثم أعد تحميل الصفحة." />;
  if (!loaded || loaded.id !== section.id) return <LoadingState stage={`جارٍ فتح «${section.title_ar}»…`} />;
  const { Screen } = loaded;
  return <Screen />;
}

export function AdminIndexScreen() {
  usePageTitle('إدارة القنوات');
  const v = useLoadAdminViewer();
  const [params] = useSearchParams();
  if (v.status === 'loading') return <LoadingState stage="جارٍ تحميل أدوارك…" />;
  if (v.status === 'error')
    return (
      <div className="ml-page">
        <ErrorState message={v.error ?? ''} onRetry={v.reload} />
      </div>
    );
  const sections = visibleAdminSections({ roles: v.roles, isPlatformAdmin: v.isPlatformAdmin });
  if (v.roles.length === 0 && !v.isPlatformAdmin) return <NotFoundScreen />;
  const node = params.get('node');
  const keep = node ? `?node=${encodeURIComponent(node)}&subject=${encodeURIComponent(node)}` : '';
  return (
    <div className="ml-page ml-page--narrow ad-screen">
      <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'إدارة القنوات' }]} />
      <header className="ml-page__header">
        <h1 className="ml-page__title">إدارة القنوات</h1>
        <p className="ml-page__lede">للقنوات التي لك فيها دور. كل إجراء يسجَّل في «سجل الإجراءات» مع نطاقه، ولا يظهر هنا أي محتوى خاص بالطلاب.</p>
      </header>
      {v.cachedAt !== null && <CachedBanner at={v.cachedAt} />}
      <ul role="list" className="ml-list">
        {sections.map((s) => (
          <ListItem key={s.id} to={`${s.path}${keep}`} title={s.title_ar} subtitle={s.description_ar} trailing={<ChevronLeft size={18} aria-hidden="true" />} />
        ))}
      </ul>
    </div>
  );
}

export function AdminSectionScreen() {
  const { section = '' } = useParams();
  const v = useLoadAdminViewer();
  const found = useMemo(
    () => (v.status === 'ready' ? (visibleAdminSections({ roles: v.roles, isPlatformAdmin: v.isPlatformAdmin }).find((s) => s.id === section) ?? null) : null),
    [v.status, v.roles, v.isPlatformAdmin, section],
  );
  usePageTitle(found?.title_ar ?? 'إدارة القنوات');
  if (v.status === 'loading') return <LoadingState stage="جارٍ تحميل أدوارك…" />;
  if (v.status === 'error')
    return (
      <div className="ml-page">
        <ErrorState message={v.error ?? ''} onRetry={v.reload} />
      </div>
    );
  if (!found) return <NotFoundScreen />;
  return (
    <AdminViewerProvider value={v}>
      <div className="ad-host">
        <div className="ad-host__crumbs">
          <Breadcrumbs items={[{ label: 'أنا', to: '/me' }, { label: 'إدارة القنوات', to: '/admin' }, { label: found.title_ar }]} />
          {v.cachedAt !== null && <CachedBanner at={v.cachedAt} />}
        </div>
        <SectionLoader section={found} />
      </div>
    </AdminViewerProvider>
  );
}
