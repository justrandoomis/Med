// Weakness Center routes (§44): the center (weaknesses, Mistake Genome, Forgetting Forecast), one weakness, and the
// Reasoning Replay of a question. Lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'weakness', lazy: () => import('./WeaknessCenter').then((m) => ({ Component: m.WeaknessCenter })) },
    { path: 'weakness/replay/:questionId', lazy: () => import('./ReplayScreen').then((m) => ({ Component: m.ReplayScreen })) },
    { path: 'weakness/:id', lazy: () => import('./WeaknessDetail').then((m) => ({ Component: m.WeaknessDetail })) },
  ],
};
