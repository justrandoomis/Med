// Practice & exams routes (§37–§41). The runner is full-bleed (a clean question sheet without the app shell);
// everything else lives in the shell. Screens are lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'exams', lazy: () => import('./HistoryScreen').then((m) => ({ Component: m.HistoryScreen })) },
    { path: 'exams/new', lazy: () => import('./BuilderScreen').then((m) => ({ Component: m.BuilderScreen })) },
    { path: 'exams/generate', lazy: () => import('./GenerateScreen').then((m) => ({ Component: m.GenerateScreen })) },
    { path: 'exams/simulate', lazy: () => import('./SimulationScreen').then((m) => ({ Component: m.SimulationScreen })) },
    { path: 'exams/written/:questionId', lazy: () => import('./WrittenScreen').then((m) => ({ Component: m.WrittenScreen })) },
    { path: 'exams/:attemptId/results', lazy: () => import('./ResultsScreen').then((m) => ({ Component: m.ResultsScreen })) },
    { path: 'practice', lazy: () => import('./PracticeEntry').then((m) => ({ Component: m.PracticeEntry })) },
  ],
  fullBleed: [{ path: 'exams/:attemptId', lazy: () => import('./RunnerScreen').then((m) => ({ Component: m.RunnerScreen })) }],
};
