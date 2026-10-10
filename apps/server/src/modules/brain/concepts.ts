// Concept correction (§16, §05: «extracted topics I can correct»). Every decision is the owner's and persists across
// re-extraction: status (accept / reject), rename (old names stay as aliases so a later extraction lands on the same
// concept), kind, note, merge (the merged concept is kept, pointing at its target; its mentions, relations and names
// move to the target). Mentions themselves are derived from the regions and are never edited by hand.
import {
  type BrainConceptCreateRequest,
  type BrainConceptListResponse,
  type BrainConceptPatchRequest,
  type BrainConceptView,
  type ConceptStatus,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { findConceptByName, nameNorm, resolveConceptId } from './resolve';
import { conceptRow, conceptView, courseSources, inList, MENTION_SELECT, type ConceptRow, type MentionRow, studySource, versionIdsOf } from './store';

function mentionsOfVersions(ctx: AppContext, versionIds: string[]): MentionRow[] {
  if (versionIds.length === 0) return [];
  return ctx.db.all<MentionRow>(`${MENTION_SELECT} WHERE m.version_id IN (${inList(versionIds.length)}) ORDER BY p.page_index, r.reading_order`, versionIds);
}

/** Concepts with mentions in the study versions of a scope (course subtree / one source / everything). */
export function listConcepts(
  ctx: AppContext,
  opts: { courseNodeId?: string | null; sourceId?: string | null; status?: ConceptStatus | 'all'; q?: string | null; withMentions?: boolean } = {},
): BrainConceptListResponse {
  let versionIds: string[] | null = null;
  if (opts.sourceId) versionIds = versionIdsOf([studySource(ctx, opts.sourceId)]);
  else if (opts.courseNodeId) versionIds = versionIdsOf(courseSources(ctx, opts.courseNodeId));
  const mentions =
    versionIds === null
      ? ctx.db.all<MentionRow>(
          `${MENTION_SELECT} WHERE s.deleted_at IS NULL AND m.version_id = COALESCE(s.frozen_version_id, s.current_version_id) ORDER BY s.sort_order, p.page_index, r.reading_order`,
        )
      : mentionsOfVersions(ctx, versionIds);
  const byConcept = new Map<string, MentionRow[]>();
  for (const m of mentions) {
    const id = resolveConceptId(ctx, m.concept_id);
    const list = byConcept.get(id) ?? [];
    list.push(m);
    byConcept.set(id, list);
  }
  // owner-made concepts appear in the global list even without mentions
  if (versionIds === null) for (const r of ctx.db.all<{ id: string }>(`SELECT id FROM concept WHERE origin = 'owner' AND merged_into_id IS NULL`)) if (!byConcept.has(r.id)) byConcept.set(r.id, []);
  const ids = [...byConcept.keys()];
  const rows = new Map(
    (ids.length ? ctx.db.all<ConceptRow>(`SELECT * FROM concept WHERE id IN (${inList(ids.length)})`, ids) : []).map((r) => [r.id, r]),
  );
  const counts = { suggested: 0, accepted: 0, rejected: 0, merged: 0 };
  counts.merged = ids.length ? (ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM concept WHERE merged_into_id IN (${inList(ids.length)})`, ids)?.n ?? 0) : 0;
  const q = opts.q ? nameNorm(opts.q) : '';
  const items: BrainConceptView[] = [];
  for (const [id, ms] of byConcept) {
    const c = rows.get(id);
    if (!c) continue;
    counts[c.status]++;
    if (opts.status && opts.status !== 'all' && c.status !== opts.status) continue;
    if (!opts.status && c.status === 'rejected') continue;
    if (q && !nameNorm(`${c.name_en ?? ''} ${c.name_ar ?? ''}`).includes(q)) continue;
    items.push(conceptView(ctx, c, ms, opts.withMentions ?? false));
  }
  items.sort((a, b) => (a.status === b.status ? 0 : a.status === 'accepted' ? -1 : b.status === 'accepted' ? 1 : 0) || Number(b.has_definition) - Number(a.has_definition) || b.mention_count - a.mention_count || a.name.localeCompare(b.name, 'ar'));
  return {
    items: items.slice(0, 1000),
    counts,
    notes_ar: [
      'المفاهيم مستخرجة آليًا من نص المحاضرات (العناوين والتعريفات والأقسام والجداول) دون ذكاء اصطناعي؛ كل ذكر يشير إلى موضعه في المصدر.',
      'قراراتك (القبول والرفض وإعادة التسمية والدمج) تبقى كما هي عند إعادة الاستخراج.',
      ...(counts.rejected > 0 && opts.status !== 'rejected' && opts.status !== 'all' ? [`المفاهيم المرفوضة (${counts.rejected}) مخفية هنا؛ اختر «المرفوضة» لرؤيتها.`] : []),
      ...(counts.merged > 0 ? [`${counts.merged} مفهومًا دُمجت في غيرها وتظهر ضمن المفهوم الذي دُمجت فيه.`] : []),
    ],
  };
}

export function getConcept(ctx: AppContext, id: string): BrainConceptView & { merged_into: { id: string; name: string } | null } {
  const c = conceptRow(ctx, id);
  const target = c.merged_into_id ? conceptRow(ctx, resolveConceptId(ctx, id)) : null;
  // mentions of this concept and of every concept merged into it — in the STUDY version of each source (frozen, else
  // current), like the list: a superseded version's quotes are not mixed in with the current ones (review F2)
  const merged = ctx.db.all<{ id: string }>('WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT c.id FROM concept c JOIN m ON c.merged_into_id = m.id) SELECT id FROM m', [id]).map((r) => r.id);
  const mentions = ctx.db.all<MentionRow>(
    `${MENTION_SELECT} WHERE m.concept_id IN (${inList(merged.length)}) AND s.deleted_at IS NULL AND m.version_id = COALESCE(s.frozen_version_id, s.current_version_id)
      ORDER BY s.sort_order, s.created_at, p.page_index, r.reading_order`,
    merged,
  );
  return { ...conceptView(ctx, c, mentions, true), merged_into: target ? { id: target.id, name: target.name_ar || target.name_en || target.id } : null };
}

function addAlias(ctx: AppContext, conceptId: string, alias: string, origin: 'rename' | 'merge' | 'owner'): void {
  const norm = nameNorm(alias);
  if (!norm) return;
  ctx.db.run(
    `INSERT INTO concept_alias (id, concept_id, alias, alias_norm, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(alias_norm) DO UPDATE SET concept_id = excluded.concept_id, origin = excluded.origin`,
    [newId(ctx.clock.now()), conceptId, alias, norm, origin, ctx.clock.now()],
  );
}

function cleanName(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 120) : null;
}

export function patchConcept(ctx: AppContext, id: string, patch: BrainConceptPatchRequest): BrainConceptView {
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const before = conceptRow(ctx, id);
    if (before.merged_into_id) throw new AppError('CONFLICT', 'هذا المفهوم مدموج في مفهوم آخر؛ عدّل المفهوم الذي دُمج فيه.', 409);
    const set: string[] = [];
    const params: unknown[] = [];
    if (patch.name_en !== undefined || patch.name_ar !== undefined) {
      const en = patch.name_en !== undefined ? cleanName(patch.name_en) : before.name_en;
      const ar = patch.name_ar !== undefined ? cleanName(patch.name_ar) : before.name_ar;
      if (!en && !ar) throw new AppError('BAD_REQUEST', 'للمفهوم اسم واحد على الأقل (عربي أو إنجليزي).', 400);
      for (const n of [en, ar]) {
        if (!n) continue;
        const other = findConceptByName(ctx, n);
        if (other && other.id !== id) throw new AppError('CONFLICT', `يوجد مفهوم آخر بالاسم «${n}». ادمج المفهومين بدل التسمية المكررة.`, 409, { concept_id: other.id });
      }
      // the old names keep resolving to this concept (a later extraction must not recreate them)
      for (const old of [before.name_en, before.name_ar]) if (old && old !== en && old !== ar) addAlias(ctx, id, old, 'rename');
      // a new name that was an alias is a name now
      for (const n of [en, ar]) if (n) ctx.db.run('DELETE FROM concept_alias WHERE alias_norm = ? AND concept_id = ?', [nameNorm(n), id]);
      set.push(`name_en = ?, name_ar = ?, name_origin = 'owner'`);
      params.push(en, ar);
    }
    if (patch.kind !== undefined) {
      set.push(`kind = ?, kind_origin = 'owner'`);
      params.push(cleanName(patch.kind));
    }
    if (patch.note !== undefined) {
      set.push('owner_note = ?');
      params.push(patch.note?.trim() ? patch.note.trim().slice(0, 2000) : null);
    }
    if (patch.status) {
      set.push('status = ?');
      params.push(patch.status);
    }
    if (set.length === 0) return;
    ctx.db.run(`UPDATE concept SET ${set.join(', ')}, updated_at = ? WHERE id = ?`, [...params, now, id]);
    ctx.audit.record({
      entityType: 'concept',
      entityId: id,
      action: patch.status === 'accepted' ? 'accept_concept' : patch.status === 'rejected' ? 'reject_concept' : 'update',
      summary:
        patch.status === 'rejected'
          ? `رفض المفهوم «${before.name_ar ?? before.name_en ?? ''}»`
          : patch.status === 'accepted'
            ? `قبول المفهوم «${before.name_ar ?? before.name_en ?? ''}»`
            : `تعديل المفهوم «${before.name_ar ?? before.name_en ?? ''}»`,
      before: { name_en: before.name_en, name_ar: before.name_ar, status: before.status, kind: before.kind },
      after: patch,
    });
  });
  return getConcept(ctx, id);
}

export function createConcept(ctx: AppContext, input: BrainConceptCreateRequest): BrainConceptView {
  const en = cleanName(input.name_en);
  const ar = cleanName(input.name_ar);
  if (!en && !ar) throw new AppError('BAD_REQUEST', 'اكتب اسم المفهوم (عربي أو إنجليزي).', 400);
  for (const n of [en, ar]) {
    if (!n) continue;
    const other = findConceptByName(ctx, n);
    if (other) throw new AppError('CONFLICT', `يوجد مفهوم بالاسم «${n}» بالفعل.`, 409, { concept_id: other.id });
  }
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO concept (id, name_en, name_ar, kind, origin, status, name_origin, kind_origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 'accepted', 'owner', 'owner', ?, ?)`,
      [id, en, ar, cleanName(input.kind), now, now],
    );
    ctx.audit.record({ entityType: 'concept', entityId: id, action: 'create', summary: `إضافة المفهوم «${ar ?? en}»` });
  });
  return getConcept(ctx, id);
}

/** Move everything of `id` onto `target` and leave `id` as a pointer (shared by owner merges and bilingual pairing). */
function mergeCore(ctx: AppContext, src: ConceptRow, dst: ConceptRow, now: number): void {
  const id = src.id;
  const target = dst.id;
  ctx.db.run('UPDATE concept_mention SET concept_id = ? WHERE concept_id = ?', [target, id]);
  // relations: re-point both ends; a relation that would link the target to itself is dropped. When the target already
  // has the same relation, ONE row survives and it is the one that carries an owner decision: the target's row wins
  // unless it is an undecided suggestion and the moved row is decided (accepted / rejected / owner-made) — a merge
  // never silently undoes the owner's rejection or acceptance (review F2)
  const decided = (x: { origin: string; status: string }) => x.origin === 'owner' || x.status !== 'suggested';
  for (const r of ctx.db.all<{ id: string; from_concept_id: string; to_concept_id: string; relation: string; origin: string; status: string }>(
    'SELECT id, from_concept_id, to_concept_id, relation, origin, status FROM concept_relation WHERE from_concept_id = ? OR to_concept_id = ?',
    [id, id],
  )) {
    const from = r.from_concept_id === id ? target : r.from_concept_id;
    const to = r.to_concept_id === id ? target : r.to_concept_id;
    if (from === to) {
      ctx.db.run('DELETE FROM concept_relation WHERE id = ?', [r.id]);
      continue;
    }
    const dup = ctx.db.get<{ id: string; origin: string; status: string }>(
      'SELECT id, origin, status FROM concept_relation WHERE from_concept_id = ? AND to_concept_id = ? AND relation = ? AND id <> ?',
      [from, to, r.relation, r.id],
    );
    if (dup && !(decided(r) && !decided(dup))) {
      ctx.db.run('DELETE FROM concept_relation WHERE id = ?', [r.id]);
      continue;
    }
    if (dup) ctx.db.run('DELETE FROM concept_relation WHERE id = ?', [dup.id]);
    ctx.db.run('UPDATE concept_relation SET from_concept_id = ?, to_concept_id = ?, updated_at = ? WHERE id = ?', [from, to, now, r.id]);
  }
  for (const n of [src.name_en, src.name_ar]) if (n && nameNorm(n) !== nameNorm(dst.name_en ?? '') && nameNorm(n) !== nameNorm(dst.name_ar ?? '')) addAlias(ctx, target, n, 'merge');
  ctx.db.run('UPDATE concept_alias SET concept_id = ? WHERE concept_id = ?', [target, id]);
  ctx.db.run('UPDATE concept SET merged_into_id = ?, updated_at = ? WHERE id = ?', [target, now, id]);
  ctx.db.run('UPDATE concept SET updated_at = ? WHERE id = ?', [now, target]);
}

/** Merge `id` into `intoId`: mentions, relations and names move; `id` stays as a pointer (never deleted). */
export function mergeConcept(ctx: AppContext, id: string, intoId: string): BrainConceptView {
  const now = ctx.clock.now();
  const target = resolveConceptId(ctx, intoId);
  if (resolveConceptId(ctx, id) === target || id === target) throw new AppError('BAD_REQUEST', 'لا يمكن دمج المفهوم في نفسه.', 400);
  ctx.db.tx(() => {
    const src = conceptRow(ctx, id);
    const dst = conceptRow(ctx, target);
    if (src.merged_into_id) throw new AppError('CONFLICT', 'هذا المفهوم مدموج بالفعل.', 409);
    mergeCore(ctx, src, dst, now);
    ctx.audit.record({
      entityType: 'concept',
      entityId: id,
      action: 'merge',
      summary: `دمج «${src.name_ar ?? src.name_en ?? ''}» في «${dst.name_ar ?? dst.name_en ?? ''}»`,
      before: { id, name_en: src.name_en, name_ar: src.name_ar, status: src.status },
      after: { merged_into_id: target },
    });
  });
  return getConcept(ctx, target);
}

/**
 * A bilingual heading («Acute Appendicitis — التهاب الزائدة الدودية الحاد») STATES that its two parts name one
 * concept. When the question candidates already made two separate SUGGESTIONS of them, they are joined — but only
 * when neither carries an owner decision (status suggested, automatic names, not merged). Returns whether it merged.
 */
export function joinBilingualSuggestions(ctx: AppContext, keepId: string, otherId: string, otherName: string): boolean {
  if (keepId === otherId) return false;
  const keep = conceptRow(ctx, keepId);
  const other = conceptRow(ctx, otherId);
  const undecided = (c: ConceptRow) => c.origin === 'auto' && c.status === 'suggested' && c.name_origin === 'auto' && !c.merged_into_id;
  if (!undecided(keep) || !undecided(other)) return false;
  const now = ctx.clock.now();
  mergeCore(ctx, other, keep, now);
  const altIsAr = /[\u0600-\u06FF]/.test(otherName);
  if (altIsAr && !keep.name_ar) ctx.db.run('UPDATE concept SET name_ar = ? WHERE id = ?', [otherName, keepId]);
  if (!altIsAr && !keep.name_en) ctx.db.run('UPDATE concept SET name_en = ? WHERE id = ?', [otherName, keepId]);
  ctx.db.run('DELETE FROM concept_alias WHERE concept_id = ? AND alias_norm = ?', [keepId, nameNorm(otherName)]);
  ctx.audit.record({
    entityType: 'concept',
    entityId: otherId,
    action: 'merge',
    actor: 'job',
    summary: `ضم «${otherName}» إلى «${keep.name_en ?? keep.name_ar ?? ''}»: العنوان ثنائي اللغة يسميهما معًا (اقتراحان لم تقرر فيهما بعد)`,
    after: { merged_into_id: keepId },
  });
  return true;
}
