// Client error sink (§56 error tracking). The browser batches uncaught errors / unhandled rejections / route errors,
// REDACTS them (packages/shared quality-api.ts: no document text, no query strings, no tokens, stack frames reduced to
// code locations) and POSTs them here with the owner's session. The server redacts AGAIN (never trusts the client),
// groups by fingerprint with a count, and keeps them 30 days after the last occurrence, at most 500 rows.
import { createHash } from 'node:crypto';
import {
  CLIENT_ERROR_MAX_ROWS,
  CLIENT_ERROR_RETENTION_DAYS,
  redactClientError,
  type ClientErrorBatchResponse,
  type ClientErrorKind,
  type ClientErrorReport,
  type ClientErrorView,
  type ClientErrorsResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { newId } from '../../lib/ids';

const DAY = 24 * 3600 * 1000;
export const MAX_BATCH = 20;

/** «Chrome 131», «Firefox 133», «Safari 18» — never the full user-agent string. */
export function browserFamily(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, 'Safari') ??
    (/(iPhone|iPad)/.test(ua) ? 'iOS WebView' : 'other')
  );
}

function fingerprint(r: { kind: string; message: string; stack: string | null }): string {
  // the first frame locates the code; digits in the message (counts, ids) do not split one problem into many
  const frame = r.stack?.split('\n')[0] ?? '';
  return createHash('sha256').update(`${r.kind}\n${r.message.replace(/\d+/g, '#')}\n${frame}`).digest('hex').slice(0, 40);
}

export function pruneClientErrors(ctx: AppContext): number {
  const cutoff = ctx.clock.now() - CLIENT_ERROR_RETENTION_DAYS * DAY;
  let n = ctx.db.run('DELETE FROM client_error WHERE last_seen_at < ?', [cutoff]).changes;
  const extra = ctx.db.all<{ id: string }>('SELECT id FROM client_error ORDER BY last_seen_at DESC, id DESC LIMIT -1 OFFSET ?', [CLIENT_ERROR_MAX_ROWS]);
  for (const r of extra) n += ctx.db.run('DELETE FROM client_error WHERE id = ?', [r.id]).changes;
  return n;
}

export function storeClientErrors(ctx: AppContext, reports: ClientErrorReport[], userAgent: string | undefined): ClientErrorBatchResponse {
  const now = ctx.clock.now();
  const ua = browserFamily(userAgent);
  let stored = 0;
  const dropped = Math.max(0, reports.length - MAX_BATCH);
  ctx.db.tx(() => {
    for (const raw of reports.slice(0, MAX_BATCH)) {
      const r = redactClientError(raw);
      const fp = fingerprint(r);
      ctx.db.run(
        `INSERT INTO client_error (id, fingerprint, kind, message, stack, route, app_version, user_agent, count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET count = client_error.count + excluded.count, last_seen_at = excluded.last_seen_at,
           route = excluded.route, app_version = excluded.app_version, user_agent = excluded.user_agent`,
        [newId(now), fp, r.kind, r.message, r.stack, r.route, r.app_version, ua, r.count, now, now],
      );
      stored++;
    }
    pruneClientErrors(ctx);
  });
  return { stored, dropped };
}

interface Row {
  id: string;
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  route: string | null;
  app_version: string | null;
  user_agent: string | null;
  count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export const CLIENT_ERROR_RETENTION_AR = `تُحفظ أخطاء الواجهة ${CLIENT_ERROR_RETENTION_DAYS} يومًا بعد آخر ظهور، وبحد أقصى ${CLIENT_ERROR_MAX_ROWS} خطأ مختلف. تُنقّى قبل الإرسال وعلى الخادم: لا نص من ملفاتك أو ملاحظاتك، ولا عناوين بحث، ولا رموز أو مفاتيح؛ يبقى نوع الخطأ ورسالته المختصرة ومواضع الشيفرة والصفحة.`;

export function listClientErrors(ctx: AppContext, limit = 100): ClientErrorsResponse {
  pruneClientErrors(ctx);
  const items = ctx.db.all<Row>('SELECT * FROM client_error ORDER BY last_seen_at DESC, id DESC LIMIT ?', [limit]) as ClientErrorView[];
  const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM client_error')!.n;
  return { items, total, retention_ar: CLIENT_ERROR_RETENTION_AR };
}

export function clearClientErrors(ctx: AppContext): number {
  return ctx.db.run('DELETE FROM client_error').changes;
}
