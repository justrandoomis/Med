// The binding hook (ARCHITECTURE_DELTA §5.5 gate 2; P1-T1 step 1). Registered right after the auth guard (gate 1,
// session → viewer). It decides the ONE database a request may touch and enters it for the rest of the request:
//   * /api/spaces/:spaceId/… — only a route on the space allow-list, only for a viewer with that route's minimum access
//     in THIS subject (membership / role on the subject node that owns the space, or an ancestor); anything else 404;
//   * any other /api route with a session — the viewer's OWN vault (never another one: the vault comes from the
//     session's user, never from the request); while that vault cannot be used (locked, being deleted) only sign-out,
//     sign-in and the public routes work, without a database (accountUnavailable);
//   * public / unauthenticated requests — the root context (no database at all);
//   * platform operations (§5.8) — 404 for everyone but a platform admin, before any handler runs.
// Fastify loses the async context between the body parser and the handler, so preValidation re-enters it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { type Binding, ROOT, type SpaceAccess } from '../../system/binding';
import { accountUnavailableError } from '../../system/tenancy';
import { isApiRequest, PUBLIC_ROUTES } from '../auth/guard';
import { isPlatformRoute, isSpaceRouteUrl, type SpaceRouteAllowList } from './routes';

const RANK: Record<SpaceAccess, number> = { guest_publication: 0, member: 1, moderator: 2 };

const RELEASE = Symbol('medlevo.binding.release');
interface Releasable {
  [RELEASE]?: () => void;
}

const notFound = () => new AppError('NOT_FOUND', 'المسار المطلوب غير موجود.', 404);

/** Sign-in routes that retire the request's own session (they touch no vault). */
const RETIRES_SESSION = new Set(['POST /api/auth/logout', 'POST /api/auth/login']);

/**
 * A valid session whose account cannot be used right now — its vault is locked (restore, migration), being deleted or
 * missing (P1-T1 step 1 review). No vault is opened. Signing out and handing the browser to another account still work
 * (they retire this session); the public routes answer as for someone signed out (`/api/auth/status`: not signed in,
 * so the web client shows the sign-in screen instead of looping on 401s); everything else is 401 with the reason.
 */
function accountUnavailable(req: FastifyRequest, url: string): Binding {
  const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${url}`;
  if (RETIRES_SESSION.has(key)) return ROOT;
  if (PUBLIC_ROUTES.has(key) || PUBLIC_ROUTES.has(`${req.method} ${url}`)) {
    req.auth = null;
    req.viewer = null;
    return ROOT;
  }
  throw accountUnavailableError();
}

function spaceBinding(ctx: AppContext, req: FastifyRequest, allowList: SpaceRouteAllowList): Binding {
  const url = req.routeOptions.url ?? '';
  const grant = allowList.find(req.method, url);
  const viewer = req.viewer;
  if (!grant || !viewer) throw notFound();
  const spaceId = (req.params as Record<string, unknown> | undefined)?.spaceId;
  if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > 64) throw notFound();
  const space = ctx.system.vaults.spaceByIdInternal(spaceId);
  if (!space || space.status === 'archived' || space.status === 'migrating') throw notFound();
  const m = ctx.authz.memberships.accessToSpace(viewer, spaceId);
  if (!m) throw notFound();
  if (m.pending) throw new AppError('MEMBERSHIP_PENDING', 'طلب انضمامك إلى هذه المادة بانتظار الموافقة.', 403);
  if (RANK[m.access] < RANK[grant.minAccess]) {
    // a guest who may not see the route at all gets «not found»; a member below the route's level may see the space
    if (m.access === 'guest_publication') throw notFound();
    throw new AppError('FORBIDDEN', 'لا تملك صلاحية هذا الإجراء في هذه المادة.', 403);
  }
  return { kind: 'space', spaceId, subjectNodeId: m.subjectNodeId, viewer, access: m.access, route: grant };
}

export function registerBindingHook(app: FastifyInstance, ctx: AppContext, allowList: SpaceRouteAllowList): void {
  // fail closed at boot: a space route that is not on the allow-list is never mounted
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isSpaceRouteUrl(route.url)) return;
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      if (!allowList.find(m, route.url)) throw new Error(`space route not on the allow-list (authz/spaceRoutes.ts): ${m} ${route.url}`);
    }
  });

  app.addHook('onRequest', (req, reply, done) => {
    let binding: Binding = ROOT;
    try {
      if (isApiRequest(req)) {
        const url = req.routeOptions.url ?? '';
        const viewer = req.viewer;
        if (isPlatformRoute(req.method, url)) {
          // the body of a missing route — a non-admin cannot even tell that the operation exists
          if (!viewer || !ctx.authz.can(viewer, 'operate', { type: 'platform', operation: `${req.method} ${url}` }).allowed) throw notFound();
        }
        if (isSpaceRouteUrl(url)) binding = spaceBinding(ctx, req, allowList);
        else if (viewer) binding = ctx.tenancy.vaultBindingOrNull(viewer) ?? accountUnavailable(req, url);
        else binding = { kind: 'root', viewer: null };
        if (binding.kind !== 'root') {
          const ref = binding.kind === 'vault' ? (['vault', binding.vaultId] as const) : (['space', binding.spaceId] as const);
          const release = ctx.pool.acquire(ref[0], ref[1]);
          (req as unknown as Releasable)[RELEASE] = release;
          reply.raw.once('close', release);
        }
      }
    } catch (e) {
      done(e as Error);
      return;
    }
    ctx.binding.enterRequest(req, binding, done);
  });

  app.addHook('preValidation', (req, _reply, done) => {
    ctx.binding.reenter(req, done);
  });

  app.addHook('onResponse', (req, _reply, done) => {
    (req as unknown as Releasable)[RELEASE]?.();
    done();
  });
}
