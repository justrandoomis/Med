// Artifact rows ↔ ArtifactView (shared/evidence.ts) + lineage, freeze, cache lookup (§17, §18, ARCHITECTURE §3.7).
// A cached artifact is reused only when its key matches EXACTLY and canReuse() (evidence module) says its
// dependencies still exist and are not stale. Abstentions are never served from the cache.
import {
  ABSTAIN_REASON_LABELS_AR,
  type AbstainReason,
  type ArtifactView,
  type ResolvedScope,
  type RichText,
  type ScopeMode,
  type SelectionAnchor,
  type SourceScope,
  type StudyArtifactView,
  type StudyBlockMeta,
  type StudyBlockView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { canReuse, getClaimViews } from '../evidence/services';
import { claimIdsOf } from './text';

export type ArtifactKind = ArtifactView['kind'];
export type ArtifactStatus = ArtifactView['status'];

/** What is stored in artifact.scope_json (the resolved lock, never the request alone). */
export interface StoredScope {
  mode: ScopeMode;
  source_ids: string[];
  version_ids: string[];
  version_by_source: Record<string, string>;
  describe_ar: string;
  hash: string;
  include_my_notes: boolean;
  allow_external: boolean;
}

export function storedScope(s: ResolvedScope): StoredScope {
  return {
    mode: s.mode,
    source_ids: [...s.sourceIds],
    version_ids: [...s.versionIds],
    version_by_source: { ...s.versionBySource },
    describe_ar: s.describeAr,
    hash: s.hash,
    include_my_notes: s.includeMyNotes,
    allow_external: s.allowExternal,
  };
}

export interface ArtifactRow {
  id: string;
  lineage_id: string;
  version_no: number;
  kind: ArtifactKind;
  title: string | null;
  primary_source_id: string | null;
  scope_json: string;
  params_json: string;
  cache_key: string;
  rules_version: string;
  generator_version: string;
  verifier_version: string;
  model: string | null;
  status: ArtifactStatus;
  coverage_json: string | null;
  job_id: string | null;
  is_frozen: number;
  stale_reason: string | null;
  created_at: number;
  published_at: number | null;
  updated_at: number;
  abstain_json: string | null;
  removed_json: string | null;
  anchor_json: string | null;
  parent_artifact_id: string | null;
  scope_hash: string | null;
}

interface BlockRow {
  id: string;
  artifact_id: string;
  block_key: string;
  section_key: string | null;
  ord: number;
  kind: ArtifactView['blocks'][number]['kind'];
  content_json: string;
  source_region_ids_json: string;
  status: 'complete' | 'incomplete' | 'rejected';
  verification_status: ArtifactView['blocks'][number]['verification_status'];
  table_json: string | null;
  meta_json: string | null;
}

export function getArtifactRow(ctx: AppContext, id: string): ArtifactRow | undefined {
  return ctx.db.get<ArtifactRow>('SELECT * FROM artifact WHERE id = ?', [id]);
}

export function requireArtifact(ctx: AppContext, id: string): ArtifactRow {
  const row = getArtifactRow(ctx, id);
  if (!row) throw new AppError('NOT_FOUND', 'المحتوى المولَّد المطلوب غير موجود.', 404, { artifact_id: id });
  return row;
}

export interface AbstainView {
  reason: AbstainReason;
  reason_ar: string;
  detail?: string;
  suggest_scope?: SourceScope;
}

export function abstainView(reason: AbstainReason, detail?: string | null, suggest?: SourceScope | null): AbstainView {
  const out: AbstainView = { reason, reason_ar: ABSTAIN_REASON_LABELS_AR[reason] };
  if (detail) out.detail = detail;
  if (suggest) out.suggest_scope = suggest;
  return out;
}

/** Full view of one artifact version: blocks, the claims their runs reference, removed sentences, abstention. */
export function artifactView(ctx: AppContext, idOrRow: string | ArtifactRow): StudyArtifactView {
  const a = typeof idOrRow === 'string' ? requireArtifact(ctx, idOrRow) : idOrRow;
  const scope = fromJson<StoredScope>(a.scope_json) ?? ({ mode: 'lecture_only', source_ids: [], version_ids: [], describe_ar: '', hash: '' } as unknown as StoredScope);
  const rows = ctx.db.all<BlockRow>('SELECT * FROM content_block WHERE artifact_id = ? ORDER BY ord, id', [a.id]);
  const blocks: StudyBlockView[] = rows.map((b) => {
    const table = fromJson<{ header: RichText[]; rows: RichText[][] }>(b.table_json);
    return {
      id: b.id,
      block_key: b.block_key,
      section_key: b.section_key,
      ord: b.ord,
      kind: b.kind,
      content: fromJson<RichText>(b.content_json) ?? { v: 1, paragraphs: [] },
      table: table ?? null,
      source_region_ids: fromJson<string[]>(b.source_region_ids_json, []) ?? [],
      status: b.status,
      verification_status: b.verification_status,
      meta: fromJson<StudyBlockMeta>(b.meta_json),
    };
  });
  const claimIds = new Set<string>();
  for (const b of blocks) {
    for (const id of claimIdsOf(b.content)) claimIds.add(id);
    if (b.table) for (const rt of [...b.table.header, ...b.table.rows.flat()]) for (const id of claimIdsOf(rt)) claimIds.add(id);
  }
  // a frozen artifact keeps its versions on purpose: its evidence is not reported as «replaced»
  const claims = getClaimViews(ctx, [...claimIds], { pinnedVersionIds: a.is_frozen ? scope.version_ids : [] });
  const versions = ctx.db
    .all<{ id: string; version_no: number; status: ArtifactStatus; is_frozen: number; created_at: number; published_at: number | null }>(
      'SELECT id, version_no, status, is_frozen, created_at, published_at FROM artifact WHERE lineage_id = ? ORDER BY version_no DESC LIMIT 50',
      [a.lineage_id],
    )
    .map((v) => ({ ...v, is_frozen: v.is_frozen === 1 }));
  const abstain = fromJson<AbstainView>(a.abstain_json);
  return {
    id: a.id,
    lineage_id: a.lineage_id,
    version_no: a.version_no,
    kind: a.kind,
    title: a.title,
    primary_source_id: a.primary_source_id,
    scope: { mode: scope.mode, source_ids: scope.source_ids, version_ids: scope.version_ids, describe_ar: scope.describe_ar },
    params: fromJson<Record<string, unknown>>(a.params_json, {}) ?? {},
    status: a.status,
    model: a.model,
    rules_version: a.rules_version,
    coverage: fromJson<ArtifactView['coverage']>(a.coverage_json),
    is_frozen: a.is_frozen === 1,
    stale_reason: a.stale_reason,
    created_at: a.created_at,
    published_at: a.published_at,
    blocks,
    claims,
    removed: fromJson<ArtifactView['removed']>(a.removed_json, []) ?? [],
    abstain: abstain ?? null,
    anchor: fromJson<SelectionAnchor>(a.anchor_json),
    parent_artifact_id: a.parent_artifact_id,
    job_id: a.job_id,
    versions,
  };
}

/** A published, non-abstained artifact with exactly this key whose dependencies are still valid. */
export function findReusable(ctx: AppContext, cacheKey: string, kind: ArtifactKind): ArtifactRow | null {
  const rows = ctx.db.all<ArtifactRow>(
    `SELECT * FROM artifact WHERE cache_key = ? AND kind = ? AND status = 'published' AND abstain_json IS NULL ORDER BY created_at DESC, id DESC LIMIT 5`,
    [cacheKey, kind],
  );
  for (const r of rows) if (canReuse(ctx, 'artifact', r.id).usable) return r;
  return null;
}

export function nextVersionNo(ctx: AppContext, lineageId: string): number {
  return (ctx.db.get<{ m: number | null }>('SELECT MAX(version_no) AS m FROM artifact WHERE lineage_id = ?', [lineageId])?.m ?? 0) + 1;
}

export function setFrozen(ctx: AppContext, id: string, frozen: boolean): StudyArtifactView {
  const a = requireArtifact(ctx, id);
  if (frozen && !['published', 'partial', 'stale'].includes(a.status)) {
    throw new AppError('CONFLICT', 'لا يمكن تثبيت محتوى لم يُنشر بعد.', 409);
  }
  ctx.db.run('UPDATE artifact SET is_frozen = ?, updated_at = ? WHERE id = ?', [frozen ? 1 : 0, ctx.clock.now(), id]);
  ctx.audit.record({
    entityType: 'artifact',
    entityId: id,
    action: frozen ? 'freeze' : 'unfreeze',
    summary: frozen ? `تثبيت «${a.title ?? 'محتوى مولَّد'}» على النسخة ${a.version_no}` : `إلغاء تثبيت «${a.title ?? 'محتوى مولَّد'}»`,
  });
  return artifactView(ctx, id);
}
