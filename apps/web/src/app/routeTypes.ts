import type { RouteObject } from 'react-router-dom';

/**
 * Every feature exports `routes: FeatureRoutes` from `src/features/<feature>/routes.tsx`.
 * The app route table (src/app/routes.tsx) places them:
 *
 *  - `shell`     authenticated routes rendered inside the AppShell (top bar on wide screens,
 *                bottom tab bar on phones). Paths are RELATIVE to '/', e.g. 'library/:nodeId'.
 *                The home screen is `{ index: true }`.
 *  - `fullBleed` authenticated routes WITHOUT the shell (the study workspace '/study/…', focused
 *                exam mode, …). Paths are relative to '/'.
 *  - `public`    routes that need no owner session (only the auth feature uses this).
 *
 * Prefer `lazy` for screen code so each feature is its own chunk:
 *   { path: 'library', lazy: () => import('./LibraryScreen').then((m) => ({ Component: m.LibraryScreen })) }
 */
export interface FeatureRoutes {
  shell?: RouteObject[];
  fullBleed?: RouteObject[];
  public?: RouteObject[];
}

/** Data the owner gate loader exposes via useRouteLoaderData('owner'). */
export interface OwnerGateData {
  mode: 'online' | 'offline';
  username: string | null;
  /** remaining one-time recovery codes (online only) */
  remainingRecoveryCodes: number | null;
  /** current auth session id (online only) */
  sessionId: string | null;
  /** server's minimum password length (for password forms) */
  passwordMinLength: number;
  /** when offline: why the server could not be asked */
  offlineMessage?: string;
}
