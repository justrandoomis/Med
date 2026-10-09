import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    {
      path: 'settings',
      lazy: () => import('./SettingsScreen').then((m) => ({ Component: m.SettingsScreen })),
    },
  ],
};
