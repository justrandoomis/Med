// First-run setup token (track D1, §49 hardening). Before the owner account exists, whoever reaches the server
// first could claim it. When the server is reachable beyond this machine — it listens on a non-loopback address,
// sits behind a reverse proxy (MEDLEVO_TRUST_PROXY), or its configured web origin (MEDLEVO_ORIGIN) is not a
// loopback address (a proxy / tunnel / port-forward in front of a loopback listener) — POST /api/auth/setup
// requires a setup token:
//   * MEDLEVO_SETUP_TOKEN from the environment (also makes the token required on loopback), or
//   * a one-time token generated at boot and printed to the server log. Only its sha256 is kept, in memory;
//     it is never stored in the database and a restart prints a new one.
// Loopback-only servers (the default 127.0.0.1) keep today's flow: no token.
import { createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../../context';
import { safeEqual } from '../../lib/hash';

export interface SetupTokenOptions {
  /** explicit token (tests). undefined → process.env.MEDLEVO_SETUP_TOKEN */
  setupToken?: string | null;
  /** receives a generated one-time token (tests). Default: printed to the server log at boot. */
  announceSetupToken?: (token: string) => void;
}

export interface SetupTokenGate {
  /** setup needs a token right now */
  readonly required: boolean;
  check(supplied: string | undefined): boolean;
  /** forget the one-time token after a successful setup */
  consume(): void;
  reasonAr(): string;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127(\.\d{1,3}){3}$/.test(h);
}

const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 (easy to copy from a log)

function generateToken(): string {
  const bytes = randomBytes(20);
  let s = '';
  for (const b of bytes) s += BASE32[b % 32];
  return s.match(/.{4}/g)!.join('-');
}

const normalizeGenerated = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

export function createSetupTokenGate(ctx: AppContext, opts: SetupTokenOptions & { ownerExists: boolean }): SetupTokenGate {
  const envToken = opts.setupToken !== undefined ? opts.setupToken?.trim() || null : process.env.MEDLEVO_SETUP_TOKEN?.trim() || null;
  // a non-loopback web origin means the app is meant to be opened from elsewhere, even if the listener is loopback
  const publicOrigin = ctx.config.allowedOrigins.find((o) => {
    try {
      return !isLoopbackHost(new URL(o).hostname);
    } catch {
      return false;
    }
  });
  const exposed = !isLoopbackHost(ctx.config.host) || ctx.config.trustProxy || publicOrigin !== undefined;
  const required = envToken !== null || exposed;
  let generatedHash: string | null = null;

  if (required && envToken === null && !opts.ownerExists) {
    const token = generateToken();
    generatedHash = sha(normalizeGenerated(token));
    if (opts.announceSetupToken) opts.announceSetupToken(token);
    else {
      const msg =
        `MedLevo first-run setup: no owner account exists and this server is reachable beyond this machine (host ${ctx.config.host}` +
        `${ctx.config.trustProxy ? ', behind a proxy' : ''}${publicOrigin ? `, web origin ${publicOrigin}` : ''}). Creating the owner requires this one-time setup token: ${token} ` +
        '(it is not stored anywhere; restarting the server prints a new one). Set MEDLEVO_SETUP_TOKEN to choose your own.';
      ctx.log.warn(msg);
      if (ctx.config.logLevel === 'silent' && ctx.config.env !== 'test') process.stderr.write(`${msg}\n`);
    }
  }

  return {
    get required() {
      return required;
    },
    check(supplied) {
      if (!required) return true;
      if (typeof supplied !== 'string' || supplied.trim() === '') return false;
      if (envToken !== null) return safeEqual(supplied.trim(), envToken);
      if (!generatedHash) return false;
      return safeEqual(sha(normalizeGenerated(supplied)), generatedHash);
    },
    consume() {
      generatedHash = null;
    },
    reasonAr() {
      return envToken !== null
        ? 'رمز الإعداد غير صحيح أو مفقود. أدخل قيمة MEDLEVO_SETUP_TOKEN المضبوطة على الخادم.'
        : 'رمز الإعداد غير صحيح أو مفقود. الخادم متاح من الشبكة، لذلك يطلب الإعداد الأول رمزًا لمرة واحدة مطبوعًا في سجل تشغيل الخادم.';
    },
  };
}
