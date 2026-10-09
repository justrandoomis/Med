// Offline fallback (§46, §47): search the owner's notes stored on THIS device (Dexie) with the same Arabic
// search key as the server (normalizeForSearch). Sources, questions and generated content need the server.
import { findExactPhrase, findHighlights, makeSnippet, richTextToPlain, searchTokens, type RichText, type SearchResult } from '@medlevo/shared';
import type { NoteRow } from '../../lib/localdb';

interface PageAnchor {
  type?: string;
  source_id?: string;
  version_id?: string;
  page_id?: string;
  page_index?: number;
}

/**
 * Notes whose text contains every query token (word-start match on the normalized key) — or, in exact mode,
 * the phrase exactly as typed (same rule as the server's exact mode).
 */
export function searchNotesLocally(notes: NoteRow[], q: string, limit = 50, mode: 'keyword' | 'exact' = 'keyword'): SearchResult[] {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return [];
  const out: SearchResult[] = [];
  for (const n of notes) {
    if (n.deletedAt) continue;
    const text = [n.title ?? '', richTextToPlain(n.body as RichText)].filter(Boolean).join('\n');
    if (!text) continue;
    const exact = mode === 'exact' ? findExactPhrase(text, q) : null;
    if (exact ? exact.length === 0 : !tokens.every((t) => findHighlights(text, [t], { prefix: true }).length > 0)) continue;
    const anchor = (n.anchor ?? null) as PageAnchor | null;
    const page = anchor?.type === 'page' && anchor.source_id ? anchor : null;
    out.push({
      type: 'notes',
      id: n.id,
      title: n.title?.trim() || 'ملاحظة',
      snippet: makeSnippet(text, exact ?? findHighlights(text, tokens, { prefix: true })),
      location: page
        ? { source_id: page.source_id!, version_id: page.version_id ?? null, page_id: page.page_id ?? null, page_index: page.page_index ?? null, page_label_ar: null, region_id: null }
        : null,
      origin: n.origin === 'ai_answer' ? 'generated' : n.origin === 'handwriting_recognition' ? 'recognized' : 'owner_note',
      source_type: null,
      source_title: null,
      is_evidence: false,
    });
    if (out.length >= limit) break;
  }
  return out;
}
