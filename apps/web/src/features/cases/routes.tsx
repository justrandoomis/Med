// Clinical cases / OSCE / viva routes (§42). Screens are lazy chunks inside the shell.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'cases', lazy: () => import('./CasesScreen').then((m) => ({ Component: m.CasesScreen })) },
    { path: 'cases/new', lazy: () => import('./CaseEditor').then((m) => ({ Component: m.CaseEditor })) },
    { path: 'cases/run/:attemptId', lazy: () => import('./CaseRunner').then((m) => ({ Component: m.CaseRunner })) },
    { path: 'cases/report/:attemptId', lazy: () => import('./CaseReport').then((m) => ({ Component: m.CaseReport })) },
    { path: 'cases/:caseId', lazy: () => import('./CaseDetailScreen').then((m) => ({ Component: m.CaseDetailScreen })) },
    { path: 'cases/:caseId/edit', lazy: () => import('./CaseEditor').then((m) => ({ Component: m.CaseEditor })) },
  ],
};
