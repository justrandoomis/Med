// Study Planner routes (§45): plans, a new plan (with preview + feasibility), editing inputs (a new plan replaces the
// old one, archived), and one plan's days with check-off and a visible rebalance. Lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'planner', lazy: () => import('./PlannerScreen').then((m) => ({ Component: m.PlannerScreen })) },
    { path: 'planner/new', lazy: () => import('./PlanEditor').then((m) => ({ Component: m.PlanEditor })) },
    { path: 'planner/:id/edit', lazy: () => import('./PlanEditor').then((m) => ({ Component: m.PlanEditor })) },
    { path: 'planner/:id', lazy: () => import('./PlanView').then((m) => ({ Component: m.PlanView })) },
  ],
};
