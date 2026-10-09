// Question Vault routes (§33–§36, §48). Screens are lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'questions', lazy: () => import('./VaultScreen').then((m) => ({ Component: m.VaultScreen })) },
    { path: 'questions/add', lazy: () => import('./QuickAddScreen').then((m) => ({ Component: m.QuickAddScreen })) },
    { path: 'questions/review', lazy: () => import('./ReviewQueueScreen').then((m) => ({ Component: m.ReviewQueueScreen })) },
    { path: 'questions/:questionId', lazy: () => import('./QuestionDetailScreen').then((m) => ({ Component: m.QuestionDetailScreen })) },
    { path: 'questions/:questionId/review', lazy: () => import('./ReviewScreen').then((m) => ({ Component: m.ReviewScreen })) },
  ],
};
