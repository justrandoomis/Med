// Source Lock (§08, ARCHITECTURE §3.7): resolve an owner's SourceScope into the exact source versions the
// server will allow in retrieval, generation, verification and cache keys. The scope is decided HERE from
// the request and the database — never from model output or document text (AC-29).
//
//  lecture_only            → the focal lecture's version (version_pins ?? frozen ?? current); nothing else
//  references_only         → the chosen references only
//  lecture_plus_references → both, each source marked with its origin (lecture / reference)
//  external                → only when the owner enabled external evidence; otherwise refused with the reason
//  include_my_notes        → «ملاحظاتي» sources only when explicitly requested (low assurance)
// Trashed / purged sources are excluded with a specific Arabic reason. hash = sha256(stableStringify(…)).
import {
  SCOPE_MODE_LABELS_AR,
  SOURCE_TYPE_LABELS_AR,
  sourceScopeSchema,
  stableStringify,
  type ProcessingStatus,
  type ResolvedScope,
  type ScopeExclusion,
  type ScopeOrigin,
  type ScopeSourceView,
  type SourceScope,
  type SourceType,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { parseWith } from '../../lib/http';

/** A resolved scope plus what the owner needs to see (origins, exclusions). Structurally a ResolvedScope. */
export interface ScopeReport extends ResolvedScope {
  /** sourceId → origin in this scope */
  origins: Record<string, ScopeOrigin>;
  sources: ScopeSourceView[];
  excluded: ScopeExclusion[];
}

interface SourceRow {
  id: string;
  title: string;
  source_type: SourceType;
  current_version_id: string | null;
  frozen_version_id: string | null;
  deleted_at: number | null;
}

interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  processing_status: ProcessingStatus;
}

const MSG = {
  lectureRequired: 'حدّد المحاضرة (lecture_source_id) لهذا النطاق.',
  referencesRequired: 'اختر مرجعًا واحدًا على الأقل لنطاق «المراجع المختارة فقط».',
  externalDisabled:
    'الأدلة الخارجية غير مفعّلة: لم تُبنَ هذه الميزة بعد ولا يوجد إعداد لتفعيلها، لذلك يبقى البحث داخل مصادرك فقط. اختر نطاقًا آخر.',
  sourceMissing: 'هذا المصدر غير موجود (ربما حُذف نهائيًا).',
  sourceTrashed: 'هذا المصدر في سلة المحذوفات؛ لا يُستخدم دليلًا حتى تستعيده.',
  noVersion: 'لا توجد نسخة قابلة للاستخدام من هذا المصدر بعد.',
  pinForeign: 'النسخة المثبتة في الطلب لا تخص هذا المصدر.',
  pinMissing: 'النسخة المثبتة في الطلب غير موجودة.',
  myNotesNotRequested: '«ملاحظاتي» مصدر منخفض الموثوقية؛ لا يدخل النطاق إلا بطلب صريح (include_my_notes).',
  lectureTrashed: 'المحاضرة المحددة في سلة المحذوفات أو محذوفة؛ لا يمكن قفل النطاق عليها.',
  nothingLeft: 'لم يبقَ أي مصدر صالح في النطاق المطلوب.',
};

/**
 * Whether the owner enabled external evidence. The shared settings schema has no such key yet and the
 * `external.evidence` capability is not implemented, so this is false in this build (documented). A future
 * `external_evidence_enabled` setting is read without code changes here.
 */
export function externalEvidenceEnabled(ctx: AppContext): boolean {
  if (!ctx.capabilities.isAvailable('external.evidence')) return false;
  const s = ctx.settings.get() as unknown as Record<string, unknown>;
  return s.external_evidence_enabled === true;
}

function scopeHash(mode: SourceScope['mode'], sourceIds: string[], versionIds: string[], includeMyNotes: boolean, allowExternal: boolean): string {
  return sha256(
    stableStringify({
      mode,
      source_ids: [...sourceIds].sort(),
      version_ids: [...versionIds].sort(),
      include_my_notes: includeMyNotes,
      allow_external: allowExternal,
    }),
  );
}

function cleanTitle(title: string): string {
  return title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
}

/**
 * Resolve a SourceScope. Throws OUT_OF_SCOPE / FEATURE_DISABLED / VALIDATION_FAILED with an Arabic reason
 * when the request cannot be honoured (never widens silently).
 */
export function resolveScope(ctx: AppContext, input: SourceScope | unknown): ScopeReport {
  const scope = parseWith(sourceScopeSchema, input, 'body');
  const { db } = ctx;
  const allowExternal = externalEvidenceEnabled(ctx);
  if (scope.mode === 'external' && !allowExternal) {
    throw new AppError('FEATURE_DISABLED', MSG.externalDisabled, 409, { mode: scope.mode });
  }

  const excluded: ScopeExclusion[] = [];
  const picked: Array<{ src: SourceRow; version: VersionRow; origin: ScopeOrigin; pinned: boolean }> = [];
  const seen = new Set<string>();

  const getSource = (id: string) =>
    db.get<SourceRow>('SELECT id, title, source_type, current_version_id, frozen_version_id, deleted_at FROM source WHERE id = ?', [id]);

  const pick = (sourceId: string, origin: ScopeOrigin, opts: { required?: boolean } = {}): void => {
    if (seen.has(sourceId)) return;
    seen.add(sourceId);
    const src = getSource(sourceId);
    if (!src) {
      if (opts.required) throw new AppError('OUT_OF_SCOPE', MSG.lectureTrashed, 409, { source_id: sourceId });
      excluded.push({ source_id: sourceId, title: null, reason_ar: MSG.sourceMissing });
      return;
    }
    if (src.deleted_at !== null) {
      if (opts.required) throw new AppError('OUT_OF_SCOPE', MSG.lectureTrashed, 409, { source_id: sourceId });
      excluded.push({ source_id: sourceId, title: cleanTitle(src.title), reason_ar: MSG.sourceTrashed });
      return;
    }
    if (src.source_type === 'my_notes' && origin !== 'lecture' && !scope.include_my_notes) {
      excluded.push({ source_id: sourceId, title: cleanTitle(src.title), reason_ar: MSG.myNotesNotRequested });
      return;
    }
    const pin = scope.version_pins[sourceId];
    let versionId: string | null = null;
    let pinned = false;
    if (pin) {
      const v = db.get<{ source_id: string }>('SELECT source_id FROM source_version WHERE id = ?', [pin]);
      if (!v) throw new AppError('VALIDATION_FAILED', MSG.pinMissing, 400, { source_id: sourceId, version_id: pin });
      if (v.source_id !== sourceId) throw new AppError('VALIDATION_FAILED', MSG.pinForeign, 400, { source_id: sourceId, version_id: pin });
      versionId = pin;
      pinned = true;
    } else {
      versionId = src.frozen_version_id ?? src.current_version_id;
    }
    const version = versionId
      ? db.get<VersionRow>('SELECT id, source_id, version_no, processing_status FROM source_version WHERE id = ?', [versionId])
      : undefined;
    if (!version) {
      if (opts.required) throw new AppError('OUT_OF_SCOPE', MSG.noVersion, 409, { source_id: sourceId });
      excluded.push({ source_id: sourceId, title: cleanTitle(src.title), reason_ar: MSG.noVersion });
      return;
    }
    picked.push({ src, version, origin: src.source_type === 'my_notes' && origin !== 'lecture' ? 'my_notes' : origin, pinned });
  };

  const needsLecture = scope.mode === 'lecture_only' || scope.mode === 'lecture_plus_references';
  if (needsLecture) {
    if (!scope.lecture_source_id) throw new AppError('VALIDATION_FAILED', MSG.lectureRequired, 400, { mode: scope.mode });
    pick(scope.lecture_source_id, 'lecture', { required: true });
  }

  if (scope.mode === 'references_only') {
    if (scope.reference_source_ids.length === 0) throw new AppError('VALIDATION_FAILED', MSG.referencesRequired, 400);
    for (const id of scope.reference_source_ids) pick(id, 'reference');
  } else if (scope.mode === 'lecture_plus_references' || scope.mode === 'external') {
    let refs = scope.reference_source_ids;
    if (refs.length === 0 && scope.lecture_source_id) {
      // the lecture's own chosen references (explicit source links made by the owner)
      refs = db
        .all<{ other: string }>(
          `SELECT CASE WHEN from_source_id = ? THEN to_source_id ELSE from_source_id END AS other
             FROM source_link WHERE relation = 'reference_for' AND (from_source_id = ? OR to_source_id = ?) ORDER BY created_at`,
          [scope.lecture_source_id, scope.lecture_source_id, scope.lecture_source_id],
        )
        .map((r) => r.other);
    }
    for (const id of refs) pick(id, 'reference');
    if (scope.mode === 'external' && scope.lecture_source_id && !needsLecture) pick(scope.lecture_source_id, 'lecture');
  }

  if (scope.include_my_notes && scope.lecture_source_id) {
    // owner's «ملاحظاتي» sources explicitly linked to the lecture (any relation), low assurance
    const linked = db.all<{ other: string }>(
      `SELECT CASE WHEN l.from_source_id = ? THEN l.to_source_id ELSE l.from_source_id END AS other
         FROM source_link l JOIN source o ON o.id = CASE WHEN l.from_source_id = ? THEN l.to_source_id ELSE l.from_source_id END
        WHERE (l.from_source_id = ? OR l.to_source_id = ?) AND o.source_type = 'my_notes'
        ORDER BY l.created_at`,
      [scope.lecture_source_id, scope.lecture_source_id, scope.lecture_source_id, scope.lecture_source_id],
    );
    for (const r of linked) pick(r.other, 'my_notes');
  }

  if (picked.length === 0) throw new AppError('OUT_OF_SCOPE', MSG.nothingLeft, 409, { excluded });

  const sourceIds = picked.map((p) => p.src.id);
  const versionIds = picked.map((p) => p.version.id);
  const versionBySource: Record<string, string> = {};
  const origins: Record<string, ScopeOrigin> = {};
  for (const p of picked) {
    versionBySource[p.src.id] = p.version.id;
    origins[p.src.id] = p.origin;
  }
  const includeMyNotes = scope.include_my_notes;
  const sources: ScopeSourceView[] = picked.map((p) => ({
    source_id: p.src.id,
    title: cleanTitle(p.src.title),
    source_type: p.src.source_type,
    version_id: p.version.id,
    version_no: p.version.version_no,
    origin: p.origin,
    pinned: p.pinned,
    frozen: p.src.frozen_version_id === p.version.id,
    newer_version_exists: p.src.current_version_id !== null && p.src.current_version_id !== p.version.id,
    processing_status: p.version.processing_status,
    low_assurance: p.src.source_type === 'my_notes',
  }));

  return {
    mode: scope.mode,
    sourceIds,
    versionIds,
    versionBySource,
    allowExternal,
    includeMyNotes,
    hash: scopeHash(scope.mode, sourceIds, versionIds, includeMyNotes, allowExternal),
    describeAr: describeScopeAr(scope.mode, sources),
    origins,
    sources,
    excluded,
  };
}

/** «المحاضرة فقط: Acute Appendicitis (النسخة 1)» / «المحاضرة + المراجع: محاضرة X؛ مرجع: Y». */
export function describeScopeAr(mode: SourceScope['mode'], sources: Array<Pick<ScopeSourceView, 'title' | 'source_type' | 'version_no' | 'origin'>>): string {
  const part = (s: (typeof sources)[number]) => `${SOURCE_TYPE_LABELS_AR[s.source_type]}: ${s.title} (النسخة ${s.version_no})`;
  return `${SCOPE_MODE_LABELS_AR[mode]} — ${sources.map(part).join('؛ ')}`;
}

/** Strip the report fields: the plain ResolvedScope contract (e.g. to store in artifact.scope_json). */
export function toResolvedScope(r: ResolvedScope): ResolvedScope {
  return {
    mode: r.mode,
    sourceIds: [...r.sourceIds],
    versionIds: [...r.versionIds],
    versionBySource: { ...r.versionBySource },
    allowExternal: r.allowExternal,
    includeMyNotes: r.includeMyNotes,
    hash: r.hash,
    describeAr: r.describeAr,
  };
}

/** True when every version id belongs to the scope (server-side Source Lock assertion). */
export function inScope(scope: Pick<ResolvedScope, 'versionIds'>, versionIds: Iterable<string>): boolean {
  const allowed = new Set(scope.versionIds);
  for (const v of versionIds) if (!allowed.has(v)) return false;
  return true;
}
