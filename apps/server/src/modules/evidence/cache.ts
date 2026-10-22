// Cache keys & reuse checks (§17, ARCHITECTURE §3.7). A generated artifact is reused only when its key
// matches EXACTLY and its dependencies still exist and are not stale. The key always contains the resolved
// scope hash, so a lecture-only request can never hit an artifact produced with a wider scope (AC-05).
//
// AOS-18.17 / 21.42 (ARCHITECTURE_DELTA §10.6): the key also carries
//   * the VIEWER dimension — `hash(user id)` whenever the request touches anything private (the user's own uploads, a
//     source that is not an official stub, «ملاحظاتي» / include_my_notes), otherwise the constant `shared`. A stub of an
//     official lecture has the SAME version ids in every member's vault, so without it two members' private requests
//     over one official lecture got the same key and a cache shared between them would serve one user's private answer
//     to another;
//   * the OFFICIAL dimension — the origin of every locked version: `official:<space id>` for a stub of a published
//     official version, `own` for the user's own sources. An artifact built from something that is not official content
//     (a private copy, a student's explanation) therefore never has the key of an official-lecture request.
// Artifacts made before these dimensions existed are found again through `legacyKey` — only for requests that touch no
// shared (official) content, so the lookup can only ever reach the user's own vault's artifacts.
import { stableStringify, type ResolvedScope } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';

export interface CacheKeyInput {
  /** artifact kind + anything that selects the content (e.g. 'study_book', section keys, anchor ids) */
  kind: string;
  scope: ResolvedScope;
  rulesVersion: string;
  generatorVersion: string;
  verifierVersion: string;
  level?: string | null;
  language?: string | null;
  dialect?: string | null;
  /** owner settings that change the output (custom instruction, answer style, …) */
  settings?: Record<string, unknown>;
  /** extra request parameters (page indexes, selection anchor, summary type, …) */
  params?: Record<string, unknown>;
}

/** The origin of each locked version and the viewer dimension of a request (AOS-18.17). */
export interface KeyDimensions {
  /** `shared` when the request touches only official content; otherwise sha256 of the user id */
  viewer: string;
  /** versionId → `official:<space id>` | `own` */
  origins: Record<string, string>;
  /** the request touches the user's private content */
  privateParts: boolean;
  /** the request touches shared (official) content */
  sharedParts: boolean;
}

/** The user the bound database belongs to (the request's viewer, or the vault's owner for background work). */
function keyUserId(ctx: AppContext): string | null {
  return ctx.tenancy.fileTokenScope()?.userId ?? null;
}

export function keyDimensions(ctx: AppContext, scope: Pick<ResolvedScope, 'versionIds' | 'includeMyNotes'>): KeyDimensions {
  const origins: Record<string, string> = {};
  for (const id of [...scope.versionIds].sort()) {
    const r = ctx.db.get<{ is_stub: number | null; origin_space_id: string | null }>(
      'SELECT s.is_stub, s.origin_space_id FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
      [id],
    );
    origins[id] = r && r.is_stub === 1 && r.origin_space_id ? `official:${r.origin_space_id}` : 'own';
  }
  const values = Object.values(origins);
  const privateParts = scope.includeMyNotes === true || values.some((o) => o === 'own');
  const sharedParts = values.some((o) => o.startsWith('official:'));
  const viewer = privateParts ? sha256(`viewer:${keyUserId(ctx) ?? 'unknown'}`) : 'shared';
  return { viewer, origins, privateParts, sharedParts };
}

export interface CacheKeys {
  /** the key artifacts are stored under from now on */
  key: string;
  /** the key of the same request before AOS-18.17 — only for requests that touch no shared content (see the header) */
  legacyKey: string | null;
  dims: KeyDimensions;
}

/**
 * sha256(stableStringify({kind, source versions + content hashes, scope.hash, rules, level, language, dialect,
 * settings, generator/verifier versions, params, viewer, origins})). Throws when the scope has no versions.
 */
export function cacheKeys(ctx: AppContext, input: CacheKeyInput): CacheKeys {
  const { scope } = input;
  if (!scope?.hash || !Array.isArray(scope.versionIds) || scope.versionIds.length === 0) {
    throw new AppError('OUT_OF_SCOPE', 'لا يمكن حساب مفتاح التخزين دون نطاق مصادر محسوم.', 409);
  }
  const versions = [...scope.versionIds].sort().map((id) => ({
    id,
    hash: ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM source_version WHERE id = ?', [id])?.content_hash ?? null,
  }));
  const base = {
    kind: input.kind,
    versions,
    scope: scope.hash,
    rules: input.rulesVersion,
    generator: input.generatorVersion,
    verifier: input.verifierVersion,
    level: input.level ?? null,
    language: input.language ?? null,
    dialect: input.dialect ?? null,
    settings: input.settings ?? {},
    params: input.params ?? {},
  };
  const dims = keyDimensions(ctx, scope);
  return {
    key: sha256(stableStringify({ ...base, viewer: dims.viewer, origins: dims.origins })),
    legacyKey: dims.sharedParts ? null : sha256(stableStringify(base)),
    dims,
  };
}

/** The key artifacts are stored under (see cacheKeys). */
export function cacheKey(ctx: AppContext, input: CacheKeyInput): string {
  return cacheKeys(ctx, input).key;
}

/** Keys to look an artifact up by: the current one first, then the legacy one when it may be used. */
export function lookupKeys(k: string | CacheKeys): string[] {
  if (typeof k === 'string') return [k];
  return k.legacyKey && k.legacyKey !== k.key ? [k.key, k.legacyKey] : [k.key];
}

export interface ReuseCheck {
  usable: boolean;
  /** Arabic reason when not usable */
  reason_ar: string | null;
}

/**
 * Can a cached dependent (artifact, question version, …) be served again? Its recorded source versions must
 * still exist, their sources must not be in the trash, and an artifact must not be stale/failed/superseded.
 */
export function canReuse(ctx: AppContext, dependentType: string, dependentId: string): ReuseCheck {
  if (dependentType === 'artifact') {
    const a = ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [dependentId]);
    if (!a) return { usable: false, reason_ar: 'المحتوى المخزّن غير موجود.' };
    if (['stale', 'failed', 'superseded', 'generating', 'draft'].includes(a.status)) {
      return { usable: false, reason_ar: a.status === 'stale' ? 'تغيّر مصدر يعتمد عليه هذا المحتوى؛ يحتاج إعادة توليد أو مراجعة.' : 'المحتوى المخزّن غير منشور.' };
    }
  }
  const deps = ctx.db.all<{ source_version_id: string; v: string | null; deleted_at: number | null; src: string | null; region_id: string | null; region: string | null }>(
    `SELECT d.source_version_id, v.id AS v, s.deleted_at, s.id AS src, d.region_id, r.id AS region FROM artifact_dependency d
       LEFT JOIN source_version v ON v.id = d.source_version_id LEFT JOIN source s ON s.id = v.source_id
       LEFT JOIN source_region r ON r.id = d.region_id
      WHERE d.dependent_type = ? AND d.dependent_id = ?`,
    [dependentType, dependentId],
  );
  if (deps.length === 0) return { usable: false, reason_ar: 'لا تُعرف المصادر التي اعتمد عليها هذا المحتوى؛ لا يُعاد استخدامه.' };
  if (deps.some((d) => !d.v || !d.src)) return { usable: false, reason_ar: 'حُذفت نسخة مصدر يعتمد عليها هذا المحتوى.' };
  if (deps.some((d) => d.deleted_at !== null)) return { usable: false, reason_ar: 'مصدر يعتمد عليه هذا المحتوى في سلة المحذوفات.' };
  // a cited region that no longer exists (its page was re-processed / corrected) — even before the content
  // alert for that re-processing has been reconciled
  if (deps.some((d) => d.region_id !== null && !d.region)) {
    return { usable: false, reason_ar: 'أُعيدت معالجة صفحة يعتمد عليها هذا المحتوى، فلم يعد النص المستشهد به موجودًا كما هو؛ يحتاج إعادة توليد أو مراجعة.' };
  }
  return { usable: true, reason_ar: null };
}
