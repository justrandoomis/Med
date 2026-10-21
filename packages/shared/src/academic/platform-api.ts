// Academic OS — platform operations (ARCHITECTURE_DELTA §5.8; P1-T1 step 1). Whole-deployment views for the platform
// admin only: every route under /api/platform and every whole-instance route of §5.8 answers 404 to anyone else.
// These views count accounts, databases and queued work — never the content of anyone's vault.
import { z } from 'zod';

export interface PlatformStatusResponse {
  accounts: { total: number; active: number; platform_admins: number };
  vaults: { total: number; open: number };
  spaces: { total: number };
  pool: { open: number; max: number; hits: number; misses: number; evictions: number; fd_limit: number | null };
  jobs: { queued: number; running: number; failed_last_day: number };
  /** whole-deployment routes guarded in place (method + path), for the platform section of the Control Center */
  guarded_routes: string[];
}

// ───────── P1-T1 step 2: quotas (PRD Q10, Q22) ─────────

/**
 * PUT /api/platform/quotas/users/:userId · /api/platform/quotas/spaces/:spaceId. A field left out stays as it is;
 * `null` returns to the default (2 GB per student vault, 20 GB per subject space; AI: user #1 = the deployment budget,
 * everyone else 0 until set).
 */
export const setQuotaSchema = z
  .object({
    storage_mb: z.number().int().min(0).max(100_000_000).nullable().optional(),
    ai_monthly_usd: z.number().min(0).max(100_000).nullable().optional(),
  })
  .strict();
export type SetQuotaRequest = z.infer<typeof setQuotaSchema>;

export interface PlatformQuotaView {
  subject: { kind: 'user'; user_id: string } | { kind: 'space'; space_id: string };
  storage: { limit_bytes: number | null; used_bytes: number | null; explicit: boolean };
  ai: { limit_usd: number; month: string; used_usd_est: number; explicit: boolean };
}
