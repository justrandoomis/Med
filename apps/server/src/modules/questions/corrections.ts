// Owner actions on a question (§34, §35, §36; AC-15, AC-26). Every content or key change creates a NEW version
// (attempted versions are immutable and keep their attempts); a key change also reports its impact on past
// attempts and raises a content alert — nothing is re-graded silently. Review decisions record which fields the
// owner personally checked (owner_reviewed_fields).
import {
  type KeyChangeImpact,
  type KeyCorrectionRequest,
  type LectureLinkRelation,
  type QuestionCorrectionRequest,
  type QuestionMutationResponse,
  type QuestionReviewRequest,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { keyChangeImpact, questionCorrectionAlert, refreshQuestion } from './lifecycle';
import { resolveOpenItems } from './review';
import {
  correctOptionKeys,
  currentVersion,
  deriveVersion,
  getQuestionRow,
  optionsAsInput,
  questionView,
  setCurrentVersion,
  stemText,
  type NewOption,
} from './store';
import { blockingIssues } from './validate';

const TEXT_REVIEW_KINDS = ['truncated_question', 'missing_option', 'question_validation_failed'] as const;

function mutationResponse(ctx: AppContext, questionId: string, newVersionId: string | null, impact: KeyChangeImpact | null): QuestionMutationResponse {
  const view = questionView(ctx, questionId);
  return { question: view, new_version_id: newVersionId, impact, validation: view.current.validation };
}

/** PATCH: the owner corrects text / options / type → a new owner_correction version. */
export function correctQuestion(ctx: AppContext, questionId: string, body: QuestionCorrectionRequest): QuestionMutationResponse {
  const result = ctx.db.tx(() => {
    const q = getQuestionRow(ctx, questionId);
    const cur = currentVersion(ctx, q);
    const changed: string[] = [];
    let options: NewOption[] | undefined;
    const prev = optionsAsInput(ctx, cur.id);
    if (body.options) {
      const prevKeys = new Set(prev.map((o) => o.option_key));
      let next = Math.max(0, ...prev.map((o) => Number(o.option_key.replace(/^o/, '')) || 0)) + 1;
      const used = new Set<string>();
      options = body.options.map((o) => {
        let key = o.option_key && prevKeys.has(o.option_key) && !used.has(o.option_key) ? o.option_key : `o${next++}`;
        if (used.has(key)) key = `o${next++}`;
        used.add(key);
        const before = prev.find((p) => p.option_key === key);
        return {
          option_key: key,
          source_label: o.source_label !== undefined ? o.source_label : (before?.source_label ?? null),
          text: o.text.trim(),
          raw_text: before?.raw_text ?? null,
          region_id: before?.region_id ?? null,
          pinned_position: o.pinned_position ?? before?.pinned_position ?? false,
        };
      });
      const sig = (xs: NewOption[]) => JSON.stringify(xs.map((o) => [o.option_key, o.source_label, o.text, !!o.pinned_position]));
      if (sig(options) !== sig(prev)) changed.push('options');
      else options = undefined;
    }
    const newStem = body.stem !== undefined ? body.stem.trim() : undefined;
    if (newStem !== undefined && newStem !== stemText(cur)) changed.push('stem');
    if (body.qtype !== undefined && body.qtype !== cur.qtype) changed.push('qtype');
    if (body.explanation !== undefined) changed.push('explanation');
    if (body.learning_objective !== undefined && body.learning_objective !== cur.learning_objective) changed.push('learning_objective');
    if (changed.length === 0) throw new AppError('VALIDATION_FAILED', 'لا يوجد تغيير لحفظه. لاعتماد النص كما هو استخدم «قبول بعد المراجعة».', 400);
    if (newStem !== undefined && !newStem) throw new AppError('VALIDATION_FAILED', 'نص السؤال لا يمكن أن يكون فارغًا.', 400);

    // correct options that still exist keep their key; a removed key option makes the answer unresolved
    const curKeys = correctOptionKeys(ctx, cur);
    const keysAfter = options && curKeys ? curKeys.filter((k) => options!.some((o) => o.option_key === k)) : curKeys;
    const keyLost = curKeys && keysAfter && keysAfter.length < curKeys.length;
    const reviewed = [...new Set([...(fromJson<string[]>(cur.owner_reviewed_fields_json, []) ?? []), ...(body.reviewed_fields ?? []), ...changed])];
    const d = deriveVersion(ctx, cur, {
      kind: 'owner_correction',
      createdBy: 'owner',
      stemText: newStem,
      options,
      qtype: body.qtype,
      explanation: body.explanation === undefined ? undefined : body.explanation,
      learningObjective: body.learning_objective === undefined ? undefined : body.learning_objective,
      ownerReviewedFields: reviewed,
      extractionStatus: cur.extraction_status === 'not_applicable' ? 'not_applicable' : 'owner_reviewed',
      correctOptionKeys: keyLost ? null : keysAfter,
      answerStatus: keyLost ? 'unresolved' : cur.answer_status,
      keyDetails: keyLost ? { conflict_ar: 'حُذف الخيار الذي يشير إليه المفتاح؛ حدّد الإجابة من جديد.' } : undefined,
      note: body.note?.trim() || `صححتَ: ${changed.map((c) => FIELD_AR[c] ?? c).join('، ')}.`,
    });
    setCurrentVersion(ctx, q.id, d.versionId);
    // a corrected FACT in the question: whatever was built on the previous version is named in one alert (AC-26)
    questionCorrectionAlert(ctx, q.id, cur.id, changed.map((c) => FIELD_AR[c] ?? c).join('، '));
    if (q.status === 'retired' || q.status === 'draft') ctx.db.run(`UPDATE question SET status = 'needs_review' WHERE id = ?`, [q.id]);
    // the owner's decision is recorded on the open items BEFORE re-validation (which drops open items that no longer apply)
    resolveOpenItems(ctx, 'question', q.id, 'corrected', body.note ?? null, [...TEXT_REVIEW_KINDS]);
    const refreshed = refreshQuestion(ctx, q.id);
    ctx.audit.record({
      entityType: 'question',
      entityId: q.id,
      action: 'correct',
      summary: `تصحيح سؤال (نسخة جديدة): ${changed.map((c) => FIELD_AR[c] ?? c).join('، ')}`,
      before: { version_id: cur.id, stem: stemText(cur) },
      after: { version_id: d.versionId, changed, blockers: blockingIssues(refreshed.validation).map((i) => i.check) },
    });
    return d.versionId;
  });
  return mutationResponse(ctx, questionId, result, null);
}

const FIELD_AR: Record<string, string> = {
  stem: 'نص السؤال',
  options: 'الخيارات',
  qtype: 'نوع السؤال',
  explanation: 'الشرح',
  learning_objective: 'هدف التعلم',
  key: 'مفتاح الإجابة',
};

/** The owner sets (or clears) the key → new version + impact report + content alert (AC-15, AC-26). */
export function correctKey(ctx: AppContext, questionId: string, body: KeyCorrectionRequest): QuestionMutationResponse {
  const out = ctx.db.tx(() => {
    const q = getQuestionRow(ctx, questionId);
    const cur = currentVersion(ctx, q);
    const known = new Set(optionsAsInput(ctx, cur.id).map((o) => o.option_key));
    if (body.option_keys !== null) {
      if (body.option_keys.length === 0) throw new AppError('VALIDATION_FAILED', 'اختر خيارًا واحدًا على الأقل، أو أزل مفتاحك بإرسال null.', 400);
      const unknown = body.option_keys.filter((k) => !known.has(k));
      if (unknown.length) throw new AppError('VALIDATION_FAILED', `خيارات غير موجودة في النسخة الحالية: ${unknown.join('، ')}.`, 400);
    }
    const oldKeys = correctOptionKeys(ctx, cur);
    const reason = body.reason?.trim() || null;
    const reviewed = [...new Set([...(fromJson<string[]>(cur.owner_reviewed_fields_json, []) ?? []), 'key'])];
    const d =
      body.option_keys === null
        ? deriveVersion(ctx, cur, {
            kind: 'owner_correction',
            createdBy: cur.created_by === 'owner' ? 'owner' : cur.created_by,
            answerStatus: 'missing_key',
            correctOptionKeys: null,
            keyDetails: { notes_ar: reason ?? 'أزلتَ مفتاحك؛ يُعاد الاعتماد على مفتاح المصدر إن وُجد.' },
            ownerReviewedFields: reviewed,
            note: 'أزلتَ المفتاح الذي حددته.',
          })
        : deriveVersion(ctx, cur, {
            kind: 'owner_correction',
            createdBy: cur.created_by === 'owner' ? 'owner' : cur.created_by,
            answerStatus: 'owner_key',
            correctOptionKeys: [...new Set(body.option_keys)],
            keyDetails: {
              ...(fromJson<Record<string, unknown>>(cur.key_details_json, {}) ?? {}),
              notes_ar: reason ?? 'مفتاح حددته بنفسك (ليس مفتاح المصدر).',
            } as never,
            ownerReviewedFields: reviewed,
            qtype: body.option_keys.length > 1 && cur.qtype === 'sba' ? 'multi_select' : undefined,
            note: `حددتَ المفتاح بنفسك${reason ? `: ${reason}` : ''}.`,
          });
    const impact = keyChangeImpact(ctx, q.id, cur.id, body.option_keys, body.option_keys === null ? 'missing_key' : 'owner_key', 'owner');
    setCurrentVersion(ctx, q.id, d.versionId);
    resolveOpenItems(ctx, 'question', q.id, 'corrected', reason, ['conflicting_key', 'unofficial_mark']);
    refreshQuestion(ctx, q.id);
    ctx.audit.record({
      entityType: 'question',
      entityId: q.id,
      action: 'correct_key',
      summary: impact.summary_ar,
      before: { version_id: cur.id, answer_status: cur.answer_status, option_keys: oldKeys },
      after: { version_id: d.versionId, option_keys: body.option_keys, would_change: impact.would_change },
    });
    return { versionId: d.versionId, impact };
  });
  return mutationResponse(ctx, questionId, out.versionId, out.impact);
}

/** Side-by-side review decision: accept (owner_reviewed + fields) or reject (retired, never deleted). */
export function reviewQuestion(ctx: AppContext, questionId: string, body: QuestionReviewRequest): QuestionMutationResponse {
  ctx.db.tx(() => {
    const q = getQuestionRow(ctx, questionId);
    const cur = currentVersion(ctx, q);
    const now = ctx.clock.now();
    if (body.decision === 'reject') {
      const reason = body.reason?.trim() || 'رفضته في المراجعة (ليس سؤالًا صالحًا أو استخراجه غير قابل للإصلاح).';
      ctx.db.run(`UPDATE question SET status = 'retired', retired_reason = ?, updated_at = ? WHERE id = ?`, [reason, now, q.id]);
      ctx.db.run('DELETE FROM question_fts WHERE question_id = ?', [q.id]);
      resolveOpenItems(ctx, 'question', q.id, 'rejected', reason);
      ctx.audit.record({ entityType: 'question', entityId: q.id, action: 'retire', summary: `استبعاد سؤال: ${reason}`, before: { status: q.status }, after: { status: 'retired' } });
      return;
    }
    const validation = fromJson(cur.validation_json, null) as import('@medlevo/shared').QuestionValidation | null;
    const blockers = blockingIssues(validation).filter((i) => i.check !== 'key_conflict');
    if (blockers.length > 0 && !body.acknowledge_blockers) {
      throw new AppError(
        'CONFLICT',
        'لا يُعتمد السؤال تلقائيًا لأن فحوصًا مانعة لم تُجتز. قارن مع الأصل ثم صحح النص، أو أكّد أنك راجعته رغم ذلك.',
        409,
        { blockers: blockers.map((b) => ({ check: b.check, reason_ar: b.reason_ar })) },
      );
    }
    const fields = body.reviewed_fields?.length ? body.reviewed_fields : ['stem', 'options'];
    const reviewed = [...new Set([...(fromJson<string[]>(cur.owner_reviewed_fields_json, []) ?? []), ...fields])];
    ctx.db.run(`UPDATE question_version SET extraction_status = CASE extraction_status WHEN 'not_applicable' THEN 'not_applicable' ELSE 'owner_reviewed' END,
                  owner_reviewed_fields_json = ? WHERE id = ?`, [toJson(reviewed), cur.id]);
    if (q.status === 'retired') ctx.db.run(`UPDATE question SET status = 'needs_review', retired_reason = NULL WHERE id = ?`, [q.id]);
    resolveOpenItems(ctx, 'question', q.id, 'accepted', body.reason ?? null, [...TEXT_REVIEW_KINDS]);
    refreshQuestion(ctx, q.id);
    ctx.audit.record({
      entityType: 'question',
      entityId: q.id,
      action: 'review_accept',
      summary: `راجعتَ السؤال وقبلته (${fields.map((f) => FIELD_AR[f] ?? f).join('، ')})${blockers.length ? ` رغم ${blockers.length} فحص مانع` : ''}`,
      after: { version_id: cur.id, reviewed_fields: reviewed, acknowledged_blockers: blockers.map((b) => b.check) },
    });
  });
  return mutationResponse(ctx, questionId, null, null);
}

// ───────── lecture links ─────────
export function decideLink(ctx: AppContext, linkId: string, status: 'accepted' | 'rejected', reason: string | null): void {
  ctx.db.tx(() => {
    const l = ctx.db.get<{ id: string; question_id: string; status: string; relation: string }>('SELECT id, question_id, status, relation FROM question_lecture_link WHERE id = ?', [linkId]);
    if (!l) throw new AppError('NOT_FOUND', 'رابط المحاضرة غير موجود.', 404);
    const now = ctx.clock.now();
    ctx.db.run('UPDATE question_lecture_link SET status = ?, decision_reason = ?, updated_at = ? WHERE id = ?', [status, reason, now, linkId]);
    ctx.db.run(
      `UPDATE review_queue_item SET status = ?, resolved_at = ?, resolution_json = ? WHERE entity_type = 'question_lecture_link' AND entity_id = ? AND status = 'open'`,
      [status === 'accepted' ? 'accepted' : 'rejected', now, toJson({ by: 'owner', note: reason }), linkId],
    );
    ctx.audit.record({
      entityType: 'question_lecture_link',
      entityId: linkId,
      action: status === 'accepted' ? 'accept_link' : 'reject_link',
      summary: status === 'accepted' ? 'قبلتَ ربط السؤال بالمحاضرة' : `رفضتَ ربط السؤال بالمحاضرة${reason ? `: ${reason}` : ''}`,
      before: { status: l.status },
      after: { status, reason },
    });
  });
}

export function ownerLink(ctx: AppContext, questionId: string, lectureSourceId: string, relation: LectureLinkRelation, reason: string | null): string {
  return ctx.db.tx(() => {
    getQuestionRow(ctx, questionId);
    const src = ctx.db.get<{ id: string; deleted_at: number | null }>('SELECT id, deleted_at FROM source WHERE id = ?', [lectureSourceId]);
    if (!src || src.deleted_at !== null) throw new AppError('NOT_FOUND', 'المحاضرة غير موجودة أو في سلة المحذوفات.', 404);
    const now = ctx.clock.now();
    const text = reason?.trim() ? `ربطته بنفسك: ${reason.trim()}` : 'ربطته بنفسك.';
    const prior = ctx.db.get<{ id: string }>('SELECT id FROM question_lecture_link WHERE question_id = ? AND lecture_source_id = ?', [questionId, lectureSourceId]);
    let id: string;
    if (prior) {
      id = prior.id;
      ctx.db.run(
        `UPDATE question_lecture_link SET relation = ?, reason = ?, origin = 'owner', status = 'accepted', decision_reason = ?, answerable_from_lecture = ?, updated_at = ? WHERE id = ?`,
        [relation, text, reason, relation === 'directly_covered' ? 1 : 0, now, id],
      );
    } else {
      id = newId(now);
      ctx.db.run(
        `INSERT INTO question_lecture_link (id, question_id, lecture_source_id, relation, score, reason, reason_json, answerable_from_lecture, origin, status, decision_reason,
           created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 'owner', 'accepted', ?, ?, ?)`,
        [id, questionId, lectureSourceId, relation, text, relation === 'directly_covered' ? 1 : 0, reason, now, now],
      );
    }
    ctx.db.run(`UPDATE review_queue_item SET status = 'accepted', resolved_at = ? WHERE entity_type = 'question_lecture_link' AND entity_id = ? AND status = 'open'`, [now, id]);
    ctx.audit.record({ entityType: 'question_lecture_link', entityId: id, action: 'owner_link', summary: text, after: { question_id: questionId, lecture_source_id: lectureSourceId, relation } });
    return id;
  });
}
