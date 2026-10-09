import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ path: 'upload', lazy: () => import('./UploadScreen').then((m) => ({ Component: m.UploadScreen })) }],
};
