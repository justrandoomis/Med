// Study workspace routes (full-bleed, no shell): /study/:sourceId?v=<versionId>&page=<index>, /notebook/:nodeId
import { Navigate } from 'react-router-dom';
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  fullBleed: [
    { path: 'study/:sourceId', lazy: () => import('./WorkspaceScreen').then((m) => ({ Component: m.WorkspaceScreen })) },
    // a notebook's note pages as a book (track F1): /notebook/:nodeId?page=<notePageId>
    { path: 'notebook/:nodeId', lazy: () => import('./notebook/NotebookScreen').then((m) => ({ Component: m.NotebookScreen })) },
    // the workspace always opens a source; without one, go to the library to choose it
    { path: 'study', element: <Navigate to="/library" replace /> },
  ],
};
