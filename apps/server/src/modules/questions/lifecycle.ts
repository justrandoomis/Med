// After extraction or a correction: resolve the answer from every bound source key, re-validate, set the
// separate statuses (question / extraction / key), sync the question's review items and its search row.
// A key change on a version that was attempted creates a NEW version and an alert with the impact on past
// attempts — attempts are never re-graded silently (§36, AC-15, AC-26).
import { type AnswerCheckView, type KeyChangeImpact, type QuestionValidation } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { newId } from '../../lib/ids';
import { recordDependencies } from '../evidence/services';
import { resolveAnswer, type AnswerResolution } from './keys';
import { syncReviewItems, type DesiredItem } from './review';
import {
  correctOptionKeys,
  currentVersion,
  deriveVersion,
  getQuestionRow,
  getVersionRow,
  isVersionLocked,
  occurrenceVersionState,
  optionRows,
  refreshFts,
  setCurrentVersion,
  stemText,
  type OccurrenceParse,
  type OccurrenceRow,
  type VersionRow,
} from './store';
import { richTextToPlain, type RichText } from '@medlevo/shared';
import { LOW_CONFIDENCE_AR, textChecksPassed, validateQuestion } from './validate';

const sameKeys = (a: string[] | null, b: string[] | null) =>
  (a === null && b === null) || (a !== null && b !== null && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|'));

/** The occurrence whose raw text is the reference for the current version (first current one). */
export function primaryOccurrence(ctx: AppContext, questionId: string): OccurrenceRow | null {
  return (
    ctx.db.get<OccurrenceRow>(
      `SELECT o.* FROM question_occurrence o JOIN source s ON s.id = o.source_id
        WHERE o.question_id = ? AND s.deleted_at IS NULL ORDER BY o.status = 'current' DESC, o.created_at, o.ord LIMIT 1`,
      [questionId],
    ) ?? null
  );
}

export function computeValidation(
  ctx: AppContext,
  v: VersionRow,
  resolution: Pick<AnswerResolution, 'status' | 'conflictAr' | 'unofficialMarks' | 'uncertainKeyAr'>,
  occ: OccurrenceRow | null,
): QuestionValidation {
  const parse = fromJson<OccurrenceParse | null>(occ?.parse_json ?? null, null);
  const ownerMade = v.created_by === 'owner';
  const ownerReviewed = v.extraction_status === 'owner_reviewed';
  // structural findings the owner already compared with the original stay visible, but no longer block
  const structural = ownerMade
    ? []
    : (parse?.issues ?? []).map((i) => (ownerReviewed && i.severity === 'blocker' ? { ...i, severity: 'warning' as const, reason_ar: `راجعتَه وقبلته: ${i.reason_ar}` } : i));
  const options = optionRows(ctx, v.id).map((o) => ({ label: o.source_label, text: richTextToPlain(fromJson<RichText | null>(o.text_json, null)) }));
  // a replaced question source whose version in force no longer has this question (§18): kept with its
  // attempts, but not scored until the owner looks at it
  let supersededAr: { reason_ar: string; severity: 'blocker' | 'warning' } | null = null;
  const q = ctx.db.get<{ origin_type: string }>('SELECT origin_type FROM question WHERE id = ?', [v.question_id]);
  if (q?.origin_type === 'source') {
    const st = occurrenceVersionState(ctx, v.question_id);
    if (st.total > 0 && st.inForce.size === 0 && st.supersededIn.length > 0) {
      const where = st.supersededIn.map((s) => `«${s.source_title}»${s.version_no ? ` (النسخة ${s.version_no})` : ''}`).join('، ');
      supersededAr = {
        reason_ar: `هذا السؤال من نسخة سابقة من المصدر؛ النسخة المعتمدة حاليًا من ${where} لا تحتويه (ربما عُدّل نصه أو حُذف). بقي مع محاولاتك، ولا يُحتسب في الاختبارات المقيّمة حتى تراجعه.`,
        severity: ownerMade || ownerReviewed ? 'warning' : 'blocker',
      };
    }
  }
  return validateQuestion({
    supersededAr,
    uncertainKeyAr: resolution.uncertainKeyAr ?? null,
    stem: stemText(v),
    options,
    qtype: v.qtype,
    rawText: occ?.raw_text ?? null,
    structural,
    figuresAttached: parse?.figure_region_ids.length ?? 0,
    uncertainRegions: ownerMade || ownerReviewed ? [] : (parse?.uncertain ?? []),
    answerStatus: resolution.status,
    conflictAr: resolution.conflictAr,
    unofficialMarks: resolution.unofficialMarks,
    createdBy: v.created_by,
    ownerReviewedFields: fromJson<string[]>(v.owner_reviewed_fields_json, []) ?? [],
  });
}

export interface RefreshResult {
  versionId: string;
  newVersion: boolean;
  impact: KeyChangeImpact | null;
  validation: QuestionValidation;
}

/**
 * Bring a question up to date with its sources: answer from bound keys (unless the owner set the key), validation,
 * statuses, review items, search row, dependencies.
 */
export function refreshQuestion(ctx: AppContext, questionId: string, opts: { jobId?: string | null } = {}): RefreshResult {
  return ctx.db.tx(() => {
    const q = getQuestionRow(ctx, questionId);
    let v = currentVersion(ctx, q);
    let newVersion = false;
    let impact: KeyChangeImpact | null = null;
    const occ = primaryOccurrence(ctx, q.id);
    let resolution: AnswerResolution = {
      status: v.answer_status,
      correctOptionKeys: correctOptionKeys(ctx, v),
      keyEntryIds: [],
      conflictAr: fromJson<{ conflict_ar?: string }>(v.key_details_json, {})?.conflict_ar ?? null,
      notesAr: null,
      unofficialMarks: [],
    };
    if (q.origin_type === 'source') {
      const src = resolveAnswer(ctx, q.id, v);
      const ownerDecided = v.answer_status === 'owner_key' || v.answer_status === 'ai_derived';
      if (ownerDecided) {
        // the owner's (or an evidence-derived) key stays; the source state is reported next to it
        const ownerKeys = correctOptionKeys(ctx, v);
        const note =
          src.status === 'source_key' && !sameKeys(src.correctOptionKeys, ownerKeys)
            ? 'مفتاح المصدر يختار إجابة مختلفة عن المفتاح الذي حددته؛ بقي اختيارك ولم يُغيَّر شيء تلقائيًا.'
            : src.status === 'conflicting_key'
              ? src.conflictAr
              : null;
        const kd = { ...(fromJson<Record<string, unknown>>(v.key_details_json, {}) ?? {}), key_entry_ids: src.keyEntryIds, source_note_ar: note ?? undefined };
        ctx.db.run('UPDATE question_version SET key_details_json = ? WHERE id = ?', [toJson(kd), v.id]);
        resolution = { ...resolution, unofficialMarks: src.unofficialMarks };
      } else {
        const kdNow = fromJson<{ conflict_ar?: string; answer_check?: AnswerCheckView }>(v.key_details_json, {}) ?? {};
        const check = kdNow.answer_check;
        // G4 / AC-15: «the source key selects B but the selected evidence points to C» — that conflict stays (shown, not
        // scored) until the source key ITSELF changes; a later extraction / refresh never silently restores the key
        const materialConflict =
          v.answer_status === 'conflicting_key' && check?.outcome === 'conflicts' && src.status === 'source_key' && sameKeys(src.correctOptionKeys, check.key_option_keys);
        // a check of the same key is kept with the version (it is about exactly this key)
        const checkStillApplies = !!check && check.key_status === src.status && sameKeys(check.key_option_keys, src.correctOptionKeys);
        const curKeys = correctOptionKeys(ctx, v);
        const curConflict = kdNow.conflict_ar ?? null;
        const changed = !materialConflict && (src.status !== v.answer_status || !sameKeys(src.correctOptionKeys, curKeys) || (src.conflictAr ?? null) !== curConflict);
        const keyDetails = materialConflict
          ? { ...kdNow, key_entry_ids: src.keyEntryIds }
          : {
              key_entry_ids: src.keyEntryIds,
              ...(src.conflictAr ? { conflict_ar: src.conflictAr } : {}),
              ...(src.notesAr ? { notes_ar: src.notesAr } : {}),
              ...(checkStillApplies ? { answer_check: check } : {}),
            };
        if (changed) {
          if (isVersionLocked(ctx, v.id)) {
            const d = deriveVersion(ctx, v, {
              kind: 'structured',
              createdBy: 'extraction',
              answerStatus: src.status,
              correctOptionKeys: src.correctOptionKeys,
              keyDetails,
              jobId: opts.jobId ?? null,
              note: 'تغيّر مفتاح المصدر لهذا السؤال (مفتاح جديد أو متعارض)؛ المحاولات السابقة بقيت على نسختها.',
            });
            impact = keyChangeImpact(ctx, q.id, v.id, src.correctOptionKeys, src.status, 'source');
            setCurrentVersion(ctx, q.id, d.versionId);
            ctx.db.run('UPDATE question_occurrence SET question_version_id = ? WHERE question_id = ? AND question_version_id = ?', [d.versionId, q.id, v.id]);
            v = getVersionRow(ctx, d.versionId);
            newVersion = true;
          } else {
            const byKey = new Map(optionRows(ctx, v.id).map((o) => [o.option_key, o.id]));
            const ids = src.correctOptionKeys ? src.correctOptionKeys.map((k) => byKey.get(k)).filter((x): x is string => !!x) : null;
            ctx.db.run('UPDATE question_version SET answer_status = ?, correct_option_ids_json = ?, key_details_json = ? WHERE id = ?', [
              src.status,
              ids ? toJson(ids) : null,
              toJson(keyDetails),
              v.id,
            ]);
            v = getVersionRow(ctx, v.id);
          }
        } else if (toJson(keyDetails) !== v.key_details_json) {
          ctx.db.run('UPDATE question_version SET key_details_json = ? WHERE id = ?', [toJson(keyDetails), v.id]);
        }
        resolution = materialConflict ? { ...src, status: 'conflicting_key', correctOptionKeys: null, conflictAr: kdNow.conflict_ar ?? null } : src;
      }
    }

    const validation = computeValidation(ctx, v, resolution, occ);
    let extraction = v.extraction_status;
    if (extraction !== 'owner_reviewed' && extraction !== 'not_applicable') extraction = textChecksPassed(validation) ? 'checks_passed' : 'needs_review';
    ctx.db.run('UPDATE question_version SET validation_json = ?, extraction_status = ? WHERE id = ?', [toJson(validation), extraction, v.id]);
    const status = q.status === 'retired' || q.status === 'draft' ? q.status : textChecksPassed(validation) || extraction === 'owner_reviewed' ? 'ready' : 'needs_review';
    ctx.db.run('UPDATE question SET status = ?, updated_at = ? WHERE id = ?', [status, ctx.clock.now(), q.id]);

    // review items (one open item per problem; the owner's past decisions are respected)
    const desired: DesiredItem[] = [];
    if (q.status !== 'retired') {
      {
        for (const i of validation.issues) {
          if (i.passed || i.severity !== 'blocker') continue;
          if (i.check === 'key_conflict') continue;
          // text checks the owner already compared with the original raise no new item; key / version checks do
          if (extraction === 'owner_reviewed' && i.check !== 'key_bound' && i.check !== 'scope') continue;
          const uncertainText = i.reason_ar.includes(LOW_CONFIDENCE_AR);
          const kind = uncertainText
            ? 'question_validation_failed'
            : i.check === 'stem_complete'
              ? 'truncated_question'
              : i.check === 'options_complete' || i.check === 'option_order'
                ? 'missing_option'
                : 'question_validation_failed';
          desired.push({ kind, code: `check:${i.check}`, reason: i.reason_ar, details: { check: i.check, version_id: v.id } });
        }
      }
      if (resolution.status === 'conflicting_key' || resolution.status === 'unresolved') {
        desired.push({
          kind: 'conflicting_key',
          code: `key:${resolution.status}`,
          reason: resolution.conflictAr ?? 'لا يمكن تحديد مفتاح صالح لهذا السؤال من المصدر.',
          details: { version_id: v.id, key_entry_ids: resolution.keyEntryIds },
        });
      }
      if (resolution.unofficialMarks.length > 0) {
        desired.push({
          kind: 'unofficial_mark',
          code: 'mark:unofficial',
          reason: `على الخيار ${resolution.unofficialMarks.map((m) => m.label).join('، ')} ${resolution.unofficialMarks[0]!.kind === 'circled_option' ? 'دائرة مرسومة' : 'علامة بخط اليد'} — قد تكون إجابة طالب سابق؛ لم تُعتمد مفتاحًا رسميًا. حدد المفتاح بنفسك إن كنت متأكدًا.`,
          details: { entry_ids: resolution.unofficialMarks.map((m) => m.entryId), version_id: v.id },
        });
      }
    }
    syncReviewItems(ctx, 'question', q.id, 'question', desired, occ?.source_id ?? null, q.id);
    refreshFts(ctx, q.id);
    recordQuestionDependencies(ctx, q.id, v.id);
    return { versionId: v.id, newVersion, impact, validation };
  });
}

/** question_version → the source versions / regions it was extracted from (C1 dependency service). */
export function recordQuestionDependencies(ctx: AppContext, questionId: string, versionId: string): void {
  const occ = ctx.db.all<{ source_version_id: string; region_ids_json: string }>(
    `SELECT source_version_id, region_ids_json FROM question_occurrence WHERE question_id = ? AND status = 'current'`,
    [questionId],
  );
  if (occ.length === 0) return;
  recordDependencies(
    ctx,
    'question_version',
    versionId,
    occ.map((o) => o.source_version_id),
    occ.flatMap((o) => fromJson<string[]>(o.region_ids_json, []) ?? []),
  );
}

/**
 * What a key change means for past attempts of the question (any version): which attempts WOULD be graded
 * differently. Nothing is re-graded; a `key_corrected` content alert lists the affected versions/attempts.
 */
export function keyChangeImpact(
  ctx: AppContext,
  questionId: string,
  oldVersionId: string,
  newKeys: string[] | null,
  newStatus: string,
  by: 'owner' | 'source' | 'evidence',
): KeyChangeImpact {
  const now = ctx.clock.now();
  const attempts = ctx.db.all<{ id: string; question_version_id: string; selected_option_ids_json: string | null; is_correct: number | null; answered_at: number }>(
    'SELECT id, question_version_id, selected_option_ids_json, is_correct, answered_at FROM question_attempt WHERE question_id = ? ORDER BY answered_at',
    [questionId],
  );
  const keyOfOption = new Map<string, string>();
  for (const vid of new Set(attempts.map((a) => a.question_version_id))) for (const o of optionRows(ctx, vid)) keyOfOption.set(o.id, o.option_key);
  const rows: KeyChangeImpact['attempts'] = attempts.map((a) => {
    const selected = (fromJson<string[]>(a.selected_option_ids_json, []) ?? []).map((id) => keyOfOption.get(id)).filter((k): k is string => !!k);
    const would = newKeys && newKeys.length > 0 ? sameKeys(selected, newKeys) : null;
    return { attempt_id: a.id, version_id: a.question_version_id, answered_at: a.answered_at, was_correct: a.is_correct === null ? null : a.is_correct === 1, would_be_correct: would };
  });
  const changing = rows.filter((r) => r.was_correct !== r.would_be_correct);
  const q = getQuestionRow(ctx, questionId);
  const occ = primaryOccurrence(ctx, q.id);
  const who = by === 'owner' ? 'صححتَ مفتاح الإجابة' : by === 'evidence' ? 'الأدلة المختارة تخالف مفتاح المصدر' : 'تغيّر مفتاح المصدر';
  const summary =
    rows.length === 0
      ? `${who} لسؤال لم تُحل له محاولات بعد. النسخة السابقة محفوظة.`
      : by === 'evidence'
        ? `${who}: ${rows.length === 1 ? 'محاولة واحدة سابقة قُيّمت' : `${rows.length} محاولات سابقة قُيّمت`} بمفتاح المصدر؛ بقيت نتائجها كما هي ولم يُعَد تقييم أي منها، والسؤال لا يُحتسب في الاختبارات المقيّمة الجديدة حتى تحسم التعارض.`
        : `${who}: ${rows.length === 1 ? 'محاولة واحدة سابقة' : `${rows.length} محاولات سابقة`}، منها ${changing.length} ستتغير نتيجتها لو قُيّمت بالمفتاح الجديد. لم يُعَد تقييم أي محاولة تلقائيًا؛ بقيت كل محاولة مرتبطة بنسختها.`;
  const alertId = newId(now);
  const affected = [
    { type: 'question_version', id: oldVersionId, impact: 'needs_review' as const },
    ...changing.map((r) => ({ type: 'question_attempt', id: r.attempt_id, impact: 'needs_review' as const })),
  ];
  // A key correction is not a source-version change, so the evidence dependency service (onSourceVersionChanged) does
  // not cover it: the alert is written here with the same shape that service uses (content_alert + content_alert_item).
  ctx.db.run(
    `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at, details_json)
     VALUES (?, 'key_corrected', 'answer_change', ?, ?, ?, ?, 'open', ?, ?)`,
    [alertId, occ?.source_id ?? null, occ?.source_version_id ?? null, summary, toJson(affected), now, toJson({ question_id: questionId, new_status: newStatus, by })],
  );
  ctx.db.run(
    `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, 'question_version', ?, 'needs_review', 0, ?, '[]')`,
    [alertId, oldVersionId, 'نسخة سابقة من السؤال بمفتاح مختلف؛ محاولاتك عليها لم يُعد تقييمها.'],
  );
  // one item per attempt whose result WOULD differ (the alert view lists items, not affected_json)
  const verdict = (x: boolean | null) => (x === null ? 'غير محسوبة' : x ? 'صحيحة' : 'خاطئة');
  for (const r of changing) {
    ctx.db.run(
      `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, 'question_attempt', ?, 'needs_review', 0, ?, '[]')
       ON CONFLICT (alert_id, dependent_type, dependent_id) DO NOTHING`,
      [
        alertId,
        r.attempt_id,
        by === 'evidence'
          ? `محاولة سُجلت ${verdict(r.was_correct)} بمفتاح المصدر، ومفتاحه الآن موضع تعارض مع الأدلة المختارة؛ لم يُعَد تقييمها وبقيت على نسختها.`
          : `محاولة سُجلت ${verdict(r.was_correct)} وستكون ${verdict(r.would_be_correct)} بالمفتاح الجديد؛ لم يُعَد تقييمها وبقيت على نسختها.`,
      ],
    );
  }
  // tools built on this question that no source-version dependency reaches (G8, AC-26): cards made from mistakes
  // on it and exams that still pin the old version
  addToolItems(ctx, alertId, questionTools(ctx, questionId, oldVersionId), 'key');
  return { attempts_total: rows.length, would_change: changing.length, attempts: rows, content_alert_id: alertId, summary_ar: summary };
}

interface QuestionTools {
  cards: string[];
  exams: Array<{ id: string; unfinished: boolean }>;
}

/** Cards made from mistakes on the question and exams that pin `versionId` (finished or not). */
export function questionTools(ctx: AppContext, questionId: string, versionId: string): QuestionTools {
  const cards = ctx.db
    .all<{ id: string }>(
      `SELECT id FROM flashcard WHERE deleted_at IS NULL AND origin = 'from_mistake' AND json_valid(origin_ref_json)
          AND json_extract(origin_ref_json, '$.question_id') = ? ORDER BY created_at, id`,
      [questionId],
    )
    .map((r) => r.id);
  const exams = ctx.db
    .all<{ id: string; unfinished: number }>(
      `SELECT e.id, EXISTS (SELECT 1 FROM exam_attempt a WHERE a.exam_id = e.id AND a.status IN ('in_progress', 'paused')) AS unfinished
         FROM exam e WHERE json_valid(e.items_json)
          AND EXISTS (SELECT 1 FROM json_each(e.items_json) j WHERE json_extract(j.value, '$.question_version_id') = ?)
        ORDER BY e.created_at, e.id`,
      [versionId],
    )
    .map((r) => ({ id: r.id, unfinished: r.unfinished === 1 }));
  return { cards, exams };
}

function addToolItems(ctx: AppContext, alertId: string, tools: QuestionTools, what: 'key' | 'text'): void {
  const ins = (type: string, id: string, impact: 'needs_review' | 'still_valid', reason: string) =>
    ctx.db.run(
      `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, ?, ?, ?, 0, ?, '[]')
       ON CONFLICT (alert_id, dependent_type, dependent_id) DO NOTHING`,
      [alertId, type, id, impact, reason],
    );
  for (const c of tools.cards) {
    ins('flashcard', c, 'needs_review', what === 'key' ? 'بطاقة صُنعت من خطأ في هذا السؤال؛ مفتاحه تغيّر، فراجع جوابها. سجل مراجعاتك محفوظ.' : 'بطاقة صُنعت من خطأ في هذا السؤال وتحمل نصه السابق؛ راجعها. سجل مراجعاتك محفوظ.');
  }
  for (const e of tools.exams) {
    if (e.unfinished) {
      ins('exam', e.id, 'needs_review', what === 'key' ? 'اختبار أُنشئ قبل التصحيح ولم يُنهَ: يثبّت النسخة السابقة ويُصحَّح بمفتاحها؛ الاختبار الجديد يستخدم المفتاح المصحح.' : 'اختبار أُنشئ قبل التصحيح ولم يُنهَ: يعرض النص السابق للسؤال.');
    } else {
      const started = ctx.db.get('SELECT 1 AS x FROM exam_attempt WHERE exam_id = ?', [e.id]);
      if (!started) continue;
      ins('exam', e.id, 'still_valid', 'اختبار مُنهى على النسخة السابقة: نتيجته كما هي ولم يُعَد تقييمه.');
    }
  }
}

/**
 * The owner corrected a FACT in the question itself (stem / options / explanation) — a new version (G8, AC-26). When
 * something was built on the previous version (attempts, cards from mistakes, exams that pin it) one alert names them;
 * nothing is re-graded or rewritten. Returns null when nothing depends on the previous version.
 */
export function questionCorrectionAlert(ctx: AppContext, questionId: string, oldVersionId: string, changedAr: string): string | null {
  const attempts = ctx.db.all<{ id: string }>('SELECT id FROM question_attempt WHERE question_version_id = ? ORDER BY answered_at, id', [oldVersionId]).map((r) => r.id);
  const tools = questionTools(ctx, questionId, oldVersionId);
  const exams = tools.exams.filter((e) => e.unfinished || ctx.db.get('SELECT 1 AS x FROM exam_attempt WHERE exam_id = ?', [e.id]));
  if (attempts.length === 0 && tools.cards.length === 0 && exams.length === 0) return null;
  const now = ctx.clock.now();
  const occ = primaryOccurrence(ctx, questionId);
  const parts = [
    attempts.length ? `${attempts.length === 1 ? 'محاولة واحدة' : `${attempts.length} محاولات`} على النسخة السابقة بقيت كما هي ولم يُعَد تقييمها` : '',
    tools.cards.length ? `${tools.cards.length === 1 ? 'بطاقة واحدة' : `${tools.cards.length} بطاقات`} من أخطائك فيه تحتاج مراجعة` : '',
    exams.some((e) => e.unfinished) ? 'اختبار لم يُنهَ ما زال على النسخة السابقة' : '',
  ].filter(Boolean);
  const summary = `صححتَ ${changedAr} في سؤال؛ أُنشئت نسخة جديدة والنسخة السابقة محفوظة. ${parts.join('، ')}.`;
  const alertId = newId(now);
  const affected = [
    { type: 'question_version', id: oldVersionId, impact: 'needs_review' as const },
    ...attempts.map((id) => ({ type: 'question_attempt', id, impact: 'still_valid' as const })),
    ...tools.cards.map((id) => ({ type: 'flashcard', id, impact: 'needs_review' as const })),
  ];
  ctx.db.run(
    `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, summary, affected_json, status, created_at, details_json)
     VALUES (?, 'source_updated', 'fact_change', ?, ?, ?, ?, 'open', ?, ?)`,
    [alertId, occ?.source_id ?? null, occ?.source_version_id ?? null, summary, toJson(affected), now, toJson({ question_id: questionId, corrected: changedAr, by: 'owner' })],
  );
  ctx.db.run(
    `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, 'question_version', ?, 'needs_review', 0, ?, '[]')`,
    [alertId, oldVersionId, `النسخة السابقة من السؤال قبل تصحيح ${changedAr}؛ محفوظة كما هي مع محاولاتها.`],
  );
  for (const id of attempts) {
    ctx.db.run(
      `INSERT INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, 'question_attempt', ?, 'still_valid', 0, ?, '[]')
       ON CONFLICT (alert_id, dependent_type, dependent_id) DO NOTHING`,
      [alertId, id, 'محاولة على النسخة السابقة؛ بقيت مرتبطة بها ولم يتغير تقييمها.'],
    );
  }
  addToolItems(ctx, alertId, { cards: tools.cards, exams }, 'text');
  return alertId;
}
