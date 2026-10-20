// Study Book track (C2) shell routes: the owner's terminology dictionary (§21) and the explanation rules (§19).
// The Study Book itself, explanations, chat and summaries live inside the study workspace (/study/:sourceId).
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'terms', lazy: () => import('./TermsScreen').then((m) => ({ Component: m.TermsScreen })) },
    { path: 'explanation-rules', lazy: () => import('./RulesScreen').then((m) => ({ Component: m.RulesScreen })) },
    // Round 7 H4: one generated explanation on its own page (reached from the topics it is linked to)
    { path: 'explanations/:artifactId', lazy: () => import('./ArtifactScreen').then((m) => ({ Component: m.ArtifactScreen })) },
  ],
};
