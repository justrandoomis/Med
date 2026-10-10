// Views of cases (list / detail) and the module's capability summary.
import {
  AUTHORED_DATA_NOTE_AR,
  CASE_KIND_LABELS_AR,
  CASE_ORIGIN_LABELS_AR,
  CASE_STATUS_LABELS_AR,
  type CaseDetailView,
  type CaseGenerationInfo,
  type CasesCapabilities,
  type CaseSentence,
  type CaseSummaryView,
  type OsceStationType,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { getClaimViews } from '../evidence/services';
import { claimIdsOfDefinition } from './claims';
import { honestyFor, VOICE_UNAVAILABLE_AR } from './definition';
import { attemptCount, definitionOf, generationOf, getVersionRow, scopeOf, validationOf, type CaseRow } from './store';

export function casesCapabilities(ctx: AppContext): CasesCapabilities {
  const st = ctx.ai.status();
  const gen = st.tasks.case_sim;
  return {
    authoring: { available: true },
    generation: gen.available ? { available: true, reason_ar: null } : { available: false, reason_ar: gen.reason_ar ?? 'توليد الحالات يتطلب مزود ذكاء اصطناعي مضبوطًا على الخادم.' },
    ai_viva_judge: gen.available ? { available: true, reason_ar: null } : { available: false, reason_ar: gen.reason_ar ?? 'الحكم بالذكاء الاصطناعي يتطلب مزودًا مضبوطًا على الخادم؛ الحكم الحتمي بالكلمات متاح.' },
    voice: { available: false, reason_ar: VOICE_UNAVAILABLE_AR },
    text_mode: { available: true },
  };
}

function lastAttempt(ctx: AppContext, caseId: string): CaseSummaryView['last_attempt'] {
  const a = ctx.db.get<{ id: string; status: 'in_progress' | 'completed' | 'abandoned'; started_at: number; finished_at: number | null }>(
    'SELECT id, status, started_at, finished_at FROM case_attempt WHERE case_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    [caseId],
  );
  return a ?? null;
}

export function summaryView(ctx: AppContext, r: CaseRow): CaseSummaryView {
  const gen = generationOf(r);
  const version = ctx.db.get<{ scope_json: string | null }>('SELECT scope_json FROM clinical_case_version WHERE case_id = ? AND version_no = ?', [r.id, r.current_version_no]);
  const scope = version ? scopeOf(version) : null;
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    kind_label_ar: CASE_KIND_LABELS_AR[r.kind],
    station_type: (r.station_type as OsceStationType | null) ?? null,
    origin: r.origin,
    origin_label_ar: CASE_ORIGIN_LABELS_AR[r.origin],
    status: r.status,
    status_label_ar: CASE_STATUS_LABELS_AR[r.status],
    status_reasons_ar: fromJson<string[]>(r.status_reasons_json, []) ?? [],
    version_no: r.current_version_no,
    scope_describe_ar: scope?.resolved.describeAr ?? null,
    attempts: attemptCount(ctx, r.id),
    last_attempt: lastAttempt(ctx, r.id),
    generation: gen ? publicGeneration(gen) : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function publicGeneration(g: CaseGenerationInfo & { request?: unknown }): CaseGenerationInfo {
  return { status: g.status, status_label_ar: g.status_label_ar, job_id: g.job_id, message_ar: g.message_ar, removed: g.removed ?? [], model: g.model ?? null };
}

export function detailView(ctx: AppContext, r: CaseRow): CaseDetailView {
  // a generated case has no version until its generation finished (placeholder definition, nothing playable)
  const v = r.current_version_no >= 1 ? getVersionRow(ctx, r.id, r.current_version_no) : null;
  const def = v ? definitionOf(v) : definitionOf(r);
  const scope = v ? scopeOf(v) : null;
  const claims = getClaimViews(ctx, claimIdsOfDefinition(def), { pinnedVersionIds: scope?.resolved.versionIds ?? [] });
  const versions = ctx.db
    .all<{ version_no: number; created_at: number; origin: 'owner' | 'generated'; id: string }>('SELECT id, version_no, created_at, origin FROM clinical_case_version WHERE case_id = ? ORDER BY version_no DESC', [r.id])
    .map((x) => ({
      version_no: x.version_no,
      created_at: x.created_at,
      origin: x.origin,
      attempts: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM case_attempt WHERE case_version_id = ?', [x.id])?.n ?? 0,
    }));
  return {
    ...summaryView(ctx, r),
    definition: def,
    scope: scope?.request ?? null,
    claims,
    validation: v ? validationOf(v) : [],
    honesty: honestyFor(def),
    authored_note_ar: AUTHORED_DATA_NOTE_AR,
    versions,
  };
}

/** Claim ids of a list of sentences. */
export function claimIdsOf(list: CaseSentence[]): string[] {
  return list.map((s) => s.claim_id).filter((x): x is string => !!x);
}
