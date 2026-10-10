// Course Brain screens (track F2). The course page itself is the library's course view (CourseBrainTabs inside
// features/library/NodeScreen.tsx); these are the extra screens it links to.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'library/topics', lazy: () => import('./TopicsScreen').then((m) => ({ Component: m.TopicsScreen })) },
    { path: 'library/topics/:topicId', lazy: () => import('./TopicsScreen').then((m) => ({ Component: m.TopicScreen })) },
    { path: 'concepts', lazy: () => import('./ConceptsScreen').then((m) => ({ Component: m.ConceptsScreen })) },
    { path: 'concepts/:conceptId', lazy: () => import('./ConceptScreen').then((m) => ({ Component: m.ConceptScreen })) },
    { path: 'knowledge', lazy: () => import('./KnowledgeScreen').then((m) => ({ Component: m.KnowledgeScreen })) },
  ],
};
