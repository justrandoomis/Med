// Concept identity (Course Brain). A concept is found by any of its names: name_en / name_ar, an alias (old names
// after an owner rename, names of concepts merged into it) — and a merged concept always resolves to the concept
// that absorbed it. Both extractors (questions' candidates and the brain's stated mentions) go through here, so an
// owner rename or merge is never undone by a later extraction (§16: «correctable suggestions»).
import { normalizeForSearch, stripBidiControls } from '@medlevo/shared';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { contentTokens } from '../questions/text';

/** Search key of a concept name (Arabic/Latin normalized, lowercased, whitespace collapsed). */
export function nameNorm(name: string): string {
  return normalizeForSearch(stripBidiControls(name)).replace(/\s+/g, ' ').trim();
}

/** Stemmed key (plurals / possessives / Arabic article ignored) — «pregnancy tests» = «pregnancy test». */
export function nameKey(name: string): string {
  return contentTokens(name)
    .map((t) => t.stem)
    .join(' ');
}

/** Follow merged_into_id to the live concept (bounded; a broken chain stops at the last existing row). */
export function resolveConceptIdDb(db: Pick<Db, 'get'>, id: string): string {
  let cur = id;
  for (let i = 0; i < 20; i++) {
    const r = db.get<{ merged_into_id: string | null }>('SELECT merged_into_id FROM concept WHERE id = ?', [cur]);
    if (!r || !r.merged_into_id) return cur;
    cur = r.merged_into_id;
  }
  return cur;
}

export function resolveConceptId(ctx: AppContext, id: string): string {
  return resolveConceptIdDb(ctx.db, id);
}

/** One lookup by name (aliases first, then names; merged concepts resolve to their target). */
export function findConceptByName(ctx: AppContext, name: string): { id: string } | null {
  const norm = nameNorm(name);
  if (!norm) return null;
  const alias = ctx.db.get<{ concept_id: string }>('SELECT concept_id FROM concept_alias WHERE alias_norm = ?', [norm]);
  if (alias) return { id: resolveConceptId(ctx, alias.concept_id) };
  const row = ctx.db.get<{ id: string }>(
    `SELECT id FROM concept WHERE ml_norm(coalesce(name_en, '')) = ? OR ml_norm(coalesce(name_ar, '')) = ?
      ORDER BY merged_into_id IS NULL DESC, name_origin = 'owner' DESC, origin = 'owner' DESC, created_at LIMIT 1`,
    [norm, norm],
  );
  return row ? { id: resolveConceptId(ctx, row.id) } : null;
}

/**
 * In-memory index of every concept name for one extraction run (one query instead of one per name). Lookups by
 * the normalized name first, then by the stemmed key; merged concepts resolve to their target.
 */
export class ConceptIndex {
  private byNorm = new Map<string, string>();
  private byKey = new Map<string, string>();
  private mergedInto = new Map<string, string>();

  constructor(private ctx: AppContext) {
    const rows = ctx.db.all<{ id: string; name_en: string | null; name_ar: string | null; merged_into_id: string | null; name_origin: string; origin: string }>(
      `SELECT id, name_en, name_ar, merged_into_id, name_origin, origin FROM concept
        ORDER BY merged_into_id IS NULL, name_origin = 'owner', origin = 'owner', created_at DESC`,
    );
    // ascending priority: later rows overwrite earlier ones, so live / owner-named / oldest concepts win
    for (const r of rows) {
      if (r.merged_into_id) this.mergedInto.set(r.id, r.merged_into_id);
      for (const n of [r.name_en, r.name_ar]) if (n) this.put(n, r.id);
    }
    for (const a of ctx.db.all<{ concept_id: string; alias: string }>('SELECT concept_id, alias FROM concept_alias ORDER BY created_at DESC')) this.put(a.alias, a.concept_id);
  }

  private put(name: string, id: string): void {
    const n = nameNorm(name);
    if (n) this.byNorm.set(n, id);
    const k = nameKey(name);
    if (k) this.byKey.set(k, id);
  }

  private resolve(id: string): string {
    let cur = id;
    for (let i = 0; i < 20 && this.mergedInto.has(cur); i++) cur = this.mergedInto.get(cur)!;
    return cur;
  }

  find(name: string): string | null {
    const n = nameNorm(name);
    const hit = (n && this.byNorm.get(n)) || this.byKey.get(nameKey(name));
    return hit ? this.resolve(hit) : null;
  }

  /** Register a concept created during the run. */
  add(name: string, id: string): void {
    this.put(name, id);
  }
}
