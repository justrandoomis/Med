// RichText builders for generated questions (§21): runs carry their direction (LTR islands isolated by
// segmentRuns), and every run of a verified sentence carries its claim id so the web can show evidence chips
// right after the claim. No bidi control characters are stored.
import { detectDir, segmentRuns, stripBidiControls, type Paragraph, type RichText, type Run } from '@medlevo/shared';

export interface Piece {
  text: string;
  claimId?: string | null;
}

export function paragraph(pieces: Piece[]): Paragraph | null {
  const kept = pieces.map((p) => ({ ...p, text: stripBidiControls(p.text).replace(/\s+/g, ' ').trim() })).filter((p) => p.text);
  if (kept.length === 0) return null;
  const dir = detectDir(kept.map((p) => p.text).join(' '));
  const runs: Run[] = [];
  kept.forEach((p, i) => {
    if (i > 0) runs.push({ t: ' ', dir });
    for (const r of segmentRuns(p.text, dir)) runs.push(p.claimId ? { ...r, claim: p.claimId } : r);
  });
  return { dir, runs };
}

export function richText(paragraphs: Array<Paragraph | null>): RichText {
  return { v: 1, paragraphs: paragraphs.filter((p): p is Paragraph => p !== null) };
}

export function claimIdsOf(rt: RichText | null | undefined): string[] {
  const out = new Set<string>();
  for (const p of rt?.paragraphs ?? []) for (const r of p.runs) if (r.claim) out.add(r.claim);
  return [...out];
}

export function shorten(text: string, n: number): string {
  const t = stripBidiControls(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
