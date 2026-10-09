// Owner terminology in prompts (§21). The dictionary itself (medical_term) is owned by the evidence module
// (CRUD at /api/evidence/terms, used by retrieval/search expansion); this module only READS it to tell the
// generator the owner's preferred Arabic renderings of terms that occur in the evidence. Source text is never edited.
import { normalizeForSearch } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';

export interface PromptTerm {
  term_en: string;
  preferred_ar: string | null;
  abbreviation: string | null;
}

/** Dictionary entries whose English term, abbreviation or synonym occurs in `texts` (max 40). */
export function termsForTexts(ctx: AppContext, texts: string[]): PromptTerm[] {
  const hay = ` ${normalizeForSearch(texts.join('\n')).replace(/\s+/g, ' ')} `;
  if (hay.trim().length === 0) return [];
  const rows = ctx.db.all<{ term_en: string; abbreviation: string | null; synonyms_json: string; owner_preferred_ar: string | null; accepted_translation_ar: string | null }>(
    'SELECT term_en, abbreviation, synonyms_json, owner_preferred_ar, accepted_translation_ar FROM medical_term ORDER BY term_en COLLATE NOCASE LIMIT 5000',
  );
  const out: PromptTerm[] = [];
  for (const r of rows) {
    const variants = [r.term_en, r.abbreviation, ...(fromJson<string[]>(r.synonyms_json, []) ?? [])].filter((v): v is string => !!v && v.trim().length > 1);
    const hit = variants.some((v) => hay.includes(` ${normalizeForSearch(v).replace(/\s+/g, ' ').trim()} `));
    if (!hit) continue;
    const preferred = r.owner_preferred_ar ?? r.accepted_translation_ar;
    if (!preferred && !r.abbreviation) continue;
    out.push({ term_en: r.term_en, preferred_ar: preferred, abbreviation: r.abbreviation });
    if (out.length >= 40) break;
  }
  return out;
}
