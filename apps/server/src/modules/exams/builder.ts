// Exam builder (§39, AC-14, AC-17): selects items from the Question Vault by scope and filters, never the same
// question twice (one question with several occurrences, confirmed duplicates and derived translations are ONE
// item), pins question_version_id and a stable option order, and — in assessed modes — keeps only scorable
// questions. The policy is computed here and stored with the exam; it never changes afterwards.
import { createHash } from 'node:crypto';
import {
  EXAM_MODE_LABELS_AR,
  MCQ_QUESTION_TYPES,
  isAssessedMode,
  newId,
  richTextToPlain,
  type ExamBuildExclusion,
  type ExamBuildReport,
  type ExamCreateRequest,
  type ExamExclusionCode,
  type ExamPolicyView,
  type QuestionType,
  type RichText,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { listForExam, type ExamCandidate } from '../questions/service';
import { displayLabels, optionOrder, questionMediaFiles } from './delivery';
import { defaultPolicy, questionsAr, type ExamItemRecord } from './store';

// ───────── deterministic randomness ─────────
export function seededRandom(seed: string): () => number {
  const h = createHash('sha256').update(seed).digest();
  let a = h.readUInt32LE(0);
  return () => {
    // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ───────── candidates ─────────
interface Candidate extends ExamCandidate {
  group: string;
  difficulty: 'easy' | 'medium' | 'hard' | null;
  difficulty_origin: 'estimate' | 'personal' | null;
  is_mistake: boolean;
  attempted: boolean;
  media_problem: boolean;
}

const QUESTION_SOURCE_TYPES = new Set(['question_source', 'previous_exam']);

function unionCandidates(lists: ExamCandidate[][]): ExamCandidate[] {
  const out = new Map<string, ExamCandidate>();
  for (const l of lists) for (const c of l) if (!out.has(c.question_id)) out.set(c.question_id, c);
  return [...out.values()];
}

function gather(ctx: AppContext, req: ExamCreateRequest): ExamCandidate[] {
  const lists: ExamCandidate[][] = [];
  const base = { limit: 5000 } as const;
  const sources = req.source_ids?.length
    ? ctx.db.all<{ id: string; source_type: string }>(
        `SELECT id, source_type FROM source WHERE deleted_at IS NULL AND id IN (${req.source_ids.map(() => '?').join(',')})`,
        req.source_ids,
      )
    : [];
  if (req.source_ids?.length && sources.length === 0) throw new AppError('NOT_FOUND', 'المصادر المختارة غير موجودة أو محذوفة.', 404);
  const questionSources = sources.filter((s) => QUESTION_SOURCE_TYPES.has(s.source_type)).map((s) => s.id);
  const lectures = sources.filter((s) => !QUESTION_SOURCE_TYPES.has(s.source_type)).map((s) => s.id);
  if (req.lecture_only_answerable && lectures.length === 0) {
    throw new AppError('VALIDATION_FAILED', '«من محاضرتي فقط» يحتاج اختيار محاضرة واحدة على الأقل.', 400, {
      where: 'body',
      issues: [{ path: 'lecture_only_answerable', code: 'custom', message: 'اختر محاضرة أولًا.' }],
    });
  }
  if (req.question_ids?.length) lists.push(listForExam(ctx, { ...base, questionIds: req.question_ids }));
  if (questionSources.length) lists.push(listForExam(ctx, { ...base, sourceIds: questionSources }));
  if (lectures.length) {
    if (req.lecture_only_answerable) for (const l of lectures) lists.push(listForExam(ctx, { ...base, lectureOnlyAnswerable: l }));
    else lists.push(listForExam(ctx, { ...base, lectureSourceIds: lectures }));
  }
  if (req.course_node_ids?.length) lists.push(listForExam(ctx, { ...base, courseNodeIds: req.course_node_ids }));
  const scoped = !!(req.question_ids?.length || req.source_ids?.length || req.course_node_ids?.length);
  if (!scoped) lists.push(listForExam(ctx, base));
  let all = unionCandidates(lists);
  // a /practice deep link always reaches its question (if it still exists), whatever the filters say
  if (req.start_question_id && !all.some((c) => c.question_id === req.start_question_id)) {
    all = [...listForExam(ctx, { questionIds: [req.start_question_id] }), ...all];
  }
  return all;
}

/** One group per «same question»: listForExam's duplicate_group + translation/paraphrase lineage (§37). */
function lineageGroups(ctx: AppContext, cands: ExamCandidate[]): Map<string, string> {
  const group = new Map(cands.map((c) => [c.question_id, c.duplicate_group]));
  if (cands.length === 0) return group;
  const ids = cands.map((c) => c.version_id);
  const rows: Array<{ id: string; origin_q: string }> = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    rows.push(
      ...ctx.db.all<{ id: string; origin_q: string }>(
        `SELECT v.question_id AS id, o.question_id AS origin_q FROM question_version v JOIN question_version o ON o.id = v.derived_from_version_id
          WHERE v.id IN (${part.map(() => '?').join(',')}) AND v.kind IN ('translation','paraphrase') AND o.question_id <> v.question_id`,
        part,
      ),
    );
  }
  for (const r of rows) {
    const target = group.get(r.origin_q) ?? r.origin_q;
    group.set(r.id, target);
  }
  return group;
}

interface Personal {
  mistakes: Set<string>;
  attempted: Set<string>;
  stats: Map<string, { n: number; c: number }>;
}

function personal(ctx: AppContext): Personal {
  const mistakes = new Set<string>();
  const attempted = new Set<string>();
  const stats = new Map<string, { n: number; c: number }>();
  const rows = ctx.db.all<{ question_id: string; is_correct: number | null; scored: number; answered_at: number }>(
    'SELECT question_id, is_correct, scored, answered_at FROM question_attempt ORDER BY answered_at',
  );
  const latest = new Map<string, number | null>();
  for (const r of rows) {
    attempted.add(r.question_id);
    if (r.scored !== 1) continue;
    latest.set(r.question_id, r.is_correct);
    const s = stats.get(r.question_id) ?? { n: 0, c: 0 };
    s.n++;
    if (r.is_correct === 1) s.c++;
    stats.set(r.question_id, s);
  }
  for (const [q, c] of latest) if (c === 0) mistakes.add(q);
  return { mistakes, attempted, stats };
}

function difficultyOf(est: string | null, stats: { n: number; c: number } | undefined): { d: Candidate['difficulty']; origin: Candidate['difficulty_origin'] } {
  if (est) {
    if (est === 'easy') return { d: 'easy', origin: 'estimate' };
    if (est === 'medium') return { d: 'medium', origin: 'estimate' };
    if (est === 'hard' || est === 'very_hard') return { d: 'hard', origin: 'estimate' };
  }
  if (stats && stats.n >= 2) {
    const r = stats.c / stats.n;
    return { d: r >= 0.8 ? 'easy' : r <= 0.4 ? 'hard' : 'medium', origin: 'personal' };
  }
  return { d: null, origin: null };
}

// ───────── build ─────────
export interface BuildResult {
  report: ExamBuildReport;
  items: ExamItemRecord[];
  policy: ExamPolicyView;
  seed: string;
}

const REASONS_AR: Record<ExamExclusionCode, string> = {
  unscorable: 'مفتاحها غير محسوم أو لم تجتز فحصًا مانعًا — لا تدخل اختبارًا محسوبًا (تبقى للتدريب غير المحسوب)',
  duplicate: 'السؤال نفسه ظهر في أكثر من موضع/ملف؛ أُدرج مرة واحدة',
  written_type: 'أسئلة مكتوبة (مقالية/قصيرة) تُحل في صفحة الإجابة المكتوبة',
  difficulty: 'صعوبتها التقديرية تختلف عن الصعوبة المطلوبة',
  media_unavailable: 'يعتمد السؤال على صورة لا يمكن عرضها الآن',
  origin_mix: 'لم تدخل بسبب نسبة الأسئلة الأصلية إلى المولدة التي اخترتها',
  not_needed: 'مطابقة لكن العدد المطلوب اكتمل',
};

function addExclusion(map: Map<ExamExclusionCode, ExamBuildExclusion>, code: ExamExclusionCode, questionId: string): void {
  const e = map.get(code) ?? { code, reason_ar: REASONS_AR[code], count: 0, question_ids: [] };
  e.count++;
  if (e.question_ids.length < 50) e.question_ids.push(questionId);
  map.set(code, e);
}

export function buildExam(ctx: AppContext, req: ExamCreateRequest): BuildResult {
  const mode = req.mode;
  const assessed = isAssessedMode(mode);
  const seed = req.seed ?? newId(ctx.clock.now());
  const rand = seededRandom(seed);
  const exclusions = new Map<ExamExclusionCode, ExamBuildExclusion>();
  const notes: string[] = [];
  const wantedTypes = new Set<QuestionType>(req.qtypes?.length ? req.qtypes : MCQ_QUESTION_TYPES);

  const raw = gather(ctx, req);
  const groups = lineageGroups(ctx, raw);
  const me = personal(ctx);
  const versionInfo = new Map<string, { difficulty_est: string | null }>();
  for (let i = 0; i < raw.length; i += 400) {
    const part = raw.slice(i, i + 400).map((c) => c.version_id);
    if (part.length === 0) continue;
    for (const r of ctx.db.all<{ id: string; difficulty_est: string | null }>(
      `SELECT id, difficulty_est FROM question_version WHERE id IN (${part.map(() => '?').join(',')})`,
      part,
    ))
      versionInfo.set(r.id, { difficulty_est: r.difficulty_est });
  }

  let cands: Candidate[] = raw.map((c) => {
    const d = difficultyOf(versionInfo.get(c.version_id)?.difficulty_est ?? null, me.stats.get(c.question_id));
    return {
      ...c,
      group: groups.get(c.question_id) ?? c.duplicate_group,
      difficulty: d.d,
      difficulty_origin: d.origin,
      is_mistake: me.mistakes.has(c.question_id),
      attempted: me.attempted.has(c.question_id),
      media_problem: false,
    };
  });
  const matched = cands.length;
  const scorableCount = cands.filter((c) => c.scorable).length;

  // question types: written items go to the written flow
  cands = cands.filter((c) => {
    if (!MCQ_QUESTION_TYPES.includes(c.qtype)) {
      addExclusion(exclusions, 'written_type', c.question_id);
      return false;
    }
    return wantedTypes.has(c.qtype);
  });
  // a question whose figure cannot be delivered cannot be answered fairly
  cands = cands.filter((c) => {
    const m = questionMediaFiles(ctx, c.question_id);
    if (m.figuresWithoutFile > 0) {
      addExclusion(exclusions, 'media_unavailable', c.question_id);
      return false;
    }
    return true;
  });
  // assessed modes: only scorable (AC-14)
  if (assessed) {
    cands = cands.filter((c) => {
      if (!c.scorable) {
        addExclusion(exclusions, 'unscorable', c.question_id);
        return false;
      }
      return true;
    });
  }
  // difficulty (estimates only): matching first, unknown fills, different estimate excluded
  const wantDiff = req.difficulty && req.difficulty !== 'any' ? req.difficulty : null;
  let unknownDifficulty = 0;
  if (wantDiff) {
    cands = cands.filter((c) => {
      if (c.difficulty && c.difficulty !== wantDiff) {
        addExclusion(exclusions, 'difficulty', c.question_id);
        return false;
      }
      return true;
    });
  }

  // order: deep-link question first, then (my mistakes), never attempted, attempted — shuffled inside each tier
  const tier = (c: Candidate) => (c.question_id === req.start_question_id ? 0 : req.include_my_mistakes && c.is_mistake ? 1 : wantDiff && c.difficulty === wantDiff ? 2 : !c.attempted ? 3 : 4);
  const byTier = new Map<number, Candidate[]>();
  for (const c of cands) byTier.set(tier(c), [...(byTier.get(tier(c)) ?? []), c]);
  // inside a tier prefer scorable members so a duplicate group keeps its scorable copy
  const ordered = [...byTier.keys()].sort((a, b) => a - b).flatMap((t) => {
    const sh = shuffle(byTier.get(t)!, rand);
    return [...sh.filter((c) => c.scorable), ...sh.filter((c) => !c.scorable)];
  });

  // never the same question twice (AC-17)
  const seenGroups = new Set<string>();
  const unique: Candidate[] = [];
  let duplicatesRemoved = 0;
  for (const c of ordered) {
    if (seenGroups.has(c.group)) {
      duplicatesRemoved++;
      addExclusion(exclusions, 'duplicate', c.question_id);
      continue;
    }
    seenGroups.add(c.group);
    unique.push(c);
  }

  // origin mix (source + owner = «original»; generated)
  const count = Math.max(1, Math.min(req.count, 200));
  const original = unique.filter((c) => c.origin_type !== 'generated');
  const generated = unique.filter((c) => c.origin_type === 'generated');
  let wantGen = generated.length;
  let wantOrig = original.length;
  if (req.origin_mix && req.origin_mix.source + req.origin_mix.generated > 0) {
    const g = req.origin_mix.generated / (req.origin_mix.source + req.origin_mix.generated);
    wantGen = Math.round(count * g);
    wantOrig = count - wantGen;
    if (generated.length < wantGen) {
      notes.push(`طلبت ${questionsAr(wantGen)} مولدة وتوفر ${questionsAr(generated.length)} فقط؛ أُكمل العدد من الأسئلة الأصلية إن وُجدت.`);
      wantOrig += wantGen - generated.length;
      wantGen = generated.length;
    }
    if (original.length < wantOrig) {
      const missing = wantOrig - original.length;
      if (wantGen < generated.length) {
        const extra = Math.min(missing, generated.length - wantGen);
        notes.push(`لم تتوفر أسئلة أصلية كافية؛ أُضيف ${questionsAr(extra)} مولدة لإكمال العدد.`);
        wantGen += extra;
      }
      wantOrig = original.length;
    }
  }
  const pickedIds = new Set<string>();
  if (req.origin_mix && req.origin_mix.source + req.origin_mix.generated > 0) {
    for (const c of generated.slice(0, wantGen)) pickedIds.add(c.question_id);
    for (const c of original.slice(0, wantOrig)) pickedIds.add(c.question_id);
  }
  const selected: Candidate[] = [];
  for (const c of unique) {
    if (selected.length >= count) break;
    if (pickedIds.size > 0 && !pickedIds.has(c.question_id)) continue;
    selected.push(c);
  }
  for (const c of unique) {
    if (selected.includes(c)) continue;
    addExclusion(exclusions, pickedIds.size > 0 && !pickedIds.has(c.question_id) ? 'origin_mix' : 'not_needed', c.question_id);
  }
  if (wantDiff) unknownDifficulty = selected.filter((c) => !c.difficulty).length;
  if (unknownDifficulty > 0) notes.push(`الصعوبة تقديرية؛ ${questionsAr(unknownDifficulty)} بلا تقدير صعوبة أُدرجت لإكمال العدد.`);
  if (selected.length < count) notes.push(`طلبت ${questionsAr(count)} وتوفر ${questionsAr(selected.length)} مطابقة للشروط.`);
  if (req.include_my_mistakes && me.mistakes.size === 0) notes.push('لا توجد أخطاء سابقة محسوبة لتُضاف («أخطائي» فارغة).');
  if (!assessed && selected.some((c) => !c.scorable)) notes.push('بعض الأسئلة بلا مفتاح محسوم: تظهر للتدريب وتبقى خارج النتيجة، مع السبب.');

  // policy (fixed from now on)
  const policy = defaultPolicy(mode, req.minutes ?? null, req.per_question_seconds ?? null, selected.length);
  if (req.policy) {
    if (req.policy.pause_allowed !== undefined && mode !== 'time_pressure') policy.pause_allowed = req.policy.pause_allowed;
    if (req.policy.shuffle_options !== undefined) policy.shuffle_options = req.policy.shuffle_options;
    if (!assessed && req.policy.hints) policy.hints = req.policy.hints;
    if (!assessed && req.policy.anti_shortcut !== undefined) policy.anti_shortcut = req.policy.anti_shortcut;
  }

  // pinned items with their option order
  const items: ExamItemRecord[] = selected.map((c) => {
    const v = ctx.db.get<{ shuffle_allowed: number }>('SELECT shuffle_allowed FROM question_version WHERE id = ?', [c.version_id]);
    const opts = ctx.db.all<{ id: string; ord: number; pinned_position: number; text_json: string; source_label: string | null }>(
      'SELECT id, ord, pinned_position, text_json, source_label FROM question_option WHERE question_version_id = ? ORDER BY ord',
      [c.version_id],
    );
    const order = optionOrder(
      opts.map((o) => ({ id: o.id, ord: o.ord, pinned: o.pinned_position === 1, text: richTextToPlain(fromJson<RichText | null>(o.text_json, null)) })),
      policy.shuffle_options && v?.shuffle_allowed === 1 && c.qtype !== 'true_false',
      rand,
    );
    return {
      question_id: c.question_id,
      question_version_id: c.version_id,
      option_order: order,
      display_labels: displayLabels(opts.map((o) => o.source_label), order.length),
      scored: c.scorable,
      unscored_reason_ar: c.scorable ? null : c.unscorable_reason_ar ?? 'لا يُحتسب في النتيجة.',
      origin_type: c.origin_type,
    };
  });

  const report: ExamBuildReport = {
    requested: count,
    matched,
    scorable: scorableCount,
    unscorable: matched - scorableCount,
    duplicates_removed: duplicatesRemoved,
    selected: items.length,
    selected_scored: items.filter((i) => i.scored).length,
    selected_unscored: items.filter((i) => !i.scored).length,
    by_origin: {
      source: items.filter((i) => i.origin_type === 'source').length,
      generated: items.filter((i) => i.origin_type === 'generated').length,
      owner: items.filter((i) => i.origin_type === 'owner').length,
    },
    my_mistakes: cands.filter((c) => c.is_mistake).length,
    exclusions: [...exclusions.values()],
    notes_ar: notes,
  };
  return { report, items, policy, seed };
}

export function defaultTitle(req: ExamCreateRequest): string {
  return req.title?.trim() || EXAM_MODE_LABELS_AR[req.mode];
}

/** Persist the exam + its first attempt (idempotent by the client attempt id). */
export function createExam(ctx: AppContext, req: ExamCreateRequest, deviceId: string | null): { examId: string; attemptId: string; created: boolean } {
  return ctx.db.tx(() => {
    if (req.attempt_id) {
      const existing = ctx.db.get<{ id: string; exam_id: string }>('SELECT id, exam_id FROM exam_attempt WHERE id = ?', [req.attempt_id]);
      if (existing) return { examId: existing.exam_id, attemptId: existing.id, created: false };
    }
    const built = buildExam(ctx, req);
    if (built.items.length === 0) {
      throw new AppError('CONFLICT', 'لا توجد أسئلة مطابقة يمكن وضعها في هذا الاختبار. راجع الأسباب ووسّع الاختيار.', 409, { report: built.report });
    }
    const now = ctx.clock.now();
    const examId = newId(now);
    const attemptId = req.attempt_id ?? newId(now);
    const { attempt_id: _a, policy: _p, seed: _s, ...config } = req;
    ctx.db.run(
      `INSERT INTO exam (id, title, mode, config_json, policy_json, items_json, is_generated_simulation, created_at, build_json, seed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        examId,
        defaultTitle(req).slice(0, 200),
        req.mode,
        toJson(config),
        toJson(built.policy),
        toJson(built.items),
        req.mode === 'simulation' && built.items.some((i) => i.origin_type === 'generated') ? 1 : 0,
        now,
        toJson(built.report),
        built.seed,
      ],
    );
    ctx.db.run(
      `INSERT INTO exam_attempt (id, exam_id, status, started_at, finished_at, elapsed_ms, timer_json, current_index, result_json, updated_at, answers_json, flags_json, rev, device_id)
       VALUES (?, ?, 'in_progress', ?, NULL, 0, ?, 0, NULL, ?, '{}', '[]', 1, ?)`,
      [attemptId, examId, now, toJson({ item_ms: {}, pauses: 0, paused_at: null }), now, deviceId],
    );
    ctx.sync.touch('exam_attempt', attemptId);
    ctx.audit.record({
      entityType: 'exam',
      entityId: examId,
      action: 'create',
      summary: `${EXAM_MODE_LABELS_AR[req.mode]}: ${questionsAr(built.items.length)} (${built.report.selected_scored} محسوبة)`,
      after: { policy: built.policy, items: built.items.length, report: built.report },
      actor: 'owner',
    });
    return { examId, attemptId, created: true };
  });
}
