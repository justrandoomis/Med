// Concept candidates (§16, minimal): deterministic SUGGESTIONS from a lecture version — headings (title-like
// text), the first column of tables, figure/table captions and capitalized multi-word terms / abbreviations.
// Each becomes a `concept` (origin auto, status suggested — the owner can accept or reject it) with
// `concept_mention` rows pointing at the regions it came from (role 'candidate_*'). Matching uses accepted and
// suggested candidates, never rejected ones. A rejected concept is never resurrected by a later run.
import { normalizeForSearch, stripBidiControls, type ConceptCandidateView, type TableStructure } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { pageLabel } from './store';
import { contentTokens } from './text';

export interface Candidate {
  name: string;
  lang: 'en' | 'ar';
  role: 'candidate_heading' | 'candidate_table' | 'candidate_caption' | 'candidate_term';
  regionId: string;
}

/** Generic section words: a heading made only of these is structure, not a concept. */
const GENERIC_HEADING = new Set(
  (
    'introduction overview objectives objective learning summary conclusion conclusions references reference clinical presentation ' +
    'investigation investigations management treatment differential diagnosis complications complication definition definitions aetiology ' +
    'etiology pathophysiology epidemiology case cases questions question answers answer key table figure pathway notes note revision ' +
    'section part chapter lecture appendix test tests ' +
    // Arabic section words (normalized, article stripped — as contentTokens() stems them)
    'فحوصات فحص علاج تشخيص مقدمه اهداف خلاصه ملخص مضاعفات تعريف اسباب اعراض مكونات مقياس جدول شكل'
  ).split(/\s+/),
);
const SKIP_CAPS = new Set(['TEST', 'FIXTURE', 'NOT', 'EXCEPT', 'LEAST', 'FALSE', 'TRUE', 'AND', 'OR', 'THE', 'NB']);
const TERM_HEADS =
  'point|sign|signs|score|test|syndrome|disease|triad|criteria|classification|reflex|scale|index|ratio|incision|hernia|fracture|ulcer|maneuver|manoeuvre|law|abdomen|position|method|procedure|operation|repair|fossa|pregnancy|colic|adenitis|count|enema';
const CAP_TERM = new RegExp(String.raw`\b([A-Z][a-zA-Z]+(?:['’]s)?\s+(?:${TERM_HEADS}))\b`, 'g');
const CAP_SEQ = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b/g;
const ABBREV = /\b([A-Z]{3,8})\b/g;

function scriptOf(s: string): 'en' | 'ar' {
  return /[؀-ۿ]/.test(s) ? 'ar' : 'en';
}

function clean(s: string): string {
  return stripBidiControls(s)
    .replace(/^(?:table|figure|fig\.?|جدول|شكل)\s*\d*\s*[:.\-–]\s*/i, '')
    .replace(/[.:;،]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningful(name: string): boolean {
  if (name.length < 3 || name.length > 80) return false;
  if (name.split(/\s+/).length > 6) return false;
  if (/^[0-9\s.,%/×<>≥≤—–\-]+$/.test(name)) return false;
  const toks = contentTokens(name);
  if (toks.length === 0) return false;
  return toks.some((t) => !GENERIC_HEADING.has(t.stem) && !GENERIC_HEADING.has(t.norm));
}

export function conceptKey(name: string): string {
  return contentTokens(name)
    .map((t) => t.stem)
    .join(' ');
}

interface RegionRow {
  id: string;
  kind: string;
  text: string | null;
  structure_json: string | null;
  parent_region_id: string | null;
}

export function candidatesFromRegions(rows: RegionRow[]): Candidate[] {
  const out: Candidate[] = [];
  const add = (raw: string, role: Candidate['role'], regionId: string) => {
    const name = clean(raw);
    if (!meaningful(name)) return;
    out.push({ name, lang: scriptOf(name), role, regionId });
  };
  const terms = (text: string, regionId: string) => {
    for (const m of text.matchAll(CAP_TERM)) add(m[1]!, 'candidate_term', regionId);
    for (const m of text.matchAll(CAP_SEQ)) add(m[1]!, 'candidate_term', regionId);
    for (const m of text.matchAll(ABBREV)) if (!SKIP_CAPS.has(m[1]!)) add(m[1]!, 'candidate_term', regionId);
  };
  for (const r of rows) {
    if (r.parent_region_id && r.kind !== 'table_cell') continue;
    const text = stripBidiControls(r.text ?? '').trim();
    if (r.kind === 'heading') {
      // «Acute Appendicitis — التهاب الزائدة الدودية الحاد» → one candidate per language part
      for (const part of text.split(/\s+[—–]\s+|\s+-\s+|:\s+/)) add(part, 'candidate_heading', r.id);
      continue;
    }
    if (r.kind === 'table') {
      const s = fromJson<TableStructure | null>(r.structure_json, null);
      if (s && s.type === 'table') {
        for (const c of s.cells) {
          if (c.header && c.colspan && c.colspan > 1) {
            for (const part of (c.text ?? '').split(/\s+[—–]\s+/)) add(part.replace(/\s*\([^)]*\)/g, ''), 'candidate_table', r.id);
            terms(c.text ?? '', r.id);
          } else if (!c.header && c.c === 0) add(c.text ?? '', 'candidate_table', r.id);
        }
      }
      continue;
    }
    if (r.kind === 'caption') {
      terms(clean(text), r.id);
      continue;
    }
    if (r.kind === 'paragraph' || r.kind === 'list_item' || r.kind === 'text_block') terms(text, r.id);
  }
  // one candidate per (key, region)
  const seen = new Set<string>();
  return out.filter((c) => {
    const k = `${conceptKey(c.name)}|${c.regionId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Replace this version's candidate mentions (idempotent); concepts are shared across lectures by normalized name. */
export function extractConceptCandidates(ctx: AppContext, versionId: string): number {
  const rows = ctx.db.all<RegionRow>(
    `SELECT r.id, r.kind, r.text, r.structure_json, r.parent_region_id FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.kind NOT IN ('header','footer') AND r.status <> 'rejected' ORDER BY p.page_index, r.reading_order`,
    [versionId],
  );
  const cands = candidatesFromRegions(rows).slice(0, 300);
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM concept_mention WHERE version_id = ? AND role LIKE 'candidate%'`, [versionId]);
    const byKey = new Map<string, string>();
    for (const c of cands) {
      const key = conceptKey(c.name);
      if (!key) continue;
      let conceptId = byKey.get(key);
      if (!conceptId) {
        const norm = normalizeForSearch(c.name);
        const existing = ctx.db.get<{ id: string }>(
          `SELECT id FROM concept WHERE ml_norm(coalesce(name_en, '')) = ? OR ml_norm(coalesce(name_ar, '')) = ? ORDER BY origin = 'owner' DESC, created_at LIMIT 1`,
          [norm, norm],
        );
        if (existing) conceptId = existing.id;
        else {
          conceptId = newId(now);
          ctx.db.run(
            `INSERT INTO concept (id, name_en, name_ar, kind, origin, status, created_at, updated_at) VALUES (?, ?, ?, 'candidate', 'auto', 'suggested', ?, ?)`,
            [conceptId, c.lang === 'en' ? c.name : null, c.lang === 'ar' ? c.name : null, now, now],
          );
        }
        byKey.set(key, conceptId);
      }
      ctx.db.run('INSERT INTO concept_mention (id, concept_id, region_id, version_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        newId(now),
        conceptId,
        c.regionId,
        versionId,
        c.role,
        now,
      ]);
    }
    return byKey.size;
  });
}

export interface LectureConcept {
  id: string;
  name: string;
  key: string;
  status: 'suggested' | 'accepted';
  pageIds: string[];
}

/** Concepts mentioned in a lecture version (rejected ones excluded). */
export function lectureConcepts(ctx: AppContext, versionId: string): LectureConcept[] {
  const rows = ctx.db.all<{ id: string; name_en: string | null; name_ar: string | null; status: 'suggested' | 'accepted' | 'rejected'; page_id: string | null }>(
    `SELECT c.id, c.name_en, c.name_ar, c.status, r.page_id FROM concept_mention m
       JOIN concept c ON c.id = m.concept_id JOIN source_region r ON r.id = m.region_id
      WHERE m.version_id = ? AND c.status <> 'rejected'`,
    [versionId],
  );
  const map = new Map<string, LectureConcept>();
  for (const r of rows) {
    const name = r.name_en ?? r.name_ar ?? '';
    const e = map.get(r.id) ?? { id: r.id, name, key: conceptKey(name), status: r.status as 'suggested' | 'accepted', pageIds: [] };
    if (r.page_id && !e.pageIds.includes(r.page_id)) e.pageIds.push(r.page_id);
    map.set(r.id, e);
  }
  return [...map.values()].filter((c) => c.key.length > 0);
}

export function conceptViews(ctx: AppContext, versionIds: string[]): ConceptCandidateView[] {
  if (versionIds.length === 0) return [];
  const rows = ctx.db.all<{
    id: string;
    name_en: string | null;
    name_ar: string | null;
    kind: string | null;
    origin: 'auto' | 'owner';
    status: ConceptCandidateView['status'];
    region_id: string;
    role: string | null;
    page_id: string | null;
    page_index: number | null;
    printed_label: string | null;
    page_kind: string | null;
  }>(
    `SELECT c.id, c.name_en, c.name_ar, c.kind, c.origin, c.status, m.region_id, m.role, p.id AS page_id, p.page_index, p.printed_label, p.kind AS page_kind
       FROM concept_mention m JOIN concept c ON c.id = m.concept_id
       LEFT JOIN source_region r ON r.id = m.region_id LEFT JOIN source_page p ON p.id = r.page_id
      WHERE m.version_id IN (${versionIds.map(() => '?').join(',')})
      ORDER BY c.status = 'rejected', p.page_index, c.created_at`,
    versionIds,
  );
  const map = new Map<string, ConceptCandidateView>();
  for (const r of rows) {
    const name = r.name_en ?? r.name_ar ?? '';
    const v = map.get(r.id) ?? { id: r.id, name, lang: r.name_en ? 'en' : 'ar', kind: r.kind, origin: r.origin, status: r.status, mentions: [] };
    v.mentions.push({
      region_id: r.region_id,
      page_id: r.page_id,
      page_label_ar: r.page_index !== null ? pageLabel({ id: r.page_id ?? '', page_index: r.page_index, printed_label: r.printed_label, kind: r.page_kind ?? 'page' }) : null,
      role: r.role ?? '',
    });
    map.set(r.id, v);
  }
  return [...map.values()];
}

export function decideConcept(ctx: AppContext, id: string, status: 'accepted' | 'rejected'): void {
  const c = ctx.db.get<{ status: string }>('SELECT status FROM concept WHERE id = ?', [id]);
  if (!c) throw new AppError('NOT_FOUND', 'المفهوم المقترح غير موجود.', 404);
  ctx.db.run('UPDATE concept SET status = ?, updated_at = ? WHERE id = ?', [status, ctx.clock.now(), id]);
  ctx.audit.record({ entityType: 'concept', entityId: id, action: status === 'accepted' ? 'accept_concept' : 'reject_concept', before: { status: c.status }, after: { status } });
}
