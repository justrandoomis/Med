// Media routes (§29, §32): images & recordings hub, image detail (overlays), image quiz, recording + transcript.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'media', lazy: () => import('./MediaHub').then((m) => ({ Component: m.MediaHub })) },
    { path: 'media/images/:imageId', lazy: () => import('./ImageDetail').then((m) => ({ Component: m.ImageDetail })) },
    { path: 'media/quiz/:quizId', lazy: () => import('./ImageQuiz').then((m) => ({ Component: m.ImageQuiz })) },
    { path: 'media/audio/:audioId', lazy: () => import('./AudioScreen').then((m) => ({ Component: m.AudioScreen })) },
  ],
};
