// Official lectures in subject spaces (track P1-T5): the lecture page with its tabs «الرسمي» and «الشروحات», the
// publication page, and the admin sections «المحتوى الرسمي» and «الملفات المكررة» (registered from ./admin).
//
// P1-T5 step 2: the official lecture page (/subjects/:spaceId/lectures/:lectureId) with «ابدأ الدراسة». Step 3: its
// «الشروحات» tab and the publication page (/subjects/:spaceId/publications/:publicationId).
// test/copies/wave2-step0-routes.test.ts checks that every route here carries a real screen.
import type { FeatureRoutes } from '../../app/routeTypes';
// registers «المحتوى الرسمي» and «الملفات المكررة» in «إدارة القنوات» (P1-T4's area hosts them at /admin/:section)
import './admin/register';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'subjects/:spaceId/lectures/:lectureId', lazy: () => import('./LectureScreen').then((m) => ({ Component: m.LectureScreen })) },
    { path: 'subjects/:spaceId/publications/:publicationId', lazy: () => import('./PublicationScreen').then((m) => ({ Component: m.PublicationScreen })) },
  ],
};
