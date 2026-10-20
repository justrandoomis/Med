// Algorithms / flowcharts read from the lectures (Round 7 H4) — the views: per lecture, per concept or per course.
// Every node links back to its region; a region that no longer exists (page re-processed) has no link until the
// follow-up extraction replaces the row. Certainty is shown in words; nothing is ordered or linked beyond what was read.
import {
  ALGORITHM_CERTAINTY_LABELS_AR,
  ALGORITHM_KIND_LABELS_AR,
  type AlgorithmCertainty,
  type AlgorithmEdgeView,
  type AlgorithmKind,
  type AlgorithmNodeView,
  type KnowledgeAlgorithmListResponse,
  type KnowledgeAlgorithmView,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { resolveConceptId } from './resolve';
import { conceptRow, displayName, inList, locationOfRegion } from './store';

interface AlgorithmRow {
  id: string;
  version_id: string;
  source_id: string;
  kind: AlgorithmKind;
  title: string | null;
  section: string | null;
  concept_id: string | null;
  certainty: AlgorithmCertainty;
  ordered: number;
  structure_json: string;
  first_region_id: string | null;
  source_title: string;
}

const SELECT = `SELECT a.*, s.title AS source_title FROM knowledge_algorithm a JOIN source s ON s.id = a.source_id
  WHERE s.deleted_at IS NULL AND a.version_id = COALESCE(s.frozen_version_id, s.current_version_id)`;

function view(ctx: AppContext, r: AlgorithmRow): KnowledgeAlgorithmView {
  const st = fromJson<{ nodes: Array<{ key: string; text: string; kind: AlgorithmNodeView['kind']; region_id: string }>; edges: AlgorithmEdgeView[] }>(r.structure_json, { nodes: [], edges: [] })!;
  const regionExists = new Map<string, { page_id: string | null } | null>();
  const regionOf = (id: string) => {
    if (!regionExists.has(id)) regionExists.set(id, ctx.db.get<{ page_id: string | null }>('SELECT page_id FROM source_region WHERE id = ?', [id]) ?? null);
    return regionExists.get(id);
  };
  const nodes: AlgorithmNodeView[] = st.nodes.map((n) => {
    const reg = regionOf(n.region_id);
    const q = new URLSearchParams({ v: r.version_id, ...(reg?.page_id ? { page_id: reg.page_id } : {}), region: n.region_id });
    return { key: n.key, text: n.text, kind: n.kind, region_id: n.region_id, href: reg ? `/study/${encodeURIComponent(r.source_id)}?${q.toString()}` : null };
  });
  const concept = r.concept_id ? conceptRow(ctx, resolveConceptId(ctx, r.concept_id)) : null;
  const notes: string[] = [];
  if (r.kind === 'flowchart_figure' && r.certainty !== 'owner_reviewed') {
    notes.push('هذه تسميات الشكل كما قرأها OCR فقط: الأسهم واتجاهها غير مقروءة، فلا يُعرف ترتيب الخطوات ولا الروابط بينها. افتح الشكل في المصدر، أو اطلب قراءة الشكل وراجعها لتظهر الأسهم المؤكدة.');
  } else if (r.certainty === 'uncertain') {
    notes.push('النص مقروء آليًا (OCR) وقد تكون فيه أخطاء؛ قارنه بالصفحة الأصلية.');
  }
  if (r.kind === 'conditional' || r.kind === 'decision_list') notes.push('كل قاعدة كما وردت في النص: الشرط ثم ما يليه؛ لا تُضاف فروع لم تُكتب.');
  if (nodes.some((n) => !n.href)) notes.push('بعض المواضع لم تعد موجودة (أعيدت معالجة الصفحة)؛ يُحدَّث الهيكل بعد إعادة الاستخراج.');
  return {
    id: r.id,
    source_id: r.source_id,
    source_title: r.source_title,
    version_id: r.version_id,
    kind: r.kind,
    kind_label_ar: ALGORITHM_KIND_LABELS_AR[r.kind] ?? r.kind,
    title: r.title,
    section: r.section,
    concept: concept && concept.status !== 'rejected' ? { id: concept.id, name: displayName(concept) } : null,
    certainty: r.certainty,
    certainty_label_ar: ALGORITHM_CERTAINTY_LABELS_AR[r.certainty] ?? r.certainty,
    ordered: !!r.ordered,
    nodes,
    edges: st.edges,
    location: r.first_region_id ? locationOfRegion(ctx, r.first_region_id) : null,
    notes_ar: notes,
  };
}

export function listAlgorithms(ctx: AppContext, filter: { sourceIds?: string[]; conceptId?: string | null }): KnowledgeAlgorithmListResponse {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.sourceIds) {
    if (filter.sourceIds.length === 0) return { items: [], notes_ar: [] };
    where.push(`a.source_id IN (${inList(filter.sourceIds.length)})`);
    params.push(...filter.sourceIds);
  }
  let rows = ctx.db.all<AlgorithmRow>(`${SELECT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY s.sort_order, s.created_at, a.ord LIMIT 500`, params);
  if (filter.conceptId) {
    const target = resolveConceptId(ctx, filter.conceptId);
    rows = rows.filter((r) => r.concept_id && resolveConceptId(ctx, r.concept_id) === target);
  }
  return {
    items: rows.map((r) => view(ctx, r)),
    notes_ar: [
      'الخوارزميات والمخططات هنا مقروءة آليًا ودون ذكاء اصطناعي من نص المحاضرة كما طُبع (خطوات مرقّمة، «إذا … فـ…»، أسهم، قوائم قرار، تسميات المخططات): كل خطوة نصها الحرفي ورابط إلى موضعها، ولا يُضاف ما لم يُكتب.',
    ],
  };
}
