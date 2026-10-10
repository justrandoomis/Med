// Owner authoring of cases WITHOUT AI (§42): the owner writes the definition (facts, stages, decisions, checklist,
// OSCE station, viva questions) and may attach evidence from the case's Source Lock to any medical sentence.
// Every save creates a NEW immutable version (attempts keep the version they started on). Concurrent edits are
// refused (base_version_no), never silently overwritten.
import { caseSaveRequestSchema, type CaseDetailView, type CaseSentence, type CaseSentenceInput, type CaseEvidenceSuggestResponse } from '@medlevo/shared';
import { z } from 'zod';
import { sourceScopeSchema } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { abstainFor, evidenceFromCandidates, getViews, recordDependencies, resolveScope, retrieve, toResolvedScope } from '../evidence/services';
import { resolveOwnerSentences, sentenceKey } from './claims';
import { buildDefinition, sentenceLists, statusFor, structuralIssues } from './definition';
import { definitionOf, getCaseRow, getVersionRow, type StoredScope } from './store';
import { detailView } from './views';

function reuseMap(ctx: AppContext, caseId: string | null, versionNo: number | null): Map<string, CaseSentence> {
  const out = new Map<string, CaseSentence>();
  if (!caseId || !versionNo) return out;
  const def = definitionOf(getVersionRow(ctx, caseId, versionNo));
  const add = (l: CaseSentence[]) => l.forEach((s) => s.claim_id && out.set(sentenceKey(s), s));
  def.stages.forEach((s) => {
    add(s.teaching_points);
    s.decisions.forEach((d) => add(d.explanation));
  });
  def.checklist.forEach((c) => add(c.rationale));
  def.viva?.questions.forEach((q) => {
    q.points.forEach((p) => add(p.rationale));
    q.misconceptions.forEach((m) => add(m.correction));
  });
  return out;
}

export async function saveCase(ctx: AppContext, body: unknown, caseId: string | null): Promise<CaseDetailView> {
  const req = parseWith(caseSaveRequestSchema, body, 'body');
  const existing = caseId ? getCaseRow(ctx, caseId) : null;
  if (existing && existing.current_version_no < 1) {
    // the generation job writes version 1; an edit now would collide with it
    throw new AppError('CONFLICT', 'لم يكتمل توليد هذه الحالة بعد؛ عدّلها بعد انتهاء التوليد.', 409);
  }
  if (existing && req.base_version_no !== undefined && req.base_version_no !== existing.current_version_no) {
    throw new AppError('CONFLICT', `عُدّلت هذه الحالة في مكان آخر (النسخة ${existing.current_version_no})؛ أعد فتحها ثم طبّق تعديلك. لم يُحفظ شيء.`, 409, {
      current_version_no: existing.current_version_no,
    });
  }
  if (existing && req.definition.kind !== existing.kind) {
    throw new AppError('VALIDATION_FAILED', 'لا يمكن تغيير نوع الحالة بعد إنشائها؛ أنشئ حالة جديدة.', 400, {
      where: 'body',
      issues: [{ path: 'definition.kind', code: 'custom', message: 'نوع الحالة ثابت.' }],
    });
  }
  let stored: StoredScope | null = null;
  if (req.scope) {
    const report = resolveScope(ctx, req.scope);
    stored = { request: req.scope, resolved: toResolvedScope(report) };
  }
  const now = ctx.clock.now();
  const id = existing?.id ?? newId(now);
  const versionNo = (existing?.current_version_no ?? 0) + 1;
  const versionId = newId(now);
  const lists = sentenceLists(req.definition);
  const resolved = await resolveOwnerSentences(ctx, {
    scope: stored?.resolved ?? null,
    ownerId: versionId,
    lists,
    reuse: reuseMap(ctx, existing?.id ?? null, existing?.current_version_no ?? null),
  });
  const def = buildDefinition(req.definition, (path: string, s: CaseSentenceInput[]) => resolved.byPath.get(path) ?? (s.length ? [] : []));
  const issues = structuralIssues(def);
  const { status, reasons_ar } = statusFor(issues);
  const origin = existing?.origin ?? 'owner';

  ctx.db.tx(() => {
    // re-check inside the transaction: another save may have landed while the evidence was being validated
    if (existing) {
      const now_ = ctx.db.get<{ current_version_no: number; deleted_at: number | null }>('SELECT current_version_no, deleted_at FROM clinical_case WHERE id = ?', [existing.id]);
      if (!now_ || now_.deleted_at !== null) throw new AppError('NOT_FOUND', 'الحالة غير موجودة.', 404);
      if (now_.current_version_no !== existing.current_version_no) {
        throw new AppError('CONFLICT', `عُدّلت هذه الحالة في مكان آخر (النسخة ${now_.current_version_no})؛ أعد فتحها ثم طبّق تعديلك. لم يُحفظ شيء.`, 409, {
          current_version_no: now_.current_version_no,
        });
      }
    }
    if (!existing) {
      ctx.db.run(
        `INSERT INTO clinical_case (id, title, kind, scope_json, definition_json, is_generated, status, artifact_id, created_at, updated_at, origin, current_version_no, station_type, source_id, generation_json, status_reasons_json)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 'owner', ?, ?, ?, NULL, ?)`,
        [id, def.title, def.kind, toJson(stored?.request ?? null), toJson(def), status, now, now, versionNo, def.osce?.station_type ?? null, stored?.request.lecture_source_id ?? null, toJson(reasons_ar)],
      );
    } else {
      ctx.db.run(
        `UPDATE clinical_case SET title = ?, scope_json = ?, definition_json = ?, status = ?, current_version_no = ?, station_type = ?, source_id = ?, status_reasons_json = ?, updated_at = ? WHERE id = ?`,
        [def.title, toJson(stored?.request ?? null), toJson(def), status, versionNo, def.osce?.station_type ?? null, stored?.request.lecture_source_id ?? null, toJson(reasons_ar), now, id],
      );
    }
    ctx.db.run(
      `INSERT INTO clinical_case_version (id, case_id, version_no, definition_json, scope_json, origin, status, validation_json, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?, ?, ?)`,
      [versionId, id, versionNo, toJson(def), stored ? toJson(stored) : null, status, toJson(issues), now],
    );
    if (stored) recordDependencies(ctx, 'case', id, stored.resolved.versionIds, resolved.regionIds);
    ctx.audit.record({
      entityType: 'clinical_case',
      entityId: id,
      action: existing ? 'update' : 'create',
      summary: existing ? `تعديل الحالة «${def.title}» (النسخة ${versionNo})` : `إنشاء حالة «${def.title}»`,
      after: { version_no: versionNo, status, origin },
      actor: 'owner',
    });
  });
  return detailView(ctx, getCaseRow(ctx, id));
}

export function trashCase(ctx: AppContext, id: string): void {
  const r = getCaseRow(ctx, id);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE clinical_case SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, r.id]);
    ctx.audit.record({ entityType: 'clinical_case', entityId: r.id, action: 'trash', summary: `نقل الحالة «${r.title}» إلى سلة المحذوفات (المحاولات محفوظة)`, actor: 'owner' });
  });
}

export function restoreCase(ctx: AppContext, id: string): CaseDetailView {
  const r = getCaseRow(ctx, id, { includeDeleted: true });
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('UPDATE clinical_case SET deleted_at = NULL, updated_at = ? WHERE id = ?', [now, r.id]);
    ctx.audit.record({ entityType: 'clinical_case', entityId: r.id, action: 'restore', summary: `استعادة الحالة «${r.title}»`, actor: 'owner' });
  });
  return detailView(ctx, getCaseRow(ctx, id));
}

// ───────── evidence suggestions for the authoring form (deterministic retrieval, no AI) ─────────
const suggestSchema = z.object({ scope: sourceScopeSchema, text: z.string().trim().min(2).max(1500), limit: z.number().int().min(1).max(12).optional() }).strict();

export function suggestEvidence(ctx: AppContext, body: unknown): CaseEvidenceSuggestResponse {
  const req = parseWith(suggestSchema, body, 'body');
  const report = resolveScope(ctx, req.scope);
  const scope = toResolvedScope(report);
  const r = retrieve(ctx, { scope, query: req.text, k: req.limit ?? 6, purpose: 'clinical_expansion' });
  const abstain = abstainFor(ctx, r, scope);
  const rows = evidenceFromCandidates(ctx, r.candidates.slice(0, req.limit ?? 6));
  return {
    evidence: getViews(ctx, rows.map((x) => x.id), { pinnedVersionIds: scope.versionIds }),
    searched_ar: r.searched.summary_ar,
    abstain_ar: abstain ? abstain.reason_ar : null,
  };
}
