// Source Lock (§8). The scope is a SERVER-ENFORCED constraint applied before retrieval, during
// generation, during verification and in cache keys. It is not a UI toggle or a prompt instruction.
import { z } from 'zod';

export const SCOPE_MODES = ['lecture_only', 'references_only', 'lecture_plus_references', 'external'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];

export const SCOPE_MODE_LABELS_AR: Record<ScopeMode, string> = {
  lecture_only: 'المحاضرة فقط',
  references_only: 'المراجع المختارة فقط',
  lecture_plus_references: 'المحاضرة + المراجع',
  external: 'أدلة خارجية مسموحة',
};

export const sourceScopeSchema = z.object({
  mode: z.enum(SCOPE_MODES),
  /** focal lecture (required for lecture_only / lecture_plus_references) */
  lecture_source_id: z.string().optional(),
  /** references explicitly chosen by the owner */
  reference_source_ids: z.array(z.string()).default([]),
  /** optional explicit version pins; otherwise server uses frozen_version_id ?? current_version_id */
  version_pins: z.record(z.string(), z.string()).default({}),
  /** My Notes are low-assurance; only included when explicitly requested */
  include_my_notes: z.boolean().default(false),
});
export type SourceScope = z.infer<typeof sourceScopeSchema>;

/** Server-resolved scope. `hash` participates in every cache key. */
export interface ResolvedScope {
  mode: ScopeMode;
  sourceIds: string[];
  versionIds: string[];
  /** sourceId -> versionId actually used */
  versionBySource: Record<string, string>;
  allowExternal: boolean;
  includeMyNotes: boolean;
  hash: string;
  describeAr: string;
}

/** Deterministic JSON stringify (sorted keys) for hashing cache keys and scopes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}
