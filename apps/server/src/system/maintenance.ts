// The maintenance server (ADR-0003 §5 «Boot guard»; P1-T1 step 3): what runs INSTEAD of the app while the data
// directory is not a finished multi-user layout. It never opens the owner's data for writing on its own, never offers
// first-run setup, and answers Render's health check (so the deploy goes live and the owner can reach this page from a
// phone):
//
//   GET  /api/health            200 {ok: true, maintenance: true}
//   GET  /api/auth/status       200, signed out, setup NOT required (an R1-a tab shows its sign-in screen)
//   GET  /api/maintenance, /    the Arabic page: what happens, a sign-in form (the owner's CURRENT password or an
//                               unused recovery code — checked against the owner row, never consumed) and progress
//   POST /api/maintenance/start | retry | rollback   (owner credentials + an explicit confirmation)
//   any other /api/*            503 «الخادم قيد الترقية» with the page's address (an R1-a client keeps its outbox)
//
// Boot plan (planBoot): single-owner data → this page waits for the owner (or starts at once with
// MEDLEVO_OWNER_MIGRATION=apply); an unfinished journal → resumed at once; a rollback (MEDLEVO_OWNER_MIGRATION=rollback,
// or one in progress) → done at once, then the page says to deploy the previous release; a layout the boot guard
// refuses → the page shows the reason. When the migration completes, `finished` resolves and index.ts starts the app
// on the same port.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import { openDb } from '../db/db';
import { loggerOptions } from '../lib/log';
import { normalizeRecoveryCode, verifySecret } from '../modules/auth/password';
import { detectDataDir, isLegacyDb, type DataDirState } from './layout';
import {
  dataDirPaths,
  idsOf,
  journalNeverStarted,
  journalState,
  migrationStatus,
  MIGRATION_STEPS,
  OwnerMigrationError,
  planOwnerMigration,
  readJournal,
  rollbackOwnerMigration,
  runOwnerMigration,
  stepLabelAr,
  type MigrationRunOptions,
} from './ownerMigration';
import { normalizeUsername } from './repos';

export type BootPlan =
  | { kind: 'app' }
  | { kind: 'maintenance'; start: 'wait' | 'apply' | 'resume' | 'rollback' | 'rolled_back' | 'blocked'; reason?: string; state: DataDirState['kind'] };

/** What the server must do with this data directory before (or instead of) starting the app. */
export function planBoot(config: AppConfig): BootPlan {
  const state = detectDataDir(dataDirPaths(config)).kind;
  const js = journalState(readJournal(config.dataDir));
  if (js === 'rollback_in_progress') return { kind: 'maintenance', start: 'rollback', state };
  if (config.ownerMigration === 'rollback') {
    if (js === 'complete' || js === 'in_progress') return { kind: 'maintenance', start: 'rollback', state };
    if (state === 'legacy_single_owner') return { kind: 'maintenance', start: 'rolled_back', state };
  }
  if (js === 'in_progress') return { kind: 'maintenance', start: 'resume', state };
  // (review) an empty / torn journal beside the owner's database: nothing started — the same as single-owner data
  const neverStarted = state === 'migration_in_progress' && js === 'none' && journalNeverStarted(config);
  if (state === 'legacy_single_owner' || neverStarted) return { kind: 'maintenance', start: config.ownerMigration === 'apply' ? 'apply' : 'wait', state: 'legacy_single_owner' };
  if (state === 'orphan_vaults' || state === 'legacy_beside_multi_user' || state === 'migration_in_progress') {
    // a layout the boot guard refuses: the page shows why (the app would refuse it too, and setup mode never runs)
    const reason =
      state === 'orphan_vaults'
        ? 'مجلد البيانات يحتوي ملفات خزائن بلا قاعدة النظام (system.sqlite). لن يبدأ الخادم إعدادًا جديدًا فوقها؛ استعد قاعدة النظام من النسخة الاحتياطية.'
        : state === 'legacy_beside_multi_user'
          ? 'مجلد البيانات يحتوي نظام الحسابات المتعددة وبجانبه قاعدة مالك واحد (medlevo.sqlite): حالة غير واضحة. أكمل التراجع (MEDLEVO_OWNER_MIGRATION=rollback) أو انقل medlevo.sqlite بعد فحصه.'
          : 'سجل الترقية غير مفهوم؛ لم يُغيَّر شيء. شغّل الأمر --status من Shell لمعرفة الحالة.';
    return { kind: 'maintenance', start: 'blocked', reason, state };
  }
  return { kind: 'app' };
}

type Phase = 'waiting' | 'running' | 'failed' | 'done' | 'rolling_back' | 'rolled_back' | 'blocked';

interface MaintenanceStatus {
  phase: Phase;
  step: string | null;
  label_ar: string | null;
  done?: number;
  total?: number;
  unit?: string;
  error: { code: string; reason_ar: string; retryable: boolean } | null;
  problems_ar: string[];
  blocked_reason_ar: string | null;
}

export interface MaintenanceOptions {
  config: AppConfig;
  plan: Extract<BootPlan, { kind: 'maintenance' }>;
  /** tests: migration tuning (verifyBoot, off-site client) */
  migration?: Partial<Pick<MigrationRunOptions, 'verifyBoot' | 'offsite' | 'hooks' | 'now'>>;
  /** failed sign-ins allowed per address in 15 minutes */
  maxFailures?: number;
}

export interface MaintenanceServer {
  app: FastifyInstance;
  /** resolves when the data directory is a finished multi-user layout (the app may start) */
  finished: Promise<void>;
  status(): MaintenanceStatus;
  close(): Promise<void>;
}

const MAINTENANCE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export const MAINTENANCE_PAGE = '/api/maintenance';
const BUSY_AR = `الخادم قيد الترقية إلى نظام الحسابات المتعددة. بياناتك محفوظة كما هي وما تكتبه يبقى على جهازك. افتح صفحة الترقية لإكمالها: ${MAINTENANCE_PAGE}`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function startMaintenance(o: MaintenanceOptions): Promise<MaintenanceServer> {
  const { config } = o;
  const app = Fastify({ logger: loggerOptions(config.logLevel), trustProxy: config.trustProxy, bodyLimit: 16 * 1024 });
  const st: MaintenanceStatus = { phase: 'waiting', step: null, label_ar: null, error: null, problems_ar: [], blocked_reason_ar: null };
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  const failures = new Map<string, number[]>();
  const maxFailures = o.maxFailures ?? 10;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const finishIfMigrated = () => {
    const s = migrationStatus(config);
    if (s.state === 'multi_user' && s.journal === 'complete') {
      st.phase = 'done';
      st.step = 'complete';
      st.label_ar = stepLabelAr('complete');
      resolveFinished();
      return true;
    }
    return false;
  };

  const run = (mode: 'apply' | 'resume', skipOffsite = false) => {
    st.phase = 'running';
    st.error = null;
    st.problems_ar = [];
    void runOwnerMigration({
      config,
      mode,
      skipOffsite,
      ...o.migration,
      progress: (p) => {
        st.step = p.step;
        st.label_ar = p.label_ar;
        st.done = p.done;
        st.total = p.total;
        st.unit = p.unit;
      },
    }).then(
      () => {
        app.log.info('owner migration complete; starting the app');
        finishIfMigrated();
      },
      (e: unknown) => {
        // another run of this process holds the directory (it reports on its own): nothing to show here
        if (e instanceof OwnerMigrationError && e.code === 'BUSY') return;
        st.phase = migrationStatus(config).state === 'legacy_single_owner' && journalState(readJournal(config.dataDir)) === 'none' ? 'waiting' : 'failed';
        st.error =
          e instanceof OwnerMigrationError
            ? { code: e.code, reason_ar: e.reasonAr, retryable: e.retryable }
            : { code: 'INTERNAL', reason_ar: 'توقفت الترقية بخطأ غير متوقع. لم يُحذف شيء؛ أعد المحاولة أو تراجع. التفاصيل في سجل الخادم.', retryable: true };
        app.log.error({ err: e }, 'owner migration stopped');
      },
    );
  };

  const rollback = () => {
    st.phase = 'rolling_back';
    st.error = null;
    void rollbackOwnerMigration({ config, ...(o.migration?.hooks ? { hooks: o.migration.hooks } : {}) }).then(
      () => {
        st.phase = 'rolled_back';
        app.log.warn('owner migration rolled back: deploy the previous release now');
      },
      (e: unknown) => {
        if (e instanceof OwnerMigrationError && e.code === 'BUSY') return;
        st.phase = 'failed';
        st.error =
          e instanceof OwnerMigrationError
            ? { code: e.code, reason_ar: e.reasonAr, retryable: e.retryable }
            : { code: 'INTERNAL', reason_ar: 'تعذّر التراجع بخطأ غير متوقع. لم يُحذف شيء؛ التفاصيل في سجل الخادم.', retryable: true };
        app.log.error({ err: e }, 'owner migration rollback stopped');
      },
    );
  };

  // ── credentials: the owner row of the database (wherever it is now); a recovery code is checked, not consumed ──
  const ownerRowPath = (): string | null => {
    const ids = idsOf(readJournal(config.dataDir));
    const vault = ids ? join(config.vaultsDir, ids.dbFile) : null;
    if (isLegacyDb(config.dbPath)) return config.dbPath;
    if (vault && existsSync(vault)) return vault;
    return null;
  };
  const checkOwner = async (username: string, secret: string): Promise<boolean> => {
    const path = ownerRowPath();
    if (!path || !secret) return false;
    // a read on a normal connection (a read-only one would leave empty -wal/-shm files behind); nothing is written
    const db = openDb(path);
    let row: { username: string; password_hash: string; recovery_codes_json: string } | undefined;
    try {
      row = db.get(`SELECT username, password_hash, recovery_codes_json FROM owner WHERE id = 'owner'`);
    } catch {
      row = undefined;
    } finally {
      db.close();
    }
    // the password may have been changed after the migration (system DB) — a resumed/rolled-back state checks both
    const candidates: Array<{ username: string; password_hash: string; recovery_codes_json: string }> = row ? [row] : [];
    try {
      if (existsSync(config.systemDbPath)) {
        const sys = openDb(config.systemDbPath);
        try {
          const u = sys.get<{ username: string; password_hash: string; recovery_codes_json: string }>('SELECT username, password_hash, recovery_codes_json FROM user_account WHERE legacy_owner = 1');
          if (u) candidates.push(u);
        } finally {
          sys.close();
        }
      }
    } catch {
      // no system DB yet
    }
    for (const c of candidates) {
      if (normalizeUsername(c.username) !== normalizeUsername(username)) continue;
      if (await verifySecret(secret, c.password_hash)) return true;
      const code = normalizeRecoveryCode(secret);
      for (const h of JSON.parse(c.recovery_codes_json || '[]') as string[]) if (await verifySecret(code, h)) return true;
    }
    return false;
  };

  const sendPage = (reply: FastifyReply, status: number, notice?: { kind: 'error' | 'info'; text: string }) =>
    reply
      .code(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', MAINTENANCE_CSP)
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      // (R1-b final) not `no-referrer`: under it a browser posts this page's forms with `Origin: null`, which guardPost
      // refuses — the owner could not start the migration from the page (test/tenancy/maintenance-form.r1b.test.ts)
      .header('referrer-policy', 'same-origin')
      .header('x-content-type-options', 'nosniff')
      .send(renderPage(st, config, notice));

  const guardPost = (req: FastifyRequest): string | null => {
    const origin = req.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) return 'رُفض الطلب لأنه صادر من أصل غير مسموح.';
    if (req.headers['sec-fetch-site'] === 'cross-site') return 'رُفض الطلب لأنه صادر من موقع آخر.';
    return null;
  };
  const ipOf = (req: FastifyRequest) => req.ip ?? 'unknown';
  const slowed = (ip: string) => {
    const now = Date.now();
    const list = (failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    failures.set(ip, list);
    return list.length >= maxFailures;
  };
  const authorize = async (req: FastifyRequest, reply: FastifyReply, needConfirm: boolean): Promise<boolean> => {
    const bad = guardPost(req);
    if (bad) {
      await sendPage(reply, 403, { kind: 'error', text: bad });
      return false;
    }
    const ip = ipOf(req);
    if (slowed(ip)) {
      await sendPage(reply, 429, { kind: 'error', text: 'محاولات كثيرة خاطئة. انتظر ربع ساعة ثم أعد المحاولة.' });
      return false;
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const username = String(body.username ?? '').slice(0, 64);
    const secret = String(body.password ?? '').slice(0, 256);
    if (!(await checkOwner(username, secret))) {
      failures.get(ip)!.push(Date.now());
      await sendPage(reply, 401, { kind: 'error', text: 'اسم المستخدم أو كلمة المرور (أو رمز الاسترداد) غير صحيح. هي نفسها التي تدخل بها التطبيق اليوم.' });
      return false;
    }
    if (needConfirm && body.confirm !== 'yes') {
      await sendPage(reply, 400, { kind: 'error', text: 'اختر «نعم، ابدأ» للتأكيد.' });
      return false;
    }
    return true;
  };

  app.get('/api/health', async () => ({ ok: true, version: config.appVersion, time: Date.now(), maintenance: true, phase: st.phase }));
  app.get('/api/auth/status', async () => ({
    setup_required: false,
    authenticated: false,
    owner: null,
    session: null,
    password_min_length: config.auth.passwordMinLength,
    maintenance: true,
  }));
  app.get(`${MAINTENANCE_PAGE}/status.json`, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ...st, journal: migrationStatus(config).lines.map((l) => ({ step: l.step, status: l.status, at: l.at })) };
  });
  app.get(MAINTENANCE_PAGE, async (_req, reply) => sendPage(reply, 200));

  // (review) every action re-checks the phase AFTER the (slow) password check: a double tap on a button sent two
  // requests that both passed the first check, and two runners (or a run and a rollback) worked on the same directory
  const notWaiting = (reply: FastifyReply) => sendPage(reply, 409, { kind: 'info', text: 'الترقية ليست في حالة الانتظار الآن.' });
  const nothingToRetry = (reply: FastifyReply) => sendPage(reply, 409, { kind: 'info', text: 'لا توجد ترقية متوقفة لإعادتها (ربما بدأت للتو من طلب آخر).' });
  const rollbackNotNow = (reply: FastifyReply) =>
    sendPage(reply, 409, { kind: 'info', text: 'التراجع متاح هنا فقط بعد توقف الترقية. بعد اكتمالها: المتغير MEDLEVO_OWNER_MIGRATION=rollback.' });

  app.post(`${MAINTENANCE_PAGE}/start`, async (req, reply) => {
    if (st.phase !== 'waiting') return notWaiting(reply);
    if (!(await authorize(req, reply, true))) return reply;
    if (st.phase !== 'waiting') return notWaiting(reply);
    const plan = planOwnerMigration(config);
    if (!plan.can_apply) {
      st.problems_ar = plan.problems_ar;
      return sendPage(reply, 409, { kind: 'error', text: 'لا يمكن بدء الترقية الآن؛ الأسباب أدناه. لم يتغير شيء.' });
    }
    run('apply');
    return reply.code(303).header('location', MAINTENANCE_PAGE).send();
  });
  app.post(`${MAINTENANCE_PAGE}/retry`, async (req, reply) => {
    if (st.phase !== 'failed' && st.phase !== 'waiting') return nothingToRetry(reply);
    if (!(await authorize(req, reply, false))) return reply;
    if (st.phase !== 'failed' && st.phase !== 'waiting') return nothingToRetry(reply);
    const body = (req.body ?? {}) as Record<string, string>;
    const mode = journalState(readJournal(config.dataDir)) === 'in_progress' ? 'resume' : 'apply';
    run(mode, body.skip_offsite === 'yes');
    return reply.code(303).header('location', MAINTENANCE_PAGE).send();
  });
  app.post(`${MAINTENANCE_PAGE}/rollback`, async (req, reply) => {
    if (st.phase !== 'failed') return rollbackNotNow(reply);
    if (!(await authorize(req, reply, true))) return reply;
    if (st.phase !== 'failed') return rollbackNotNow(reply);
    rollback();
    return reply.code(303).header('location', MAINTENANCE_PAGE).send();
  });

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (path === '/api' || path.startsWith('/api/')) {
      return reply
        .code(503)
        .header('retry-after', '60')
        .header('cache-control', 'no-store')
        .send({ error: { code: 'FEATURE_DISABLED', message: BUSY_AR, details: { maintenance: true, page: MAINTENANCE_PAGE } } });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return sendPage(reply, 503);
    return reply.code(503).header('retry-after', '60').send({ error: { code: 'FEATURE_DISABLED', message: BUSY_AR } });
  });

  // the boot decision
  switch (o.plan.start) {
    case 'apply':
      run('apply');
      break;
    case 'resume':
      run('resume');
      break;
    case 'rollback':
      rollback();
      break;
    case 'rolled_back':
      st.phase = 'rolled_back';
      break;
    case 'blocked':
      st.phase = 'blocked';
      st.blocked_reason_ar = o.plan.reason ?? null;
      break;
    default:
      st.phase = 'waiting';
  }
  await app.ready();
  return {
    app,
    finished,
    status: () => ({ ...st }),
    close: () => app.close(),
  };
}


function renderPage(st: MaintenanceStatus, config: AppConfig, notice?: { kind: 'error' | 'info'; text: string }): string {
  const lines = readJournal(config.dataDir);
  const doneSteps = new Set(lines.filter((l) => l.status === 'done').map((l) => l.step));
  const refresh = st.phase === 'running' || st.phase === 'rolling_back' || st.phase === 'done' ? '<meta http-equiv="refresh" content="4">' : '';
  const credentials = (submitLabel: string, extra = '') => `
      <label for="u">اسم المستخدم</label>
      <input id="u" name="username" autocomplete="username" required dir="auto">
      <label for="p">كلمة المرور الحالية، أو أحد رموز الاسترداد</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required dir="auto">
      ${extra}
      <button type="submit">${esc(submitLabel)}</button>`;
  const confirm = (text: string) => `<label class="check"><input type="checkbox" name="confirm" value="yes" required> ${esc(text)}</label>`;
  const stepsList = `<ol class="steps">${MIGRATION_STEPS.map((s) => {
    const mark = doneSteps.has(s) ? '✓' : st.step === s ? '…' : '·';
    return `<li class="${doneSteps.has(s) ? 'done' : st.step === s ? 'now' : ''}"><span aria-hidden="true">${mark}</span> ${esc(stepLabelAr(s))}</li>`;
  }).join('')}</ol>`;
  const progress =
    st.phase === 'running' && st.total
      ? `<p class="count">${esc(st.label_ar ?? '')}: ${st.unit === 'bytes' ? `${Math.floor((st.done ?? 0) / 1048576)} من ${Math.ceil(st.total / 1048576)} م.ب` : `${st.done ?? 0} من ${st.total}`}</p>`
      : st.label_ar
        ? `<p class="count">${esc(st.label_ar)}</p>`
        : '';
  let body = '';
  switch (st.phase) {
    case 'waiting':
      body = `
    <h1>الترقية لم تكتمل بعد</h1>
    <p>حُدّث الخادم إلى إصدار يدعم عدة حسابات. <strong>بياناتك كلها في مكانها ولم يتغير منها شيء.</strong> قبل أن يعمل التطبيق تُنقل قاعدة بياناتك كما هي — بايتًا ببايت — إلى خزنة حسابك (الحساب رقم 1):</p>
    <ul>
      <li>تُنشأ أولًا نسخة احتياطية كاملة ويُتحقق من استعادتها${config.offsite.configured ? '، وتُرفع منها نسخة مشفرة إلى R2' : ''}.</li>
      <li>كلمة المرور نفسها ورموز الاسترداد نفسها؛ أجهزتك المسجّلة تبقى مسجّلة، وما كتبته دون اتصال يُرسل بعد الترقية.</li>
      <li>تستغرق دقائق حسب حجم ملفاتك. إن انقطع شيء تُستأنف من آخر خطوة، ويمكن التراجع عنها.</li>
    </ul>
    ${st.problems_ar.length ? `<div class="box error"><p>لا يمكن البدء:</p><ul>${st.problems_ar.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <form method="post" action="${MAINTENANCE_PAGE}/start">
      ${credentials('ابدأ الترقية', confirm('نعم، ابدأ: أنشئ النسخة الاحتياطية ثم انقل بياناتي إلى الحساب رقم 1'))}
    </form>`;
      break;
    case 'running':
      body = `
    <h1>جارٍ نقل بياناتك</h1>
    <p>لا تحتاج إلى إبقاء هذه الصفحة مفتوحة؛ يستمر العمل على الخادم. تتحدث الصفحة وحدها.</p>
    ${progress}${stepsList}`;
      break;
    case 'done':
      body = `
    <h1>اكتملت الترقية</h1>
    <p>بياناتك الآن في خزنة الحساب رقم 1، والبصمة مطابقة للأصل. يبدأ التطبيق خلال ثوانٍ.</p>
    ${stepsList}
    <p><a class="button" href="/">افتح التطبيق</a></p>
    <p class="small">إن ظهر لك إشعار «تحديث» في التطبيق فاضغطه: النسخة القديمة من التطبيق على جهازك تحتاج إلى التحديث.</p>`;
      break;
    case 'failed':
      body = `
    <h1>توقفت الترقية</h1>
    <div class="box error"><p>${esc(st.error?.reason_ar ?? 'توقفت بخطأ غير متوقع.')}</p><p class="small">(${esc(st.error?.code ?? '')})</p></div>
    ${
      journalState(lines) === 'complete'
        ? // (review) a rollback asked by MEDLEVO_OWNER_MIGRATION=rollback was refused after a COMPLETE migration: the data is
          // in the vault (not «in its old place»), and only removing the variable lets the app start again
          `<p>لم يُحذف شيء. الترقية مكتملة وبياناتك في خزنة الحساب رقم 1 كما هي.</p>
    <p>ليعمل التطبيق من جديد: Render ← Environment ← احذف المتغير MEDLEVO_OWNER_MIGRATION ← Save. للعودة إلى ما قبل الترقية في هذه الحالة استعد النسخة الاحتياطية المأخوذة قبلها (دليل التشغيل: «التراجع عن الترقية بعد اكتمالها»).</p>`
        : `<p>لم يُحذف شيء. ${journalState(lines) === 'in_progress' ? 'يمكنك إعادة المحاولة من آخر خطوة مكتملة، أو التراجع لتعود بياناتك كما كانت.' : 'بياناتك ما زالت في مكانها القديم كما هي.'}</p>
    ${stepsList}
    <form method="post" action="${MAINTENANCE_PAGE}/retry">
      <h2>إعادة المحاولة</h2>
      ${credentials('أعد المحاولة', st.error?.code === 'OFFSITE_FAILED' ? `<label class="check"><input type="checkbox" name="skip_offsite" value="yes"> تابع دون نسخة R2 (النسخة المحلية المتحقق منها موجودة)</label>` : '')}
    </form>`
    }
    ${journalState(lines) === 'in_progress' ? `<form method="post" action="${MAINTENANCE_PAGE}/rollback"><h2>التراجع</h2>${credentials('تراجع عن الترقية', confirm('نعم، أعد بياناتي إلى نظام المالك الواحد'))}</form>` : ''}`;
      break;
    case 'rolling_back':
      body = `<h1>جارٍ التراجع عن الترقية</h1><p>تعود قاعدة بياناتك إلى مكانها القديم كما هي.</p>`;
      break;
    case 'rolled_back':
      body = `
    <h1>تم التراجع عن الترقية</h1>
    <p>عادت قاعدة بياناتك إلى مكانها القديم (medlevo.sqlite) ومعها كل ما كتبته بعد الترقية، وحُفظت ملفات نظام الحسابات جانبًا دون حذف.</p>
    <p>الآن انشر الإصدار السابق: من لوحة Render افتح Events، واختر النشر الذي سبق الترقية، ثم Rollback. بعدها احذف المتغير MEDLEVO_OWNER_MIGRATION من صفحة Environment.</p>`;
      break;
    case 'blocked':
      body = `
    <h1>لا يعمل الخادم على مجلد البيانات هذا</h1>
    <div class="box error"><p>${esc(st.blocked_reason_ar ?? 'حالة مجلد البيانات غير مفهومة.')}</p></div>
    <p>لم يُغيَّر أي ملف. لن يبدأ الخادم إعدادًا جديدًا فوق بيانات موجودة.</p>`;
      break;
  }
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>ترقية MedLevo</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #5b5b57; --card: #ffffff; --line: #c9c9c3; --accent: #0b5cad; --err-bg: #fdecea; --err-fg: #8a1c12; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ececea; --muted: #b3b3ad; --card: #20201e; --line: #4a4a46; --accent: #7db4f0; --err-bg: #3a1c19; --err-fg: #ffb4a8; } }
  @media (prefers-contrast: more) { :root { --line: currentColor; --muted: var(--fg); } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.7 system-ui, "Segoe UI", Tahoma, sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; overflow-wrap: anywhere; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; } h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; }
  form { display: grid; gap: .5rem; margin-block-start: 1rem; }
  label { font-weight: 600; } label.check { font-weight: 400; display: flex; gap: .6rem; align-items: center; min-height: 44px; }
  input[type=checkbox] { inline-size: 24px; block-size: 24px; flex: none; }
  input:not([type=checkbox]) { min-height: 44px; font: inherit; padding: .4rem .7rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
  button, a.button { min-height: 44px; min-width: 44px; font: inherit; font-weight: 700; padding: .5rem 1.2rem; border-radius: 8px; border: 2px solid var(--accent); background: var(--accent); color: var(--card); cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
  .box.error { background: var(--err-bg); color: var(--err-fg); border-radius: 8px; padding: .75rem 1rem; margin-block: 1rem; }
  .steps { padding-inline-start: 1.25rem; } .steps li.done { color: var(--muted); } .steps li.now { font-weight: 700; }
  .count { font-weight: 600; } .small { font-size: .9rem; color: var(--muted); }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <div class="card">
    ${notice ? `<div class="box ${notice.kind === 'error' ? 'error' : ''}" role="alert"><p>${esc(notice.text)}</p></div>` : ''}
    ${body}
  </div>
  <p class="small">MedLevo ${esc(config.appVersion)} — صفحة الترقية. لا تعرض هذه الصفحة شيئًا من بياناتك.</p>
</main>
</body>
</html>`;
}
