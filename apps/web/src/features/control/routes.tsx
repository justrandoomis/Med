// Personal Control Center routes (§48): /control and its sections, inside the app shell. Screens are lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    {
      path: 'control',
      lazy: () => import('./ControlLayout').then((m) => ({ Component: m.ControlLayout })),
      children: [
        { index: true, lazy: () => import('./ControlIndex').then((m) => ({ Component: m.ControlIndex })) },
        { path: 'review', lazy: () => import('./ReviewQueueScreen').then((m) => ({ Component: m.ReviewQueueScreen })) },
        { path: 'review/:itemId', lazy: () => import('./ReviewItemScreen').then((m) => ({ Component: m.ReviewItemScreen })) },
        { path: 'alerts', lazy: () => import('./AlertsScreen').then((m) => ({ Component: m.AlertsScreen })) },
        { path: 'sync', lazy: () => import('./SyncScreen').then((m) => ({ Component: m.SyncScreen })) },
        { path: 'processing', lazy: () => import('./ProcessingScreen').then((m) => ({ Component: m.ProcessingScreen })) },
        { path: 'sources', lazy: () => import('./SourcesScreen').then((m) => ({ Component: m.SourcesScreen })) },
        { path: 'intelligence', lazy: () => import('./IntelligenceScreen').then((m) => ({ Component: m.IntelligenceScreen })) },
        { path: 'storage', lazy: () => import('./StorageScreen').then((m) => ({ Component: m.StorageScreen })) },
        { path: 'capabilities', lazy: () => import('./CapabilitiesScreen').then((m) => ({ Component: m.CapabilitiesScreen })) },
        { path: 'history', lazy: () => import('./HistoryScreen').then((m) => ({ Component: m.HistoryScreen })) },
      ],
    },
  ],
};
