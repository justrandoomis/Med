import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'sources/:sourceId', lazy: () => import('./SourceScreen').then((m) => ({ Component: m.SourceScreen })) },
    // Academic OS P1-T3: compare two versions side by side; order a folder's lectures by number or date
    { path: 'sources/:sourceId/compare', lazy: () => import('./CompareScreen').then((m) => ({ Component: m.CompareScreen })) },
    { path: 'lectures/order/:nodeId', lazy: () => import('./LectureOrderScreen').then((m) => ({ Component: m.LectureOrderScreen })) },
  ],
};
