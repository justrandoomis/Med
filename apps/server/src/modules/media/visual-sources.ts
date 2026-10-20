// Round 7 H4 (§32 «أنشئ سجلًا للمصادر البصرية التي أسمح بها»): the owner's registry of external visual sources.
// Owner-managed: name, domain (+ optional atlas path), the owner's licence note, enabled. Used by
//   * validateImageCandidate (check `allowed_source`): an external candidate is accepted only from an ENABLED entry;
//   * assertExternalFetchAllowed: the gate any future fetch must pass — the server switch MEDLEVO_ALLOW_EXTERNAL_FETCH
//     AND an enabled entry. No image provider exists in this version, so nothing is fetched (the list says so).
// Entries are owner data (in the full JSON export and the backup); every change is in the change log.
import {
  VISUAL_SOURCE_KIND_LABELS_AR,
  visualSourceCreateSchema,
  visualSourcePatchSchema,
  type VisualSourceKind,
  type VisualSourceListResponse,
  type VisualSourceView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { matchAllowedSource, type AllowedVisualSource } from './validate-image';

interface Row {
  id: string;
  name: string;
  domain: string;
  path_prefix: string | null;
  kind: VisualSourceKind;
  licence_note: string | null;
  enabled: number;
  note: string | null;
  created_at: number;
  updated_at: number;
}

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.test', '.invalid', '.example'];

const bad = (msg: string) => new AppError('VALIDATION_FAILED', msg, 400);

/** «https://www.Example.org/cases/x?y» → { domain: 'example.org', path: '/cases/x' }; a public host name only. */
export function normalizeDomain(input: string): { domain: string; path: string | null } {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw bad('النطاق غير صالح: اكتب اسم موقع مثل example.org.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('يُقبل موقع ويب فقط (http أو https).');
  if (u.username || u.password) throw bad('لا تكتب اسم مستخدم أو كلمة مرور في عنوان المصدر.');
  if (u.port) throw bad('اكتب النطاق دون رقم منفذ.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) throw bad('اكتب اسم نطاق وليس عنوان IP.');
  if (!HOST_RE.test(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) || host === 'localhost') throw bad('النطاق غير صالح: اكتب اسم موقع عام مثل example.org.');
  const path = u.pathname && u.pathname !== '/' ? safePath(u.pathname) : null;
  return { domain: host, path };
}

function safePath(p: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    throw bad('مسار الأطلس غير صالح.');
  }
  const path = decoded.startsWith('/') ? decoded : `/${decoded}`;
  // eslint-disable-next-line no-control-regex -- a path never carries control characters
  if (path.includes('..') || /[\u0000-\u001f?#\\]/.test(path) || path.length > 200) throw bad('مسار الأطلس غير صالح.');
  return path;
}

function view(r: Row): VisualSourceView {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    path_prefix: r.path_prefix,
    kind: r.kind,
    kind_label_ar: VISUAL_SOURCE_KIND_LABELS_AR[r.kind] ?? VISUAL_SOURCE_KIND_LABELS_AR.other,
    licence_note: r.licence_note,
    enabled: r.enabled === 1,
    note: r.note,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getRow(ctx: AppContext, id: string): Row {
  const r = ctx.db.get<Row>('SELECT * FROM visual_source WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'هذا المصدر البصري غير موجود في سجلك.', 404);
  return r;
}

function assertUnique(ctx: AppContext, domain: string, path: string | null, exceptId: string | null): void {
  const dup = ctx.db.get<{ id: string; name: string }>(`SELECT id, name FROM visual_source WHERE domain = ? AND COALESCE(path_prefix, '') = ? AND id <> ?`, [domain, path ?? '', exceptId ?? '']);
  if (dup) throw new AppError('CONFLICT', `هذا النطاق مسجّل مسبقًا باسم «${dup.name}».`, 409);
}

/** The server switch and the provider: what would actually be fetched (nothing in this version). */
export function fetchState(ctx: AppContext): VisualSourceListResponse['fetch'] {
  return ctx.config.allowExternalFetch
    ? { server_allows: true, provider_available: false, state: 'not_implemented', reason_ar: 'الجلب من الإنترنت مسموح على الخادم، لكن لا يوجد مزود بحث عن الصور في هذا الإصدار؛ لا يُجلب شيء. أي مزود مستقبلي يجلب من المصادر المفعّلة هنا فقط.' }
    : { server_allows: false, provider_available: false, state: 'disabled', reason_ar: 'الجلب من الإنترنت معطّل على الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH)، ولا يوجد مزود بحث عن الصور؛ لا يُجلب شيء من هذه المصادر. السجل يحدد ما يُقبل إن وُجدت صورة خارجية.' };
}

export function listVisualSources(ctx: AppContext): VisualSourceListResponse {
  const rows = ctx.db.all<Row>('SELECT * FROM visual_source ORDER BY enabled DESC, name COLLATE NOCASE, id');
  return {
    items: rows.map(view),
    fetch: fetchState(ctx),
    notes_ar: [
      'صورة خارجية تُقبل مثالًا فقط إن كان رابطها الأصلي من مصدر مفعّل هنا (النطاق أو نطاق فرعي منه، ومسار الأطلس إن حددته)، ثم تمر ببقية فحوص المطابقة.',
      'ملاحظة الترخيص تكتبها أنت للتذكير بشروط الاستخدام؛ MedLevo لا يتحقق من التراخيص.',
      'صور مصادرك تُعرض أولًا دائمًا؛ هذا السجل للصور الخارجية فقط.',
    ],
  };
}

/** ENABLED entries, for the validator and any future fetch. */
export function enabledVisualSources(ctx: AppContext): AllowedVisualSource[] {
  return ctx.db.all<AllowedVisualSource>('SELECT id, name, domain, path_prefix FROM visual_source WHERE enabled = 1 ORDER BY id');
}

export function createVisualSource(ctx: AppContext, body: unknown): VisualSourceView {
  const b = parseWith(visualSourceCreateSchema, body, 'body');
  const { domain, path } = normalizeDomain(b.domain);
  const pathPrefix = b.path_prefix ? safePath(b.path_prefix) : path;
  assertUnique(ctx, domain, pathPrefix, null);
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO visual_source (id, name, domain, path_prefix, kind, licence_note, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.name, domain, pathPrefix, b.kind, b.licence_note || null, b.enabled ? 1 : 0, b.note || null, now, now],
    );
    ctx.audit.record({ entityType: 'visual_source', entityId: id, action: 'create', summary: `أضفت مصدرًا بصريًا مسموحًا: ${b.name} (${domain})`, after: { name: b.name, domain, path_prefix: pathPrefix, enabled: b.enabled } });
  });
  return view(getRow(ctx, id));
}

export function patchVisualSource(ctx: AppContext, id: string, body: unknown): VisualSourceView {
  const before = getRow(ctx, id);
  const b = parseWith(visualSourcePatchSchema, body, 'body');
  let domain = before.domain;
  let pathPrefix = before.path_prefix;
  if (b.domain !== undefined) {
    const n = normalizeDomain(b.domain);
    domain = n.domain;
    if (b.path_prefix === undefined) pathPrefix = n.path;
  }
  if (b.path_prefix !== undefined) pathPrefix = b.path_prefix ? safePath(b.path_prefix) : null;
  assertUnique(ctx, domain, pathPrefix, id);
  const next: Row = {
    ...before,
    name: b.name ?? before.name,
    domain,
    path_prefix: pathPrefix,
    kind: b.kind ?? before.kind,
    licence_note: b.licence_note === undefined ? before.licence_note : b.licence_note || null,
    enabled: b.enabled === undefined ? before.enabled : b.enabled ? 1 : 0,
    note: b.note === undefined ? before.note : b.note || null,
    updated_at: ctx.clock.now(),
  };
  ctx.db.tx(() => {
    ctx.db.run(`UPDATE visual_source SET name = ?, domain = ?, path_prefix = ?, kind = ?, licence_note = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`, [
      next.name,
      next.domain,
      next.path_prefix,
      next.kind,
      next.licence_note,
      next.enabled,
      next.note,
      next.updated_at,
      id,
    ]);
    const toggled = before.enabled !== next.enabled;
    ctx.audit.record({
      entityType: 'visual_source',
      entityId: id,
      action: toggled ? (next.enabled ? 'enable' : 'disable') : 'update',
      summary: toggled ? `${next.enabled ? 'فعّلت' : 'عطّلت'} المصدر البصري ${next.name}` : `عدّلت المصدر البصري ${next.name}`,
      before: { name: before.name, domain: before.domain, path_prefix: before.path_prefix, enabled: before.enabled === 1 },
      after: { name: next.name, domain: next.domain, path_prefix: next.path_prefix, enabled: next.enabled === 1 },
    });
  });
  return view(getRow(ctx, id));
}

export function deleteVisualSource(ctx: AppContext, id: string): void {
  const before = getRow(ctx, id);
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM visual_source WHERE id = ?', [id]);
    ctx.audit.record({ entityType: 'visual_source', entityId: id, action: 'delete', summary: `حذفت المصدر البصري ${before.name} من السجل`, before: { name: before.name, domain: before.domain, path_prefix: before.path_prefix } });
  });
}

/**
 * The gate any future external image fetch must pass: the server switch AND an enabled registry entry. Returns the
 * entry. (No fetch is made in this version — there is no image provider; the SSRF guard still applies to any fetch.)
 */
export function assertExternalFetchAllowed(ctx: AppContext, url: string): AllowedVisualSource {
  if (!ctx.config.allowExternalFetch) throw new AppError('FEATURE_DISABLED', 'جلب الصور من الإنترنت معطّل في إعدادات الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH).', 409);
  const hit = matchAllowedSource(url, enabledVisualSources(ctx));
  if (!hit) throw new AppError('FORBIDDEN', 'هذا الرابط ليس من مصدر بصري سمحت به (أو أن مصدره معطّل)؛ لا يُجلب.', 403);
  return hit;
}
