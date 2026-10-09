// Study Book track (C2) shell routes: the owner's terminology dictionary (§21) and the explanation rules (§19).
// The Study Book itself, explanations, chat and summaries live inside the study workspace (/study/:sourceId).
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'terms', lazy: () => import('./TermsScreen').then((m) => ({ Component: m.TermsScreen })) },
    { path: 'explanation-rules', lazy: () => import('./RulesScreen').then((m) => ({ Component: m.RulesScreen })) },
  ],
};
