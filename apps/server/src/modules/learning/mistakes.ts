// Mistake Genome (§44, AC-27) and Reasoning Replay (§44).
//  * Genome: distribution of the mistake types of wrong scored answers — an editable ESTIMATE (auto suggestion from
//    the exams track, or the owner's own classification), never a psychological diagnosis. Edits go through the exams
//    service (setMistakeType: origin 'owner', the auto suggestion stays visible, the answer itself never changes).
//  * Reasoning Replay: a structured teaching explanation of why the best answer wins and the others lose, built ONLY
//    from what the question carries (its explanation, distractor explanations with their claims, answer evidence).
//    It is never presented as a model's hidden reasoning. When a part is missing it is said explicitly; completing it
//    needs AI through the evidence-checked explain flow (gated by the capability, with the reason).
import {
  MISTAKE_TYPES,
  MISTAKE_TYPE_LABELS_AR,
  SCORABLE_ANSWER_STATUSES,
  parseRichText,
  stemPreview,
  type AnswerStatus,
  type ClaimView,
  type ConfidenceLevel,
  type MistakeGenomeView,
  type MistakeType,
  type QuestionAttemptDTO,
  type ReasoningReplayOption,
  type ReasoningReplayView,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { getClaimViews, getViews } from '../evidence/services';
import { setMistakeType } from '../exams/attempts';
import { questionAttemptDTO } from '../exams/store';
import { signalResets } from './profile';

// ───────── genome ─────────
export function mistakeGenome(ctx: AppContext, opts: { sourceId?: string | null; courseNodeId?: string | null } = {}): MistakeGenomeView {
  const resets = signalResets(ctx.db);
  const since = Math.max(resets.mcq_attempts ?? 0, 0);
  const typesSince = resets.mistake_types ?? 0;
  const where = ['qa.scored = 1', 'qa.is_correct = 0', 'q.deleted_at IS NULL', 'qa.answered_at >= ?'];
  const params: unknown[] = [since];
  if (opts.sourceId) {
    where.push(
      `(EXISTS (SELECT 1 FROM question_lecture_link l WHERE l.question_id = qa.question_id AND l.lecture_source_id = ? AND l.status <> 'rejected')
        OR EXISTS (SELECT 1 FROM question_occurrence o WHERE o.question_id = qa.question_id AND o.source_id = ?))`,
    );
    params.push(opts.sourceId, opts.sourceId);
  }
  if (opts.courseNodeId) {
    where.push('q.course_node_id = ?');
    params.push(opts.courseNodeId);
  }
  const rows = ctx.db.all<{ id: string; question_id: string; answered_at: number; mistake_type: MistakeType | null; mistake_origin: 'auto' | 'owner' | null; auto_mistake_type: MistakeType | null; auto_mistake_reason: string | null; stem_json: string }>(
    `SELECT qa.id, qa.question_id, qa.answered_at, qa.mistake_type, qa.mistake_origin, qa.auto_mistake_type, qa.auto_mistake_reason, v.stem_json
       FROM question_attempt qa JOIN question q ON q.id = qa.question_id JOIN question_version v ON v.id = qa.question_version_id
      WHERE ${where.join(' AND ')} ORDER BY qa.answered_at DESC, qa.id DESC`,
    params,
  );
  const typeOf = (r: (typeof rows)[number]) => (r.answered_at < typesSince ? null : r.mistake_type);
  const dist = MISTAKE_TYPES.map((t) => {
    const xs = rows.filter((r) => typeOf(r) === t);
    return { type: t, label_ar: MISTAKE_TYPE_LABELS_AR[t], count: xs.length, by_owner: xs.filter((r) => r.mistake_origin === 'owner').length, by_auto: xs.filter((r) => r.mistake_origin !== 'owner').length };
  });
  return {
    estimate_note_ar:
      'تصنيف تقديري لأسباب الأخطاء، يقترحه النظام من شكل السؤال ووقتك وثقتك، وتستطيع تعديله لكل خطأ. ليس تشخيصًا نفسيًا ولا حكمًا عليك.',
    denominator: rows.length,
    unclassified: rows.filter((r) => !typeOf(r)).length,
    distribution: dist.sort((a, b) => b.count - a.count || MISTAKE_TYPES.indexOf(a.type) - MISTAKE_TYPES.indexOf(b.type)),
    recent: rows.slice(0, 30).map((r) => ({
      attempt_id: r.id,
      question_id: r.question_id,
      stem_preview: stemPreview(fromJson<RichText>(r.stem_json), 120),
      answered_at: r.answered_at,
      mistake_type: typeOf(r),
      mistake_origin: typeOf(r) ? r.mistake_origin : null,
      auto_mistake_type: r.auto_mistake_type,
      auto_reason_ar: r.auto_mistake_reason,
    })),
  };
}

/** Owner edit of an attempt's mistake type through the exams service (audited; the answer never changes). */
export function editMistakeType(ctx: AppContext, attemptId: string, type: MistakeType | null): QuestionAttemptDTO {
  const before = ctx.db.get<{ mistake_type: string | null; is_correct: number | null }>('SELECT mistake_type, is_correct FROM question_attempt WHERE id = ?', [attemptId]);
  if (!before) throw new AppError('NOT_FOUND', 'المحاولة غير موجودة على الخادم بعد؛ ستُرسل التعديلات بعد مزامنتها.', 404);
  if (before.is_correct !== 0 && type !== null) throw new AppError('CONFLICT', 'لا يُصنَّف إلا الخطأ: هذه الإجابة ليست خاطئة محسوبة.', 409);
  const row = ctx.db.tx(() => {
    const r = setMistakeType(ctx.db, attemptId, type, ctx.clock.now(), (t, id) => void ctx.sync.touch(t, id));
    ctx.audit.record({
      entityType: 'question_attempt',
      entityId: attemptId,
      action: 'mistake_type',
      summary: `عدّلت تصنيف الخطأ إلى «${type ? MISTAKE_TYPE_LABELS_AR[type] : 'دون تصنيف'}».`,
      before: { mistake_type: before.mistake_type },
      after: { mistake_type: type },
    });
    return r;
  });
  return questionAttemptDTO(row);
}

// ───────── reasoning replay ─────────
const LABEL_AR = 'تفسير تعليمي منظّم لسبب ترجيح الإجابة واستبعاد غيرها، مبني على شرح السؤال وأدلته المحفوظة — وليس سجلًا لتفكير داخلي لأي نموذج.';

function claimIdsOf(rt: RichText | null, out: Set<string>): void {
  for (const p of rt?.paragraphs ?? []) for (const r of p.runs) if (r.claim) out.add(r.claim);
}

export function reasoningReplay(ctx: AppContext, questionId: string, attemptId?: string | null): ReasoningReplayView {
  const q = ctx.db.get<{ id: string; current_version_id: string | null; deleted_at: number | null }>('SELECT id, current_version_id, deleted_at FROM question WHERE id = ?', [questionId]);
  if (!q || q.deleted_at !== null) throw new AppError('NOT_FOUND', 'السؤال غير موجود.', 404);
  let attempt: { id: string; question_version_id: string; selected_option_ids_json: string | null; is_correct: number | null; confidence: ConfidenceLevel | null; hints_used: number } | undefined;
  if (attemptId) {
    attempt = ctx.db.get('SELECT id, question_version_id, selected_option_ids_json, is_correct, confidence, hints_used FROM question_attempt WHERE id = ? AND question_id = ?', [attemptId, questionId]);
    if (!attempt) throw new AppError('NOT_FOUND', 'المحاولة غير موجودة لهذا السؤال.', 404);
  }
  const versionId = attempt?.question_version_id ?? q.current_version_id;
  const v = versionId
    ? ctx.db.get<{ id: string; stem_json: string; correct_option_ids_json: string | null; explanation_json: string | null; distractor_explanations_json: string | null; answer_status: AnswerStatus }>(
        'SELECT id, stem_json, correct_option_ids_json, explanation_json, distractor_explanations_json, answer_status FROM question_version WHERE id = ?',
        [versionId],
      )
    : undefined;
  if (!v) throw new AppError('NOT_FOUND', 'نسخة السؤال غير موجودة.', 404);
  const options = ctx.db.all<{ id: string; option_key: string; source_label: string | null; ord: number; text_json: string }>(
    'SELECT id, option_key, source_label, ord, text_json FROM question_option WHERE question_version_id = ? ORDER BY ord',
    [v.id],
  );
  const correct = fromJson<string[]>(v.correct_option_ids_json, []) ?? [];
  const keyKnown = correct.length > 0 && SCORABLE_ANSWER_STATUSES.includes(v.answer_status);
  const explanation = v.explanation_json ? parseRichText(fromJson(v.explanation_json)) : null;
  const distractors = fromJson<Record<string, unknown>>(v.distractor_explanations_json, {}) ?? {};
  // distractor explanations are keyed by option id or by the stable option key ('o2') — both are accepted
  const why = (optionId: string, optionKey: string): RichText | null => {
    const raw = distractors[optionId] ?? distractors[optionKey];
    if (!raw) return null;
    try {
      const rt = parseRichText(raw);
      return rt.paragraphs.length ? rt : null;
    } catch {
      return null;
    }
  };
  const evidence = ctx.db.all<{ option_id: string | null; evidence_id: string; role: string }>('SELECT option_id, evidence_id, role FROM answer_evidence WHERE question_version_id = ?', [v.id]);
  const chosen = new Set(fromJson<string[]>(attempt?.selected_option_ids_json, []) ?? []);
  const missing: string[] = [];
  const labelOf = (o: { source_label: string | null; ord: number }) => o.source_label ?? String.fromCharCode(65 + o.ord);
  const opts: ReasoningReplayOption[] = options.map((o) => {
    const isBest = keyKnown && correct.includes(o.id);
    let w = why(o.id, o.option_key);
    if (isBest && !w && explanation?.paragraphs.length) w = explanation;
    if (keyKnown && !w) missing.push(isBest ? `لا يوجد في السؤال أو مصدره شرح لسبب صحة الخيار ${labelOf(o)}.` : `لا يوجد في السؤال أو مصدره شرح لسبب استبعاد الخيار ${labelOf(o)}.`);
    return {
      option_id: o.id,
      label: labelOf(o),
      text: parseRichText(fromJson(o.text_json)),
      why: w,
      evidence_ids: evidence.filter((e) => e.option_id === o.id || (isBest && e.option_id === null && e.role === 'supports_answer')).map((e) => e.evidence_id),
      is_best: isBest,
      chosen_by_you: chosen.has(o.id),
    };
  });
  if (!keyKnown) missing.unshift('مفتاح الإجابة غير محسوم لهذا السؤال، فلا يُعرض أي خيار على أنه الأرجح.');
  const claimIds = new Set<string>();
  claimIdsOf(explanation, claimIds);
  for (const o of opts) claimIdsOf(o.why, claimIds);
  const claims: Record<string, ClaimView> = claimIds.size ? getClaimViews(ctx, [...claimIds]) : {};
  const hasText = !!explanation?.paragraphs.length || opts.some((o) => !o.is_best && o.why);
  const contentSource: ReasoningReplayView['content_source'] = keyKnown && hasText ? 'question_explanation' : keyKnown && evidence.length ? 'evidence_only' : 'none';
  if (contentSource === 'evidence_only') missing.push('لا يوجد شرح مكتوب؛ المعروض هو الأدلة المرتبطة بالإجابة فقط.');
  const cap = ctx.capabilities.get('ai.explain');
  const aiAvailable = cap.state === 'available' && ctx.ai.isAvailable('explain');
  const needed = keyKnown && missing.length > 0;
  return {
    question_id: q.id,
    question_version_id: v.id,
    stem: parseRichText(fromJson(v.stem_json)),
    content_source: contentSource,
    label_ar: LABEL_AR,
    key_known: keyKnown,
    answer_status: v.answer_status,
    options: opts,
    explanation,
    claims,
    evidence: getViews(ctx, [...new Set(evidence.map((e) => e.evidence_id))]),
    missing_ar: missing,
    ai: {
      needed,
      available: aiAvailable,
      reason_ar: !needed
        ? null
        : aiAvailable
          ? 'لإكمال الناقص اطلب «اشرح» على صفحات المحاضرة المرتبطة بالسؤال: يُولَّد الشرح من أدلة المحاضرة ويُتحقق من كل جملة طبية، ويبقى معلّمًا بأنه مولّد.'
          : `إكمال الناقص يحتاج الذكاء الاصطناعي: ${cap.reason_ar ?? 'غير مهيأ على الخادم.'}`,
    },
    attempt: attempt
      ? {
          id: attempt.id,
          selected_option_ids: [...chosen],
          is_correct: attempt.is_correct === null ? null : attempt.is_correct === 1,
          confidence: attempt.confidence,
          hints_used: attempt.hints_used,
        }
      : null,
  };
}
