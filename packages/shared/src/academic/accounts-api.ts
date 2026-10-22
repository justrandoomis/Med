// Academic OS — accounts and devices (ARCHITECTURE_DELTA §7.2; P1-T1 step 1). Types and zod schemas only.
// Every route acts on the signed-in user's OWN account; nobody — the platform admin included — reads another
// user's vault through these routes.
import { z } from 'zod';
import type { JobStatus } from '../enums';

/** The signed-in account, as the app shell needs it. */
export interface MeLite {
  id: string;
  username: string;
  display_name: string;
  is_platform_admin: boolean;
  /**
   * (P1-T1 step 3) user #1 — the first account (the owner migrated from the single-owner installation, or the account
   * of first-run setup). Only this account claims what a device kept from before accounts existed: the IndexedDB
   * database `medlevo` and the un-prefixed `localStorage` keys (ADR-0003 §5 step 8). Every other account gets its own
   * `medlevo:<id>` database and `<id>:`-prefixed keys.
   */
  owns_legacy_device_data?: boolean;
}

/** Storage / AI / ASR allowance of an account (filled by P1-T1 step 2: blob registry, quotas, AI reservations). */
export interface QuotaView {
  /** `exports_bytes` (AOS-21.43, additive): the «نسخة من بياناتي» archives kept on the server — part of used_bytes */
  storage: { used_bytes: number; limit_bytes: number | null; exports_bytes?: number };
  ai: {
    month: string;
    used_usd_est: number;
    limit_usd: number | null;
    /**
     * AOS-21.46 (additive; absent from older servers): what may still be spent this month — the smaller of the
     * allowance left and the deployment ceiling left. ESTIMATED, the numbers the atomic reservation checks.
     */
    remaining_usd?: number;
    /** AOS-21.46: when this month's allowance starts again (ms; the account's timezone) */
    resets_at?: number;
    /** AOS-21.46: null when an AI call may be tried now; otherwise why AI is refused before any call */
    blocked_reason_ar?: string | null;
  };
  asr: { month: string; used_minutes: number; limit_minutes: number | null };
  /** AOS-21.46: the AI allowance of each subject the viewer moderates (never shown to members) */
  ai_spaces?: SpaceAiAllowanceView[];
}

/** AOS-21.46: one subject space's monthly AI allowance (official-only shared work is charged to it). */
export interface SpaceAiAllowanceView {
  space_id: string;
  title: string;
  month: string;
  used_usd_est: number;
  /** 0 until the platform admin sets one */
  limit_usd: number;
  remaining_usd: number;
  resets_at: number;
}

/** Channel membership and roles arrive with P1-T4 (R1-c); until then both lists are empty. */
export interface MembershipView {
  node_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'left' | 'removed';
}
export interface RoleView {
  node_id: string;
  role: 'admin' | 'assistant' | 'subject_moderator' | 'contributor';
}

export interface MeResponse extends MeLite {
  vault_id: string;
  timezone: string;
  memberships: MembershipView[];
  roles: RoleView[];
  /** null until P1-T1 step 2 measures the allowance (never an invented number) */
  quota: QuotaView | null;
  /** the account migrated from the single-owner installation (P1-T1 step 3) */
  legacy_owner: boolean;
}

export const DEVICE_PLATFORMS = ['web', 'ios', 'android', 'other'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** One of the user's devices. `device_uid` is issued by the server and globally unique (relay receipts, CRDT ids). */
export interface DeviceView {
  device_id: string;
  device_uid: string;
  label: string | null;
  platform: DevicePlatform | null;
  /** an Ed25519 public key is registered (the key itself is not echoed) */
  has_key: boolean;
  shared_device: boolean;
  first_seen_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  /** the device of the session making the request */
  current: boolean;
}

export interface DevicesResponse {
  devices: DeviceView[];
}

/** client device ids are ULID-like tokens generated on the device */
export const deviceIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const registerDeviceSchema = z
  .object({
    device_id: deviceIdSchema,
    label: z.string().trim().max(100).optional(),
    platform: z.enum(DEVICE_PLATFORMS).optional(),
  })
  .strict();
export type RegisterDeviceRequest = z.infer<typeof registerDeviceSchema>;

/**
 * AOS-4.7 / ADR-0003 Q26 (track C3): `PATCH /api/accounts/me/devices/:deviceId` — mark one of MY devices as shared
 * («جهاز مشترك»): the web client then clears that device's local data at every sign-out.
 */
export const updateDeviceSchema = z.object({ shared_device: z.boolean() }).strict();
export type UpdateDeviceRequest = z.infer<typeof updateDeviceSchema>;

/** Ed25519 public key, base64url without padding (32 bytes → 43 characters). */
export const deviceKeySchema = z
  .object({
    public_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    alg: z.literal('Ed25519'),
  })
  .strict();
export type DeviceKeyRequest = z.infer<typeof deviceKeySchema>;

// ───────── P1-T1 step 2: export of my data, account deletion ─────────

/** «نسخة من بياناتي»: an archive of the user's OWN vault and the files it references (no other account's data). */
export interface AccountExportView {
  job_id: string;
  status: JobStatus;
  created_at: number;
  finished_at: number | null;
  file_name: string | null;
  size: number | null;
  sha256: string | null;
  /** present while the archive is on the server */
  download_url: string | null;
  /** files the vault references that are NOT in the archive (missing or damaged in the store); null before it is done */
  missing_files: number | null;
  /** an honest note when the archive is incomplete (missing_files > 0) */
  warning_ar: string | null;
  error_ar: string | null;
}

export interface AccountExportsResponse {
  exports: AccountExportView[];
  included_ar: string[];
  note_ar: string;
}

/** PRD Q14 (ADR-0003 §7): what deleting the account removes, and what it cannot. */
export interface DeletionPreview {
  vault: { sources: number; annotations: number; notes: number; recordings: number; cards: number; bytes: number };
  /** publications arrive with P1-T5; until then always 0 */
  publications: { total: number; forked_by_others: number };
  policy_ar: string[];
  confirm_token: string;
  expires_at: number;
  /** null when the account can be deleted; otherwise why not (e.g. the last platform admin) */
  blocked_ar: string | null;
}

export const accountDeleteSchema = z.union([
  z.object({ preview: z.literal(true) }).strict(),
  z.object({ confirm_token: z.string().min(10).max(512), password: z.string().min(1).max(1024) }).strict(),
]);
export type AccountDeleteRequest = z.infer<typeof accountDeleteSchema>;

export interface AccountDeleteResponse {
  status: 'deletion_pending' | 'deleted';
}

export const ACCOUNTS_LABELS_AR = {
  device_revoked: 'أُلغي هذا الجهاز. لن يُقبل منه أي تغيير حتى يُسجَّل من جديد باسم جهاز آخر.',
  device_not_found: 'الجهاز غير موجود في أجهزتك.',
  export_running: 'هناك نسخة من بياناتك قيد الإنشاء الآن. انتظر اكتمالها.',
  export_not_found: 'النسخة غير موجودة أو حُذفت. أنشئ نسخة جديدة.',
  delete_password: 'كلمة المرور غير صحيحة. لم يُحذف شيء.',
  delete_token: 'انتهت صلاحية معاينة الحذف أو لا تخص حسابك. اعرض المعاينة من جديد ثم أكّد.',
  delete_last_admin: 'لا يمكن حذف هذا الحساب لأنه آخر مسؤول للمنصة. عيّن مسؤولًا آخر أولًا.',
  former_user: 'طالب سابق',
} as const;
