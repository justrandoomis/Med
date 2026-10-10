// Rows of the cases module: clinical_case (identity), clinical_case_version (immutable definitions), case_attempt
// (snapshot) and case_event (append-only log). Synchronous helpers (safe inside ctx.db.tx).
import type { CaseDefinition, CaseGenerationInfo, CaseKind, CaseOrigin, CaseStatus, CaseValidationIssue, ResolvedScope, SourceScope } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';

export interface CaseRow {
  id: string;
  title: string;
  kind: CaseKind;
  scope_json: string;
  definition_json: string;
  is_generated: number;
  status: CaseStatus;
  artifact_id: string | null;
  origin: CaseOrigin;
  current_version_no: number;
  station_type: string | null;
  source_id: string | null;
  generation_json: string | null;
  status_reasons_json: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  case_id: string;
  version_no: number;
  definition_json: string;
  scope_json: string | null;
  origin: CaseOrigin;
  status: CaseStatus;
  validation_json: string;
  created_at: number;
}

export interface AttemptRow {
  id: string;
  case_id: string;
  state_json: string;
  events_json: string;
  assessment_json: string | null;
  status: 'in_progress' | 'completed' | 'abandoned';
  started_at: number;
  finished_at: number | null;
  updated_at: number;
  case_version_id: string | null;
  feedback: 'immediate' | 'end';
  judge: 'deterministic' | 'ai';
  mode: 'text' | 'voice';
  last_seq: number;
}

export interface EventRow {
  id: string;
  attempt_id: string;
  seq: number;
  type: string;
  payload_json: string;
  created_at: number;
}

/** What a version stores about its Source Lock. */
export interface StoredScope {
  request: SourceScope;
  resolved: ResolvedScope;
}

export const NOT_FOUND_AR = 'الحالة غير موجودة.';

export function getCaseRow(ctx: AppContext, id: string, opts: { includeDeleted?: boolean } = {}): CaseRow {
  const r = ctx.db.get<CaseRow>('SELECT * FROM clinical_case WHERE id = ?', [id]);
  if (!r || (r.deleted_at !== null && !opts.includeDeleted)) throw new AppError('NOT_FOUND', NOT_FOUND_AR, 404);
  return r;
}

export function getVersionRow(ctx: AppContext, caseId: string, versionNo: number): VersionRow {
  const v = ctx.db.get<VersionRow>('SELECT * FROM clinical_case_version WHERE case_id = ? AND version_no = ?', [caseId, versionNo]);
  if (!v) throw new AppError('NOT_FOUND', 'نسخة الحالة غير موجودة.', 404);
  return v;
}

export function getVersionById(ctx: AppContext, id: string): VersionRow {
  const v = ctx.db.get<VersionRow>('SELECT * FROM clinical_case_version WHERE id = ?', [id]);
  if (!v) throw new AppError('NOT_FOUND', 'نسخة الحالة غير موجودة.', 404);
  return v;
}

export function definitionOf(v: Pick<VersionRow, 'definition_json'>): CaseDefinition {
  return fromJson<CaseDefinition>(v.definition_json)!;
}

export function scopeOf(v: Pick<VersionRow, 'scope_json'>): StoredScope | null {
  return fromJson<StoredScope | null>(v.scope_json, null);
}

export function validationOf(v: Pick<VersionRow, 'validation_json'>): CaseValidationIssue[] {
  return fromJson<CaseValidationIssue[]>(v.validation_json, []) ?? [];
}

export function generationOf(r: Pick<CaseRow, 'generation_json'>): (CaseGenerationInfo & { request?: unknown }) | null {
  return fromJson<(CaseGenerationInfo & { request?: unknown }) | null>(r.generation_json, null);
}

export function getAttemptRow(ctx: AppContext, id: string): AttemptRow {
  const a = ctx.db.get<AttemptRow>('SELECT * FROM case_attempt WHERE id = ?', [id]);
  if (!a) throw new AppError('NOT_FOUND', 'المحاولة غير موجودة.', 404);
  return a;
}

export function eventsOf(ctx: AppContext, attemptId: string): EventRow[] {
  return ctx.db.all<EventRow>('SELECT * FROM case_event WHERE attempt_id = ? ORDER BY seq', [attemptId]);
}

export function attemptCount(ctx: AppContext, caseId: string): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM case_attempt WHERE case_id = ?', [caseId])?.n ?? 0;
}
