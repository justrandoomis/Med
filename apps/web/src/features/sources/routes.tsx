import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ path: 'sources/:sourceId', lazy: () => import('./SourceScreen').then((m) => ({ Component: m.SourceScreen })) }],
};
