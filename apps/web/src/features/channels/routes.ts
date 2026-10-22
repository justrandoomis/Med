// «القنوات» (P1-T4 step 3; IA §3.2, §3.3): the channels home, browsing the tree, the subject page, and the invite-link
// landing /join/:token — the one Academic OS screen reachable before sign-in (it shows only the channel's title).
// The official lecture page under a subject (/subjects/:spaceId/lectures/:lectureId) is P1-T5's (features/lectures).
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'channels', lazy: () => import('./ChannelsHome').then((m) => ({ Component: m.ChannelsHome })) },
    { path: 'channels/:nodeId', lazy: () => import('./BrowseScreen').then((m) => ({ Component: m.BrowseScreen })) },
    { path: 'subjects/:subjectId', lazy: () => import('./SubjectScreen').then((m) => ({ Component: m.SubjectScreen })) },
  ],
  public: [{ path: 'join/:token', lazy: () => import('./JoinLinkScreen').then((m) => ({ Component: m.JoinLinkScreen })) }],
};
