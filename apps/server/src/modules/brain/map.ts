// Course knowledge map (§31, §16): lectures ↔ concepts ↔ questions as nodes and edges, plus concept ↔ concept relations.
// Every edge says what backs it: «mentions» = the concept is stated on these lecture pages; «covers» = the question
// bears on the concept (matcher / its text / its evidence); «relation» = owner-made or suggested (inferred, labelled).
// The map is a regrouping for study, distinct from the source's own figures, and every element links back to the page
// or the question it came from. Large courses are cut to the most informative concepts / questions, with the totals.
import { RELATION_LABELS_AR, type KnowledgeMapEdge, type KnowledgeMapNode, type KnowledgeMapResponse } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { versionConcepts } from './coverage';
import { conceptNamesNorm, lectureQuestions, type LectureQuestion } from './lecture-questions';
import { resolveConceptId } from './resolve';
import { courseSources, inList, nodeTitle, pageLabelAr, readerHref, studySource } from './store';

const MAX_CONCEPTS = 60;
const MAX_QUESTIONS = 40;

const SOURCE_TYPE_AR: Record<string, string> = { lecture: 'محاضرة', course_reference: 'مرجع الكورس', textbook: 'كتاب', practical_manual: 'دليل عملي', guideline: 'دليل إرشادي' };

export function knowledgeMap(ctx: AppContext, courseNodeId: string, opts: { sourceId?: string | null } = {}): KnowledgeMapResponse {
  const course = nodeTitle(ctx, courseNodeId);
  let lectures = courseSources(ctx, courseNodeId);
  if (opts.sourceId) {
    studySource(ctx, opts.sourceId);
    lectures = lectures.filter((l) => l.id === opts.sourceId);
  }
  const nodes: KnowledgeMapNode[] = [];
  const edges: KnowledgeMapEdge[] = [];
  const conceptInfo = new Map<string, { name: string; status: string; lectures: Map<string, string[]>; mentions: number; definition: boolean }>();
  const questionInfo = new Map<string, LectureQuestion & { lectures: Set<string> }>();
  const pageLabels = new Map<string, { label: string; source_id: string; version_id: string; page_index: number }>();

  lectures.forEach((l, i) => {
    const extracted = l.version_id ? ctx.db.get<{ status: string }>('SELECT status FROM concept_extraction WHERE version_id = ?', [l.version_id]) : null;
    nodes.push({
      id: `lecture:${l.id}`,
      type: 'lecture',
      label: l.title,
      sublabel: `${SOURCE_TYPE_AR[l.source_type] ?? l.source_type}${extracted ? '' : ' — لم يُستخرج هيكلها بعد'}`,
      status: extracted ? 'extracted' : 'not_extracted',
      href: `/sources/${encodeURIComponent(l.id)}`,
      order: i,
    });
    if (!l.version_id) return;
    for (const p of ctx.db.all<{ id: string; page_index: number; printed_label: string | null; kind: string }>('SELECT id, page_index, printed_label, kind FROM source_page WHERE version_id = ?', [l.version_id]))
      pageLabels.set(p.id, { label: pageLabelAr(p), source_id: l.id, version_id: l.version_id, page_index: p.page_index });
    const concepts = versionConcepts(ctx, l.version_id);
    const stated = new Map<string, { n: number; def: boolean }>();
    for (const m of ctx.db.all<{ concept_id: string; role: string }>(`SELECT concept_id, role FROM concept_mention WHERE version_id = ?`, [l.version_id])) {
      const cid = resolveConceptId(ctx, m.concept_id);
      const e = stated.get(cid) ?? { n: 0, def: false };
      e.n++;
      if (m.role === 'definition' || m.role === 'classification') e.def = true;
      stated.set(cid, e);
    }
    for (const c of concepts) {
      const info = conceptInfo.get(c.id) ?? { name: c.name, status: c.status, lectures: new Map(), mentions: 0, definition: false };
      info.lectures.set(l.id, c.page_ids);
      info.mentions += stated.get(c.id)?.n ?? 0;
      info.definition ||= stated.get(c.id)?.def ?? false;
      conceptInfo.set(c.id, info);
    }
    for (const q of lectureQuestions(
      ctx,
      l,
      concepts.map((c) => ({ id: c.id, names: conceptNamesNorm(ctx, c.id), page_ids: c.page_ids })),
    )) {
      const prev = questionInfo.get(q.id);
      if (prev) {
        prev.lectures.add(l.id);
        for (const [k, v] of q.concepts) prev.concepts.set(k, v);
      } else questionInfo.set(q.id, { ...q, lectures: new Set([l.id]) });
    }
  });

  // most informative concepts first: accepted, defined, linked to questions, mentioned more
  const questionsPerConcept = new Map<string, number>();
  for (const q of questionInfo.values()) for (const c of q.concepts.keys()) questionsPerConcept.set(c, (questionsPerConcept.get(c) ?? 0) + 1);
  const rankedConcepts = [...conceptInfo.entries()].sort(
    ([a, x], [b, y]) =>
      Number(y.status === 'accepted') - Number(x.status === 'accepted') ||
      Number(y.definition) - Number(x.definition) ||
      (questionsPerConcept.get(b) ?? 0) - (questionsPerConcept.get(a) ?? 0) ||
      y.mentions - x.mentions ||
      x.name.localeCompare(y.name, 'ar'),
  );
  const shownConcepts = rankedConcepts.slice(0, MAX_CONCEPTS);
  const shownConceptIds = new Set(shownConcepts.map(([id]) => id));
  // concepts in first-lecture order inside the column
  const lectureOrder = new Map(lectures.map((l, i) => [l.id, i]));
  shownConcepts.sort(([, x], [, y]) => Math.min(...[...x.lectures.keys()].map((k) => lectureOrder.get(k) ?? 0)) - Math.min(...[...y.lectures.keys()].map((k) => lectureOrder.get(k) ?? 0)) || x.name.localeCompare(y.name, 'ar'));
  shownConcepts.forEach(([id, c], i) => {
    nodes.push({
      id: `concept:${id}`,
      type: 'concept',
      label: c.name,
      sublabel: `${c.status === 'accepted' ? 'مقبول' : 'مقترح'}${c.definition ? ' — له تعريف في المحاضرة' : ''}`,
      status: c.status,
      href: `/concepts/${encodeURIComponent(id)}`,
      order: i,
    });
    for (const [lid, pids] of c.lectures) {
      const pages = pids.map((p) => ({ page_id: p, label_ar: pageLabels.get(p)?.label ?? '' })).filter((p) => p.label_ar);
      edges.push({ id: `m:${lid}:${id}`, from: `lecture:${lid}`, to: `concept:${id}`, kind: 'mentions', support: 'stated', relation: null, status: null, label_ar: `مذكور في ${pages.map((p) => p.label_ar).join('، ') || 'المحاضرة'}`, pages });
    }
  });

  const rankedQuestions = [...questionInfo.values()].sort(
    (a, b) =>
      [...b.concepts.keys()].filter((c) => shownConceptIds.has(c)).length - [...a.concepts.keys()].filter((c) => shownConceptIds.has(c)).length || Number(a.side === 'generated') - Number(b.side === 'generated') || a.stem.localeCompare(b.stem),
  );
  const shownQuestions = rankedQuestions.slice(0, MAX_QUESTIONS);
  shownQuestions.forEach((q, i) => {
    nodes.push({
      id: `question:${q.id}`,
      type: 'question',
      label: q.stem || 'سؤال',
      sublabel: `${q.side === 'generated' ? 'سؤال مولَّد' : q.origin_type === 'owner' ? 'سؤال أضفته' : 'سؤال من المصادر'}${q.attempts > 0 ? ' — حاولت حله' : ''}`,
      status: q.side,
      href: `/questions/${encodeURIComponent(q.id)}`,
      order: i,
    });
    const shownFor = [...q.concepts.entries()].filter(([c]) => shownConceptIds.has(c));
    for (const [cid, basis] of shownFor) {
      edges.push({
        id: `q:${q.id}:${cid}`,
        from: `question:${q.id}`,
        to: `concept:${cid}`,
        kind: 'covers',
        support: 'matched',
        relation: null,
        status: q.side,
        label_ar: basis === 'matcher' ? 'ربط السؤال بالمحاضرة ذكر هذا المفهوم' : basis === 'text' ? 'اسم المفهوم في نص السؤال' : 'من أدلة السؤال المولَّد',
        pages: [],
      });
    }
    if (shownFor.length === 0) {
      for (const lid of q.lectures) {
        const pages = q.page_ids.map((p) => ({ page_id: p, label_ar: pageLabels.get(p)?.label ?? '' })).filter((p) => p.label_ar);
        edges.push({ id: `ql:${q.id}:${lid}`, from: `question:${q.id}`, to: `lecture:${lid}`, kind: 'covers', support: 'matched', relation: null, status: q.side, label_ar: 'مرتبط بالمحاضرة', pages });
      }
    }
  });

  // relations among the shown concepts (rejected ones are not drawn)
  const ids = [...shownConceptIds];
  if (ids.length) {
    for (const r of ctx.db.all<{ id: string; from_concept_id: string; to_concept_id: string; relation: string; support: string; status: string; origin: string }>(
      `SELECT id, from_concept_id, to_concept_id, relation, support, status, origin FROM concept_relation
        WHERE status <> 'rejected' AND from_concept_id IN (${inList(ids.length)}) AND to_concept_id IN (${inList(ids.length)})`,
      [...ids, ...ids],
    )) {
      const label = RELATION_LABELS_AR[r.relation as keyof typeof RELATION_LABELS_AR] ?? r.relation;
      edges.push({
        id: `r:${r.id}`,
        from: `concept:${r.from_concept_id}`,
        to: `concept:${r.to_concept_id}`,
        kind: 'relation',
        support: r.origin === 'owner' ? 'owner' : (r.support as 'stated' | 'inferred'),
        relation: r.relation as KnowledgeMapEdge['relation'],
        status: r.status,
        label_ar: `${label}${r.origin === 'owner' ? ' (أضفتها)' : r.support === 'inferred' ? ' (مستنتجة)' : ''}${r.status === 'suggested' ? ' — مقترحة' : ''}`,
        pages: [],
      });
    }
  }
  // reader links on mention edges' pages are built by the client from page ids; give the lecture nodes the reader href
  for (const n of nodes) if (n.type === 'lecture') {
    const l = lectures.find((x) => `lecture:${x.id}` === n.id);
    if (l?.version_id) n.href = readerHref(l.id, l.version_id, null);
  }
  return {
    course: { id: course.id, title: course.title },
    lecture_id: opts.sourceId ?? null,
    nodes,
    edges,
    truncated: { concepts: { shown: shownConcepts.length, total: conceptInfo.size }, questions: { shown: shownQuestions.length, total: questionInfo.size } },
    notes_ar: [
      'الخريطة إعادة تنظيم تعليمية لمحتوى المحاضرات، وليست صورة من المصدر؛ كل مفهوم يرجع إلى صفحاته وكل سؤال إلى أصله.',
      'العلاقات المستنتجة مقترحات معلَّمة «مستنتجة» وليست نصًا من المحاضرة، وفتحها لا يوسّع نطاق المصدر في جلسة الدراسة.',
      ...(conceptInfo.size > shownConcepts.length ? [`تعرض الخريطة ${shownConcepts.length} من ${conceptInfo.size} مفهومًا (المقبولة والمعرَّفة والمرتبطة بأسئلة أولًا)؛ صفحة المفاهيم فيها الكل.`] : []),
    ],
  };
}
