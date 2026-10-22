// «أنا» (P1-T4 step 3; IA §3.1 destination 5, §3.2): the account hub and the screens of the student's own account. Settings
// keeps its URL (/settings, features/settings) and is listed here.
import type { FeatureRoutes } from '../../app/routeTypes';

export const routes: FeatureRoutes = {
  shell: [
    { path: 'me', lazy: () => import('./MeScreen').then((m) => ({ Component: m.MeScreen })) },
    { path: 'me/devices', lazy: () => import('./DevicesScreen').then((m) => ({ Component: m.DevicesScreen })) },
    { path: 'me/privacy', lazy: () => import('./PrivacyScreen').then((m) => ({ Component: m.PrivacyScreen })) },
    { path: 'me/usage', lazy: () => import('./UsageScreen').then((m) => ({ Component: m.UsageScreen })) },
  ],
};
