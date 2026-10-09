// Cache keys & reuse checks (§17, ARCHITECTURE §3.7). A generated artifact is reused only when its key
// matches EXACTLY and its dependencies still exist and are not stale. The key always contains the resolved
// scope hash, so a lecture-only request can never hit an artifact produced with a wider scope (AC-05).
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

/**
 * sha256(stableStringify({kind, source versions + content hashes, scope.hash, rules, level, language, dialect,
 * settings, generator/verifier versions, params})). Throws when the scope has no versions (nothing to key).
 */
export function cacheKey(ctx: AppContext, input: CacheKeyInput): string {
  const { scope } = input;
  if (!scope?.hash || !Array.isArray(scope.versionIds) || scope.versionIds.length === 0) {
    throw new AppError('OUT_OF_SCOPE', 'لا يمكن حساب مفتاح التخزين دون نطاق مصادر محسوم.', 409);
  }
  const versions = [...scope.versionIds].sort().map((id) => ({
    id,
    hash: ctx.db.get<{ content_hash: string }>('SELECT content_hash FROM source_version WHERE id = ?', [id])?.content_hash ?? null,
  }));
  return sha256(
    stableStringify({
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
    }),
  );
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
