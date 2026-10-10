// One-Tap Revision (§45): «I have N minutes» → a deterministic session from due cards (weakest recall first), recent
// mistakes, questions of active weak points and the lecture pages behind the mistakes — with time estimates and a
// reason per item. No AI call. The estimated total never exceeds the requested minutes.
import {
  type RevisionSessionDetail,
  type RevisionSessionRequest,
  type RevisionSessionView,
  type WeaknessDetailView,
} from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { measuredPace, signalResets } from './profile';
import { srsContext, statesFor, type FlashcardRow } from './store';
import { DAY_MS, dayOf } from './time';
import { getWeakness, listStored, refreshWeaknesses } from './weakness';

const id = z.string().trim().min(1).max(64);
export const revisionRequestSchema = z.object({
  minutes: z.number().int().min(5).max(240),
  course_node_id: id.nullable().optional(),
  source_ids: z.array(id).max(50).optional(),
});

type Item = RevisionSessionView['items'][number];
const SCORABLE = `('source_key','owner_key','ai_derived')`;
const PAGE_MINUTES = 2;

interface Scope {
  sourceIds: Set<string> | null;
  courseNodeId: string | null;
}

function scopeOf(ctx: AppContext, req: RevisionSessionRequest): Scope {
  let sourceIds: Set<string> | null = req.source_ids?.length ? new Set(req.source_ids) : null;
  if (req.course_node_id) {
    const inCourse = ctx.db
      .all<{ id: string }>('SELECT id FROM source WHERE deleted_at IS NULL AND (course_node_id = ? OR node_id = ? OR subject_node_id = ?)', [req.course_node_id, req.course_node_id, req.course_node_id])
      .map((r) => r.id);
    sourceIds = sourceIds ? new Set([...sourceIds].filter((x) => inCourse.includes(x))) : new Set(inCourse);
  }
  return { sourceIds, courseNodeId: req.course_node_id ?? null };
}

function questionInScope(ctx: AppContext, qid: string, scope: Scope): boolean {
  if (!scope.sourceIds && !scope.courseNodeId) return true;
  if (scope.courseNodeId && ctx.db.get('SELECT 1 AS x FROM question WHERE id = ? AND course_node_id = ?', [qid, scope.courseNodeId])) return true;
  if (!scope.sourceIds || scope.sourceIds.size === 0) return false;
  const ids = [...scope.sourceIds];
  const qs = ids.map(() => '?').join(',');
  return !!ctx.db.get(
    `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM question_lecture_link WHERE question_id = ? AND status <> 'rejected' AND lecture_source_id IN (${qs}))
        OR EXISTS (SELECT 1 FROM question_occurrence WHERE question_id = ? AND source_id IN (${qs}))`,
    [qid, ...ids, qid, ...ids],
  );
}

function linkPages(ctx: AppContext, qid: string): Array<{ source_id: string; page_ids: string[] }> {
  return ctx.db
    .all<{ lecture_source_id: string; reason_json: string | null }>(
      `SELECT l.lecture_source_id, l.reason_json FROM question_lecture_link l JOIN source s ON s.id = l.lecture_source_id
        WHERE l.question_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only' AND s.deleted_at IS NULL
        ORDER BY l.status = 'accepted' DESC, l.score DESC LIMIT 2`,
      [qid],
    )
    .map((l) => ({ source_id: l.lecture_source_id, page_ids: fromJson<{ lecture_page_ids?: string[] }>(l.reason_json, {})?.lecture_page_ids ?? [] }));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function buildRevision(ctx: AppContext, req: RevisionSessionRequest, focus: WeaknessDetailView | null = null): RevisionSessionDetail {
  const minutes = Math.max(5, Math.min(240, Math.floor(req.minutes)));
  const scope = scopeOf(ctx, req);
  const srs = srsContext(ctx);
  const now = ctx.clock.now();
  const pace = measuredPace(ctx.db);
  const cardSecs = pace.median_seconds_per_card !== null ? Math.max(10, Math.min(120, pace.median_seconds_per_card)) : 30;
  const qSecs = pace.median_seconds_per_question !== null ? Math.max(30, Math.min(300, pace.median_seconds_per_question)) : 90;
  const cardMin = round1(cardSecs / 60);
  const qMin = round1(qSecs / 60);

  // 1) due cards, weakest recall first
  const focusCardIds = focus ? new Set(focus.signal_views.filter((s) => s.card_id && !s.excluded).map((s) => s.card_id!)) : null;
  const cardRows = ctx.db
    .all<FlashcardRow>(`SELECT * FROM flashcard WHERE deleted_at IS NULL AND suspended = 0 AND (buried_until IS NULL OR buried_until <= ?)`, [now])
    .filter((c) => (focusCardIds ? focusCardIds.has(c.id) || (!!c.source_id && focus!.source_ids.includes(c.source_id) && !!focus!.concept_id && c.concept_id === focus!.concept_id) : true))
    .filter((c) => (scope.sourceIds ? !!c.source_id && scope.sourceIds.has(c.source_id) : true));
  const states = statesFor(ctx.db, cardRows, srs, now);
  const dueCards = cardRows
    .map((c) => ({ c, s: states.get(c.id)! }))
    .filter((x) => x.s.eventCount > 0 && x.s.view.due_at <= now)
    .sort((a, b) => (a.s.view.retrievability ?? 0) - (b.s.view.retrievability ?? 0) || a.s.view.due_at - b.s.view.due_at || (a.c.id < b.c.id ? -1 : 1));
  const cardItems: Item[] = dueCards.map(({ c, s }) => ({
    kind: 'flashcard',
    card_id: c.id,
    est_minutes: cardMin,
    reason_ar: s.view.retrievability !== null ? `مستحقة للمراجعة؛ احتمال تذكّرها الآن نحو ${Math.round(s.view.retrievability * 100)}٪ (تقدير).` : 'مستحقة للمراجعة.',
  }));

  // 2) recent mistakes: the latest scored answer to the question was wrong (last 30 days)
  const mcqSince = Math.max(signalResets(ctx.db).mcq_attempts ?? 0, now - 30 * DAY_MS);
  const latest = ctx.db.all<{ question_id: string; is_correct: number; answered_at: number }>(
    `SELECT qa.question_id, qa.is_correct, qa.answered_at FROM question_attempt qa JOIN question q ON q.id = qa.question_id
      WHERE qa.scored = 1 AND qa.is_correct IS NOT NULL AND q.deleted_at IS NULL AND q.status <> 'retired' AND qa.answered_at >= ?
        AND qa.answered_at = (SELECT MAX(x.answered_at) FROM question_attempt x WHERE x.question_id = qa.question_id AND x.scored = 1 AND x.is_correct IS NOT NULL)
      ORDER BY qa.answered_at DESC, qa.question_id`,
    [mcqSince],
  );
  const focusQs = focus ? new Set(focus.signal_views.filter((s) => s.question_id && s.correct === false && !s.excluded).map((s) => s.question_id!)) : null;
  const seenQ = new Set<string>();
  const mistakeQs = latest
    .filter((r) => r.is_correct === 0 && !seenQ.has(r.question_id) && (seenQ.add(r.question_id), true))
    .filter((r) => (focusQs ? focusQs.has(r.question_id) : true))
    .filter((r) => questionInScope(ctx, r.question_id, scope));
  // a focused weakness also retries its repeated mistakes even when the latest answer was right
  if (focus) for (const q of focus.repeated.question_ids) if (!mistakeQs.some((m) => m.question_id === q)) mistakeQs.push({ question_id: q, is_correct: 0, answered_at: 0 });
  const tz = srs.timezone;
  const mistakeItems: Item[] = mistakeQs.map((r) => ({
    kind: 'question',
    question_id: r.question_id,
    est_minutes: qMin,
    reason_ar: r.answered_at ? `أخطأت فيه آخر مرة (${dayOf(r.answered_at, tz)}).` : 'خطأ متكرر في هذه النقطة.',
  }));

  // 3) questions of active weak points that were not answered confidently and independently in the last 7 days
  const weakItems: Item[] = [];
  if (!focus) refreshWeaknesses(ctx);
  const weaknesses = focus ? [focus] : listStored(ctx, 'open').filter((w) => w.kind !== 'question').slice(0, 5);
  const used = new Set(mistakeItems.map((i) => (i.kind === 'question' ? i.question_id : '')));
  for (const w of weaknesses) {
    let qids: string[] = [];
    if (w.kind === 'lecture' && w.source_ids[0]) {
      qids = ctx.db
        .all<{ question_id: string }>(
          `SELECT l.question_id FROM question_lecture_link l JOIN question q ON q.id = l.question_id JOIN question_version v ON v.id = q.current_version_id
            WHERE l.lecture_source_id = ? AND l.status <> 'rejected' AND l.relation <> 'course_related_only' AND q.deleted_at IS NULL AND q.status <> 'retired'
              AND v.answer_status IN ${SCORABLE} ORDER BY l.score DESC, l.question_id LIMIT 30`,
          [w.source_ids[0]],
        )
        .map((r) => r.question_id);
    } else if (w.kind === 'concept' && w.concept_id) {
      qids = ctx.db
        .all<{ question_id: string }>(
          `SELECT DISTINCT l.question_id FROM question_lecture_link l, json_each(COALESCE(json_extract(l.reason_json, '$.concepts'), '[]')) c
             JOIN question q ON q.id = l.question_id JOIN question_version v ON v.id = q.current_version_id
            WHERE c.value = ? AND l.status <> 'rejected' AND q.deleted_at IS NULL AND q.status <> 'retired' AND v.answer_status IN ${SCORABLE}
            ORDER BY l.question_id LIMIT 30`,
          [w.concept_id],
        )
        .map((r) => r.question_id);
    }
    let k = 0;
    for (const q of qids) {
      if (k >= 5 || used.has(q) || !questionInScope(ctx, q, scope)) continue;
      const recentGood = ctx.db.get(
        `SELECT 1 AS x FROM question_attempt WHERE question_id = ? AND is_correct = 1 AND confidence = 'confident' AND hints_used = 0 AND solution_viewed_before_answer = 0 AND answered_at >= ?`,
        [q, now - 7 * DAY_MS],
      );
      if (recentGood) continue;
      used.add(q);
      weakItems.push({ kind: 'question', question_id: q, est_minutes: qMin, reason_ar: `من نقطة الضعف «${w.label}» ولم تُجب عنه بثقة ودون مساعدة في الأيام السبعة الأخيرة.` });
      k++;
    }
  }

  // 4) lecture pages behind the mistakes (and the focus weakness's suggested pages)
  const pageGroups = new Map<string, Set<string>>();
  const addPages = (sourceId: string, pageIds: string[]) => {
    if (scope.sourceIds && !scope.sourceIds.has(sourceId)) return;
    const set = pageGroups.get(sourceId) ?? new Set<string>();
    for (const p of pageIds) set.add(p);
    pageGroups.set(sourceId, set);
  };
  for (const m of mistakeQs.slice(0, 10)) for (const l of linkPages(ctx, m.question_id)) addPages(l.source_id, l.page_ids.slice(0, 3));
  if (focus) for (const a of focus.suggested_actions) if (a.kind === 'review_pages' && typeof a.ref.source_id === 'string') addPages(a.ref.source_id, (a.ref.page_ids as string[]) ?? []);
  const pageItems: Item[] = [];
  for (const [sourceId, ids] of pageGroups) {
    if (ids.size === 0) continue;
    const pages = ctx.db
      .all<{ page_index: number }>(`SELECT DISTINCT page_index FROM source_page WHERE id IN (${[...ids].map(() => '?').join(',')}) ORDER BY page_index`, [...ids])
      .map((p) => p.page_index);
    for (let i = 0; i < pages.length; i += 3) {
      const chunk = pages.slice(i, i + 3);
      pageItems.push({ kind: 'pages', source_id: sourceId, page_indexes: chunk, est_minutes: chunk.length * PAGE_MINUTES, reason_ar: 'صفحات المحاضرة المرتبطة بأسئلة أخطأت فيها.' });
    }
  }

  // allocation: shares first, then fill what is left in priority order; never above the requested minutes
  const pools: Record<'cards' | 'mistakes' | 'weak' | 'pages', Item[]> = { cards: cardItems, mistakes: mistakeItems, weak: weakItems, pages: pageItems };
  const shares = focus ? { mistakes: 0.4, pages: 0.3, cards: 0.2, weak: 0.1 } : { cards: 0.35, mistakes: 0.3, weak: 0.2, pages: 0.15 };
  const chosen: Record<keyof typeof pools, Item[]> = { cards: [], mistakes: [], weak: [], pages: [] };
  const taken = new Set<Item>();
  let total = 0;
  const poolUsed: Record<keyof typeof pools, number> = { cards: 0, mistakes: 0, weak: 0, pages: 0 };
  for (const key of Object.keys(shares) as Array<keyof typeof pools>) {
    const cap = shares[key] * minutes;
    for (const it of pools[key]) {
      if (poolUsed[key] + it.est_minutes > cap + 1e-9 || total + it.est_minutes > minutes + 1e-9) continue;
      chosen[key].push(it);
      taken.add(it);
      poolUsed[key] += it.est_minutes;
      total += it.est_minutes;
    }
  }
  for (const key of ['mistakes', 'cards', 'weak', 'pages'] as const) {
    for (const it of pools[key]) {
      if (taken.has(it) || total + it.est_minutes > minutes + 1e-9) continue;
      chosen[key].push(it);
      taken.add(it);
      total += it.est_minutes;
    }
  }
  const items: Item[] = [...chosen.cards, ...chosen.mistakes, ...chosen.weak, ...chosen.pages];
  const n = (k: keyof typeof pools) => chosen[k].length;
  const parts: string[] = [];
  if (n('cards')) parts.push(`${n('cards')} ${n('cards') === 1 ? 'بطاقة مستحقة' : 'بطاقات مستحقة'} (الأضعف تذكرًا أولًا)`);
  if (n('mistakes')) parts.push(`${n('mistakes')} ${n('mistakes') === 1 ? 'سؤال أخطأت فيه مؤخرًا' : 'أسئلة أخطأت فيها مؤخرًا'}`);
  if (n('weak')) parts.push(`${n('weak')} ${n('weak') === 1 ? 'سؤال' : 'أسئلة'} من نقاط ضعف نشطة`);
  if (n('pages')) parts.push(`${n('pages')} ${n('pages') === 1 ? 'مجموعة صفحات' : 'مجموعات صفحات'} لإعادة القراءة`);
  const left = (['cards', 'mistakes', 'weak', 'pages'] as const).reduce((a, k) => a + pools[k].length - n(k), 0);
  const explanation = items.length
    ? `جلسة ${minutes} دقيقة (المجموع التقديري ${round1(total)} دقيقة): ${parts.join('، ')}.${focus ? ` مخصصة لنقطة الضعف «${focus.label}» لأن الخطأ تكرر فيها.` : ''}${left ? ` بقي ${left} عنصرًا لم يتسع لها الوقت.` : ''} الاختيار ثابت من بياناتك دون ذكاء اصطناعي، والأوقات تقديرية.`
    : 'لا توجد الآن بطاقات مستحقة أو أخطاء حديثة أو نقاط ضعف نشطة ضمن النطاق المختار؛ لا شيء يحتاج مراجعة سريعة. جرّب نطاقًا أوسع أو ادرس محاضرة جديدة.';
  const basis = [
    `البطاقة: ${cardSecs} ثانية تقريبًا${pace.median_seconds_per_card !== null ? ' (من متوسط مراجعاتك)' : ' (افتراضي: بياناتك لا تكفي للقياس)'}.`,
    `السؤال: ${qSecs} ثانية تقريبًا${pace.median_seconds_per_question !== null ? ' (من متوسط وقتك)' : ' (افتراضي: بياناتك لا تكفي للقياس)'}.`,
    `الصفحة: ${PAGE_MINUTES} دقيقة تقديرًا لإعادة القراءة.`,
  ];
  const sid = newId(now);
  ctx.db.run(
    'INSERT INTO revision_session (id, request_json, items_json, explanation_ar, details_json, total_est_minutes, weakness_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sid, toJson({ ...req, minutes }), toJson(items), explanation, toJson({ basis }), round1(total), focus?.id ?? null, now],
  );
  return { id: sid, minutes, items, explanation_ar: explanation, total_est_minutes: round1(total), estimate_basis_ar: basis, created_at: now, weakness_id: focus?.id ?? null };
}

export function weaknessRevision(ctx: AppContext, weaknessId: string, minutes = 20): RevisionSessionDetail {
  const w = getWeakness(ctx, weaknessId);
  return buildRevision(ctx, { minutes }, w);
}

export function getRevision(ctx: AppContext, sessionId: string): RevisionSessionDetail {
  const r = ctx.db.get<{ id: string; request_json: string; items_json: string; explanation_ar: string; details_json: string | null; total_est_minutes: number; weakness_id: string | null; created_at: number }>(
    'SELECT * FROM revision_session WHERE id = ?',
    [sessionId],
  );
  if (!r) throw new AppError('NOT_FOUND', 'جلسة المراجعة غير موجودة.', 404);
  const req = fromJson<RevisionSessionRequest>(r.request_json)!;
  return {
    id: r.id,
    minutes: req.minutes,
    items: fromJson<Item[]>(r.items_json, []) ?? [],
    explanation_ar: r.explanation_ar,
    total_est_minutes: r.total_est_minutes,
    estimate_basis_ar: fromJson<{ basis?: string[] }>(r.details_json, {})?.basis ?? [],
    created_at: r.created_at,
    weakness_id: r.weakness_id,
  };
}
