// Academic OS — channels: the university tree, joining (class code, QR, invite link, invitation), memberships, roles
// and course follow (ARCHITECTURE_DELTA §7.3, §4.1 `2050_directory` / `2100_permissions`; PRD AOS-2.1, 2.11–2.16,
// 18.1–18.6, 21.2–21.6, 21.15, 21.18). Track P1-T4, wave-2 step 0: types and zod schemas only, no behaviour.
// System routes under /api/channels; every list is filtered by the viewer before it is paginated, and anything the
// viewer may not see answers 404 with the body of a missing id (§5.5).
//
// This file also holds the §7.1 conventions every wave-2 contract shares (cursor pages, ids, dates, plain display
// text, minimum group sizes), so P1-T5's files import them from here instead of redefining them.
//
// STABLE CONTRACT: after step 0, fields and enum members are only ever ADDED (P1-T4 owns this file); nothing is renamed
// or removed. The account-level `MembershipView` / `RoleView` of accounts-api.ts (P1-T1) stay as they are; the richer
// channel views below are named `ChannelMembershipView` / `ChannelRoleView`.
import { z } from 'zod';
import type { MeLite } from './accounts-api';
import { deviceIdSchema } from './accounts-api';
import type { ChannelKind, ChannelRole, UserRef } from './visibility';
import { CHANNEL_KINDS, channelKindSchema, channelRoleSchema } from './visibility';

// ───────────────────────────── §7.1 conventions shared by every wave-2 contract ─────────────────────────────

export const CURSOR_PAGE_DEFAULT_LIMIT = 30;
export const CURSOR_PAGE_MAX_LIMIT = 100;

/**
 * Cursor pagination (§7.1). The cursor is opaque base64url of (sort key, id), stable under inserts. Named «cursor page»
 * because «page» in this code base means a page of a lecture.
 */
export interface CursorPageQuery {
  cursor?: string;
  limit?: number;
}
export interface CursorPage<T> {
  items: T[];
  /** null = the last page */
  next_cursor: string | null;
}

/** The request header of server-generated creations (§7.1 «Idempotency»: same key + same body → the same object). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** ids of rows (ULIDs or the server's own ids): letters, digits, `_` and `-`, at most 64 characters */
export const entityIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'معرّف غير صالح.');

export const cursorPageQuerySchema = z.object({
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/, 'مؤشر الصفحة غير صالح.').optional(),
  limit: z.coerce.number().int().min(1).max(CURSOR_PAGE_MAX_LIMIT).default(CURSOR_PAGE_DEFAULT_LIMIT),
});

function isCalendarDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** a calendar date, YYYY-MM-DD (Latin digits) */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'اكتب التاريخ بالشكل 2026-10-21.')
  .refine(isCalendarDate, 'هذا التاريخ غير موجود في التقويم.');

/** Bidi controls (LRM, RLM, ALM, embeddings, overrides, isolates): never stored in display text (AC-20). */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex -- the point of this pattern: control characters are refused in one-line text
const CONTROL_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex -- multi-line text keeps tab and newlines, nothing else invisible
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Text a person types that other people read (titles, reasons, notes): trimmed, bounded, no bidi control characters
 * (the renderer isolates English runs itself — AC-20) and no invisible control characters.
 */
export function plainTextSchema(opts: { max: number; min?: number; multiline?: boolean; field_ar: string }) {
  const min = opts.min ?? 1;
  return z
    .string()
    .trim()
    .min(min, min <= 1 ? `اكتب ${opts.field_ar}.` : `${opts.field_ar} أقصر من ${min} أحرف.`)
    .max(opts.max, `${opts.field_ar} أطول من ${opts.max} حرفًا.`)
    .refine((s) => !BIDI_CONTROLS.test(s), `${opts.field_ar} يحتوي محارف تحكم في الاتجاه؛ احذفها ثم أعد المحاولة.`)
    .refine((s) => !(opts.multiline ? CONTROL_MULTI_LINE : CONTROL_ONE_LINE).test(s), `${opts.field_ar} يحتوي محارف غير مرئية غير مسموحة.`);
}

/**
 * Counts about groups of people (copy holders, members, statistics) are never shown under this size: the cell says
 * «أقل من 5» instead (ARCHITECTURE_DELTA §13, §4.1 `lecture_copy`).
 */
export const MIN_GROUP_SIZE = 5;
export interface GroupCount {
  /** null when 1–4 people: suppressed */
  value: number | null;
  label_ar: string;
}
export function groupCount(n: number): GroupCount {
  if (n > 0 && n < MIN_GROUP_SIZE) return { value: null, label_ar: `أقل من ${MIN_GROUP_SIZE}` };
  return { value: n, label_ar: String(n) };
}

// ───────────────────────────── the tree (2050) ─────────────────────────────

export const CHANNEL_KIND_LABELS_AR: Record<ChannelKind, string> = {
  university: 'جامعة',
  college: 'كلية',
  department: 'قسم',
  stage: 'مرحلة',
  academic_year: 'سنة دراسية',
  course: 'فصل أو مقرر',
  subject: 'مادة',
};

export const CHANNEL_ROLE_LABELS_AR: Record<ChannelRole, string> = {
  admin: 'مدير القناة',
  assistant: 'مساعد',
  subject_moderator: 'مشرف المادة',
  contributor: 'مساهم',
};

/** Position of a kind in University → College → Department → Stage → Academic Year → Course → Subject. */
export function channelKindRank(kind: ChannelKind): number {
  return CHANNEL_KINDS.indexOf(kind);
}
/** Kinds strictly descend down the tree; a level may be skipped (a college without departments). */
export function isDescendingKind(parent: ChannelKind, child: ChannelKind): boolean {
  return channelKindRank(child) > channelKindRank(parent);
}

export const JOIN_POLICIES = ['closed', 'approval', 'open_with_code'] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];
export const JOIN_POLICY_LABELS_AR: Record<JoinPolicy, string> = {
  closed: 'بدعوة فقط',
  approval: 'بطلب انضمام يوافق عليه المشرف',
  open_with_code: 'برمز الانضمام مباشرة',
};
export const joinPolicySchema = z.enum(JOIN_POLICIES);

export const CHANNEL_NODE_STATUSES = ['active', 'archived'] as const;
export type ChannelNodeStatus = (typeof CHANNEL_NODE_STATUSES)[number];

/** A node as anyone may name it: id, kind and title only. */
export interface NodeRef {
  id: string;
  kind: ChannelKind;
  title: string;
}

/** GET /api/channels/tree, GET /api/channels/nodes/:id — titles are visible to any signed-in user (§7.3). */
export interface ChannelNodeView extends NodeRef {
  parent_id: string | null;
  title_en: string | null;
  ordinal: number | null;
  /** YYYY-MM-DD (academic years and courses) */
  starts_on: string | null;
  ends_on: string | null;
  /** the node owns a subject space (official lectures, publications) */
  has_space: boolean;
  /** that space, ONLY for a viewer who may bind it (approved member or a role here or above); null for everyone else */
  space_id: string | null;
  join_policy: JoinPolicy;
  status: ChannelNodeStatus;
  viewer: {
    /** the viewer's membership on this node or the nearest ancestor that carries one */
    membership: ChannelMembershipView | null;
    /** roles the viewer holds here, inherited down the tree */
    roles: ChannelRole[];
    /** where the nearest inherited role or membership comes from (null: on this node, or none) */
    inherited_from: NodeRef | null;
    /**
     * the viewer's own «تابع المادة» on this subject (null: not following, or not a subject) — the state of the toggle on
     * the subject page (AOS-2.16; review W2-step0 R8)
     */
    course_follow: CourseFollowView | null;
  };
}

/** GET /api/channels/nodes/:id */
export interface ChannelNodeDetail extends ChannelNodeView {
  /** breadcrumbs from the root to the parent */
  path: NodeRef[];
}

export interface ChannelTreeResponse {
  nodes: ChannelNodeView[];
  /** the depth or size limit cut the tree; ask again with `root` */
  truncated: boolean;
}

export const channelTreeQuerySchema = z.object({
  root: entityIdSchema.optional(),
  depth: z.coerce.number().int().min(1).max(CHANNEL_KINDS.length).default(2),
});
export type ChannelTreeQuery = z.infer<typeof channelTreeQuerySchema>;

const nodeTitle = plainTextSchema({ max: 120, field_ar: 'اسم العقدة' });
const nodeTitleEn = plainTextSchema({ max: 120, field_ar: 'الاسم الإنجليزي' });
const ordinalSchema = z.number().int().min(0).max(10_000);
const datesInOrder = (b: { starts_on?: string | null; ends_on?: string | null }) => !b.starts_on || !b.ends_on || b.starts_on <= b.ends_on;

/** POST /api/channels/nodes — Admin of the parent, or the platform admin (a university). */
export const createChannelNodeSchema = z
  .object({
    parent_id: entityIdSchema.nullable(),
    kind: channelKindSchema,
    title: nodeTitle,
    title_en: nodeTitleEn.optional(),
    ordinal: ordinalSchema.optional(),
    starts_on: isoDateSchema.optional(),
    ends_on: isoDateSchema.optional(),
    /** subjects get their own space (AOS-21.6) */
    create_space: z.boolean().optional(),
    join_policy: joinPolicySchema.optional(),
  })
  .strict()
  .refine(datesInOrder, { message: 'تاريخ النهاية قبل تاريخ البداية.', path: ['ends_on'] });
export type CreateChannelNodeRequest = z.infer<typeof createChannelNodeSchema>;

/** PATCH /api/channels/nodes/:id — rename, reorder, move (a new parent of a higher kind), dates, join policy. */
export const patchChannelNodeSchema = z
  .object({
    parent_id: entityIdSchema.optional(),
    title: nodeTitle.optional(),
    title_en: nodeTitleEn.nullable().optional(),
    ordinal: ordinalSchema.nullable().optional(),
    starts_on: isoDateSchema.nullable().optional(),
    ends_on: isoDateSchema.nullable().optional(),
    join_policy: joinPolicySchema.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'لا يوجد ما يُغيَّر.')
  .refine(datesInOrder, { message: 'تاريخ النهاية قبل تاريخ البداية.', path: ['ends_on'] });
export type PatchChannelNodeRequest = z.infer<typeof patchChannelNodeSchema>;

/** POST /api/channels/nodes/:id/archive — `preview: true` first (the impact), then `preview: false` archives. */
export const archiveChannelNodeSchema = z.object({ preview: z.boolean() }).strict();
export type ArchiveChannelNodeRequest = z.infer<typeof archiveChannelNodeSchema>;

export interface ChannelArchivePreview {
  node: NodeRef;
  /** nodes below it that are archived with it */
  descendants: number;
  /** approved and pending memberships on it and below (they stop granting access) */
  memberships: number;
  /** subject spaces that become read-only */
  spaces: number;
  /** open join codes and invite links that are revoked */
  open_codes: number;
}
export interface ChannelArchiveResponse {
  preview: ChannelArchivePreview;
  /** false for a preview */
  archived: boolean;
}

// ───────────────────────────── memberships and joining ─────────────────────────────

export const MEMBERSHIP_STATUSES = ['pending', 'approved', 'rejected', 'left', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export const MEMBERSHIP_STATUS_LABELS_AR: Record<MembershipStatus, string> = {
  pending: 'بانتظار الموافقة',
  approved: 'عضو',
  rejected: 'رُفض الطلب',
  left: 'غادر',
  removed: 'أُزيل',
};

export const JOIN_METHODS = ['class_code', 'qr', 'invite_link', 'invitation', 'added_by_admin', 'legacy_owner'] as const;
export type JoinMethod = (typeof JOIN_METHODS)[number];

/** The viewer's own membership of one node (it applies to the node and everything below it). */
export interface ChannelMembershipView {
  id: string;
  node: NodeRef;
  status: MembershipStatus;
  join_method: JoinMethod;
  created_at: number;
  decided_at: number | null;
  /** the Arabic reason given with a rejection or a removal */
  reason_ar: string | null;
}

/** POST /api/channels/join, /join/link, /invitations/:id/decision */
export interface JoinResponse {
  membership: ChannelMembershipView;
  /** e.g. «طلبك بانتظار موافقة مشرف المادة» */
  message_ar: string;
}

/** GET /api/channels/join/preview?token= — PUBLIC (ADR-0003 §3.10): the channel's title only, else the generic 404. */
export interface JoinPreviewResponse {
  title_ar: string;
  kind: ChannelKind;
  requires_approval: boolean;
}

/**
 * Class codes use Crockford's base32 alphabet (no I, L, O, U): 8 symbols = 40 bits, shown as \u00abABCD-EFGH\u00bb
 * (P1-T4 step 1; review W2-step0 N9 \u2014 fixed before the first code existed).
 */
export const JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 8;

/**
 * The form a class code is hashed in (`join_code.secret_hash` is a keyed hash of it): upper case, without spaces or
 * dashes, Arabic-Indic and Eastern Arabic-Indic digits read as Latin digits (a phone keyboard in Arabic types them),
 * and the look-alikes of Crockford's base32 read as the digits they resemble: O \u2192 0, I and L \u2192 1.
 */
export function normalizeJoinCode(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s\u00a0-]+/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** what a person types or pastes; normalised with `normalizeJoinCode` before hashing */
const joinCodeInput = z.string().trim().min(4, 'اكتب رمز الانضمام.').max(64, 'رمز الانضمام أطول من المعتاد؛ تأكد منه.');
/** the random part of an invite link `/join/<token>` (also what the QR encodes) */
const joinTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'رابط الدعوة غير صالح.');

/** POST /api/channels/join (rate-limited per account and per IP: preset `join`) */
export const joinWithCodeSchema = z.object({ code: joinCodeInput }).strict();
/** POST /api/channels/join/link — the QR encodes the same link */
export const joinWithLinkSchema = z.object({ token: joinTokenSchema }).strict();
export const joinPreviewQuerySchema = z.object({ token: joinTokenSchema });

/**
 * What proves a new account may join (POST /api/auth/register; P1-T1's `JoinTokenVerifier` checks it): a class code
 * or the token of an invite link / QR — both secrets. Not an invitation id (review W2-step0 R3): an invitation is
 * addressed to an EXISTING account (`channel_invitation.invitee_user_id`, accepted with POST
 * /api/channels/invitations/:id/decision), and its id is no secret — it is in the invitee's inbox and the admin list.
 * ARCHITECTURE_DELTA §7.2 lists `{ invitation_id }` here too; this contract narrows it.
 */
export const joinProofSchema = z.union([z.object({ code: joinCodeInput }).strict(), z.object({ invite_token: joinTokenSchema }).strict()]);
export type JoinProof = z.infer<typeof joinProofSchema>;

/**
 * POST /api/auth/register (ARCHITECTURE_DELTA §7.2) — a new account always comes with a join proof: there is no open
 * sign-up (PRD Q2/Q3). The server also applies its own minimum password length (config) and username rules. Like
 * /api/auth/setup and /api/auth/login it signs the new account in on THIS device, so it takes the same device fields
 * the web client sends with every sign-in (`deviceFields()` in apps/web/src/lib/auth.ts; review W2-step0 R2).
 */
export const registerWithJoinSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[\p{L}\p{N}._-]+$/u, 'اسم المستخدم يقبل الحروف والأرقام و . _ - فقط، دون مسافات.'),
    display_name: plainTextSchema({ max: 80, field_ar: 'الاسم الظاهر' }),
    password: z.string().min(1).max(256),
    join: joinProofSchema,
    device_label: z.string().trim().max(100).optional(),
    device_id: deviceIdSchema.optional(),
  })
  .strict();
export type RegisterWithJoinRequest = z.infer<typeof registerWithJoinSchema>;
export interface RegisterWithJoinResponse {
  user: MeLite;
  /** shown once */
  recovery_codes: string[];
  membership: ChannelMembershipView | null;
}

// ───────────────────────────── members (Admin / Assistant of the node or above) ─────────────────────────────

/** GET /api/channels/nodes/:id/members — one row of the members and join-requests list. */
export interface MemberView {
  membership_id: string;
  user: UserRef;
  status: MembershipStatus;
  join_method: JoinMethod;
  created_at: number;
  decided_at: number | null;
  decided_by: UserRef | null;
  reason_ar: string | null;
  /** roles held on this node */
  roles: ChannelRole[];
}

export const membersQuerySchema = cursorPageQuerySchema.extend({ status: z.enum(MEMBERSHIP_STATUSES).optional() });
/** GET /api/channels/nodes/:id/members — memberships ON this node, oldest first (P1-T4 step 1). */
export type MembersResponse = CursorPage<MemberView>;

export const MEMBER_DECISIONS = ['approve', 'reject', 'remove'] as const;
export type MemberDecision = (typeof MEMBER_DECISIONS)[number];
/** POST /api/channels/nodes/:id/members/:userId/decision — the requester is notified (`join_decided`) and audited. */
export const memberDecisionSchema = z
  .object({
    decision: z.enum(MEMBER_DECISIONS),
    reason: plainTextSchema({ max: 300, field_ar: 'السبب' }).optional(),
  })
  .strict();
export type MemberDecisionRequest = z.infer<typeof memberDecisionSchema>;

// ───────────────────────────── invitations ─────────────────────────────

export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];
export interface InvitationView {
  id: string;
  node: NodeRef;
  invitee: UserRef;
  invited_by: UserRef;
  status: InvitationStatus;
  expires_at: number;
  created_at: number;
  decided_at: number | null;
}

/** POST /api/channels/nodes/:id/invitations */
export const createInvitationsSchema = z
  .object({ user_ids: z.array(entityIdSchema).min(1).max(100) })
  .strict()
  .refine((b) => new Set(b.user_ids).size === b.user_ids.length, 'تكرر شخص في الدعوة نفسها.');
/** POST /api/channels/invitations/:id/decision — the invitee */
export const invitationDecisionSchema = z.object({ accept: z.boolean() }).strict();

/**
 * GET /api/channels/invitations (the viewer's own pending invitations — review W2-step0 N5) and POST
 * /api/channels/nodes/:id/invitations (the invitations sent; members already in are skipped). P1-T4 step 1, additive.
 */
export interface InvitationsResponse {
  invitations: InvitationView[];
}

/**
 * POST /api/channels/invitations/:id/decision — a `JoinResponse` plus the decided invitation; `membership` is null
 * after a decline (P1-T4 step 1, additive: a decline creates no membership).
 */
export interface InvitationDecisionResponse {
  invitation: InvitationView;
  membership: ChannelMembershipView | null;
  message_ar: string;
}

/**
 * (C2, AOS-18.5) GET /api/channels/nodes/:id/invitations?status= — the invitations sent into a node, newest first (the
 * node's Admins / Assistants; others 403 like the members list). A pending invitation past its time reads «expired».
 * DELETE /api/channels/invitations/:id — revoke a pending one (audited; id-addressed: the 404 of a missing id to anyone
 * who may not manage the node's members) → InvitationView.
 */
export const nodeInvitationsQuerySchema = z.object({ status: z.enum(INVITATION_STATUSES).optional() }).strict();
export type NodeInvitationsQuery = z.infer<typeof nodeInvitationsQuerySchema>;

/**
 * (C2, AOS-18.5) GET /api/channels/nodes/:id/invitees?q= — the person picker of «ادعُ أشخاصًا». Never a directory of
 * every account: it finds (a) the account whose username is EXACTLY `q` (the inviter knows it) and (b) the approved
 * members of the channels the inviter already manages around this node (the university / college / stage above it and
 * what lies below the topmost one they manage) whose name or username starts with `q`. At most 10; rate-limited.
 */
export const inviteeSearchQuerySchema = z.object({ q: z.string().trim().min(2, 'اكتب حرفين على الأقل.').max(64) }).strict();
export type InviteeSearchQuery = z.infer<typeof inviteeSearchQuerySchema>;
export interface InviteeCandidate {
  user: UserRef;
  /** how they were found: the exact username, or a member of a channel the inviter manages */
  match: 'username' | 'member';
  /** «عضو في …» — the channel they belong to (only for `member`) */
  where_ar: string | null;
  /** already in this node (or above it), already invited, or can be invited now */
  state: 'can_invite' | 'member' | 'invited';
}
export interface InviteeSearchResponse {
  candidates: InviteeCandidate[];
}

// ───────────────────────────── class codes and invite links ─────────────────────────────

export const JOIN_CODE_KINDS = ['class_code', 'invite_link'] as const;
export type JoinCodeKind = (typeof JOIN_CODE_KINDS)[number];

/** A code as the admin list shows it: never the code itself (stored hashed), only its last characters. */
export interface JoinCodeView {
  id: string;
  node: NodeRef;
  kind: JoinCodeKind;
  /** the last 2 characters, to tell codes apart */
  hint: string;
  requires_approval: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: number;
  revoked_at: number | null;
  created_by: UserRef;
  created_at: number;
}
export interface JoinCodesResponse {
  codes: JoinCodeView[];
}

/** POST /api/channels/nodes/:id/codes — expiry is required (at most 180 days); `max_uses` optional. */
export const createJoinCodeSchema = z
  .object({
    kind: z.enum(JOIN_CODE_KINDS),
    expires_in_hours: z.number().int().min(1).max(24 * 180),
    max_uses: z.number().int().min(1).max(10_000).optional(),
    requires_approval: z.boolean(),
  })
  .strict();
export type CreateJoinCodeRequest = z.infer<typeof createJoinCodeSchema>;

/** The plaintext is in this response ONCE (the server keeps only its hash). */
export interface CreateJoinCodeResponse {
  view: JoinCodeView;
  /** class_code: base32 groups «ABCD-EFGH» */
  code?: string;
  /** invite_link: https://<origin>/join/<token> */
  link?: string;
  /** the same link, for the QR renderer */
  qr_payload?: string;
}

// ───────────────────────────── roles (2100) ─────────────────────────────

export interface ChannelRoleView {
  id: string;
  node: NodeRef;
  user: UserRef;
  role: ChannelRole;
  granted_by: UserRef;
  created_at: number;
}
export interface ChannelRolesResponse {
  roles: ChannelRoleView[];
}

/** POST /api/channels/nodes/:id/roles — an Admin assigns roles below Admin; the platform admin any role. */
export const assignRoleSchema = z.object({ user_id: entityIdSchema, role: channelRoleSchema }).strict();
export type AssignRoleRequest = z.infer<typeof assignRoleSchema>;

// ───────────────────────────── course follow «تابع المادة» (2050 `course_follow`) ─────────────────────────────

/** Not a payment: new official lectures of the subject are added to the library as stubs (links, not copies). */
export interface CourseFollowView {
  subject: NodeRef;
  add_new_lectures: boolean;
  /** the library folder of the follower's vault where new stubs appear (null: «موادي من القنوات») */
  library_folder_id: string | null;
  created_at: number;
}

/** PUT /api/channels/subjects/:id/follow (DELETE unfollows) — members of the subject only. */
export const courseFollowSchema = z
  .object({
    add_new_lectures: z.boolean(),
    library_folder_id: entityIdSchema.nullable().optional(),
  })
  .strict();
export type CourseFollowRequest = z.infer<typeof courseFollowSchema>;
/**
 * DELETE /api/channels/subjects/:id/follow — the follow ended (P1-T4 step 2, additive). Idempotent: unfollowing a
 * subject one does not follow answers the same. Lectures already added to the library stay there (links, not copies).
 */
export interface CourseUnfollowResponse {
  subject: NodeRef;
  course_follow: null;
}
