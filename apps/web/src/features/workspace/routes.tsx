// Study workspace routes (full-bleed, no shell): /study/:sourceId?v=<versionId>&page=<index>
import { Navigate } from 'react-router-dom';
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  fullBleed: [
    { path: 'study/:sourceId', lazy: () => import('./WorkspaceScreen').then((m) => ({ Component: m.WorkspaceScreen })) },
    // the workspace always opens a source; without one, go to the library to choose it
    { path: 'study', element: <Navigate to="/library" replace /> },
  ],
};
