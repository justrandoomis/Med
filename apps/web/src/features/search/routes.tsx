// Universal Search (§46) — /search inside the app shell.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ path: 'search', lazy: () => import('./SearchScreen').then((m) => ({ Component: m.SearchScreen })) }],
};
