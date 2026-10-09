import type { RouteObject } from 'react-router-dom';
import type { FeatureRoutes } from './routeTypes';
import { ownerGateLoader } from './guards';
import { AppShell } from './AppShell';
import { NotFoundScreen, OwnerLayout, RootLayout, RouteErrorScreen } from './layouts';
import { LoadingState } from '../design';
import { routes as auth } from '../features/auth/routes';
import { routes as home } from '../features/home/routes';
import { routes as library } from '../features/library/routes';
import { routes as upload } from '../features/upload/routes';
import { routes as sources } from '../features/sources/routes';
import { routes as workspace } from '../features/workspace/routes';
import { routes as studybook } from '../features/studybook/routes';
import { routes as questions } from '../features/questions/routes';
import { routes as exams } from '../features/exams/routes';
import { routes as review } from '../features/review/routes';
import { routes as weakness } from '../features/weakness/routes';
import { routes as planner } from '../features/planner/routes';
import { routes as search } from '../features/search/routes';
import { routes as control } from '../features/control/routes';
import { routes as settings } from '../features/settings/routes';

/** Every feature's routes (see routeTypes.ts for the placement contract). */
export const FEATURES: Record<string, FeatureRoutes> = {
  auth,
  home,
  library,
  upload,
  sources,
  workspace,
  studybook,
  questions,
  exams,
  review,
  weakness,
  planner,
  search,
  control,
  settings,
};

export function buildRoutes(features: Record<string, FeatureRoutes> = FEATURES): RouteObject[] {
  const all = Object.values(features);
  const publicRoutes = all.flatMap((f) => f.public ?? []);
  const shellRoutes = all.flatMap((f) => f.shell ?? []);
  const fullBleedRoutes = all.flatMap((f) => f.fullBleed ?? []);
  return [
    {
      id: 'root',
      path: '/',
      element: <RootLayout />,
      errorElement: <RouteErrorScreen />,
      // shown while the first loader (auth status) runs
      hydrateFallbackElement: <LoadingState stage="جارٍ فتح MedLevo…" />,
      children: [
        ...publicRoutes,
        {
          id: 'owner',
          loader: ownerGateLoader,
          element: <OwnerLayout />,
          errorElement: <RouteErrorScreen />,
          children: [
            {
              element: <AppShell />,
              errorElement: <RouteErrorScreen />,
              children: [...shellRoutes, { path: '*', element: <NotFoundScreen /> }],
            },
            ...fullBleedRoutes,
          ],
        },
      ],
    },
  ];
}
