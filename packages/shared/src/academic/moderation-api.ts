// Academic OS — the minimal moderation flow and the scoped security audit (ARCHITECTURE_DELTA §7.12, §13, §4.1
// `2310_moderation` / `security_audit`; PRD AOS-18.7 and 18.8 Phase 1 parts, 18.14). Track P1-T4, wave-2 step 0:
// types and zod schemas only.
//
// Phase 1 (course-only publications go live at once, so something must stand behind them — PRD Q6): a member reports
// a publication → the queue of that subject's moderators → hide / restore / dismiss with an Arabic reason → the author
// and the reporter are notified → an audit entry. One OPEN report per reporter per target. Moderators see published
// content of their subject and the reports — never vault content (no route exists for it).
// Phase 2 widens the target types and actions (appeals, «اطلب تعديلًا», «راجعه مشرف المادة», discussions, profiles):
// the full enums below are the database's vocabulary; the request schemas accept only the Phase 1 values.
//
// STABLE CONTRACT: values and fields are only ever ADDED (P1-T4 owns this file).
import { z } from 'zod';
import type { CursorPage, NodeRef } from './channels-api';
import { cursorPageQuerySchema, entityIdSchema, plainTextSchema } from './channels-api';
import type { ChannelRole, UserRef } from './visibility';

/** Everything that can ever be reported (`moderation_report.target_type`). */
export const REPORT_TARGET_TYPES = [
  'publication',
  'publication_version',
  'discussion_thread',
  'discussion_post',
  'suggestion',
  'profile',
  'room',
  'official_lecture',
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
/** What can be reported in Phase 1. */
export const REPORT_TARGET_TYPES_PHASE1 = ['publication', 'publication_version'] as const satisfies readonly ReportTargetType[];

export const REPORT_REASONS = ['wrong_content', 'copyright', 'harassment', 'spam', 'privacy', 'patient_identifiers', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const reportReasonSchema = z.enum(REPORT_REASONS);
export const REPORT_REASON_LABELS_AR: Record<ReportReason, string> = {
  wrong_content: 'معلومة خاطئة',
  copyright: 'انتهاك حقوق النشر',
  harassment: 'إساءة أو تحرش',
  spam: 'محتوى مزعج أو إعلاني',
  privacy: 'يكشف معلومات شخصية',
  patient_identifiers: 'يحتوي معرّفات مريض',
  other: 'سبب آخر',
};

export const REPORT_STATUSES = ['open', 'actioned', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_STATUS_LABELS_AR: Record<ReportStatus, string> = {
  open: 'مفتوح',
  actioned: 'اتُّخذ إجراء',
  dismissed: 'لا مخالفة',
};

/** What a report or an action is about. `db` = 'system' (the publication index) or the id of the subject's space. */
export interface ModerationTarget {
  db: string;
  type: ReportTargetType;
  id: string;
}
/**
 * Where each Phase 1 target lives — ONE spelling per target, so the «one open report per reporter per target» index
 * (reporter, target_db, target_type, target_id) cannot be dodged by naming the same publication twice (review
 * W2-step0 R4): a publication is its row in the system index, a publication version is its row in the subject's space.
 */
export const MODERATION_TARGET_DB: Record<(typeof REPORT_TARGET_TYPES_PHASE1)[number], 'system' | 'space'> = {
  publication: 'system',
  publication_version: 'space',
};
export const moderationTargetSchema = z
  .object({
    db: z.union([z.literal('system'), entityIdSchema]),
    type: z.enum(REPORT_TARGET_TYPES_PHASE1),
    id: entityIdSchema,
  })
  .strict()
  .refine((t) => (MODERATION_TARGET_DB[t.type] === 'system') === (t.db === 'system'), {
    message: 'مكان المحتوى لا يطابق نوعه.',
    path: ['db'],
  });

/** POST /api/moderation/reports (rate-limited: preset `reports`). */
export const createReportSchema = z
  .object({
    target: moderationTargetSchema,
    reason: reportReasonSchema,
    note: plainTextSchema({ max: 1000, field_ar: 'الملاحظة', multiline: true }).optional(),
  })
  .strict();
export type CreateReportRequest = z.infer<typeof createReportSchema>;

/** A report as the moderators of its scope (and its reporter) see it. The author never learns who reported. */
export interface ReportView {
  id: string;
  /** with the title the moderator may see, or null when the target is gone */
  target: ModerationTarget & { title: string | null };
  /** the subject (or node) whose moderators receive it */
  scope: NodeRef;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  created_at: number;
  resolved_at: number | null;
  /** moderators of the scope only; null for anyone else */
  reporter: UserRef | null;
}

/** GET /api/moderation/queue — moderators of that scope (or above) only; anyone else 404. */
export const reportQueueQuerySchema = cursorPageQuerySchema.extend({
  scope_node_id: entityIdSchema,
  status: z.enum(REPORT_STATUSES).optional(),
});
export type ReportQueueResponse = CursorPage<ReportView>;

/** Everything a moderator can ever do (`moderation_action.action`). */
export const MODERATION_ACTIONS = [
  'hide',
  'restore',
  'request_changes',
  'mark_reviewed',
  'remove_post',
  'lock_thread',
  'warn_user',
  'suspend_user',
  'dismiss',
] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];
/** Phase 1: hide, restore, dismiss. «راجعه مشرف المادة» (`mark_reviewed`, Subject Moderators only) is Phase 2. */
export const MODERATION_ACTIONS_PHASE1 = ['hide', 'restore', 'dismiss'] as const satisfies readonly ModerationAction[];
export const MODERATION_ACTION_LABELS_AR: Record<ModerationAction, string> = {
  hide: 'أخفِ مع السبب',
  restore: 'أعِد الإظهار',
  request_changes: 'اطلب تعديلًا',
  mark_reviewed: 'راجعه مشرف المادة',
  remove_post: 'احذف المشاركة',
  lock_thread: 'أغلق النقاش',
  warn_user: 'نبّه المستخدم',
  suspend_user: 'أوقف المستخدم',
  dismiss: 'أبقِ (لا مخالفة)',
};

/** POST /api/moderation/actions — every action carries an Arabic reason the author (and reporter) will read. */
export const moderationActionSchema = z
  .object({
    report_id: entityIdSchema.optional(),
    target: moderationTargetSchema.optional(),
    action: z.enum(MODERATION_ACTIONS_PHASE1),
    reason_ar: plainTextSchema({ min: 2, max: 500, field_ar: 'السبب', multiline: true }),
  })
  .strict()
  .refine((b) => !!b.report_id || !!b.target, { message: 'حدّد البلاغ أو المحتوى الذي يخصه الإجراء.', path: ['target'] });
export type ModerationActionRequest = z.infer<typeof moderationActionSchema>;

export interface ModerationActionView {
  id: string;
  report_id: string | null;
  action: ModerationAction;
  target: ModerationTarget;
  reason_ar: string;
  moderator: UserRef;
  /** the role the moderator acted with in that scope, or the platform admin */
  role: ChannelRole | 'platform_admin';
  created_at: number;
}

// ───────────────────────────── scoped security audit (GET /api/admin/audit) ─────────────────────────────

/** One `security_audit` row as an Admin of the scope sees it: no IP address, no private content. */
export interface SecurityAuditView {
  id: string;
  actor: UserRef | null;
  /** e.g. 'subject_moderator@<node>' | 'platform_admin' | 'self' */
  actor_role: string | null;
  scope: NodeRef | null;
  /** login | role_grant | role_revoke | membership_decide | code_create | code_revoke | lecture_publish | … */
  action: string;
  target: { db: string; type: string; id: string } | null;
  /** Arabic, written without private content */
  summary_ar: string;
  created_at: number;
}
export const auditQuerySchema = cursorPageQuerySchema.extend({
  scope_node_id: entityIdSchema,
  action: z
    .string()
    .regex(/^[a-z_]{1,64}$/, 'نوع الإجراء غير صالح.')
    .optional(),
});
export type SecurityAuditResponse = CursorPage<SecurityAuditView>;
