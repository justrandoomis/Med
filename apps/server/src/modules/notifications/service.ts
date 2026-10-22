// The notifications service (P1-T4 step 2; ARCHITECTURE_DELTA §4.1 `2200_notifications`, §7.12, §12; PRD AOS-18.13,
// 21.31, 5.18 Phase 1 part). One instance per application context (`notificationsOf(ctx)`), shared by the plugin (the
// inbox routes), the channels and moderation modules, and P1-T5 (new lectures and versions, subject events, followed
// publications, re-anchor reports) — every one of them calls `publish()`:
//   * the content is validated with the STRICT per-kind schema (titles and counts only; an unknown field throws before
//     anything is written) after every title went through `notificationTitle` (bidi controls out, one line, ≤ 200);
//   * the actor is dropped for the kinds that never name one (a moderation outcome never names the reporter);
//   * one fan-out row is written (in the caller's transaction, `dedupe_key` unique) and the worker is poked — the caller
//     never walks the audience.
// The inbox shows a row only while its reader may still open what it is about (access.ts), counts only those, and marks
// only the reader's own rows read. This file is the only one of the module that holds the system DB handle
// (test/tenancy/import-boundary.test.ts lists it).
import {
  type MarkNotificationsReadRequest,
  type MarkNotificationsReadResponse,
  NOTIFICATION_KIND_LABELS_AR,
  NOTIFICATION_KINDS,
  NOTIFICATION_KINDS_WITHOUT_ACTOR,
  type NotificationContent,
  notificationContentSchema,
  type NotificationKind,
  type NotificationPrefsResponse,
  type NotificationsQuery,
  type NotificationsResponse,
  type NotificationTarget,
  notificationTitle,
  type NotificationView,
  type PutNotificationPrefsRequest,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { Viewer } from '../../system/binding';
import { userRef } from '../channels/views';
import { accessMemo, NOTIFICATION_ACCESS, type NotificationAccess } from './access';
import { type AudiencePager, Audiences, type AudienceSpec, MAX_EXPLICIT_RECIPIENTS } from './audiences';
import { NotificationFanout } from './fanout';
import { notificationText } from './render';

export type { AudienceSpec, AudiencePager } from './audiences';
export type { NotificationAccess } from './access';

/** Where the notified-about object lives; `space_id` only for db 'space'. */
export interface NotificationTargetInput {
  db: 'system' | 'vault' | 'space';
  space_id?: string | null;
  type: string;
  id: string;
}

export interface PublishInput {
  /** kind + payload (titles may be raw: they are cleaned here) */
  content: NotificationContent;
  /** who caused it (ignored for NOTIFICATION_KINDS_WITHOUT_ACTOR) */
  actorUserId?: string | null;
  target?: NotificationTargetInput | null;
  /** in-app route it opens; default per kind */
  link?: string | null;
  /** what a recipient must still be allowed to see it (default per kind) */
  access?: NotificationAccess;
  /** the node `access` is checked on (required unless access is 'self') */
  scopeNodeId?: string | null;
  /** one event = one key: the same key again is no new fan-out, and nobody gets the row twice */
  dedupeKey: string;
  audience: AudienceSpec;
  /** never told (e.g. the actor, the author of a reported item) */
  exclude?: readonly string[];
}

/** Who must still be allowed to open the subject of a kind (unless the caller says otherwise). */
export const DEFAULT_ACCESS: Record<NotificationKind, NotificationAccess> = {
  join_requested: 'manage_members',
  join_decided: 'self',
  invitation: 'self',
  official_lecture_new: 'member',
  official_version: 'member',
  subject_update: 'member',
  publication_updated: 'member',
  moderation: 'self',
  report_received: 'moderate',
  reanchor_ready: 'self',
  quota_warning: 'self',
};

const TITLE_FIELDS = new Set(['node_title', 'subject_title', 'lecture_title', 'title', 'publication_title', 'target_title']);
const LINK_RE = /^\/[A-Za-z0-9/_?=&.%-]{0,511}$/;

/** Whether a link may ride on a notification (an in-app path); callers drop any other link instead of failing. */
export function isNotificationLink(link: string | null | undefined): link is string {
  return typeof link === 'string' && LINK_RE.test(link);
}
const DEDUPE_RE = /^[A-Za-z0-9_.:@|-]{1,200}$/;
const WITHOUT_ACTOR = new Set<string>(NOTIFICATION_KINDS_WITHOUT_ACTOR);
const PUSH_UNAVAILABLE_AR =
  'الإشعارات خارج التطبيق غير مفعّلة على هذا الخادم بعد (لا توجد مفاتيح إرسال، ولم تُجرَّب على جهاز). تصلك كل التنبيهات في «التنبيهات» داخل التطبيق. على iPhone وiPad تحتاج هذه الإشعارات أيضًا تثبيت التطبيق على الشاشة الرئيسية.';

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  actor_user_id: string | null;
  subject_db: string | null;
  subject_type: string | null;
  subject_id: string | null;
  payload_json: string;
  link: string | null;
  access: NotificationAccess;
  scope_node_id: string | null;
  seq: number;
  created_at: number;
  read_at: number | null;
}

const badCursor = () => new AppError('VALIDATION_FAILED', 'مؤشر الصفحة غير صالح.', 400, { where: 'query', issues: [{ path: 'cursor', code: 'custom', message: 'مؤشر الصفحة غير صالح.' }] });

function defaultLink(kind: NotificationKind, target: NotificationTargetInput | null | undefined, scopeNodeId: string | null): string | null {
  switch (kind) {
    case 'join_requested':
      return scopeNodeId ? `/admin/members?node=${scopeNodeId}` : null;
    case 'join_decided':
    case 'invitation':
      return target?.type === 'channel_node' ? `/channels/${target.id}` : null;
    case 'official_lecture_new':
    case 'official_version':
    case 'subject_update':
      return scopeNodeId ? `/subjects/${scopeNodeId}` : null;
    case 'report_received':
      return scopeNodeId ? `/admin/moderation?node=${scopeNodeId}` : null;
    case 'quota_warning':
      return '/me';
    default:
      return null;
  }
}

/** Every title of a payload cleaned with `notificationTitle` (vault titles may hold bidi controls or 300 characters). */
function cleanTitles(content: NotificationContent): NotificationContent {
  const payload: Record<string, unknown> = { ...(content.payload as Record<string, unknown>) };
  for (const [k, v] of Object.entries(payload)) if (TITLE_FIELDS.has(k) && typeof v === 'string') payload[k] = notificationTitle(v);
  return { kind: content.kind, payload } as NotificationContent;
}

export class NotificationService {
  readonly audiences: Audiences;
  readonly fanout: NotificationFanout;

  constructor(private readonly ctx: AppContext) {
    this.audiences = new Audiences(ctx.system.db);
    this.fanout = new NotificationFanout(ctx, this.audiences);
  }

  private get db() {
    return this.ctx.system.db;
  }

  /** Another module's audience (P1-T5: copy holders through `lecture_copy`, followers of a publication). */
  registerAudience(name: string, pager: AudiencePager): void {
    this.audiences.register(name, pager);
  }

  // ───────────────────────── publishing ─────────────────────────

  /**
   * Queue one notification event for its audience. Validates everything first (throws on a payload with anything but
   * titles and counts, a bad link or audience); writes one fan-out row; returns whether it was new.
   */
  publish(input: PublishInput): { fanoutId: string; created: boolean } {
    const parsed = notificationContentSchema.safeParse(cleanTitles(input.content));
    if (!parsed.success) throw new Error(`notification payload refused (${input.content.kind}): ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.code).join('; ')}`);
    const content = parsed.data;
    const access = input.access ?? DEFAULT_ACCESS[content.kind];
    if (!NOTIFICATION_ACCESS.includes(access)) throw new Error(`notification access unknown: ${String(access)}`);
    const scopeNodeId = input.scopeNodeId ?? null;
    if (access !== 'self' && !scopeNodeId) throw new Error(`notification ${content.kind}: access '${access}' needs a scope node`);
    if (!DEDUPE_RE.test(input.dedupeKey)) throw new Error('notification dedupe key not allowed');
    const link = input.link === undefined ? defaultLink(content.kind, input.target, scopeNodeId) : input.link;
    if (link !== null && !LINK_RE.test(link)) throw new Error('notification link must be an in-app path');
    const target = input.target ?? null;
    if (target && (target.db === 'space') !== !!target.space_id) throw new Error('notification target: a space target names its space, nothing else does');
    const audience = this.normaliseAudience(input.audience);
    const actor = WITHOUT_ACTOR.has(content.kind) ? null : (input.actorUserId ?? null);
    const now = this.ctx.clock.now();
    const id = newId(now);
    const created =
      this.db.run(
        `INSERT OR IGNORE INTO notification_fanout (id, kind, payload_json, actor_user_id, subject_db, subject_type, subject_id, link, access, scope_node_id, dedupe_key, audience_json, exclude_json, run_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          content.kind,
          JSON.stringify(content.payload),
          actor,
          target ? (target.db === 'space' ? target.space_id! : target.db) : null,
          target?.type ?? null,
          target?.id ?? null,
          link,
          access,
          scopeNodeId,
          input.dedupeKey,
          JSON.stringify(audience),
          JSON.stringify([...new Set(input.exclude ?? [])]),
          now,
          now,
        ],
      ).changes === 1;
    if (created) this.fanout.poke();
    const row = created ? { id } : this.db.get<{ id: string }>('SELECT id FROM notification_fanout WHERE dedupe_key = ?', [input.dedupeKey])!;
    return { fanoutId: row.id, created };
  }

  private normaliseAudience(a: AudienceSpec): AudienceSpec {
    switch (a.kind) {
      case 'users': {
        const ids = [...new Set(a.user_ids)].filter((x) => typeof x === 'string' && x.length > 0).sort();
        if (ids.length > MAX_EXPLICIT_RECIPIENTS) throw new Error(`notification audience: more than ${MAX_EXPLICIT_RECIPIENTS} explicit recipients — register an audience instead`);
        return { kind: 'users', user_ids: ids };
      }
      case 'node_approvers':
      case 'scope_moderators':
        if (!a.node_id) throw new Error('notification audience needs a node');
        return a;
      case 'course_followers':
        if (!a.subject_node_id) throw new Error('notification audience needs a subject');
        return a;
      case 'registered':
        if (!this.audiences.has(a.name)) throw new Error(`notification audience not registered: ${a.name}`);
        return { kind: 'registered', name: a.name, params: Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, String(v)])) };
    }
  }

  // ───────────────────────── the inbox ─────────────────────────

  /**
   * SQL for «rows the viewer may still open»: every (access, scope) the viewer's rows use is decided once, and the query
   * keeps `self` rows plus the allowed pairs.
   */
  private visible(viewer: Viewer): { sql: string; params: string[] } {
    const groups = this.db.all<{ access: NotificationAccess; scope_node_id: string | null }>(
      `SELECT DISTINCT access, scope_node_id FROM notification WHERE user_id = ? AND access != 'self'`,
      [viewer.userId],
    );
    const may = accessMemo(this.ctx, viewer);
    const allowed = groups.filter((g) => may(g.access, g.scope_node_id)).map((g) => `${g.access}|${g.scope_node_id ?? ''}`);
    if (allowed.length === 0) return { sql: `access = 'self'`, params: [] };
    return { sql: `(access = 'self' OR (access || '|' || IFNULL(scope_node_id, '')) IN (${allowed.map(() => '?').join(',')}))`, params: allowed };
  }

  private unreadCount(viewer: Viewer, vis = this.visible(viewer)): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notification WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL AND ${vis.sql}`, [viewer.userId, ...vis.params])!.n;
  }

  inbox(viewer: Viewer, q: NotificationsQuery): NotificationsResponse {
    let after: number | null = null;
    if (q.cursor) {
      try {
        const v = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as unknown;
        if (!Array.isArray(v) || v.length !== 1 || !Number.isSafeInteger(v[0])) throw new Error('cursor');
        after = v[0] as number;
      } catch {
        throw badCursor();
      }
    }
    const vis = this.visible(viewer);
    const where = ['user_id = ?', 'dismissed_at IS NULL', vis.sql];
    const params: (string | number)[] = [viewer.userId, ...vis.params];
    if (q.unread) where.push('read_at IS NULL');
    if (after !== null) {
      where.push('seq < ?');
      params.push(after);
    }
    const rows = this.db.all<NotificationRow>(
      `SELECT id, kind, actor_user_id, subject_db, subject_type, subject_id, payload_json, link, access, scope_node_id, seq, created_at, read_at
         FROM notification WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      [...params, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const people = this.people(page.map((r) => r.actor_user_id));
    const items: NotificationView[] = [];
    for (const r of page) {
      const v = this.view(r, people);
      if (v) items.push(v);
    }
    const last = page[page.length - 1];
    return {
      items,
      next_cursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.seq])).toString('base64url') : null,
      unread_count: this.unreadCount(viewer, vis),
    };
  }

  private people(ids: (string | null)[]): Map<string, { id: string; display_name: string; status: string }> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, { id: string; display_name: string; status: string }>();
    if (wanted.length === 0) return out;
    for (const p of this.db.all<{ id: string; display_name: string; status: string }>(`SELECT id, display_name, status FROM user_account WHERE id IN (${wanted.map(() => '?').join(',')})`, wanted)) out.set(p.id, p);
    return out;
  }

  /** A stored row as the contract's view — re-validated: a row that does not pass the strict schema is never shown. */
  private view(r: NotificationRow, people: Map<string, { id: string; display_name: string; status: string }>): NotificationView | null {
    const parsed = notificationContentSchema.safeParse({ kind: r.kind, payload: fromJson<unknown>(r.payload_json) });
    if (!parsed.success) return null;
    const content = parsed.data;
    let target: NotificationTarget | null = null;
    if (r.subject_type && r.subject_id && r.subject_db) {
      const db = r.subject_db === 'system' || r.subject_db === 'vault' ? r.subject_db : 'space';
      target = { db, space_id: db === 'space' ? r.subject_db : null, type: r.subject_type, id: r.subject_id };
    }
    const actor = !WITHOUT_ACTOR.has(r.kind) && r.actor_user_id ? userRef(r.actor_user_id, people) : null;
    return { ...content, id: r.id, actor, target, text_ar: notificationText(content), link: r.link, created_at: r.created_at, read_at: r.read_at } as NotificationView;
  }

  markRead(viewer: Viewer, body: MarkNotificationsReadRequest): MarkNotificationsReadResponse {
    const vis = this.visible(viewer);
    const now = this.ctx.clock.now();
    let updated: number;
    if ('all' in body) {
      updated = this.db.run(`UPDATE notification SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND dismissed_at IS NULL AND ${vis.sql}`, [now, viewer.userId, ...vis.params]).changes;
    } else {
      const ids = [...new Set(body.ids)];
      updated = this.db.run(
        `UPDATE notification SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')}) AND ${vis.sql}`,
        [now, viewer.userId, ...ids, ...vis.params],
      ).changes;
    }
    return { updated, unread_count: this.unreadCount(viewer, vis) };
  }

  // ───────────────────────── preferences ─────────────────────────

  prefs(viewer: Viewer): NotificationPrefsResponse {
    const rows = this.db.all<{ kind: string; channel: 'in_app' | 'push'; enabled: number }>('SELECT kind, channel, enabled FROM notification_pref WHERE user_id = ?', [viewer.userId]);
    const get = (kind: NotificationKind, channel: 'in_app' | 'push', fallback: boolean) => {
      const r = rows.find((x) => x.kind === kind && x.channel === channel);
      return r ? r.enabled === 1 : fallback;
    };
    return {
      prefs: NOTIFICATION_KINDS.map((kind) => ({ kind, label_ar: NOTIFICATION_KIND_LABELS_AR[kind], in_app: get(kind, 'in_app', true), push: false })),
      push: { available: false, reason_ar: PUSH_UNAVAILABLE_AR },
    };
  }

  putPrefs(viewer: Viewer, body: PutNotificationPrefsRequest): NotificationPrefsResponse {
    if (body.prefs.some((p) => p.channel === 'push' && p.enabled)) throw new AppError('FEATURE_DISABLED', PUSH_UNAVAILABLE_AR, 409, { feature: 'notifications.push' });
    this.db.tx(() => {
      for (const p of body.prefs) {
        if (p.channel !== 'in_app') continue; // push stays off (nothing to switch off)
        this.db.run(
          `INSERT INTO notification_pref (user_id, kind, channel, enabled) VALUES (?, ?, 'in_app', ?)
           ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = excluded.enabled`,
          [viewer.userId, p.kind, p.enabled ? 1 : 0],
        );
      }
    });
    return this.prefs(viewer);
  }

  // ───────────────────────── account deletion ─────────────────────────

  /** The deleted account's inbox, preferences and push subscriptions go; rows naming it as actor read «طالب سابق». */
  forgetUser(userId: string): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM notification WHERE user_id = ?', [userId]);
      this.db.run('DELETE FROM notification_pref WHERE user_id = ?', [userId]);
      this.db.run('DELETE FROM push_subscription WHERE user_id = ?', [userId]);
    });
  }
}

const instances = new WeakMap<object, NotificationService>();

/** The notifications service of an application context (created on first use; shared by every module). */
export function notificationsOf(ctx: AppContext): NotificationService {
  let s = instances.get(ctx.system);
  if (!s) {
    s = new NotificationService(ctx);
    instances.set(ctx.system, s);
  }
  return s;
}
