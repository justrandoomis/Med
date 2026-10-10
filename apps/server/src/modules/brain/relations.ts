// Concept relations (§16 Course Brain). Two kinds of rows in concept_relation:
//  * owner relations (origin 'owner'): what the owner states — accepted, editable, deletable;
//  * suggestions (origin 'auto', support 'inferred'): computed per course from the stated mentions —
//      - «defined earlier, used later»: concept A has a definition / classification in an earlier lecture of the course
//        and appears (as a stated mention, or by name in the text) in a later lecture that does not define it →
//        A is a suggested PREREQUISITE of that later lecture's main concept(s) (its title heading);
//      - «listed under a section»: X is listed under «Differential diagnosis» in the lecture about M →
//        X differential_of M (the «of M» part is inferred from the lecture heading).
//    Each suggestion carries its reasons with the exact locations. It is labelled «مستنتجة» everywhere and never
//    shown as lecture text. Following it opens the other lecture; it never widens the Source Lock of a study session.
// A recompute never changes a row the owner decided (accepted / rejected / owner-made): rejected suggestions are
// never resurrected, accepted ones keep their status. Only undecided suggestions whose basis disappeared are removed.
import {
  RELATION_LABELS_AR,
  type BrainLocation,
  type ConceptRelationView,
  type ConceptStatus,
  type RelationKind,
  type RelationReason,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { nameNorm, resolveConceptId } from './resolve';
import { conceptRow, displayName, inList, locationOfRegion, sourcesOfCourseKey, type StudySource } from './store';

const DEFINING_ROLES = ['definition', 'classification'];

interface StatedMention {
  concept_id: string;
  region_id: string;
  role: string;
  quote: string | null;
  page_index: number | null;
}

/** Per-recompute memo of concept lookups (review F2: a course recompute used to re-query them per mention / pair). */
interface RecomputeMemo {
  status: Map<string, string | undefined>;
  names: Map<string, string[]>;
  display: Map<string, string>;
  locations: Map<string, BrainLocation | null>;
  /** usable regions of a version + all their normalized texts joined (a cheap «can it occur at all?» prefilter) */
  regions: Map<string, { list: Array<{ id: string; norm: string; text: string }>; all: string }>;
}

function newMemo(): RecomputeMemo {
  return { status: new Map(), names: new Map(), display: new Map(), locations: new Map(), regions: new Map() };
}

function statedMentions(ctx: AppContext, versionId: string, memo: RecomputeMemo = newMemo()): StatedMention[] {
  const statusOf = (id: string) => {
    if (!memo.status.has(id)) memo.status.set(id, ctx.db.get<{ status: string }>('SELECT status FROM concept WHERE id = ?', [id])?.status);
    return memo.status.get(id);
  };
  return ctx.db
    .all<StatedMention & { status: string; merged_into_id: string | null }>(
      `SELECT m.concept_id, m.region_id, m.role, m.quote, p.page_index, c.status, c.merged_into_id
         FROM concept_mention m JOIN concept c ON c.id = m.concept_id LEFT JOIN source_region r ON r.id = m.region_id LEFT JOIN source_page p ON p.id = r.page_id
        WHERE m.version_id = ? AND m.support = 'stated'
        ORDER BY p.page_index, r.reading_order`,
      [versionId],
    )
    .map((m) => ({ ...m, concept_id: m.merged_into_id ? resolveConceptId(ctx, m.concept_id) : m.concept_id }))
    .filter((m) => statusOf(m.concept_id) !== 'rejected');
}

/** Main concepts of a lecture: the concepts of its first heading(s) (the title page). */
function mainConcepts(mentions: StatedMention[]): string[] {
  const heads = mentions.filter((m) => m.role === 'heading');
  if (heads.length === 0) return [];
  const first = Math.min(...heads.map((h) => h.page_index ?? 0));
  return [...new Set(heads.filter((h) => (h.page_index ?? 0) === first).map((h) => h.concept_id))];
}

function namesOf(ctx: AppContext, conceptId: string): string[] {
  const c = ctx.db.get<{ name_en: string | null; name_ar: string | null }>('SELECT name_en, name_ar FROM concept WHERE id = ?', [conceptId]);
  const aliases = ctx.db.all<{ alias: string }>('SELECT alias FROM concept_alias WHERE concept_id = ?', [conceptId]).map((a) => a.alias);
  return [c?.name_en, c?.name_ar, ...aliases].filter((n): n is string => !!n).map(nameNorm).filter((n) => n.length >= 3);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First region of the version whose text names the concept (word boundary on normalized text). */
function findUsage(regions: { list: Array<{ id: string; norm: string; text: string }>; all: string }, names: string[]): { id: string; text: string } | null {
  if (names.length === 0) return null;
  // exact prefilter: a whole-word occurrence is also a substring of the joined text — most concepts are not in most
  // lectures, so the per-region regex below only runs where the name can occur
  if (!names.some((n) => regions.all.includes(n))) return null;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?:$|[^\\p{L}\\p{N}])`, 'u');
  for (const r of regions.list) if (re.test(r.norm)) return { id: r.id, text: r.text };
  return null;
}

function loc(ctx: AppContext, regionId: string, quote: string | null, memo?: RecomputeMemo): (BrainLocation & { quote: string | null }) | undefined {
  let l: BrainLocation | null;
  if (memo) {
    if (!memo.locations.has(regionId)) memo.locations.set(regionId, locationOfRegion(ctx, regionId));
    l = memo.locations.get(regionId) ?? null;
  } else l = locationOfRegion(ctx, regionId);
  return l ? { ...l, quote: quote ? quote.slice(0, 300) : null } : undefined;
}

interface Suggestion {
  from: string;
  to: string;
  relation: RelationKind;
  reasons: RelationReason[];
}

export interface RecomputeStats {
  created: number;
  updated: number;
  removed: number;
  kept_owner: number;
}

/** Recompute the suggested (inferred) relations of one course group. Owner decisions are never changed. */
export function recomputeInferredRelations(ctx: AppContext, key: string): RecomputeStats {
  const memo = newMemo();
  const lectures: Array<StudySource & { mentions: StatedMention[]; firstMention: Map<string, StatedMention> }> = sourcesOfCourseKey(ctx, key)
    .filter((s) => !!s.version_id && !!ctx.db.get('SELECT 1 AS x FROM concept_extraction WHERE version_id = ?', [s.version_id]))
    .map((s) => {
      const mentions = statedMentions(ctx, s.version_id!, memo);
      const firstMention = new Map<string, StatedMention>();
      for (const m of mentions) if (!firstMention.has(m.concept_id)) firstMention.set(m.concept_id, m);
      return { ...s, mentions, firstMention };
    });
  const namesOfMemo = (id: string) => {
    if (!memo.names.has(id)) memo.names.set(id, namesOf(ctx, id));
    return memo.names.get(id)!;
  };
  const displayOf = (id: string) => {
    if (!memo.display.has(id)) memo.display.set(id, displayName(conceptRow(ctx, id)));
    return memo.display.get(id)!;
  };
  const regionsOf = (versionId: string) => {
    let r = memo.regions.get(versionId);
    if (!r) {
      const list = ctx.db
        .all<{ id: string; text: string | null }>(
          `SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id
            WHERE r.version_id = ? AND r.parent_region_id IS NULL AND r.kind NOT IN ('header','footer') AND r.status <> 'rejected' AND r.text IS NOT NULL
            ORDER BY p.page_index, r.reading_order`,
          [versionId],
        )
        .map((x) => ({ id: x.id, text: x.text ?? '', norm: nameNorm(x.text ?? '') }));
      r = { list, all: list.map((x) => x.norm).join('\n') };
      memo.regions.set(versionId, r);
    }
    return r;
  };
  const suggestions = new Map<string, Suggestion>();
  const push = (s: Suggestion) => {
    if (s.from === s.to) return;
    const k = `${s.from}|${s.to}|${s.relation}`;
    const prev = suggestions.get(k);
    if (prev) prev.reasons.push(...s.reasons.filter((r) => !prev.reasons.some((p) => p.text_ar === r.text_ar)));
    else suggestions.set(k, s);
  };

  // «defined earlier, used later»
  lectures.forEach((li, i) => {
    const defined = new Map<string, StatedMention>();
    for (const m of li.mentions) if (DEFINING_ROLES.includes(m.role) && !defined.has(m.concept_id)) defined.set(m.concept_id, m);
    if (defined.size === 0) return;
    for (const lj of lectures.slice(i + 1)) {
      const mains = mainConcepts(lj.mentions);
      if (mains.length === 0) continue;
      const definedThere = new Set(lj.mentions.filter((m) => DEFINING_ROLES.includes(m.role)).map((m) => m.concept_id));
      for (const [a, def] of defined) {
        if (definedThere.has(a)) continue;
        let usage: { id: string; text: string } | null = null;
        const stated = lj.firstMention.get(a);
        if (stated) usage = { id: stated.region_id, text: stated.quote ?? '' };
        else usage = findUsage(regionsOf(lj.version_id!), namesOfMemo(a));
        if (!usage) continue;
        const aName = displayOf(a);
        for (const b of mains) {
          if (b === a) continue;
          const from = loc(ctx, def.region_id, def.quote, memo);
          const to = loc(ctx, usage.id, usage.text, memo);
          push({
            from: a,
            to: b,
            relation: 'prerequisite',
            reasons: [
              {
                kind: 'defined_earlier_used_later',
                text_ar: `«${aName}» معرَّف في «${li.title}»${from?.page_label_ar ? ` (${from.page_label_ar})` : ''} ويُستخدم بعدها في «${lj.title}»${to?.page_label_ar ? ` (${to.page_label_ar})` : ''} دون تعريف هناك.`,
                ...(from ? { from } : {}),
                ...(to ? { to } : {}),
              },
            ],
          });
        }
      }
    }
  });

  // «listed under a section» → differential_of the lecture's main concept
  for (const l of lectures) {
    const mains = mainConcepts(l.mentions);
    if (mains.length !== 1) continue;
    for (const m of l.mentions.filter((x) => x.role === 'differential')) {
      const at = loc(ctx, m.region_id, m.quote, memo);
      push({
        from: m.concept_id,
        to: mains[0]!,
        relation: 'differential_of',
        reasons: [
          {
            kind: 'listed_under_section',
            text_ar: `مذكور ضمن «التشخيص التفريقي» في «${l.title}»${at?.page_label_ar ? ` (${at.page_label_ar})` : ''}؛ ربطه بعنوان المحاضرة استنتاج.`,
            ...(at ? { to: at } : {}),
          },
        ],
      });
    }
  }

  const now = ctx.clock.now();
  const stats: RecomputeStats = { created: 0, updated: 0, removed: 0, kept_owner: 0 };
  ctx.db.tx(() => {
    const seen = new Set<string>();
    for (const s of suggestions.values()) {
      const prior = ctx.db.get<{ id: string; origin: string; status: string; reasons_json: string | null; course_node_id: string | null }>(
        'SELECT id, origin, status, reasons_json, course_node_id FROM concept_relation WHERE from_concept_id = ? AND to_concept_id = ? AND relation = ?',
        [s.from, s.to, s.relation],
      );
      if (prior) {
        seen.add(prior.id);
        if (prior.origin === 'owner' || prior.status === 'rejected') {
          stats.kept_owner++;
          continue;
        }
        // undecided or accepted suggestion: refresh its reasons (the status is the owner's) — only when they changed
        const reasonsJson = toJson(s.reasons);
        if (prior.reasons_json !== reasonsJson || prior.course_node_id !== key) {
          ctx.db.run('UPDATE concept_relation SET reasons_json = ?, course_node_id = ?, updated_at = ? WHERE id = ?', [reasonsJson, key, now, prior.id]);
        }
        if (prior.status === 'accepted') stats.kept_owner++;
        else stats.updated++;
        continue;
      }
      const id = newId(now);
      seen.add(id);
      ctx.db.run(
        `INSERT INTO concept_relation (id, from_concept_id, to_concept_id, relation, support, evidence_ids_json, status, created_at, origin, reasons_json, course_node_id, updated_at)
         VALUES (?, ?, ?, ?, 'inferred', NULL, 'suggested', ?, 'auto', ?, ?, ?)`,
        [id, s.from, s.to, s.relation, now, toJson(s.reasons), key, now],
      );
      stats.created++;
    }
    // undecided suggestions of this course whose basis is gone
    for (const r of ctx.db.all<{ id: string }>(`SELECT id FROM concept_relation WHERE origin = 'auto' AND status = 'suggested' AND course_node_id = ?`, [key])) {
      if (seen.has(r.id)) continue;
      ctx.db.run('DELETE FROM concept_relation WHERE id = ?', [r.id]);
      stats.removed++;
    }
  });
  return stats;
}

// ───────── views & owner edits ─────────
interface RelationRow {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  relation: RelationKind;
  support: 'stated' | 'inferred';
  status: ConceptStatus;
  origin: 'auto' | 'owner';
  reasons_json: string | null;
  course_node_id: string | null;
  note: string | null;
  created_at: number;
  updated_at: number | null;
}

export function relationView(ctx: AppContext, r: RelationRow): ConceptRelationView {
  const f = conceptRow(ctx, r.from_concept_id);
  const t = conceptRow(ctx, r.to_concept_id);
  return {
    id: r.id,
    from: { id: f.id, name: displayName(f), status: f.status },
    to: { id: t.id, name: displayName(t), status: t.status },
    relation: r.relation,
    relation_label_ar: RELATION_LABELS_AR[r.relation] ?? r.relation,
    support: r.support,
    support_label_ar: r.origin === 'owner' ? 'أضفتها بنفسك — ليست نصًا من المحاضرة' : r.support === 'inferred' ? 'مستنتجة — ليست نصًا من المحاضرة' : 'مذكورة في النص',
    origin: r.origin,
    status: r.status,
    reasons: fromJson<RelationReason[]>(r.reasons_json, []) ?? [],
    note: r.note,
    course_node_id: r.course_node_id,
    updated_at: r.updated_at ?? r.created_at,
  };
}

export function listRelations(ctx: AppContext, filter: { conceptIds?: string[]; status?: ConceptStatus; courseKey?: string | null } = {}): ConceptRelationView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.conceptIds) {
    if (filter.conceptIds.length === 0) return [];
    where.push(`(from_concept_id IN (${inList(filter.conceptIds.length)}) OR to_concept_id IN (${inList(filter.conceptIds.length)}))`);
    params.push(...filter.conceptIds, ...filter.conceptIds);
  }
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  const rows = ctx.db.all<RelationRow>(`SELECT * FROM concept_relation ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY status = 'rejected', origin = 'owner' DESC, created_at`, params);
  return rows.map((r) => relationView(ctx, r));
}

function relationRow(ctx: AppContext, id: string): RelationRow {
  const r = ctx.db.get<RelationRow>('SELECT * FROM concept_relation WHERE id = ?', [id]);
  if (!r) throw new AppError('NOT_FOUND', 'العلاقة غير موجودة.', 404);
  return r;
}

export function createRelation(ctx: AppContext, input: { from_concept_id: string; to_concept_id: string; relation: RelationKind; note?: string | null }): ConceptRelationView {
  const from = resolveConceptId(ctx, input.from_concept_id);
  const to = resolveConceptId(ctx, input.to_concept_id);
  conceptRow(ctx, from);
  conceptRow(ctx, to);
  if (from === to) throw new AppError('BAD_REQUEST', 'لا يمكن ربط المفهوم بنفسه.', 400);
  const now = ctx.clock.now();
  let id = '';
  ctx.db.tx(() => {
    const prior = ctx.db.get<{ id: string }>('SELECT id FROM concept_relation WHERE from_concept_id = ? AND to_concept_id = ? AND relation = ?', [from, to, input.relation]);
    if (prior) {
      id = prior.id;
      // the owner states it: it becomes the owner's relation (accepted); earlier reasons stay visible
      ctx.db.run(`UPDATE concept_relation SET origin = 'owner', status = 'accepted', note = COALESCE(?, note), updated_at = ? WHERE id = ?`, [input.note ?? null, now, id]);
    } else {
      id = newId(now);
      ctx.db.run(
        `INSERT INTO concept_relation (id, from_concept_id, to_concept_id, relation, support, status, created_at, origin, reasons_json, course_node_id, note, updated_at)
         VALUES (?, ?, ?, ?, 'stated', 'accepted', ?, 'owner', ?, NULL, ?, ?)`,
        [id, from, to, input.relation, now, toJson([{ kind: 'owner', text_ar: 'علاقة أضفتها بنفسك.' }]), input.note ?? null, now],
      );
    }
    ctx.audit.record({ entityType: 'concept_relation', entityId: id, action: 'create', summary: `إضافة علاقة: ${RELATION_LABELS_AR[input.relation]}`, after: { from, to, relation: input.relation } });
  });
  return relationView(ctx, relationRow(ctx, id));
}

export function patchRelation(ctx: AppContext, id: string, patch: { status?: ConceptStatus; relation?: RelationKind; note?: string | null }): ConceptRelationView {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const before = relationRow(ctx, id);
    if (patch.relation && patch.relation !== before.relation) {
      const clash = ctx.db.get('SELECT 1 AS x FROM concept_relation WHERE from_concept_id = ? AND to_concept_id = ? AND relation = ? AND id <> ?', [
        before.from_concept_id,
        before.to_concept_id,
        patch.relation,
        id,
      ]);
      if (clash) throw new AppError('CONFLICT', 'توجد علاقة بهذا النوع بين المفهومين بالفعل.', 409);
      // changing the kind is the owner's statement: the row becomes the owner's
      ctx.db.run(`UPDATE concept_relation SET relation = ?, origin = 'owner', status = 'accepted', updated_at = ? WHERE id = ?`, [patch.relation, now, id]);
    }
    if (patch.status) ctx.db.run('UPDATE concept_relation SET status = ?, updated_at = ? WHERE id = ?', [patch.status, now, id]);
    if (patch.note !== undefined) ctx.db.run('UPDATE concept_relation SET note = ?, updated_at = ? WHERE id = ?', [patch.note?.trim() ? patch.note.trim().slice(0, 1000) : null, now, id]);
    ctx.audit.record({
      entityType: 'concept_relation',
      entityId: id,
      action: patch.status === 'accepted' ? 'accept' : patch.status === 'rejected' ? 'reject' : 'update',
      summary: patch.status === 'rejected' ? 'رفض علاقة مقترحة' : patch.status === 'accepted' ? 'قبول علاقة' : 'تعديل علاقة',
      before: { status: before.status, relation: before.relation },
      after: patch,
    });
  });
  return relationView(ctx, relationRow(ctx, id));
}

/** Owner relation → deleted; a suggestion → rejected (so it is never suggested again). */
export function deleteRelation(ctx: AppContext, id: string): void {
  ctx.db.tx(() => {
    const r = relationRow(ctx, id);
    if (r.origin === 'owner') ctx.db.run('DELETE FROM concept_relation WHERE id = ?', [id]);
    else ctx.db.run(`UPDATE concept_relation SET status = 'rejected', updated_at = ? WHERE id = ?`, [ctx.clock.now(), id]);
    ctx.audit.record({ entityType: 'concept_relation', entityId: id, action: 'delete', summary: r.origin === 'owner' ? 'حذف علاقة أضفتها' : 'رفض علاقة مقترحة', before: { status: r.status } });
  });
}

export function relationsCount(ctx: AppContext, conceptIds: string[]): { suggested: number; accepted: number; rejected: number } {
  const out = { suggested: 0, accepted: 0, rejected: 0 };
  if (conceptIds.length === 0) return out;
  for (const r of ctx.db.all<{ status: ConceptStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM concept_relation WHERE from_concept_id IN (${inList(conceptIds.length)}) OR to_concept_id IN (${inList(conceptIds.length)}) GROUP BY status`,
    [...conceptIds, ...conceptIds],
  ))
    out[r.status] = r.n;
  return out;
}
