// Weakness Center (§44, AC-27). Signals from MCQ attempts (question_attempt), card lapses / recalls (review_event),
// graded written answers (written_attempt) — case / OSCE attempts have no data contract yet and are listed as not
// collected. Signals are grouped by concept, lecture and topic (via the question's lecture links and their concepts,
// the card's concept / topic / source); a question with repeated mistakes and no group is its own weakness.
//
// Score (transparent estimate, shown with its formula): Σ|wrong weights| ÷ (Σ|wrong weights| + Σ correct weights),
// weights = MASTERY_WEIGHTS (a guessed / hint-assisted correct answer adds much less than a confident independent one).
// Status: active → improving (≥ 2 good answers since the last mistake) → resolved (≥ 3 confident independent answers
// since the last mistake); the owner can dismiss / resolve / reactivate (kept until NEW mistakes arrive after it).
// Repeated mistakes produce a dedicated revision (revision.ts), not just a counter.
import {
  MASTERY_SIGNAL_LABELS_AR,
  MASTERY_WEIGHTS,
  MISTAKE_TYPE_LABELS_AR,
  masterySignal,
  pageDisplayLabel,
  stemPreview,
  type ConfidenceLevel,
  type MasterySignal,
  type MistakeType,
  type RichText,
  type WeaknessDetailView,
  type WeaknessKind,
  type WeaknessListResponse,
  type WeaknessPatchRequest,
  type WeaknessSignal,
  type WeaknessSignalView,
  type WeaknessView,
} from '@medlevo/shared';
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { signalResets, type SignalResets } from './profile';
import { foldReviews, State } from './srs';
import { clip, pushTo, srsContext } from './store';

// ───────── signals ─────────
export interface RawSignal {
  ref: string;
  type: 'mcq' | 'card' | 'written';
  at: number;
  correct: boolean | null;
  category: string | null;
  category_label_ar: string;
  weight: number | null;
  confidence: ConfidenceLevel | null;
  hints_used: number;
  mistake_type: MistakeType | null;
  mistake_origin: 'auto' | 'owner' | null;
  question_id: string | null;
  card_id: string | null;
  label: string;
  /** independent confident recall (weight 1) */
  independent: boolean;
  groups: string[];
}

interface GroupInfo {
  kind: WeaknessKind;
  label: string;
  concept_id: string | null;
  topic_id: string | null;
  source_ids: Set<string>;
}

const RELATIONS_FOR_GROUPS = new Set(['directly_covered', 'strongly_related', 'partially_covered']);

interface QuestionGroups {
  lectures: Array<{ id: string; title: string; page_ids: string[] }>;
  concepts: Array<{ id: string; label: string }>;
  topics: Array<{ id: string; label: string }>;
}

function questionGroups(db: Db, questionId: string, cache: Map<string, QuestionGroups>): QuestionGroups {
  const hit = cache.get(questionId);
  if (hit) return hit;
  const links = db.all<{ lecture_source_id: string; title: string; relation: string; status: string; reason_json: string | null }>(
    `SELECT l.lecture_source_id, s.title, l.relation, l.status, l.reason_json FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
      WHERE l.question_id = ? AND l.status <> 'rejected' AND s.deleted_at IS NULL ORDER BY l.status = 'accepted' DESC, l.score DESC`,
    [questionId],
  );
  const lectures: QuestionGroups['lectures'] = [];
  const conceptIds = new Set<string>();
  for (const l of links) {
    if (l.status !== 'accepted' && !RELATIONS_FOR_GROUPS.has(l.relation)) continue;
    const rj = fromJson<{ concepts?: string[]; lecture_page_ids?: string[] }>(l.reason_json, {}) ?? {};
    lectures.push({ id: l.lecture_source_id, title: l.title, page_ids: rj.lecture_page_ids ?? [] });
    for (const c of rj.concepts ?? []) conceptIds.add(c);
  }
  const concepts = conceptIds.size
    ? db
        .all<{ id: string; name_ar: string | null; name_en: string | null }>(
          `SELECT id, name_ar, name_en FROM concept WHERE status <> 'rejected' AND id IN (${[...conceptIds].map(() => '?').join(',')})`,
          [...conceptIds],
        )
        .map((c) => ({ id: c.id, label: c.name_ar || c.name_en || c.id }))
    : [];
  const topics = db
    .all<{ id: string; title: string; title_ar: string | null }>(
      `SELECT t.id, t.title, t.title_ar FROM topic_link tl JOIN topic t ON t.id = tl.topic_id WHERE tl.entity_type = 'question' AND tl.entity_id = ? AND tl.status <> 'rejected'`,
      [questionId],
    )
    .map((t) => ({ id: t.id, label: t.title_ar || t.title }));
  const out = { lectures, concepts, topics };
  cache.set(questionId, out);
  return out;
}

const CARD_CATEGORY_AR = {
  card_lapse: 'بطاقة نُسيت بعد أن كانت في المراجعة (Again)',
  card_recall_hard: 'تذكّر البطاقة بصعوبة (Hard)',
  card_recall: 'تذكّر البطاقة (Good/Easy)',
};
const WRITTEN_CATEGORY_AR = {
  written_low: 'إجابة مقالية بتقدير منخفض (أقل من النصف — تقديري)',
  written_partial: 'إجابة مقالية بتقدير متوسط (تقديري)',
  written_good: 'إجابة مقالية بتقدير جيد (تقديري)',
  written_qualitative: 'إجابة مقالية بتقييم وصفي دون درجة',
};

export interface CollectResult {
  signals: RawSignal[];
  groups: Map<string, GroupInfo>;
  /** wrong attempts per question / lapses per card (repeated mistakes) */
  wrongByQuestion: Map<string, number>;
  lapsesByCard: Map<string, number>;
  questionPages: Map<string, QuestionGroups['lectures']>;
}

export function collectSignals(ctx: AppContext, resets: SignalResets = signalResets(ctx.db)): CollectResult {
  const db = ctx.db;
  const groups = new Map<string, GroupInfo>();
  const qcache = new Map<string, QuestionGroups>();
  const signals: RawSignal[] = [];
  const wrongByQuestion = new Map<string, number>();
  const lapsesByCard = new Map<string, number>();
  const questionPages = new Map<string, QuestionGroups['lectures']>();
  const group = (key: string, info: Omit<GroupInfo, 'source_ids'> & { source_id?: string | null }) => {
    let g = groups.get(key);
    if (!g) {
      g = { kind: info.kind, label: info.label, concept_id: info.concept_id, topic_id: info.topic_id, source_ids: new Set() };
      groups.set(key, g);
    }
    if (info.source_id) g.source_ids.add(info.source_id);
    return key;
  };
  const groupsOfQuestion = (qid: string, label: string): string[] => {
    const qg = questionGroups(db, qid, qcache);
    questionPages.set(qid, qg.lectures);
    const keys: string[] = [];
    for (const c of qg.concepts) keys.push(group(`concept:${c.id}`, { kind: 'concept', label: c.label, concept_id: c.id, topic_id: null, source_id: qg.lectures[0]?.id ?? null }));
    for (const l of qg.lectures) keys.push(group(`lecture:${l.id}`, { kind: 'lecture', label: l.title, concept_id: null, topic_id: null, source_id: l.id }));
    for (const t of qg.topics) keys.push(group(`topic:${t.id}`, { kind: 'topic', label: t.label, concept_id: null, topic_id: t.id }));
    keys.push(group(`question:${qid}`, { kind: 'question', label: `سؤال: ${label}`, concept_id: null, topic_id: null, source_id: qg.lectures[0]?.id ?? null }));
    return keys;
  };

  // 1) MCQ attempts
  const attempts = db.all<{
    id: string;
    question_id: string;
    is_correct: number | null;
    scored: number;
    confidence: ConfidenceLevel | null;
    hints_used: number;
    solution_viewed_before_answer: number;
    mistake_type: MistakeType | null;
    mistake_origin: 'auto' | 'owner' | null;
    answered_at: number;
    stem_json: string;
  }>(
    `SELECT qa.id, qa.question_id, qa.is_correct, qa.scored, qa.confidence, qa.hints_used, qa.solution_viewed_before_answer, qa.mistake_type,
            qa.mistake_origin, qa.answered_at, v.stem_json
       FROM question_attempt qa JOIN question q ON q.id = qa.question_id JOIN question_version v ON v.id = qa.question_version_id
      WHERE q.deleted_at IS NULL AND qa.answered_at >= ? ORDER BY qa.answered_at, qa.id`,
    [resets.mcq_attempts ?? 0],
  );
  for (const a of attempts) {
    const confidence = resets.confidence !== null && a.answered_at < resets.confidence ? null : a.confidence;
    const mt = resets.mistake_types !== null && a.answered_at < resets.mistake_types ? null : a.mistake_type;
    const isCorrect = a.scored === 1 ? (a.is_correct === null ? null : a.is_correct === 1) : null;
    const cat: MasterySignal | null = masterySignal({ is_correct: isCorrect, confidence, hints_used: a.hints_used, solution_viewed_before_answer: a.solution_viewed_before_answer === 1 });
    const label = stemPreview(fromJson<RichText>(a.stem_json), 90);
    if (isCorrect === false) wrongByQuestion.set(a.question_id, (wrongByQuestion.get(a.question_id) ?? 0) + 1);
    signals.push({
      ref: `mcq:${a.id}`,
      type: 'mcq',
      at: a.answered_at,
      correct: isCorrect,
      category: cat,
      category_label_ar: cat ? MASTERY_SIGNAL_LABELS_AR[cat] : 'غير محسوبة (مفتاح غير محسوم)',
      weight: cat ? MASTERY_WEIGHTS[cat] : null,
      confidence,
      hints_used: a.hints_used,
      mistake_type: isCorrect === false ? mt : null,
      mistake_origin: isCorrect === false && mt ? a.mistake_origin : null,
      question_id: a.question_id,
      card_id: null,
      label,
      independent: cat === 'correct_confident_independent',
      groups: groupsOfQuestion(a.question_id, label),
    });
  }

  // 2) card reviews: a lapse = Again on a card in review state; Hard/Good/Easy in review state = recall
  const srs = srsContext(ctx);
  const cardCut = resets.card_reviews ?? 0;
  const cards = db.all<{ id: string; created_at: number; concept_id: string | null; topic_id: string | null; source_id: string | null; front_json: string; s_title: string | null; c_label: string | null; t_label: string | null }>(
    `SELECT f.id, f.created_at, f.concept_id, f.topic_id, f.source_id, f.front_json, s.title AS s_title,
            COALESCE(c.name_ar, c.name_en) AS c_label, COALESCE(t.title_ar, t.title) AS t_label
       FROM flashcard f LEFT JOIN source s ON s.id = f.source_id AND s.deleted_at IS NULL
       LEFT JOIN concept c ON c.id = f.concept_id LEFT JOIN topic t ON t.id = f.topic_id
      WHERE f.deleted_at IS NULL AND EXISTS (SELECT 1 FROM review_event e WHERE e.card_id = f.id)`,
  );
  for (const c of cards) {
    const events = db.all<{ id: string; rating: 1 | 2 | 3 | 4; reviewed_at: number }>('SELECT id, rating, reviewed_at FROM review_event WHERE card_id = ? ORDER BY reviewed_at, id', [c.id]);
    const relearn = db.all<{ at: number }>('SELECT at FROM review_reset WHERE card_id = ? ORDER BY at', [c.id]).map((r) => r.at);
    const keys: string[] = [];
    if (c.concept_id && c.c_label) keys.push(group(`concept:${c.concept_id}`, { kind: 'concept', label: c.c_label, concept_id: c.concept_id, topic_id: null, source_id: c.source_id }));
    if (c.topic_id && c.t_label) keys.push(group(`topic:${c.topic_id}`, { kind: 'topic', label: c.t_label, concept_id: null, topic_id: c.topic_id }));
    if (c.source_id && c.s_title) keys.push(group(`lecture:${c.source_id}`, { kind: 'lecture', label: c.s_title, concept_id: null, topic_id: null, source_id: c.source_id }));
    const label = clip(stemPreview(fromJson<RichText>(c.front_json), 90).replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '[…]'), 90);
    // the state BEFORE each event, from the very fold that computes the schedule (same order, dedup, resets)
    foldReviews(srs.params, c.created_at, events, relearn, (e, before) => {
      if (before.state !== State.Review || e.reviewed_at < cardCut) return;
      const lapse = e.rating === 1;
      const cat = lapse ? 'card_lapse' : e.rating === 2 ? 'card_recall_hard' : 'card_recall';
      if (lapse) lapsesByCard.set(c.id, (lapsesByCard.get(c.id) ?? 0) + 1);
      signals.push({
        ref: `card:${e.id}`,
        type: 'card',
        at: e.reviewed_at,
        correct: !lapse,
        category: cat,
        category_label_ar: CARD_CATEGORY_AR[cat],
        weight: lapse ? MASTERY_WEIGHTS.wrong : e.rating === 2 ? MASTERY_WEIGHTS.correct_unsure : MASTERY_WEIGHTS.correct_confident_independent,
        confidence: null,
        hints_used: 0,
        mistake_type: null,
        mistake_origin: null,
        question_id: null,
        card_id: c.id,
        label,
        independent: e.rating >= 3,
        groups: keys,
      });
    });
  }

  // 3) written answers (graded estimates)
  const written = db.all<{ id: string; question_id: string; answered_at: number; assessment_json: string | null; assessment_kind: string | null; stem_json: string }>(
    `SELECT w.id, w.question_id, w.answered_at, w.assessment_json, w.assessment_kind, v.stem_json
       FROM written_attempt w JOIN question q ON q.id = w.question_id JOIN question_version v ON v.id = w.question_version_id
      WHERE q.deleted_at IS NULL AND w.status = 'graded' AND w.answered_at >= ? ORDER BY w.answered_at, w.id`,
    [resets.written_attempts ?? 0],
  );
  for (const w of written) {
    const a = fromJson<{ kind?: string; estimated_score?: { got: number; max: number } | null }>(w.assessment_json, {}) ?? {};
    const label = stemPreview(fromJson<RichText>(w.stem_json), 90);
    let cat: keyof typeof WRITTEN_CATEGORY_AR = 'written_qualitative';
    let correct: boolean | null = null;
    let weight: number | null = null;
    if (a.kind === 'rubric_score' && a.estimated_score && a.estimated_score.max > 0) {
      const ratio = a.estimated_score.got / a.estimated_score.max;
      if (ratio < 0.5) [cat, correct, weight] = ['written_low', false, MASTERY_WEIGHTS.wrong];
      else if (ratio < 0.8) [cat, correct, weight] = ['written_partial', true, 0];
      else [cat, correct, weight] = ['written_good', true, MASTERY_WEIGHTS.correct_unsure];
    }
    if (correct === false) wrongByQuestion.set(w.question_id, (wrongByQuestion.get(w.question_id) ?? 0) + 1);
    signals.push({
      ref: `written:${w.id}`,
      type: 'written',
      at: w.answered_at,
      correct,
      category: cat,
      category_label_ar: WRITTEN_CATEGORY_AR[cat],
      weight,
      confidence: null,
      hints_used: 0,
      mistake_type: null,
      mistake_origin: null,
      question_id: w.question_id,
      card_id: null,
      label,
      independent: false,
      groups: groupsOfQuestion(w.question_id, label),
    });
  }
  return { signals, groups, wrongByQuestion, lapsesByCard, questionPages };
}

// ───────── scoring ─────────
export interface Scored {
  score: number;
  wrong: number;
  correctIndependent: number;
  correctAssisted: number;
  notScored: number;
  lapses: number;
  wrongWeight: number;
  correctWeight: number;
}

/** Transparent weakness score from AC-27 weights (exported for tests). */
export function scoreSignals(signals: Array<Pick<RawSignal, 'correct' | 'weight' | 'category'>>): Scored {
  let wrongWeight = 0;
  let correctWeight = 0;
  let wrong = 0;
  let ci = 0;
  let ca = 0;
  let ns = 0;
  let lapses = 0;
  for (const s of signals) {
    if (s.weight === null || s.correct === null) {
      ns++;
      continue;
    }
    if (s.weight < 0) {
      wrongWeight += -s.weight;
      wrong++;
      if (s.category === 'card_lapse') lapses++;
    } else {
      correctWeight += s.weight;
      if (s.weight >= 1) ci++;
      else ca++;
    }
  }
  const denom = wrongWeight + correctWeight;
  return { score: denom > 0 ? Math.round((wrongWeight / denom) * 100) / 100 : 0, wrong, correctIndependent: ci, correctAssisted: ca, notScored: ns, lapses, wrongWeight, correctWeight };
}

export const SCORE_FORMULA_AR =
  'الدرجة تقديرية = مجموع أوزان الأخطاء ÷ (مجموع أوزان الأخطاء + مجموع أوزان الإجابات الصحيحة). الأوزان: صحيحة بثقة ودون مساعدة 1، صحيحة بتردد 0.6، بعد تلميح 0.35، بالتخمين 0.2، بعد رؤية الحل 0، خطأ 0.6. لذلك لا ترفع الإجابة الصحيحة بالتخمين أو بالتلميح الإتقانَ كما ترفعه الإجابة المستقلة الواثقة.';

function autoStatus(signals: RawSignal[]): { status: WeaknessView['status']; reason: string } {
  const scored = signals.filter((s) => s.correct !== null && s.weight !== null).sort((a, b) => a.at - b.at);
  let lastWrong = -1;
  scored.forEach((s, i) => {
    if (s.correct === false) lastWrong = i;
  });
  const after = scored.slice(lastWrong + 1);
  const independent = after.filter((s) => s.independent).length;
  const good = after.filter((s) => (s.weight ?? 0) >= MASTERY_WEIGHTS.correct_unsure).length;
  if (independent >= 3) return { status: 'resolved', reason: `${independent} إجابات مستقلة واثقة صحيحة بعد آخر خطأ.` };
  if (good >= 2) return { status: 'improving', reason: `${good} إجابات جيدة بعد آخر خطأ؛ تحتاج ${Math.max(1, 3 - independent)} إجابة مستقلة واثقة أخرى لاعتبارها محلولة.` };
  return { status: 'active', reason: after.length ? 'الإجابات بعد آخر خطأ لم تكفِ بعد لاعتبار النقطة متحسنة.' : 'آخر إشارة كانت خطأ.' };
}

function countAr(n: number, one: string, two: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

function pagesLabel(db: Db, pageIds: string[]): string[] {
  if (pageIds.length === 0) return [];
  const rows = db.all<{ id: string; page_index: number; printed_label: string | null; kind: string }>(
    `SELECT id, page_index, printed_label, kind FROM source_page WHERE id IN (${pageIds.map(() => '?').join(',')}) ORDER BY page_index`,
    pageIds,
  );
  return rows.map((p) => pageDisplayLabel({ page_index: p.page_index, printed_label: p.printed_label, kind: p.kind as never }, { withFileIndex: false }));
}

// ───────── compute + persist ─────────
interface WeaknessRow {
  id: string;
  key: string | null;
  kind: string | null;
  concept_id: string | null;
  topic_id: string | null;
  label: string;
  signals_json: string;
  score: number;
  reasons_json: string | null;
  status: WeaknessView['status'];
  created_at: number;
  updated_at: number;
  source_ids_json: string;
  actions_json: string | null;
  details_json: string | null;
  owner_label: string | null;
  owner_note: string | null;
  excluded_refs_json: string;
  status_origin: 'auto' | 'owner';
  status_changed_at: number | null;
}

interface Details {
  counts: WeaknessDetailView['counts'];
  signal_views: WeaknessSignalView[];
  repeated: WeaknessDetailView['repeated'];
  status_reason_ar: string;
  last_signal_at: number | null;
  auto_label: string;
  label_origin: 'auto' | 'owner';
}

// A cheap signature of every input of the weakness center; an unchanged signature skips the recompute.
const weaknessMemo = new WeakMap<Db, string>();

function inputSignature(ctx: AppContext): string {
  const db = ctx.db;
  // counts / revs / statuses (not only timestamps: two changes can share a millisecond)
  const parts = [
    db.get('SELECT COUNT(*) AS c, MAX(created_at) AS m, SUM(rev) AS r, MAX(updated_at) AS u FROM question_attempt'),
    db.get('SELECT COUNT(*) AS c, MAX(created_at) AS m FROM review_event'),
    db.get('SELECT COUNT(*) AS c, MAX(created_at) AS m FROM review_reset'),
    db.get(`SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE WHEN status = 'graded' THEN 1 ELSE 0 END) AS g FROM written_attempt`),
    db.get('SELECT signal_resets_json AS r, updated_at AS u FROM learning_profile'),
    db.get(`SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE status WHEN 'accepted' THEN 1 WHEN 'rejected' THEN 2 ELSE 0 END) AS s,
                   SUM(CASE relation WHEN 'directly_covered' THEN 1 WHEN 'strongly_related' THEN 2 WHEN 'partially_covered' THEN 3 ELSE 4 END) AS r,
                   SUM(length(COALESCE(reason_json, ''))) AS j FROM question_lecture_link`),
    db.get(`SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE status WHEN 'accepted' THEN 1 WHEN 'rejected' THEN 2 ELSE 0 END) AS s FROM concept`),
    db.get(`SELECT COUNT(*) AS c, SUM(CASE status WHEN 'rejected' THEN 1 ELSE 0 END) AS s FROM topic_link`),
    db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(rev) AS r FROM flashcard'),
    db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS d FROM question'),
    db.get('SELECT SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS d FROM source'),
    ctx.capabilities.get('ai.explain').state,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Recompute every weakness from the signals and persist (owner edits kept) — skipped when no input changed. */
export function refreshWeaknesses(ctx: AppContext, opts: { force?: boolean } = {}): WeaknessDetailView[] {
  if (!opts.force && weaknessMemo.get(ctx.db) === inputSignature(ctx)) return listStored(ctx);
  const out = recomputeWeaknesses(ctx);
  weaknessMemo.set(ctx.db, inputSignature(ctx));
  return out;
}

function recomputeWeaknesses(ctx: AppContext): WeaknessDetailView[] {
  const db = ctx.db;
  const now = ctx.clock.now();
  const collected = collectSignals(ctx);
  const byGroup = new Map<string, RawSignal[]>();
  for (const s of collected.signals) for (const g of s.groups) pushTo(byGroup, g, s);
  const existing = new Map(db.all<WeaknessRow>('SELECT * FROM weakness WHERE key IS NOT NULL').map((r) => [r.key!, r]));
  const aiExplain = ctx.capabilities.get('ai.explain');

  db.tx(() => {
    const touched = new Set<string>();
    for (const [key, all] of byGroup) {
      const info = collected.groups.get(key)!;
      const row = existing.get(key);
      const excluded = new Set(fromJson<string[]>(row?.excluded_refs_json, []) ?? []);
      const signals = all.filter((s) => !excluded.has(s.ref));
      const sc = scoreSignals(signals);
      const qWrong = [...new Set(signals.filter((s) => s.correct === false && s.question_id).map((s) => s.question_id!))];
      const repeatedQ = qWrong.filter((q) => (collected.wrongByQuestion.get(q) ?? 0) >= 2);
      const repeatedC = [...new Set(signals.filter((s) => s.category === 'card_lapse' && s.card_id).map((s) => s.card_id!))].filter((c) => (collected.lapsesByCard.get(c) ?? 0) >= 2);
      // a question group is a weakness only for REPEATED mistakes; other groups from the first scored mistake
      const qualifies = info.kind === 'question' ? repeatedQ.length > 0 : sc.wrong > 0;
      if (!qualifies && !row) continue;
      touched.add(key);

      const reasons: string[] = [];
      const scoredN = sc.wrong + sc.correctIndependent + sc.correctAssisted;
      if (sc.wrong > 0) reasons.push(`${countAr(sc.wrong, 'خطأ واحد', 'خطآن', 'أخطاء', 'خطأ')} من ${scoredN} ${scoredN === 1 ? 'إشارة محسوبة' : 'إشارات محسوبة'} متعلقة بـ«${info.label}».`);
      if (sc.correctAssisted > 0) reasons.push(`${countAr(sc.correctAssisted, 'إجابة صحيحة واحدة كانت', 'إجابتان صحيحتان كانتا', 'إجابات صحيحة كانت', 'إجابة صحيحة كانت')} بتردد أو بالتخمين أو بعد تلميح أو رؤية الحل أو كانت جزئية، فوزنها أقل من الإجابة المستقلة الواثقة.`);
      if (sc.lapses > 0) reasons.push(`${countAr(sc.lapses, 'بطاقة نُسيت', 'بطاقتان نُسيتا', 'مرات نُسيت فيها بطاقات', 'مرة نُسيت فيها بطاقات')} بعد أن كانت في مرحلة المراجعة (Again).`);
      if (repeatedQ.length) reasons.push(`أخطاء متكررة في ${countAr(repeatedQ.length, 'سؤال واحد', 'سؤالين', 'أسئلة', 'سؤالًا')} (أكثر من مرة في السؤال نفسه) — لذلك جلسة مراجعة مخصصة.`);
      const writtenLow = signals.filter((s) => s.category === 'written_low').length;
      if (writtenLow) reasons.push(`${countAr(writtenLow, 'إجابة مقالية', 'إجابتان مقاليتان', 'إجابات مقالية', 'إجابة مقالية')} بتقدير منخفض (التقييم آلي تقديري).`);
      const mt = new Map<MistakeType, number>();
      for (const s of signals) if (s.mistake_type) mt.set(s.mistake_type, (mt.get(s.mistake_type) ?? 0) + 1);
      const topMt = [...mt.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topMt) reasons.push(`أكثر أنواع الأخطاء هنا (تصنيف تقديري قابل للتعديل): ${MISTAKE_TYPE_LABELS_AR[topMt[0]]} (${topMt[1]}).`);
      const notScored = signals.filter((s) => s.correct === null).length;
      if (notScored) reasons.push(`${notScored} ${notScored === 1 ? 'إشارة غير محسوبة' : 'إشارات غير محسوبة'} (مفتاح غير محسوم أو تقييم وصفي) لم تدخل الدرجة.`);
      if (!qualifies) reasons.unshift('لم تعد هناك أخطاء محسوبة في هذه النقطة (بعد الاستبعاد أو إعادة ضبط الإشارات).');

      // status
      const auto = qualifies ? autoStatus(signals) : { status: 'resolved' as const, reason: 'لا توجد أخطاء محسوبة حاليًا.' };
      let status = auto.status;
      let statusOrigin: 'auto' | 'owner' = 'auto';
      let statusReason = auto.reason;
      let statusChangedAt = row?.status_changed_at ?? null;
      if (row && row.status_origin === 'owner') {
        const newWrong = signals.some((s) => s.correct === false && s.at > (row.status_changed_at ?? 0));
        if (newWrong && row.status !== 'active') {
          statusReason = `أخطاء جديدة بعد أن جعلتها «${row.status === 'dismissed' ? 'مخفية' : 'محلولة'}»، فعادت نشطة.`;
          statusChangedAt = now;
        } else {
          status = row.status;
          statusOrigin = 'owner';
          statusReason = row.status === 'dismissed' ? 'أخفيتها بنفسك؛ تعود إن ظهرت أخطاء جديدة.' : row.status === 'resolved' ? 'جعلتها محلولة بنفسك.' : 'أعدتها نشطة بنفسك.';
        }
      }

      // suggested actions
      const wrongQs = qWrong.slice(0, 10);
      const pages = new Map<string, { title: string; page_ids: Set<string> }>();
      for (const q of wrongQs) {
        for (const l of collected.questionPages.get(q) ?? []) {
          const p = pages.get(l.id) ?? { title: l.title, page_ids: new Set() };
          for (const pid of l.page_ids.slice(0, 4)) p.page_ids.add(pid);
          pages.set(l.id, p);
        }
      }
      const actions: WeaknessView['suggested_actions'] = [];
      for (const [sourceId, p] of [...pages.entries()].slice(0, 3)) {
        const ids = [...p.page_ids].slice(0, 6);
        const labels = pagesLabel(db, ids);
        if (ids.length) actions.push({ kind: 'review_pages', label_ar: `أعد قراءة ${labels.join('، ')} من «${p.title}»`, ref: { source_id: sourceId, page_ids: ids } });
      }
      const lapsedCards = [...new Set(signals.filter((s) => s.category === 'card_lapse' && s.card_id).map((s) => s.card_id!))];
      const mistakeAttempts = signals.filter((s) => s.type === 'mcq' && s.correct === false).map((s) => s.ref.slice(4));
      const withCards = mistakeAttempts.length
        ? new Set(
            db
              .all<{ a: string }>(
                `SELECT json_extract(origin_ref_json, '$.question_attempt_id') AS a FROM flashcard WHERE origin = 'from_mistake' AND deleted_at IS NULL AND json_extract(origin_ref_json, '$.question_attempt_id') IN (${mistakeAttempts.map(() => '?').join(',')})`,
                mistakeAttempts,
              )
              .map((r) => r.a),
          )
        : new Set<string>();
      const withoutCard = mistakeAttempts.filter((a) => !withCards.has(a)).slice(0, 10);
      if (lapsedCards.length) actions.push({ kind: 'flashcards', label_ar: `راجع ${countAr(lapsedCards.length, 'البطاقة التي نسيتها', 'البطاقتين اللتين نسيتهما', 'بطاقات نسيتها', 'بطاقة نسيتها')}`, ref: { card_ids: lapsedCards.slice(0, 20) } });
      if (withoutCard.length) actions.push({ kind: 'flashcards', label_ar: `اصنع بطاقة من ${countAr(withoutCard.length, 'خطئك', 'خطأيك', 'أخطائك', 'خطأً')} هنا`, ref: { create_from_attempt_ids: withoutCard } });
      if (wrongQs.length) actions.push({ kind: 'practice_questions', label_ar: `أعد حل ${countAr(wrongQs.length, 'السؤال الذي أخطأت فيه', 'السؤالين اللذين أخطأت فيهما', 'أسئلة أخطأت فيها', 'سؤالًا أخطأت فيه')}`, ref: { question_ids: wrongQs } });
      const firstPages = [...pages.entries()][0];
      actions.push({
        kind: 'simplified_explanation',
        label_ar: aiExplain.state === 'available' ? 'اطلب شرحًا مبسطًا لهذه الصفحات (مولد من المحاضرة ومتحقق من أدلته)' : `الشرح المبسط غير متاح الآن: ${aiExplain.reason_ar ?? 'خدمة الذكاء الاصطناعي غير مهيأة.'}`,
        ref: { available: aiExplain.state === 'available', reason_ar: aiExplain.state === 'available' ? null : (aiExplain.reason_ar ?? null), source_id: firstPages?.[0] ?? null, page_ids: firstPages ? [...firstPages[1].page_ids].slice(0, 6) : [] },
      });

      const signalViews: WeaknessSignalView[] = all
        .slice()
        .sort((a, b) => b.at - a.at)
        .slice(0, 200)
        .map((s) => ({
          ref: s.ref,
          type: s.type,
          at: s.at,
          correct: s.correct,
          category: s.category,
          category_label_ar: s.category_label_ar,
          weight: s.weight,
          confidence: s.confidence,
          hints_used: s.hints_used,
          mistake_type: s.mistake_type,
          mistake_origin: s.mistake_origin,
          question_id: s.question_id,
          card_id: s.card_id,
          label: s.label,
          excluded: excluded.has(s.ref),
        }));
      const details: Details = {
        counts: { signals: signals.length, wrong: sc.wrong, correct_independent: sc.correctIndependent, correct_assisted: sc.correctAssisted, not_scored: sc.notScored, lapses: sc.lapses, excluded: all.length - signals.length },
        signal_views: signalViews,
        repeated: {
          question_ids: repeatedQ,
          card_ids: repeatedC,
          summary_ar: repeatedQ.length || repeatedC.length ? `أخطاء متكررة: ${repeatedQ.length} أسئلة و${repeatedC.length} بطاقات أكثر من مرة.` : null,
        },
        status_reason_ar: statusReason,
        last_signal_at: signals.length ? Math.max(...signals.map((s) => s.at)) : null,
        auto_label: info.label,
        label_origin: row?.owner_label ? 'owner' : 'auto',
      };
      const storedSignals: WeaknessSignal[] = signals
        .slice()
        .sort((a, b) => a.at - b.at)
        .slice(-200)
        .map((s) => ({ type: s.type, ref_id: s.ref.slice(s.ref.indexOf(':') + 1), at: s.at, correct: s.correct, confidence: s.confidence, hints_used: s.hints_used, mistake_type: s.mistake_type, mistake_origin: s.mistake_origin }));
      const values = [
        info.kind,
        info.concept_id,
        info.topic_id,
        info.label,
        toJson(storedSignals),
        sc.score,
        toJson(reasons),
        status,
        toJson([...info.source_ids]),
        toJson(actions),
        toJson(details),
        statusOrigin,
        statusChangedAt,
        now,
      ];
      if (row) {
        db.run(
          `UPDATE weakness SET kind = ?, concept_id = ?, topic_id = ?, label = ?, signals_json = ?, score = ?, reasons_json = ?, status = ?, source_ids_json = ?,
                  actions_json = ?, details_json = ?, status_origin = ?, status_changed_at = ?, updated_at = ? WHERE id = ?`,
          [...values, row.id],
        );
      } else {
        db.run(
          `INSERT INTO weakness (kind, concept_id, topic_id, label, signals_json, score, reasons_json, status, source_ids_json, actions_json, details_json,
                                 status_origin, status_changed_at, updated_at, id, key, created_at, excluded_refs_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
          [...values, newId(now), key, now],
        );
      }
    }
    // weaknesses whose signals disappeared entirely (reset / purge): kept, marked resolved with the reason — except a
    // status the owner set (dismissed / resolved / active by hand), which is never silently replaced
    for (const [key, row] of existing) {
      if (touched.has(key) || row.status === 'resolved' || row.status_origin === 'owner') continue;
      const d = fromJson<Details>(row.details_json);
      const details = d ? { ...d, status_reason_ar: 'لا توجد إشارات حالية لهذه النقطة (أُعيد ضبطها أو حُذفت مصادرها).' } : null;
      db.run(`UPDATE weakness SET status = 'resolved', status_origin = 'auto', details_json = ?, updated_at = ? WHERE id = ?`, [details ? toJson(details) : row.details_json, now, row.id]);
    }
  });
  return listStored(ctx);
}

function toDetail(r: WeaknessRow): WeaknessDetailView {
  const d = fromJson<Details>(r.details_json);
  return {
    id: r.id,
    label: r.owner_label ?? r.label,
    concept_id: r.concept_id,
    topic_id: r.topic_id,
    source_ids: fromJson<string[]>(r.source_ids_json, []) ?? [],
    signals: fromJson<WeaknessSignal[]>(r.signals_json, []) ?? [],
    score: r.score,
    reasons_ar: fromJson<string[]>(r.reasons_json, []) ?? [],
    status: r.status,
    suggested_actions: fromJson<WeaknessView['suggested_actions']>(r.actions_json, []) ?? [],
    updated_at: r.updated_at,
    key: r.key ?? r.id,
    kind: (r.kind as WeaknessKind | null) ?? 'concept',
    label_origin: r.owner_label ? 'owner' : 'auto',
    owner_note: r.owner_note,
    status_origin: r.status_origin,
    status_reason_ar: d?.status_reason_ar ?? '',
    score_formula_ar: SCORE_FORMULA_AR,
    counts: d?.counts ?? { signals: 0, wrong: 0, correct_independent: 0, correct_assisted: 0, not_scored: 0, lapses: 0, excluded: 0 },
    signal_views: d?.signal_views ?? [],
    repeated: d?.repeated ?? { question_ids: [], card_ids: [], summary_ar: null },
    dedicated_revision_available: !!d && (d.repeated.question_ids.length > 0 || d.repeated.card_ids.length > 0 || d.counts.wrong >= 2),
    last_signal_at: d?.last_signal_at ?? null,
    created_at: r.created_at,
  };
}

const STATUS_ORDER: Record<WeaknessView['status'], number> = { active: 0, improving: 1, resolved: 2, dismissed: 3 };

export function listStored(ctx: AppContext, status?: WeaknessView['status'] | 'open' | 'all'): WeaknessDetailView[] {
  const rows = ctx.db.all<WeaknessRow>('SELECT * FROM weakness WHERE key IS NOT NULL');
  return rows
    .map(toDetail)
    .filter((w) => (!status || status === 'all' ? true : status === 'open' ? w.status === 'active' || w.status === 'improving' : w.status === status))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.score - a.score || b.counts.wrong - a.counts.wrong || (a.id < b.id ? -1 : 1));
}

export function listWeaknesses(ctx: AppContext, status?: WeaknessView['status'] | 'open' | 'all'): WeaknessListResponse {
  refreshWeaknesses(ctx);
  return {
    items: listStored(ctx, status ?? 'open'),
    sources_note_ar: [
      'المصادر: إجاباتك في أسئلة الاختيار من متعدد، البطاقات التي نسيتها أو تذكرتها، وتقييم إجاباتك المقالية (تقديري).',
      'الحالات السريرية وOSCE لا تُجمع بعد: لا توجد بيانات محاولات لها في هذا الإصدار.',
      'الضعف تقدير من سجلك وليس حكمًا نهائيًا؛ يمكنك تعديل الاسم أو إخفاء نقطة أو استبعاد إشارة لا تخصها.',
    ],
    generated_at: ctx.clock.now(),
  };
}

export function getWeakness(ctx: AppContext, id: string, refresh = true): WeaknessDetailView {
  if (refresh) refreshWeaknesses(ctx);
  const r = ctx.db.get<WeaknessRow>('SELECT * FROM weakness WHERE id = ?', [id]);
  if (!r || !r.key) throw new AppError('NOT_FOUND', 'نقطة الضعف غير موجودة.', 404);
  return toDetail(r);
}

export function patchWeakness(ctx: AppContext, id: string, patch: WeaknessPatchRequest): WeaknessDetailView {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const r = ctx.db.get<WeaknessRow>('SELECT * FROM weakness WHERE id = ?', [id]);
    if (!r || !r.key) throw new AppError('NOT_FOUND', 'نقطة الضعف غير موجودة.', 404);
    const set: string[] = [];
    const params: unknown[] = [];
    if (patch.label !== undefined) {
      set.push('owner_label = ?');
      params.push(patch.label?.trim() ? patch.label.trim().slice(0, 200) : null);
    }
    if (patch.note !== undefined) {
      set.push('owner_note = ?');
      params.push(patch.note?.trim() ? patch.note.trim().slice(0, 2000) : null);
    }
    if (patch.status) {
      set.push("status = ?, status_origin = 'owner', status_changed_at = ?");
      params.push(patch.status, now);
    }
    if (patch.excluded_refs !== undefined) {
      set.push('excluded_refs_json = ?');
      params.push(toJson([...new Set(patch.excluded_refs.filter((x) => typeof x === 'string' && /^(mcq|card|written):[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 500)));
    }
    if (!set.length) return;
    ctx.db.run(`UPDATE weakness SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now, id]);
    weaknessMemo.delete(ctx.db);
    ctx.audit.record({
      entityType: 'weakness',
      entityId: id,
      action: 'edit',
      summary: patch.status === 'dismissed' ? `أخفيت نقطة الضعف «${r.owner_label ?? r.label}».` : `عدّلت نقطة الضعف «${r.owner_label ?? r.label}».`,
      after: patch,
    });
  });
  return getWeakness(ctx, id);
}

export { clip };
