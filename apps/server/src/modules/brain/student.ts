// Student Knowledge Map (§44): per concept — what you read, practised and (as an ESTIMATE) mastered, its
// prerequisites and why the state is what it is. States are shown with text + icon in the UI, never colour alone.
//  * reading  = pages of the concept you viewed in the reader (source_progress of the study version);
//  * practice = attempts on the questions that bear on the concept (coverage rules) + reviews of its cards;
//  * mastery  = the AC-27 estimate over those scored attempts (learning/progress.ts), null below its minimum sample;
//  * a weakness of the concept (Weakness Center) is shown as such.
// Opening a page is never mastery; a guessed or hint-assisted answer weighs less (AC-27).
import {
  KNOWLEDGE_STATE_LABELS_AR,
  KNOWLEDGE_STATES,
  type KnowledgeState,
  type StudentConceptView,
  type StudentKnowledgeResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { signalResets } from '../learning/profile';
import { masteryEstimate, MASTERY_MIN_SAMPLE } from '../learning/progress';
import { refreshWeaknesses } from '../learning/weakness';
import { versionConcepts } from './coverage';
import { conceptNamesNorm, lectureQuestions } from './lecture-questions';
import { resolveConceptId } from './resolve';
import { courseSources, inList, nodeTitle, pageLabelAr, sourcesOfCourseKey, type StudySource } from './store';

export interface KnowledgeInput {
  pagesTotal: number;
  pagesViewed: number;
  questionAttempts: number;
  cardReviews: number;
  mastery: number | null;
  sample: number;
  weaknessStatus: string | null;
}

/** Pure state rule (unit-tested). */
export function classifyKnowledge(i: KnowledgeInput): KnowledgeState {
  if (i.weaknessStatus === 'active') return 'needs_work';
  if (i.mastery !== null) return i.mastery >= 0.8 ? 'strong' : i.mastery >= 0.5 ? 'developing' : 'needs_work';
  if (i.weaknessStatus === 'improving') return 'developing';
  if (i.questionAttempts + i.cardReviews > 0) return 'practicing';
  if (i.pagesViewed > 0) return 'read';
  return 'not_started';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function studentKnowledge(ctx: AppContext, opts: { courseNodeId?: string | null } = {}): StudentKnowledgeResponse {
  let scope: StudentKnowledgeResponse['scope'];
  let lectures: StudySource[];
  if (opts.courseNodeId) {
    const n = nodeTitle(ctx, opts.courseNodeId);
    scope = { kind: 'course', id: n.id, title: n.title };
    lectures = courseSources(ctx, n.id);
  } else {
    scope = { kind: 'all', id: null, title: null };
    lectures = [...new Map(ctx.db.all<{ k: string }>(`SELECT DISTINCT COALESCE(course_node_id, subject_node_id, node_id, '__unfiled__') AS k FROM source WHERE deleted_at IS NULL`).flatMap((r) => sourcesOfCourseKey(ctx, r.k)).map((s) => [s.id, s])).values()];
  }
  refreshWeaknesses(ctx);
  const resets = signalResets(ctx.db);

  interface Acc {
    id: string;
    lectures: Map<string, { title: string; page_ids: Set<string>; first: { page_index: number; label: string } | null }>;
    pagesTotal: Set<string>;
    pagesViewed: Set<string>;
    questions: Set<string>;
  }
  const acc = new Map<string, Acc>();
  for (const s of lectures) {
    if (!s.version_id) continue;
    const concepts = versionConcepts(ctx, s.version_id).slice(0, 400);
    if (concepts.length === 0) continue;
    const pages = new Map(ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE version_id = ?', [s.version_id]).map((p) => [p.id, p]));
    const prog = ctx.db.get<{ pages_viewed_json: string; progress_version_id: string | null }>('SELECT pages_viewed_json, progress_version_id FROM source_progress WHERE source_id = ?', [s.id]);
    const viewedIdx = new Set(prog && prog.progress_version_id === s.version_id ? (fromJson<number[]>(prog.pages_viewed_json, []) ?? []) : []);
    const qs = lectureQuestions(
      ctx,
      s,
      concepts.map((c) => ({ id: c.id, names: conceptNamesNorm(ctx, c.id), page_ids: c.page_ids })),
    );
    for (const c of concepts) {
      const a = acc.get(c.id) ?? { id: c.id, lectures: new Map(), pagesTotal: new Set(), pagesViewed: new Set(), questions: new Set() };
      const sortedPages = c.page_ids.map((pid) => pages.get(pid)).filter((p): p is NonNullable<typeof p> => !!p).sort((x, y) => x.page_index - y.page_index);
      a.lectures.set(s.id, { title: s.title, page_ids: new Set(sortedPages.map((p) => p.id)), first: sortedPages[0] ? { page_index: sortedPages[0].page_index, label: pageLabelAr(sortedPages[0]) } : null });
      for (const p of sortedPages) {
        a.pagesTotal.add(p.id);
        if (viewedIdx.has(p.page_index)) a.pagesViewed.add(p.id);
      }
      for (const q of qs) if (q.concepts.has(c.id)) a.questions.add(q.id);
      acc.set(c.id, a);
    }
  }

  const ids = [...acc.keys()];
  const concepts = new Map(
    (ids.length ? ctx.db.all<{ id: string; name_en: string | null; name_ar: string | null; status: 'suggested' | 'accepted' | 'rejected' }>(`SELECT id, name_en, name_ar, status FROM concept WHERE id IN (${inList(ids.length)})`, ids) : []).map((c) => [c.id, c]),
  );
  // cards per concept (merged concepts resolve to their target)
  const cards = new Map<string, { cards: number; reviews: number }>();
  for (const f of ctx.db.all<{ concept_id: string; id: string }>('SELECT concept_id, id FROM flashcard WHERE deleted_at IS NULL AND concept_id IS NOT NULL')) {
    const cid = resolveConceptId(ctx, f.concept_id);
    if (!acc.has(cid)) continue;
    const e = cards.get(cid) ?? { cards: 0, reviews: 0 };
    e.cards++;
    e.reviews += ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM review_event WHERE card_id = ? AND reviewed_at >= ?', [f.id, resets.card_reviews ?? 0])?.n ?? 0;
    cards.set(cid, e);
  }
  const weakness = new Map<string, { id: string; status: string; score: number }>();
  for (const w of ctx.db.all<{ id: string; concept_id: string; status: string; score: number }>(`SELECT id, concept_id, status, score FROM weakness WHERE key IS NOT NULL AND concept_id IS NOT NULL`)) {
    const cid = resolveConceptId(ctx, w.concept_id);
    const prev = weakness.get(cid);
    if (!prev || (prev.status !== 'active' && w.status === 'active')) weakness.set(cid, { id: w.id, status: w.status, score: w.score });
  }

  const base = new Map<string, Omit<StudentConceptView, 'prerequisites'>>();
  for (const a of acc.values()) {
    const c = concepts.get(a.id);
    if (!c || c.status === 'rejected') continue;
    const qids = [...a.questions];
    const attempts = qids.length
      ? ctx.db.all<{ is_correct: number | null; scored: number; confidence: 'guess' | 'unsure' | 'confident' | null; hints_used: number; solution_viewed_before_answer: number; answered_at: number }>(
          `SELECT is_correct, scored, confidence, hints_used, solution_viewed_before_answer, answered_at FROM question_attempt WHERE question_id IN (${inList(qids.length)}) AND answered_at >= ?`,
          [...qids, resets.mcq_attempts ?? 0],
        )
      : [];
    const scored = attempts.filter((x) => x.scored === 1 && x.is_correct !== null);
    const m = masteryEstimate(
      scored.map((x) => ({
        is_correct: x.is_correct === 1,
        confidence: resets.confidence !== null && x.answered_at < resets.confidence ? null : x.confidence,
        hints_used: x.hints_used,
        solution_viewed_before_answer: x.solution_viewed_before_answer === 1,
      })),
    );
    const cd = cards.get(a.id) ?? { cards: 0, reviews: 0 };
    const w = weakness.get(a.id) ?? null;
    const state = classifyKnowledge({
      pagesTotal: a.pagesTotal.size,
      pagesViewed: a.pagesViewed.size,
      questionAttempts: attempts.length,
      cardReviews: cd.reviews,
      mastery: m.value,
      sample: m.sample,
      weaknessStatus: w?.status ?? null,
    });
    const reasons: string[] = [];
    reasons.push(a.pagesTotal.size ? `قرأت ${a.pagesViewed.size} من ${a.pagesTotal.size} ${a.pagesTotal.size === 1 ? 'صفحة يُذكر فيها' : 'صفحات يُذكر فيها'}.` : 'لا صفحة معروفة له في نسخ الدراسة.');
    reasons.push(
      qids.length
        ? `${qids.length} ${qids.length === 1 ? 'سؤال مرتبط' : 'أسئلة مرتبطة'} به؛ أجبت ${attempts.length} ${attempts.length === 1 ? 'مرة' : 'مرات'} (${scored.length} محسوبة).`
        : 'لا أسئلة مرتبطة به بعد.',
    );
    if (cd.cards) reasons.push(`${cd.cards} ${cd.cards === 1 ? 'بطاقة' : 'بطاقات'} له، راجعتها ${cd.reviews} ${cd.reviews === 1 ? 'مرة' : 'مرات'}.`);
    if (w && (w.status === 'active' || w.status === 'improving')) reasons.push(w.status === 'active' ? 'له نقطة ضعف نشطة في مركز الضعف.' : 'نقطة ضعفه تتحسن في مركز الضعف.');
    const firstLecture = [...a.lectures.entries()].find(([, l]) => l.first) ?? null;
    const unread = firstLecture ? `ابدأ بقراءة ${firstLecture[1].first!.label} من «${firstLecture[1].title}».` : 'ابدأ بقراءة مواضعه.';
    const next: Record<KnowledgeState, string> = {
      not_started: unread,
      read: qids.length ? `تدرّب على ${qids.length === 1 ? 'السؤال المرتبط' : `الأسئلة المرتبطة (${qids.length})`} ليظهر تقدير.` : 'لا أسئلة مرتبطة بعد: اصنع بطاقة أو أضف سؤالًا لتتدرب عليه.',
      practicing: `أجب عن ${Math.max(1, MASTERY_MIN_SAMPLE - m.sample)} ${MASTERY_MIN_SAMPLE - m.sample === 1 ? 'سؤال محسوب آخر' : 'أسئلة محسوبة أخرى'} ليظهر تقدير الإتقان.`,
      needs_work: 'أعد قراءة مواضعه ثم أعد الأسئلة التي أخطأت فيها.',
      developing: 'استمر: إجابات مستقلة واثقة ترفع التقدير أكثر من التخمين أو التلميح.',
      strong: 'راجعه في موعده؛ الإتقان التقديري لا يعني أنه لن يحتاج مراجعة.',
    };
    base.set(a.id, {
      concept_id: a.id,
      name: c.name_ar || c.name_en || a.id,
      concept_status: c.status,
      state,
      state_label_ar: KNOWLEDGE_STATE_LABELS_AR[state],
      mastery_estimate: m.value,
      mastery_sample: m.sample,
      mastery_basis_ar:
        m.value === null
          ? `لا يُقدَّر الإتقان قبل ${MASTERY_MIN_SAMPLE} إجابات محسوبة على أسئلته (لديك ${m.sample}).`
          : `تقدير من ${m.sample} إجابات محسوبة على أسئلته: ${pct(m.value)} — صحيحة بثقة ودون مساعدة 1، بتردد 0.6، بعد تلميح 0.35، بالتخمين 0.2، بعد رؤية الحل 0، الخطأ −0.6.`,
      reasons_ar: reasons,
      reading: { pages_total: a.pagesTotal.size, pages_viewed: a.pagesViewed.size },
      practice: { questions: qids.length, question_attempts: attempts.length, scored_attempts: scored.length, cards: cd.cards, card_reviews: cd.reviews },
      weakness: w,
      lectures: [...a.lectures.entries()].map(([sid, l]) => ({ source_id: sid, title: l.title, page_ids: [...l.page_ids], first_page_label_ar: l.first?.label ?? null })),
      next_step_ar: next[state],
    });
  }

  // prerequisites (owner or suggested — never rejected) with their own state when known
  const items: StudentConceptView[] = [];
  for (const v of base.values()) {
    const rels = ctx.db.all<{ id: string; from_concept_id: string; support: 'stated' | 'inferred'; status: 'suggested' | 'accepted' | 'rejected'; origin: string }>(
      `SELECT id, from_concept_id, support, status, origin FROM concept_relation WHERE to_concept_id = ? AND relation = 'prerequisite' AND status <> 'rejected'`,
      [v.concept_id],
    );
    const prerequisites = rels.map((r) => {
      const pid = resolveConceptId(ctx, r.from_concept_id);
      const p = base.get(pid);
      const name = p?.name ?? ctx.db.get<{ n: string }>('SELECT COALESCE(name_ar, name_en, id) AS n FROM concept WHERE id = ?', [pid])?.n ?? pid;
      const st: KnowledgeState = p?.state ?? 'not_started';
      return { concept_id: pid, name, state: st, state_label_ar: KNOWLEDGE_STATE_LABELS_AR[st], support: r.origin === 'owner' ? ('stated' as const) : r.support, relation_status: r.status, relation_id: r.id };
    });
    const weakPre = prerequisites.filter((p) => p.state === 'needs_work' || p.state === 'not_started');
    const reasons = [...v.reasons_ar];
    if (weakPre.length) reasons.push(`متطلبات سابقة تحتاج انتباهًا: ${weakPre.map((p) => `«${p.name}» (${p.state_label_ar}${p.support === 'inferred' ? '، علاقة مستنتجة' : ''})`).join('، ')}.`);
    items.push({ ...v, reasons_ar: reasons, prerequisites });
  }
  const order: Record<KnowledgeState, number> = { needs_work: 0, practicing: 1, developing: 2, read: 3, not_started: 4, strong: 5 };
  items.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name, 'ar'));
  const counts = Object.fromEntries(KNOWLEDGE_STATES.map((s) => [s, items.filter((i) => i.state === s).length])) as Record<KnowledgeState, number>;
  return {
    scope,
    items,
    counts,
    estimate_note_ar: `الإتقان هنا تقدير من إجاباتك على الأسئلة المرتبطة بكل مفهوم، وليس قياسًا يقينيًا؛ لا يظهر قبل ${MASTERY_MIN_SAMPLE} إجابات محسوبة.`,
    notes_ar: [
      'الحالة مكتوبة نصًا مع رمز لكل مفهوم؛ فتح الصفحة أو التمرير لا يُعد إتقانًا.',
      'المتطلبات السابقة المستنتجة اقتراحات من ترتيب المحاضرات، ويمكنك قبولها أو رفضها من صفحة المفاهيم.',
    ],
  };
}
