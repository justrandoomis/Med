import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'upload', lazy: () => import('./UploadScreen').then((m) => ({ Component: m.UploadScreen })) },
    // Academic OS P1-T3: the uploader's review queue of import suggestions
    { path: 'upload/suggestions', lazy: () => import('./ImportSuggestionsScreen').then((m) => ({ Component: m.ImportSuggestionsScreen })) },
  ],
};
