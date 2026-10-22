// Academic OS — the in-app inbox, preferences and optional Web Push (ARCHITECTURE_DELTA §7.12, §12, §4.1
// `2200_notifications`; PRD AOS-18.13, 21.31, 5.18 Phase 1 part). Track P1-T4, wave-2 step 0: types and zod schemas.
//
// * Fan-out is a job writing `notification` rows in batches of NOTIFICATION_BATCH_SIZE with a dedupe key.
// * A payload holds TITLES AND COUNTS ONLY — never note text, ink or anything from a vault. Each kind has a strict
//   payload schema (unknown keys are refused, not stripped), and the server validates a payload with
//   `notificationContentSchema` before it writes the row, so private text cannot ride along.
// * Names of people are not stored in the payload: `actor` is rendered at read time from the system account (a
//   deleted account reads «طالب سابق» everywhere at once).
// * Push is opt-in per device and never assumed; when it cannot be offered the preferences say why (iOS delivers Web
//   Push only to a PWA installed on the Home Screen — documented, not measured here).
//
// STABLE CONTRACT: kinds and fields are only ever ADDED (P1-T4 owns this file). Only the Phase 1 kinds of §12 are
// listed; later phases append theirs (publication_new, suggestion_*, reply, mention, room_*).
import { z } from 'zod';
import type { CursorPage } from './channels-api';
import { cursorPageQuerySchema, entityIdSchema, plainTextSchema } from './channels-api';
import { REPORT_REASONS } from './moderation-api';
import type { UserRef } from './visibility';

export const NOTIFICATION_BATCH_SIZE = 500;
export const NOTIFICATION_TITLE_MAX = 200;

export const NOTIFICATION_KINDS = [
  'join_requested',
  'join_decided',
  'invitation',
  'official_lecture_new',
  'official_version',
  'subject_update',
  'publication_updated',
  'moderation',
  'report_received',
  'reanchor_ready',
  'quota_warning',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

/** Names of the kinds in the preferences screen. */
export const NOTIFICATION_KIND_LABELS_AR: Record<NotificationKind, string> = {
  join_requested: 'طلبات الانضمام إلى قنواتي',
  join_decided: 'قرار طلب انضمامي',
  invitation: 'دعوات الانضمام',
  official_lecture_new: 'محاضرة رسمية جديدة في مادة أتابعها',
  official_version: 'إصدار جديد من محاضرة عندي نسخة منها',
  // also how a copy holder learns that a lecture was withdrawn (review W2-step0 R7: the label names it)
  subject_update: 'تحديثات المادة (سحب محاضرة، ملفات، مواعيد امتحانات)',
  publication_updated: 'تحديث شرح أتابعه',
  moderation: 'قرارات الإشراف على محتواي وبلاغاتي',
  report_received: 'بلاغات جديدة في المواد التي أشرف عليها',
  reanchor_ready: 'اكتمال نقل ملاحظاتي إلى إصدار جديد',
  quota_warning: 'اقتراب نفاد مساحتي أو رصيدي',
};

const title = plainTextSchema({ max: NOTIFICATION_TITLE_MAX, field_ar: 'العنوان' });

// eslint-disable-next-line no-control-regex -- invisible controls become a space; the payload is one line
const TITLE_CONTROLS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const TITLE_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const NOTIFICATION_TITLE_FALLBACK_AR = 'بلا عنوان';

/**
 * A payload title from any stored title (review W2-step0 R5). Vault source titles allow 300 characters and may carry
 * bidi controls from a file name; the strict payload refuses both, so the fan-out passes every title through this:
 * bidi controls removed, invisible controls and runs of white space become one space, at most NOTIFICATION_TITLE_MAX
 * characters (zod counts code points; a cut title ends with «…» and never splits a character), «بلا عنوان» when
 * nothing readable is left. The result always passes the payload's title schema.
 */
export function notificationTitle(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(TITLE_BIDI, '').replace(TITLE_CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return NOTIFICATION_TITLE_FALLBACK_AR;
  const chars = Array.from(s);
  if (chars.length <= NOTIFICATION_TITLE_MAX) return s;
  return `${chars
    .slice(0, NOTIFICATION_TITLE_MAX - 1)
    .join('')
    .trimEnd()}…`;
}
const count = z.number().int().min(0).max(1_000_000_000);
const versionNo = z.number().int().min(1);

/** Kind + payload. Each payload is strict: titles and counts only. */
export const notificationContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join_requested'), payload: z.object({ node_title: title, pending_count: count.optional() }).strict() }).strict(),
  z
    .object({ kind: z.literal('join_decided'), payload: z.object({ node_title: title, decision: z.enum(['approved', 'rejected', 'removed']) }).strict() })
    .strict(),
  z.object({ kind: z.literal('invitation'), payload: z.object({ node_title: title }).strict() }).strict(),
  z
    .object({
      kind: z.literal('official_lecture_new'),
      payload: z.object({ subject_title: title, lecture_title: title, lecture_no: z.number().int().min(1).nullable() }).strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal('official_version'), payload: z.object({ subject_title: title, lecture_title: title, version_no: versionNo }).strict() })
    .strict(),
  z
    .object({
      kind: z.literal('subject_update'),
      payload: z
        .object({
          subject_title: title,
          /**
           * a `subject_event` kind (lectures-api.ts SUBJECT_EVENT_KINDS); new lectures and versions have their own kinds
           * above. `lecture_withdrawn` also reaches the holders of a copy (system `lecture_copy`), whose copies keep
           * their ink and say why.
           */
          event_kind: z.enum(['lecture_withdrawn', 'attachment_published', 'exam_date_published', 'exam_date_changed']),
          title,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('publication_updated'),
      payload: z.object({ publication_title: title, version_no: versionNo, added: count, removed: count, changed: count }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('moderation'),
      payload: z
        .object({
          target_title: title,
          action: z.enum(['hide', 'restore', 'dismiss']),
          /** the moderator's Arabic reason — written for the author and the reporter to read */
          reason_ar: plainTextSchema({ max: 500, field_ar: 'السبب', multiline: true }),
          /** why this person is told: the author of the content, or the person who reported it */
          as: z.enum(['author', 'reporter']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('report_received'),
      payload: z
        .object({
          subject_title: title,
          target_title: title,
          reason: z.enum(REPORT_REASONS),
          open_reports: count,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('reanchor_ready'),
      payload: z.object({ lecture_title: title, copied: count, needs_review: count, kept: count }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('quota_warning'),
      // AOS-21.45 (C1, additive): `subject_title` when the quota is a SUBJECT's (told to its moderators), not the reader's own
      payload: z.object({ quota: z.enum(['storage', 'ai', 'asr']), percent: z.union([z.literal(80), z.literal(100)]), subject_title: title.optional() }).strict(),
    })
    .strict(),
]);
export type NotificationContent = z.infer<typeof notificationContentSchema>;

/** Which database the notified-about object lives in (so the client can open it; access is re-checked on open). */
export interface NotificationTarget {
  db: 'system' | 'space' | 'vault';
  space_id: string | null;
  type: string;
  id: string;
}

/**
 * Kinds whose `actor` is ALWAYS null (review W2-step0 R6). A moderation outcome speaks for the role, never for a
 * person, and never names the reporter (ARCHITECTURE_DELTA §13: the author never learns who reported); a new report
 * reaches the moderators' lock screens through push, so who reported is shown only in the queue (`ReportView`).
 * Re-anchor reports and quota warnings come from the system.
 */
export const NOTIFICATION_KINDS_WITHOUT_ACTOR = ['moderation', 'report_received', 'reanchor_ready', 'quota_warning'] as const satisfies readonly NotificationKind[];

export type NotificationView = NotificationContent & {
  id: string;
  /** who caused it, rendered now from the system account (null: the system; always null for NOTIFICATION_KINDS_WITHOUT_ACTOR) */
  actor: UserRef | null;
  target: NotificationTarget | null;
  /** the Arabic line shown in the inbox, rendered from kind + payload */
  text_ar: string;
  /** the in-app route it opens, or null */
  link: string | null;
  created_at: number;
  read_at: number | null;
};

/** GET /api/notifications — grouped per day by the client in the user's timezone. */
export interface NotificationsResponse extends CursorPage<NotificationView> {
  unread_count: number;
}

const queryBool = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');
export const notificationsQuerySchema = cursorPageQuerySchema.extend({ unread: queryBool.optional() });
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

/** POST /api/notifications/read — chosen ids, or everything up to now. */
export const markNotificationsReadSchema = z.union([
  z.object({ ids: z.array(entityIdSchema).min(1).max(NOTIFICATION_BATCH_SIZE) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type MarkNotificationsReadRequest = z.infer<typeof markNotificationsReadSchema>;
/**
 * POST /api/notifications/read — how many of the viewer's OWN notifications changed, and the unread count after it
 * (P1-T4 step 2, additive). Ids that are not the viewer's (or do not exist) are ignored silently: an id never confirms
 * that someone else's notification exists.
 */
export interface MarkNotificationsReadResponse {
  updated: number;
  unread_count: number;
}

export const NOTIFICATION_CHANNELS = ['in_app', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationPrefView {
  kind: NotificationKind;
  label_ar: string;
  in_app: boolean;
  push: boolean;
}
/** GET /api/notifications/prefs */
export interface NotificationPrefsResponse {
  prefs: NotificationPrefView[];
  /** whether push can be offered on the device asking (probed, never assumed), and if not, why */
  push: { available: boolean; reason_ar: string | null };
}
/** PUT /api/notifications/prefs */
export const putNotificationPrefsSchema = z
  .object({
    prefs: z
      .array(z.object({ kind: notificationKindSchema, channel: z.enum(NOTIFICATION_CHANNELS), enabled: z.boolean() }).strict())
      .min(1)
      .max(NOTIFICATION_KINDS.length * NOTIFICATION_CHANNELS.length),
  })
  .strict();
export type PutNotificationPrefsRequest = z.infer<typeof putNotificationPrefsSchema>;

const httpsEndpoint = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s/]+\/\S*$/, 'عنوان الإشعارات يجب أن يكون https.');
const pushKey = z.string().regex(/^[A-Za-z0-9_-]{1,256}={0,2}$/, 'مفتاح الإشعارات غير صالح.');

/** Top-level names that never belong to a public push service (local networks, tests, reverse DNS). */
const NON_PUBLIC_TLDS = new Set(['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'invalid', 'example', 'arpa', 'onion']);

/**
 * The server POSTs every push message to the endpoint a client registered, so an endpoint is accepted only when it
 * names a public host by name (review W2-step0 R1, SSRF): https on the default port, no user information, no IP
 * literal (any IPv4 spelling — the WHATWG URL parser turns `2130706433` into `127.0.0.1` — or IPv6), a dotted name
 * whose top-level name is not a local or reserved one. The sender still resolves the name and refuses private,
 * loopback and link-local addresses when it sends (DNS can change after this check).
 */
export function isPublicPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || host.includes(':')) return false;
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return false;
  return !NON_PUBLIC_TLDS.has(labels[labels.length - 1]!);
}

const pushEndpoint = httpsEndpoint.refine(isPublicPushEndpoint, 'عنوان الإشعارات لا يخص خدمة إشعارات عامة.');

/** POST /api/notifications/push-subscriptions — the browser's PushSubscription JSON (VAPID). */
export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpoint,
    keys: z.object({ p256dh: pushKey, auth: pushKey }).strict(),
    device_id: entityIdSchema.optional(),
  })
  .strict();
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionSchema>;
/**
 * DELETE /api/notifications/push-subscriptions — any https endpoint: it only ever matches the caller's own rows, so a
 * subscription stored before a stricter endpoint rule can still be removed.
 */
export const deletePushSubscriptionSchema = z.object({ endpoint: httpsEndpoint }).strict();
