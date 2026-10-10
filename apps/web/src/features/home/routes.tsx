// Home (§45, §23) — the index route: Continue Studying first, then today's plan, cards, exam, weakness, questions.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [{ index: true, lazy: () => import('./HomeScreen').then((m) => ({ Component: m.HomeScreen })) }],
};
