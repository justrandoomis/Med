// buildApp(): the Fastify instance used by index.ts and by tests (fastify.inject).
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { ApiErrorBody, ErrorCode, HealthResponse } from '@medlevo/shared';
import { type AppConfig, loadConfig } from './config';
import { type AppContext, closeContextDatabases, type ContextOverrides, createContext } from './context';
import { Errors, isAppError } from './lib/errors';
import { validationError } from './lib/http';
import { loggerOptions } from './lib/log';
import { fastifyTrustProxy, registerClientIpHeader } from './lib/proxy';
import { createStaticSite } from './lib/static';
import { registerJsonCompression } from './lib/compress';
import { isApiRequest, registerAuthGuard } from './modules/auth/guard';
import { registerBindingHook } from './modules/authz/hook';
import { createSpaceRouteAllowList } from './modules/authz/routes';
import { MODULES, type ModuleEntry } from './modules';
import type { SpaceRouteGrant } from './system/binding';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildAppOptions {
  config?: AppConfig;
  overrides?: ContextOverrides;
  /** defaults to MODULES */
  modules?: ModuleEntry[];
  /** tests only: extra entries of the space-route allow-list (the shipped list is authz/spaceRoutes.ts) */
  spaceRoutes?: SpaceRouteGrant[];
}

/** Strict CSP for every /api response (JSON and private files): nothing may execute or be framed. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

const MSG: Partial<Record<ErrorCode, string>> = {
  PAYLOAD_TOO_LARGE: 'حجم الطلب أو الملف أكبر من الحد المسموح.',
  UNSUPPORTED_FORMAT: 'نوع المحتوى المرسل غير مدعوم.',
  BAD_REQUEST: 'تعذر فهم الطلب. تأكد من صحة البيانات المرسلة.',
  NOT_FOUND: 'المسار المطلوب غير موجود.',
};

/** Map any thrown error to the public envelope. Never exposes stack traces, paths, SQL or secrets. */
export function toApiError(err: unknown): { status: number; body: ApiErrorBody; headers?: Record<string, string> } {
  // an internal bug (database access without a bound tenant): logged by the handler, never shown as such
  if (isAppError(err) && err.code === 'NO_TENANT_BOUND') return toApiError(Errors.internal());
  if (isAppError(err)) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.messageAr } };
    if (err.details !== undefined) body.error.details = err.details;
    return { status: err.status, body, headers: err.headers };
  }
  if (err instanceof ZodError) return toApiError(validationError(err, 'body'));
  const fe = err as Partial<FastifyError> | undefined;
  const code = fe?.code ?? '';
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  const make = (c: ErrorCode, s: number, message?: string) => ({ status: s, body: { error: { code: c, message: message ?? MSG[c] ?? MSG.BAD_REQUEST! } } });
  if (fe?.validation) return make('VALIDATION_FAILED', 400, 'البيانات المرسلة غير صالحة. راجع الحقول المحددة ثم أعد المحاولة.');
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_REQ_FILE_TOO_LARGE' || /^FST_(PARTS|FILES|FIELDS)_LIMIT$/.test(code) || status === 413) {
    return make('PAYLOAD_TOO_LARGE', 413);
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || status === 415) return make('UNSUPPORTED_FORMAT', 415);
  if (status === 429) return toApiError(Errors.rateLimited(60));
  if (status === 404) return make('NOT_FOUND', 404);
  if (status >= 400 && status < 500) {
    if (/JSON/i.test(code)) return make('BAD_REQUEST', 400, 'تعذر قراءة الطلب: صيغة JSON غير صالحة.');
    return make('BAD_REQUEST', status);
  }
  return toApiError(Errors.internal());
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    // PL-0: none | all (an overwriting nginx / Caddy) | hop count | address list — see lib/proxy.ts
    trustProxy: fastifyTrustProxy(config.proxy.trust),
    bodyLimit: config.limits.maxJsonBodyBytes,
    // signed file tokens are ~110 chars; the default (100) would answer 414
    routerOptions: { maxParamLength: 600 },
  });
  // first hook of all: a platform-set client-address header (MEDLEVO_CLIENT_IP_HEADER) from a trusted proxy
  registerClientIpHeader(app, config.proxy);
  const ctx = createContext(config, app.log, opts.overrides);
  app.decorate('ctx', ctx);

  await app.register(helmet, {
    global: true,
    // CSP for the SPA shell (production static serving); /api responses get API_CSP below.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.cookieSecure ? { maxAge: 15552000, includeSubDomains: false } : false,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: config.limits.maxUploadBytes,
      files: 50,
      fields: 50,
      fieldSize: 1024 * 1024,
      parts: 120,
      headerPairs: 200,
    },
  });
  await app.register(rateLimit, {
    global: false,
    // AOS-21.45 (ARCHITECTURE_DELTA §14): a signed-in request is counted per USER (the guard set req.viewer in the
    // instance onRequest hook, which runs before the route's limiter) — classmates behind one campus NAT share an
    // address, not a budget; a request without a session is counted per address
    keyGenerator: (req) => (req.viewer ? `u:${req.viewer.userId}` : `ip:${req.ip}`),
    errorResponseBuilder: (_req, context) => Errors.rateLimited(Math.ceil(context.ttl / 1000)),
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = toApiError(err);
    if (mapped.status >= 500) req.log.error({ err, route: `${req.method} ${req.routeOptions?.url ?? ''}` }, 'request failed');
    if (mapped.headers) for (const [k, v] of Object.entries(mapped.headers)) reply.header(k, v);
    reply.code(mapped.status).send(mapped.body);
  });

  const staticSite = config.webDistDir ? createStaticSite(config.webDistDir) : null;
  if (config.env === 'production' && !staticSite) app.log.warn('web build not found; serving API only');

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (staticSite && !isApiRequest(req)) {
      const sent = staticSite.serve(req, reply);
      if (sent) return sent;
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: MSG.NOT_FOUND! } } satisfies ApiErrorBody);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // matched route or (decoded) /api path — never the raw URL alone (`/%61pi/...` routes to /api)
    if (isApiRequest(req)) {
      reply.header('content-security-policy', API_CSP);
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  // AOS-21.12 / NFR-P3: JSON answers ≥ 1 KiB go br / gzip-encoded when the client accepts it (packed ink in JSON)
  registerJsonCompression(app);

  registerAuthGuard(app, ctx);
  // gate 2: binds the viewer's own vault (or an allow-listed subject space), refuses platform routes to non-admins and
  // refuses to mount any space route that is not on the allow-list
  registerBindingHook(app, ctx, createSpaceRouteAllowList(opts.spaceRoutes ?? []));

  app.get('/api/health', async (): Promise<HealthResponse> => {
    let ok = true;
    try {
      // public route: no vault is bound — the system DB answers for the deployment
      ctx.system.db.get('SELECT 1 AS ok');
    } catch {
      ok = false;
    }
    return { ok, version: config.appVersion, time: ctx.clock.now() };
  });

  // P1-T1 step 3: the owner-migration page lives at this address while the server is in maintenance
  // (system/maintenance.ts); once the app runs, a page left open (or a bookmark) lands on the app instead
  app.get('/api/maintenance', async (_req, reply) => reply.code(303).header('location', '/').send());

  for (const m of opts.modules ?? MODULES) {
    await app.register(m.plugin, { prefix: m.prefix, ctx });
  }

  app.addHook('onClose', async () => {
    await ctx.jobs.stop();
    closeContextDatabases(ctx);
  });

  return app;
}

