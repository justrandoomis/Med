// MedLevo on Cloudflare Containers. The Worker is only a front door: every request goes to ONE container instance
// («main») that runs the same Docker image Render runs (Dockerfile at the repository root).
//
// Cloudflare Containers have no permanent disk. Data survives through Cloudflare R2:
//   * the server backs up (encrypted, verified) to R2 every MEDLEVO_BACKUP_INTERVAL_MINUTES while it runs;
//   * when a container starts on an empty disk it restores the newest R2 backup first
//     (deploy/docker/medlevo-cloud-boot), and refuses to start empty if that restore fails.
// The container sleeps after SLEEP_AFTER without requests; by then the last backup holds everything.
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  MEDLEVO: DurableObjectNamespace<MedLevoContainer>;
  // plain vars (wrangler.jsonc)
  MEDLEVO_ORIGIN?: string;
  MEDLEVO_R2_BUCKET: string;
  MEDLEVO_BACKUP_INTERVAL_MINUTES: string;
  // secrets (wrangler secret put …)
  ANTHROPIC_API_KEY?: string;
  MEDLEVO_SETUP_TOKEN: string;
  MEDLEVO_R2_ACCOUNT_ID: string;
  MEDLEVO_R2_ACCESS_KEY_ID: string;
  MEDLEVO_R2_SECRET_ACCESS_KEY: string;
  MEDLEVO_BACKUP_ENCRYPTION_KEY: string;
  /** operator token for POST /__ops/restart (optional; the route answers 404 without it) */
  MEDLEVO_OPS_TOKEN?: string;
}

const PORT = 10000;

export class MedLevoContainer extends Container<Env> {
  defaultPort = PORT;
  sleepAfter = '3h';
  enableInternet = true;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    const vars: Record<string, string | undefined> = {
      NODE_ENV: 'production',
      MEDLEVO_HOST: '0.0.0.0',
      MEDLEVO_PORT: String(PORT),
      MEDLEVO_TRUST_PROXY: '1',
      MEDLEVO_CLIENT_IP_HEADER: 'cf-connecting-ip',
      MEDLEVO_RESTORE_ON_BOOT: '1',
      MEDLEVO_ORIGIN: env.MEDLEVO_ORIGIN,
      MEDLEVO_R2_BUCKET: env.MEDLEVO_R2_BUCKET,
      MEDLEVO_BACKUP_INTERVAL_MINUTES: env.MEDLEVO_BACKUP_INTERVAL_MINUTES,
      MEDLEVO_R2_ACCOUNT_ID: env.MEDLEVO_R2_ACCOUNT_ID,
      MEDLEVO_R2_ACCESS_KEY_ID: env.MEDLEVO_R2_ACCESS_KEY_ID,
      MEDLEVO_R2_SECRET_ACCESS_KEY: env.MEDLEVO_R2_SECRET_ACCESS_KEY,
      MEDLEVO_BACKUP_ENCRYPTION_KEY: env.MEDLEVO_BACKUP_ENCRYPTION_KEY,
      MEDLEVO_SETUP_TOKEN: env.MEDLEVO_SETUP_TOKEN,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    };
    this.envVars = Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
  }
}

const STARTING_PAGE = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="8"><title>MedLevo</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f7f5;color:#222}main{text-align:center;padding:2rem}p{color:#666}</style></head><body><main><h1>MedLevo يبدأ التشغيل…</h1><p>تُستعاد بياناتك من النسخة الاحتياطية. تتحدث الصفحة وحدها خلال لحظات.</p><p dir="ltr">Starting up — restoring your data. This page refreshes by itself.</p></main></body></html>`;

async function sameToken(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = getContainer(env.MEDLEVO, 'main');
    const url = new URL(request.url);
    if (url.pathname === '/__ops/restart') {
      // stops the container (SIGTERM: running jobs are re-queued); the next request starts a fresh one, which restores
      // the newest R2 backup — the operator's way to apply new secrets or to test the restore
      if (!env.MEDLEVO_OPS_TOKEN || request.method !== 'POST' || !(await sameToken(request.headers.get('authorization'), `Bearer ${env.MEDLEVO_OPS_TOKEN}`))) {
        return new Response('Not found', { status: 404 });
      }
      await stub.stop('SIGTERM');
      return Response.json({ ok: true, stopped: true });
    }
    try {
      // a cold start restores from R2 first (can take a minute or more for a large library)
      await stub.startAndWaitForPorts({ ports: PORT, cancellationOptions: { portReadyTimeoutMS: 25_000 } });
    } catch {
      const wantsHtml = (request.headers.get('accept') ?? '').includes('text/html');
      return new Response(wantsHtml ? STARTING_PAGE : JSON.stringify({ ok: false, starting: true }), {
        status: 503,
        headers: { 'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'application/json', 'retry-after': '8', 'cache-control': 'no-store' },
      });
    }
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
