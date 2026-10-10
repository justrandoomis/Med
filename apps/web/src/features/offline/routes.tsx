// Offline downloads, backups and export (track D1) — /offline inside the app shell.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ path: 'offline', lazy: () => import('./OfflineScreen').then((m) => ({ Component: m.OfflineScreen })) }],
};
