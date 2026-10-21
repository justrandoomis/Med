// Route lists of gate 2 (ARCHITECTURE_DELTA §5.5) and of the platform operations (§5.8). P1-T1 step 1.
import type { SpaceRouteGrant } from '../../system/binding';
import { SPACE_ROUTES } from './spaceRoutes';

/** Every route under this prefix binds a subject space — and only if it is on the allow-list. */
export const SPACE_ROUTE_PREFIX = '/api/spaces/:spaceId';

export function isSpaceRouteUrl(url: string): boolean {
  return url === SPACE_ROUTE_PREFIX || url.startsWith(`${SPACE_ROUTE_PREFIX}/`) || url.startsWith('/api/spaces/');
}

const methodKey = (method: string) => (method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase());

export class SpaceRouteAllowList {
  private readonly byKey = new Map<string, SpaceRouteGrant>();

  constructor(entries: readonly SpaceRouteGrant[]) {
    for (const e of entries) {
      if (!e.path.startsWith(`${SPACE_ROUTE_PREFIX}/`)) throw new Error(`space route outside ${SPACE_ROUTE_PREFIX}: ${e.path}`);
      this.byKey.set(`${methodKey(e.method)} ${e.path}`, e);
    }
  }

  find(method: string, url: string): SpaceRouteGrant | null {
    return this.byKey.get(`${methodKey(method)} ${url}`) ?? null;
  }

  entries(): SpaceRouteGrant[] {
    return [...this.byKey.values()];
  }
}

/** The allow-list in force: the constant of spaceRoutes.ts plus (tests only) extra entries. */
export function createSpaceRouteAllowList(extra: readonly SpaceRouteGrant[] = []): SpaceRouteAllowList {
  return new SpaceRouteAllowList([...SPACE_ROUTES, ...extra]);
}

/**
 * Today's whole-deployment operations, guarded in place (ARCHITECTURE_DELTA §5.8): every one answers 404 — the body of
 * a missing route — to anyone but a platform admin. HEAD follows its GET. Per-user parts stay per user: POST
 * /api/control/client-errors (own errors), the Control Center's own storage, jobs, alerts and history (bound vault).
 */
export const PLATFORM_ROUTES: readonly string[] = [
  // «تقييم الجودة» evaluation runs
  'GET /api/control/evaluation',
  'GET /api/control/evaluation/runs/:id',
  'GET /api/control/evaluation/runs/:id/report.md',
  // «صحة النظام» health and the client-error sink (reading / clearing it)
  'GET /api/control/health',
  'GET /api/control/client-errors',
  'DELETE /api/control/client-errors',
  // whole-instance backups and the off-site copies of them
  'GET /api/data/backups',
  'POST /api/data/backups',
  'GET /api/data/backups/:id',
  'POST /api/data/backups/:id/verify',
  'GET /api/data/backups/:id/download',
  'DELETE /api/data/backups/:id',
  'GET /api/data/offsite',
  'POST /api/data/offsite/run',
  'GET /api/data/offsite/remote',
  // the whole-instance export (users get their own export from /api/accounts/me/export, P1-T1 step 2)
  'GET /api/data/export/all',
];

const PLATFORM_SET = new Set(PLATFORM_ROUTES);

export function isPlatformRoute(method: string, url: string): boolean {
  return PLATFORM_SET.has(`${methodKey(method)} ${url}`) || url === '/api/platform' || url.startsWith('/api/platform/');
}
