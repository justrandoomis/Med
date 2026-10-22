// «التنبيهات» (P1-T4 step 3; IA §4.9) — reached from the bell in the top bar.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ path: 'notifications', lazy: () => import('./NotificationsScreen').then((m) => ({ Component: m.NotificationsScreen })) }],
};
