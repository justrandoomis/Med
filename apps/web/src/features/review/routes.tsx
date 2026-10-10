// Review routes (§43, §44, §45, §40, §23): the Review hub, the focused flashcard session (full-bleed, works offline),
// the card library and editor (basic, cloze, image occlusion, from a selection, from a mistake), the one-tap revision,
// Exam DNA and the learning profile. Screens are lazy chunks.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'review', lazy: () => import('./ReviewHub').then((m) => ({ Component: m.ReviewHub })) },
    { path: 'review/cards', lazy: () => import('./CardLibrary').then((m) => ({ Component: m.CardLibrary })) },
    { path: 'review/cards/new', lazy: () => import('./CardEditor').then((m) => ({ Component: m.CardEditor })) },
    { path: 'review/cards/:cardId', lazy: () => import('./CardEditor').then((m) => ({ Component: m.CardEditor })) },
    { path: 'review/revision', lazy: () => import('./RevisionScreen').then((m) => ({ Component: m.RevisionScreen })) },
    { path: 'review/revision/:revisionId', lazy: () => import('./RevisionScreen').then((m) => ({ Component: m.RevisionScreen })) },
    { path: 'review/dna', lazy: () => import('./ExamDnaScreen').then((m) => ({ Component: m.ExamDnaScreen })) },
    { path: 'review/profile', lazy: () => import('./ProfileScreen').then((m) => ({ Component: m.ProfileScreen })) },
  ],
  fullBleed: [{ path: 'review/session', lazy: () => import('./ReviewSession').then((m) => ({ Component: m.ReviewSession })) }],
};
