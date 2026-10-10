// My Exam DNA & Exam Relevance (§40). From the owner's OWN question sources only (question_source, previous_exam):
//  * explicit denominators — «unique» (one question even if it repeats across files; exact duplicates are one question
//    with several occurrences) vs «occurrences» (places it appears), every ratio shown with its denominator;
//  * sample size, files and the KNOWN date range (only the publication date the owner / file gave — never guessed);
//  * warnings for small / single-file / undated / old / poorly classified samples; no teacher or department pattern
//    is inferred; topics absent from the sample are not «safe to skip»;
//  * Exam Relevance: an importance indicator inside the archive with its reasons — explicitly NOT a probability.
import { type ExamDnaDetail, type ExamRelevanceView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';

export const RELEVANCE_NOTE_AR = 'مؤشر أهمية داخل أرشيفك وكورسك، وليس احتمال ظهور السؤال في الامتحان. لا تُهمل المواضيع التي لم تظهر في العينة.';

interface OccRow {
  question_id: string;
  source_id: string;
}

interface Sample {
  sources: Array<{ id: string; title: string; source_type: string; publication_date: string | null }>;
  occ: OccRow[];
  uniqueIds: string[];
}

function sample(ctx: AppContext, opts: { courseNodeId?: string | null; sourceIds?: string[] | null } = {}): Sample {
  const where = [`s.deleted_at IS NULL`, `s.source_type IN ('question_source','previous_exam')`];
  const params: unknown[] = [];
  if (opts.courseNodeId) {
    where.push('(s.course_node_id = ? OR s.node_id = ? OR s.subject_node_id = ?)');
    params.push(opts.courseNodeId, opts.courseNodeId, opts.courseNodeId);
  }
  if (opts.sourceIds?.length) {
    where.push(`s.id IN (${opts.sourceIds.map(() => '?').join(',')})`);
    params.push(...opts.sourceIds);
  }
  const sources = ctx.db.all<{ id: string; title: string; source_type: string; publication_date: string | null }>(
    `SELECT s.id, s.title, s.source_type, s.publication_date FROM source s WHERE ${where.join(' AND ')} ORDER BY s.created_at, s.id`,
    params,
  );
  const occ: OccRow[] = [];
  for (const s of sources) {
    occ.push(
      ...ctx.db.all<OccRow>(
        `SELECT o.question_id, o.source_id FROM question_occurrence o JOIN question q ON q.id = o.question_id JOIN source s ON s.id = o.source_id
          WHERE o.source_id = ? AND o.status = 'current' AND q.deleted_at IS NULL
            AND o.source_version_id = COALESCE(s.frozen_version_id, s.current_version_id)`,
        [s.id],
      ),
    );
  }
  return { sources, occ, uniqueIds: [...new Set(occ.map((o) => o.question_id))] };
}

function conceptsOf(ctx: AppContext, questionId: string): Array<{ id: string; label: string }> {
  const ids = new Set<string>();
  for (const l of ctx.db.all<{ reason_json: string | null }>(`SELECT reason_json FROM question_lecture_link WHERE question_id = ? AND status <> 'rejected'`, [questionId])) {
    for (const c of fromJson<{ concepts?: string[] }>(l.reason_json, {})?.concepts ?? []) ids.add(c);
  }
  if (ids.size === 0) return [];
  return ctx.db
    .all<{ id: string; name_ar: string | null; name_en: string | null }>(`SELECT id, name_ar, name_en FROM concept WHERE status <> 'rejected' AND id IN (${[...ids].map(() => '?').join(',')})`, [...ids])
    .map((c) => ({ id: c.id, label: c.name_ar || c.name_en || c.id }));
}

function lecturesOf(ctx: AppContext, questionId: string): Array<{ id: string; title: string }> {
  return ctx.db.all<{ id: string; title: string }>(
    `SELECT s.id, s.title FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only' AND s.deleted_at IS NULL`,
    [questionId],
  );
}

const pct = (n: number, d: number) => (d > 0 ? `${n} من ${d}` : '—');

export function examDna(ctx: AppContext, opts: { courseNodeId?: string | null; sourceIds?: string[] | null } = {}): ExamDnaDetail {
  const s = sample(ctx, opts);
  const N = s.uniqueIds.length;
  const occByQ = new Map<string, number>();
  for (const o of s.occ) occByQ.set(o.question_id, (occByQ.get(o.question_id) ?? 0) + 1);
  const byConcept = new Map<string, { label: string; unique: number; occurrences: number }>();
  const byLecture = new Map<string, { title: string; unique: number }>();
  const byType = new Map<string, number>();
  let noConcept = 0;
  let noType = 0;
  let noLecture = 0;
  for (const qid of s.uniqueIds) {
    const cs = conceptsOf(ctx, qid);
    if (cs.length === 0) noConcept++;
    for (const c of cs) {
      const e = byConcept.get(c.id) ?? { label: c.label, unique: 0, occurrences: 0 };
      e.unique++;
      e.occurrences += occByQ.get(qid) ?? 0;
      byConcept.set(c.id, e);
    }
    const ls = lecturesOf(ctx, qid);
    if (ls.length === 0) noLecture++;
    for (const l of ls) {
      const e = byLecture.get(l.id) ?? { title: l.title, unique: 0 };
      e.unique++;
      byLecture.set(l.id, e);
    }
    const t = ctx.db.get<{ item_type: string | null }>('SELECT v.item_type FROM question q JOIN question_version v ON v.id = q.current_version_id WHERE q.id = ?', [qid])?.item_type ?? null;
    if (!t) noType++;
    byType.set(t ?? 'unclassified', (byType.get(t ?? 'unclassified') ?? 0) + 1);
  }
  const filesWithQuestions = new Set(s.occ.map((o) => o.source_id));
  const used = s.sources.filter((x) => filesWithQuestions.has(x.id));
  const dates = used.map((x) => x.publication_date).filter((d): d is string => !!d && d.trim().length > 0).sort();
  const warnings: string[] = [];
  if (N === 0) warnings.push('لا توجد أسئلة مستخرجة من مصادر أسئلتك بعد؛ ارفع ملفات أسئلة أو امتحانات سابقة ليظهر التحليل.');
  else {
    if (N < 30) warnings.push(`العينة صغيرة (${N} سؤالًا فريدًا)؛ التكرار فيها قد يكون مصادفة ولا يمثل الامتحان بالضرورة.`);
    if (used.length < 2) warnings.push('الأسئلة من ملف واحد فقط؛ لا يكفي لاستنتاج نمط.');
    if (dates.length === 0) warnings.push('تاريخ الأسئلة غير معروف (لم يُحدَّد تاريخ نشر للملفات)؛ لا يُعرف إن كانت حديثة أم قديمة.');
    else if (dates.length < used.length) warnings.push(`تاريخ ${used.length - dates.length} من ${used.length} ملفات غير معروف.`);
    const newestYear = dates.length ? Number(/^(\d{4})/.exec(dates[dates.length - 1]!)?.[1] ?? NaN) : NaN;
    const thisYear = new Date(ctx.clock.now()).getUTCFullYear();
    if (Number.isFinite(newestYear) && thisYear - newestYear >= 5) warnings.push(`أحدث ملف معروف التاريخ من ${newestYear}؛ قد تكون العينة قديمة ولا تمثل المنهج الحالي.`);
    if (noConcept > N / 2) warnings.push(`${pct(noConcept, N)} سؤالًا فريدًا غير مربوط بمفهوم؛ التوزيع حسب المفهوم ناقص.`);
    warnings.push('لا يُنسب أي نمط إلى مدرّس أو قسم: الملفات لا تحمل بيانات كافية لذلك.');
    warnings.push('المواضيع التي لم تظهر في العينة قد تأتي في الامتحان؛ لا تتركها بسبب هذا التحليل.');
  }
  return {
    sample: {
      files: used.length,
      unique_questions: N,
      occurrences: s.occ.length,
      date_range: dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0]! : `${dates[0]} – ${dates[dates.length - 1]}`) : null,
    },
    by_concept: [...byConcept.values()].map((c) => ({ ...c, denominator_unique: N })).sort((a, b) => b.unique - a.unique || b.occurrences - a.occurrences || a.label.localeCompare(b.label)),
    by_item_type: [...byType.entries()].map(([item_type, count]) => ({ item_type, count, denominator: N })).sort((a, b) => b.count - a.count || a.item_type.localeCompare(b.item_type)),
    warnings_ar: warnings,
    relevance_note_ar: RELEVANCE_NOTE_AR,
    sources: s.sources.map((x) => ({
      source_id: x.id,
      title: x.title,
      source_type: x.source_type,
      publication_date: x.publication_date,
      unique_questions: new Set(s.occ.filter((o) => o.source_id === x.id).map((o) => o.question_id)).size,
      occurrences: s.occ.filter((o) => o.source_id === x.id).length,
    })),
    by_lecture: [...byLecture.entries()].map(([id, l]) => ({ lecture_source_id: id, title: l.title, unique: l.unique, denominator_unique: N })).sort((a, b) => b.unique - a.unique),
    unclassified: { concept: noConcept, item_type: noType, lecture: noLecture },
    counting_note_ar:
      '«فريد» = السؤال يُعد مرة واحدة حتى لو تكرر في عدة ملفات (التكرارات المطابقة مدموجة في سؤال واحد). «مرات الظهور» = عدد مواضع ظهوره في الملفات. كل رقم يُعرض مع مقامه (عدد الأسئلة الفريدة في العينة).',
    generated_at: ctx.clock.now(),
  };
}

const LEVEL_AR: Record<ExamRelevanceView['level'], string> = {
  high: 'أهمية عالية في أرشيفك',
  medium: 'أهمية متوسطة في أرشيفك',
  low: 'أهمية منخفضة في أرشيفك',
  not_in_sample: 'لم يظهر في عينة أسئلتك',
};

export function examRelevance(ctx: AppContext, target: { questionId?: string | null; conceptId?: string | null }): ExamRelevanceView {
  if (!target.questionId && !target.conceptId) throw new AppError('VALIDATION_FAILED', 'حدّد سؤالًا أو مفهومًا.', 400);
  const s = sample(ctx);
  const N = s.uniqueIds.length;
  let qOcc = 0;
  let qFiles = 0;
  let concepts: Array<{ id: string; label: string }> = [];
  if (target.questionId) {
    if (!ctx.db.get('SELECT 1 AS x FROM question WHERE id = ? AND deleted_at IS NULL', [target.questionId])) throw new AppError('NOT_FOUND', 'السؤال غير موجود.', 404);
    const occ = s.occ.filter((o) => o.question_id === target.questionId);
    qOcc = occ.length;
    qFiles = new Set(occ.map((o) => o.source_id)).size;
    concepts = conceptsOf(ctx, target.questionId);
  } else {
    const c = ctx.db.get<{ id: string; name_ar: string | null; name_en: string | null }>(`SELECT id, name_ar, name_en FROM concept WHERE id = ? AND status <> 'rejected'`, [target.conceptId!]);
    if (!c) throw new AppError('NOT_FOUND', 'المفهوم غير موجود.', 404);
    concepts = [{ id: c.id, label: c.name_ar || c.name_en || c.id }];
  }
  // the most frequent concept of the target inside the sample
  let best = { label: '', unique: 0, occurrences: 0, id: '' };
  const occByQ = new Map<string, number>();
  for (const o of s.occ) occByQ.set(o.question_id, (occByQ.get(o.question_id) ?? 0) + 1);
  const conceptIdsByQ = new Map<string, Set<string>>();
  if (concepts.length) for (const qid of s.uniqueIds) conceptIdsByQ.set(qid, new Set(conceptsOf(ctx, qid).map((x) => x.id)));
  for (const c of concepts) {
    let unique = 0;
    let occurrences = 0;
    for (const qid of s.uniqueIds) {
      if (conceptIdsByQ.get(qid)?.has(c.id)) {
        unique++;
        occurrences += occByQ.get(qid) ?? 0;
      }
    }
    if (unique > best.unique) best = { label: c.label, unique, occurrences, id: c.id };
  }
  const mentions = concepts.length
    ? (ctx.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM concept_mention m JOIN source_version v ON v.id = m.version_id JOIN source s ON s.id = v.source_id
          WHERE m.concept_id IN (${concepts.map(() => '?').join(',')}) AND s.deleted_at IS NULL AND s.source_type IN ('lecture','course_reference','textbook')
            AND m.version_id = COALESCE(s.frozen_version_id, s.current_version_id)`,
        concepts.map((c) => c.id),
      )?.n ?? 0)
    : 0;
  const reasons: string[] = [];
  if (target.questionId) {
    reasons.push(qOcc > 0 ? `ظهر هذا السؤال ${qOcc === 1 ? 'مرة واحدة' : `${qOcc} مرات`} في ${qFiles === 1 ? 'ملف واحد' : `${qFiles} ملفات`} من مصادر أسئلتك.` : 'هذا السؤال غير موجود في مصادر أسئلتك المرفوعة (ربما مولّد أو أضفته بنفسك).');
  }
  if (best.unique > 0) reasons.push(`المفهوم «${best.label}» ظهر في ${pct(best.unique, N)} سؤالًا فريدًا (${best.occurrences} مرة ظهور).`);
  else if (concepts.length) reasons.push(`المفهوم «${concepts[0]!.label}» لا يظهر في أسئلة العينة.`);
  else reasons.push('السؤال غير مربوط بمفهوم، فلا يمكن حساب تكرار موضوعه.');
  reasons.push(mentions > 0 ? `المفهوم مذكور في موادك الدراسية (${mentions} ${mentions === 1 ? 'موضع' : 'مواضع'}).` : 'لم يُعثر على المفهوم في محاضراتك ومراجعك المعالجة.');
  let level: ExamRelevanceView['level'];
  if (qOcc === 0 && best.unique === 0) level = 'not_in_sample';
  else if (qFiles >= 2 || best.unique >= Math.max(3, Math.ceil(N * 0.1))) level = 'high';
  else if (best.unique >= 2) level = 'medium';
  else level = 'low';
  if (N < 10 && level === 'high') {
    level = 'medium';
    reasons.push(`العينة صغيرة (${N} سؤالًا فريدًا)، فلا يُعطى المؤشر درجة «عالية».`);
  }
  return {
    question_id: target.questionId ?? null,
    concept_id: target.conceptId ?? (best.id || null),
    level,
    level_label_ar: LEVEL_AR[level],
    reasons_ar: reasons,
    counts: { concept_unique: best.unique, concept_occurrences: best.occurrences, question_occurrences: qOcc, files_with_question: qFiles, lecture_mentions: mentions, sample_unique: N },
    note_ar: RELEVANCE_NOTE_AR,
  };
}

/** Questions that repeat across the owner's files (for Home «important questions»). */
export function repeatedQuestions(ctx: AppContext, limit: number): Array<{ question_id: string; files: number; occurrences: number }> {
  const s = sample(ctx);
  const files = new Map<string, Set<string>>();
  const occ = new Map<string, number>();
  for (const o of s.occ) {
    files.set(o.question_id, (files.get(o.question_id) ?? new Set()).add(o.source_id));
    occ.set(o.question_id, (occ.get(o.question_id) ?? 0) + 1);
  }
  return [...files.entries()]
    .filter(([, f]) => f.size >= 2)
    .map(([q, f]) => ({ question_id: q, files: f.size, occurrences: occ.get(q) ?? 0 }))
    .sort((a, b) => b.files - a.files || b.occurrences - a.occurrences || (a.question_id < b.question_id ? -1 : 1))
    .slice(0, limit);
}
