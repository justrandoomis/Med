// «إدارة القنوات» (P1-T4 step 3; IA §4.10): /admin (the sections the viewer's roles open) and /admin/:section (one
// section, loaded lazily from the registry — P1-T4's own and P1-T5's «المحتوى الرسمي» / «الملفات المكررة»). Without a
// channel role both answer the not-found page.
import type { FeatureRoutes } from '../../app/routeTypes';
// registers P1-T4's sections (P1-T5's register from features/lectures/routes)
import './register';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'admin', lazy: () => import('./AdminScreens').then((m) => ({ Component: m.AdminIndexScreen })) },
    { path: 'admin/:section', lazy: () => import('./AdminScreens').then((m) => ({ Component: m.AdminSectionScreen })) },
  ],
};
