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
}

function newMemo(): RecomputeMemo {
  return { status: new Map(), names: new Map(), display: new Map(), locations: new Map() };
}

// ───────── incremental caches (Round 7 H4) ─────────
// What one lecture contributes to a recompute is cached per process, keyed by what it was computed from, so a recompute
// after ONE lecture changed re-reads only that lecture: its stated mentions (by extraction time + the concept table's
// state), its text index (by the version's regions), and every «is concept A used in lecture B» answer (by both). The
// result is the same as a cold recompute (asserted by srv:perf/brain-course.perf.test.ts and srv:brain/h4-*.test.ts).
interface RegionIndex {
  sig: string;
  list: Array<{ id: string; norm: string; text: string }>;
  /** every token n-gram (1–8 tokens) of the version's text: a name that is not in here cannot match the word regex */
  grams: Set<string>;
}
interface LectureFacts {
  sig: string;
  mentions: StatedMention[];
  firstMention: Map<string, StatedMention>;
}
interface BrainCache {
  facts: Map<string, LectureFacts>;
  regions: Map<string, RegionIndex>;
  usage: Map<string, { sig: string; hit: { id: string; text: string } | null }>;
}
const caches = new WeakMap<object, BrainCache>();
function cacheOf(ctx: AppContext): BrainCache {
  let c = caches.get(ctx.db);
  if (!c) {
    c = { facts: new Map(), regions: new Map(), usage: new Map() };
    caches.set(ctx.db, c);
  }
  return c;
}

/** Forget the incremental caches (tests compare an incremental recompute with a cold one). */
export function clearRecomputeCaches(ctx: AppContext): void {
  caches.delete(ctx.db);
}

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const MAX_GRAM = 8;
function tokensOf(norm: string): string[] {
  return norm.split(TOKEN_SPLIT).filter(Boolean);
}

function conceptStateSig(ctx: AppContext): string {
  const c = ctx.db.get<{ c: number; u: number | null; m: number | null }>('SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(CASE WHEN merged_into_id IS NOT NULL THEN 1 ELSE 0 END) AS m FROM concept');
  return `${c?.c}|${c?.u}|${c?.m}`;
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

const ALNUM = /[\p{L}\p{N}]/u;
/** The code point that ends right before `i` / starts at `i` (surrogate pairs read whole, like a `u` regex). */
function cpBefore(text: string, i: number): string {
  if (i <= 0) return '';
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1]!;
}
function cpAt(text: string, i: number): string {
  if (i >= text.length) return '';
  const cp = text.codePointAt(i)!;
  return String.fromCodePoint(cp);
}
/**
 * `name` occurs in `text` as a whole word: exactly what the regex `(?:^|[^\p{L}\p{N}])name(?:$|[^\p{L}\p{N}])` (u flag)
 * matches, without compiling a regex per name (Round 7 H4: compiling one Unicode regex per concept dominated a cold
 * recompute of a large course).
 */
export function occursAsWord(text: string, name: string): boolean {
  if (!name) return false;
  for (let from = 0; ; ) {
    const i = text.indexOf(name, from);
    if (i < 0) return false;
    const before = cpBefore(text, i);
    const after = cpAt(text, i + name.length);
    if ((before === '' || !ALNUM.test(before)) && (after === '' || !ALNUM.test(after))) return true;
    from = i + 1;
  }
}

/** First region of the version whose text names the concept (word boundary on normalized text). */
function findUsage(regions: RegionIndex, names: string[]): { id: string; text: string } | null {
  if (names.length === 0) return null;
  // exact prefilter (Round 7 H4): a whole-word occurrence of a name is also a run of its tokens in the version's token
  // n-grams — most concepts are not in most lectures, so the per-region scan below only runs where a name can occur
  const possible = names.filter((n) => {
    const toks = tokensOf(n);
    return toks.length === 0 || toks.length > MAX_GRAM || regions.grams.has(toks.join(' '));
  });
  if (possible.length === 0) return null;
  for (const r of regions.list) for (const n of possible) if (occursAsWord(r.norm, n)) return { id: r.id, text: r.text };
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
  /** 'stated' when a sentence of a lecture states it (Round 7 H4), else 'inferred' */
  support: 'stated' | 'inferred';
  reasons: RelationReason[];
}

export interface RecomputeStats {
  created: number;
  updated: number;
  removed: number;
  kept_owner: number;
}

/** A point where the computation may pause (the async variant yields the event loop there). */
type Checkpoint = Generator<void, void, void>;

/**
 * The suggestions of one course group (pure reading; nothing is written). A generator: it yields between units of work
 * so the background job can give the event loop back to HTTP requests on a large course.
 */
function* computeSuggestions(ctx: AppContext, key: string, out: Map<string, Suggestion>): Checkpoint {
  const memo = newMemo();
  const cache = cacheOf(ctx);
  const cSig = conceptStateSig(ctx);
  const lectures: Array<StudySource & { mentions: StatedMention[]; firstMention: Map<string, StatedMention> }> = [];
  for (const s of sourcesOfCourseKey(ctx, key)) {
    if (!s.version_id) continue;
    const ex = ctx.db.get<{ u: number }>('SELECT updated_at AS u FROM concept_extraction WHERE version_id = ?', [s.version_id]);
    if (!ex) continue;
    // every extraction writes new mention rows (new ids): their ids say whether the lecture changed, whatever the clock
    const ms = ctx.db.get<{ c: number; a: string | null; b: string | null }>(
      `SELECT COUNT(*) AS c, MIN(id) AS a, MAX(id) AS b FROM concept_mention WHERE version_id = ? AND support = 'stated'`,
      [s.version_id],
    );
    const sig = `${ex.u}|${ms?.c}|${ms?.a}|${ms?.b}|${cSig}`;
    let f = cache.facts.get(s.version_id);
    if (!f || f.sig !== sig) {
      const mentions = statedMentions(ctx, s.version_id, memo);
      const firstMention = new Map<string, StatedMention>();
      for (const m of mentions) if (!firstMention.has(m.concept_id)) firstMention.set(m.concept_id, m);
      f = { sig, mentions, firstMention };
      cache.facts.set(s.version_id, f);
      yield;
    }
    lectures.push({ ...s, mentions: f.mentions, firstMention: f.firstMention });
  }
  const namesOfMemo = (id: string) => {
    if (!memo.names.has(id)) memo.names.set(id, namesOf(ctx, id));
    return memo.names.get(id)!;
  };
  const displayOf = (id: string) => {
    if (!memo.display.has(id)) memo.display.set(id, displayName(conceptRow(ctx, id)));
    return memo.display.get(id)!;
  };
  const regionSig = (versionId: string) => {
    const r = ctx.db.get<{ c: number; m: string | null; l: number | null; u: number | null }>(
      `SELECT COUNT(*) AS c, MAX(id) AS m, SUM(LENGTH(text)) AS l, MAX(updated_at) AS u FROM source_region WHERE version_id = ? AND status <> 'rejected'`,
      [versionId],
    );
    return `${r?.c}|${r?.m}|${r?.l}|${r?.u}`;
  };
  const regionSigs = new Map<string, string>();
  const regionsOf = (versionId: string): RegionIndex => {
    let sig = regionSigs.get(versionId);
    if (sig === undefined) {
      sig = regionSig(versionId);
      regionSigs.set(versionId, sig);
    }
    let r = cache.regions.get(versionId);
    if (!r || r.sig !== sig) {
      const list = ctx.db
        .all<{ id: string; text: string | null }>(
          `SELECT r.id, r.text FROM source_region r JOIN source_page p ON p.id = r.page_id
            WHERE r.version_id = ? AND r.parent_region_id IS NULL AND r.kind NOT IN ('header','footer') AND r.status <> 'rejected' AND r.text IS NOT NULL
            ORDER BY p.page_index, r.reading_order`,
          [versionId],
        )
        .map((x) => ({ id: x.id, text: x.text ?? '', norm: nameNorm(x.text ?? '') }));
      const grams = new Set<string>();
      for (const x of list) {
        const toks = tokensOf(x.norm);
        for (let i = 0; i < toks.length; i++) {
          let g = '';
          for (let n = 0; n < MAX_GRAM && i + n < toks.length; n++) {
            g = n === 0 ? toks[i]! : `${g} ${toks[i + n]}`;
            grams.add(g);
          }
        }
      }
      r = { sig, list, grams };
      cache.regions.set(versionId, r);
    }
    return r;
  };
  const usageOf = (versionId: string, conceptId: string): { id: string; text: string } | null => {
    const names = namesOfMemo(conceptId);
    const index = regionsOf(versionId);
    const sig = `${index.sig}|${names.join('\u0001')}`;
    const k = `${versionId}|${conceptId}`;
    const hit = cache.usage.get(k);
    if (hit && hit.sig === sig) return hit.hit;
    const found = findUsage(index, names);
    cache.usage.set(k, { sig, hit: found });
    return found;
  };
  const push = (s: Suggestion) => {
    if (s.from === s.to) return;
    const k = `${s.from}|${s.to}|${s.relation}`;
    const prev = out.get(k);
    if (prev) {
      prev.reasons.push(...s.reasons.filter((r) => !prev.reasons.some((p) => p.text_ar === r.text_ar)));
      if (s.support === 'stated') prev.support = 'stated';
    } else out.set(k, s);
  };

  // «defined earlier, used later»
  for (const [i, li] of lectures.entries()) {
    const defined = new Map<string, StatedMention>();
    for (const m of li.mentions) if (DEFINING_ROLES.includes(m.role) && !defined.has(m.concept_id)) defined.set(m.concept_id, m);
    if (defined.size === 0) continue;
    for (const lj of lectures.slice(i + 1)) {
      const mains = mainConcepts(lj.mentions);
      if (mains.length === 0) continue;
      const definedThere = new Set(lj.mentions.filter((m) => DEFINING_ROLES.includes(m.role)).map((m) => m.concept_id));
      for (const [a, def] of defined) {
        if (definedThere.has(a)) continue;
        let usage: { id: string; text: string } | null = null;
        const stated = lj.firstMention.get(a);
        if (stated) usage = { id: stated.region_id, text: stated.quote ?? '' };
        else usage = usageOf(lj.version_id!, a);
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
            support: 'inferred',
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
      yield;
    }
  }

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
        support: 'inferred',
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
  yield;

  // Round 7 H4: relations a sentence STATES («X causes Y», «يُعالَج X بـ Y») — support 'stated', the sentence as reason
  const statusOf = (id: string) => {
    if (!memo.status.has(id)) memo.status.set(id, ctx.db.get<{ status: string }>('SELECT status FROM concept WHERE id = ?', [id])?.status);
    return memo.status.get(id);
  };
  for (const l of lectures) {
    for (const st of ctx.db.all<{ from_concept_id: string; to_concept_id: string; relation: RelationKind; region_id: string; quote: string; pattern: string; certainty: string }>(
      'SELECT from_concept_id, to_concept_id, relation, region_id, quote, pattern, certainty FROM concept_relation_statement WHERE version_id = ? ORDER BY created_at, id',
      [l.version_id],
    )) {
      const from = resolveConceptId(ctx, st.from_concept_id);
      const to = resolveConceptId(ctx, st.to_concept_id);
      if (statusOf(from) === 'rejected' || statusOf(to) === 'rejected') continue;
      const at = loc(ctx, st.region_id, st.quote, memo);
      push({
        from,
        to,
        relation: st.relation,
        support: 'stated',
        reasons: [
          {
            kind: 'stated_in_text',
            text_ar: `مذكورة نصًا في «${l.title}»${at?.page_label_ar ? ` (${at.page_label_ar})` : ''}: «${displayOf(from)}» ${RELATION_LABELS_AR[st.relation] ?? st.relation} «${displayOf(to)}»${st.certainty === 'uncertain' ? ' — الجملة مقروءة آليًا (OCR) وقد تكون فيها أخطاء.' : '.'}`,
            pattern: st.pattern,
            ...(st.certainty === 'uncertain' ? { uncertain: true } : {}),
            ...(at ? { from: at } : {}),
          },
        ],
      });
    }
  }
}

/** Write a computed set of suggestions (one transaction). Owner decisions are never changed. */
function writeSuggestions(ctx: AppContext, key: string, suggestions: Map<string, Suggestion>): RecomputeStats {
  const now = ctx.clock.now();
  const stats: RecomputeStats = { created: 0, updated: 0, removed: 0, kept_owner: 0 };
  ctx.db.tx(() => {
    const seen = new Set<string>();
    for (const s of suggestions.values()) {
      const prior = ctx.db.get<{ id: string; origin: string; status: string; support: string; reasons_json: string | null; course_node_id: string | null }>(
        'SELECT id, origin, status, support, reasons_json, course_node_id FROM concept_relation WHERE from_concept_id = ? AND to_concept_id = ? AND relation = ?',
        [s.from, s.to, s.relation],
      );
      if (prior) {
        seen.add(prior.id);
        if (prior.origin === 'owner' || prior.status === 'rejected') {
          stats.kept_owner++;
          continue;
        }
        // undecided or accepted suggestion: refresh its reasons and support (the status is the owner's) — only when changed
        const reasonsJson = toJson(s.reasons);
        if (prior.reasons_json !== reasonsJson || prior.course_node_id !== key || prior.support !== s.support) {
          ctx.db.run('UPDATE concept_relation SET reasons_json = ?, course_node_id = ?, support = ?, updated_at = ? WHERE id = ?', [reasonsJson, key, s.support, now, prior.id]);
        }
        if (prior.status === 'accepted') stats.kept_owner++;
        else stats.updated++;
        continue;
      }
      const id = newId(now);
      seen.add(id);
      ctx.db.run(
        `INSERT INTO concept_relation (id, from_concept_id, to_concept_id, relation, support, evidence_ids_json, status, created_at, origin, reasons_json, course_node_id, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'suggested', ?, 'auto', ?, ?, ?)`,
        [id, s.from, s.to, s.relation, s.support, now, toJson(s.reasons), key, now],
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

/** Recompute the suggested relations of one course group now (synchronous). Owner decisions are never changed. */
export function recomputeInferredRelations(ctx: AppContext, key: string): RecomputeStats {
  const suggestions = new Map<string, Suggestion>();
  for (const _ of computeSuggestions(ctx, key, suggestions)) void _;
  return writeSuggestions(ctx, key, suggestions);
}

/**
 * The same recompute for the background job (Round 7 H4): the reading phase gives the event loop back every
 * `sliceMs` so HTTP requests are served while a large course is recomputed; the write is one short transaction.
 */
export async function recomputeInferredRelationsAsync(ctx: AppContext, key: string, opts: { sliceMs?: number; signal?: AbortSignal; onSlice?: (ms: number) => void } = {}): Promise<RecomputeStats> {
  const slice = opts.sliceMs ?? 20;
  const suggestions = new Map<string, Suggestion>();
  let t0 = performance.now();
  for (const _ of computeSuggestions(ctx, key, suggestions)) {
    void _;
    const spent = performance.now() - t0;
    if (spent >= slice) {
      opts.onSlice?.(spent);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (opts.signal?.aborted) throw new Error('recompute cancelled');
      t0 = performance.now();
    }
  }
  opts.onSlice?.(performance.now() - t0);
  // the write is one synchronous transaction: reported as its own slice (it blocks the event loop too)
  const w0 = performance.now();
  const stats = writeSuggestions(ctx, key, suggestions);
  opts.onSlice?.(performance.now() - w0);
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
