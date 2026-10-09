// RichText builders for generated content (§21): runs know their direction; LTR islands (terms, units,
// numbers) are isolated by segmentRuns; claim ids are attached to every run of a claim so the web renders the
// Source Chips right after the claim. No bidi control characters are ever stored.
import { detectDir, segmentRuns, stripBidiControls, type Dir, type Paragraph, type RichText, type Run } from '@medlevo/shared';

export interface SentencePiece {
  text: string;
  claimId?: string | null;
  /** verbatim source text (rendered as original, ev ids attached) */
  originalQuote?: boolean;
  evidenceIds?: string[];
}

function runsFor(piece: SentencePiece, dir: Dir): Run[] {
  const text = stripBidiControls(piece.text).trim();
  if (!text) return [];
  return segmentRuns(text, dir).map((r) => {
    const run: Run = { ...r };
    if (piece.originalQuote) run.kind = 'original_quote';
    if (piece.claimId) run.claim = piece.claimId;
    if (piece.originalQuote && piece.evidenceIds?.length) run.ev = [...piece.evidenceIds];
    return run;
  });
}

/** One paragraph from several sentences (joined with a space run that belongs to no claim). */
export function paragraphOf(pieces: SentencePiece[], kind?: Paragraph['kind'], level?: number): Paragraph | null {
  const kept = pieces.filter((p) => stripBidiControls(p.text).trim());
  if (kept.length === 0) return null;
  const dir = detectDir(kept.map((p) => p.text).join(' '));
  const runs: Run[] = [];
  kept.forEach((p, i) => {
    if (i > 0) runs.push({ t: ' ', dir });
    runs.push(...runsFor(p, dir));
  });
  const para: Paragraph = { dir, runs };
  if (kind) para.kind = kind;
  if (level) para.level = level;
  return para;
}

export function richText(paragraphs: Array<Paragraph | null>): RichText {
  return { v: 1, paragraphs: paragraphs.filter((p): p is Paragraph => p !== null) };
}

/** A server label paragraph (e.g. «مثال تعليمي مولد»), bold, never a claim. */
export function labelParagraph(text: string): Paragraph {
  const dir = detectDir(text);
  return { dir, runs: segmentRuns(text, dir).map((r) => ({ ...r, marks: ['b' as const] })) };
}

/** Plain text of RichText without claim metadata (notes, previews). */
export function stripClaims(rt: RichText): RichText {
  return {
    v: 1,
    paragraphs: rt.paragraphs.map((p) => ({
      ...p,
      runs: p.runs.map((r) => {
        const { claim: _c, ev: _e, ...rest } = r;
        return rest;
      }),
    })),
  };
}

export function claimIdsOf(rt: RichText | null | undefined): string[] {
  if (!rt) return [];
  const out = new Set<string>();
  for (const p of rt.paragraphs) for (const r of p.runs) if (r.claim) out.add(r.claim);
  return [...out];
}

export function shorten(text: string, n: number): string {
  const t = stripBidiControls(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
