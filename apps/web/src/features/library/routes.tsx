import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'library', lazy: () => import('./LibraryScreen').then((m) => ({ Component: m.LibraryScreen })) },
    { path: 'library/:nodeId', lazy: () => import('./NodeScreen').then((m) => ({ Component: m.NodeScreen })) },
  ],
};
