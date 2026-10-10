// Card faces rendered on the device (offline) with the same rules as the server's review payload
// (apps/server/src/modules/learning/review.ts → clozeRich): a cloze card hides ONLY its own index on the front
// («[…]» or «[hint]», bold) and reveals it on the back (bold + underlined) followed by «Back Extra»; other indexes
// are shown as plain text. Basic / mistake / occlusion cards show their stored front and back.
import { clozeIndexes, clozeSegments, detectDir, parseRichText, richTextToPlain, segmentRuns, type Paragraph, type RichText, type Run } from '@medlevo/shared';
import type { LocalCardRow } from './store';

function runsFor(text: string, dir: 'rtl' | 'ltr', marks?: Run['marks']): Run[] {
  return segmentRuns(text, dir).map((r) => (marks ? { ...r, marks } : r));
}

/** Cloze text → RichText with the asked index hidden (front) or revealed and emphasized (back). */
export function clozeRich(text: string, index: number, side: 'front' | 'back'): RichText {
  const segs = clozeSegments(text, index, side);
  const paragraphs: Paragraph[] = [];
  let line: Array<{ t: string; role: string }> = [];
  const flush = () => {
    const plain = line.map((s) => s.t).join('');
    if (plain.trim()) {
      const dir = detectDir(plain);
      const runs: Run[] = [];
      for (const s of line) runs.push(...runsFor(s.t, dir, s.role === 'text' ? undefined : s.role === 'blank' ? ['b'] : ['b', 'u']));
      paragraphs.push({ dir, runs });
    }
    line = [];
  };
  for (const s of segs) {
    const parts = s.t.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) flush();
      if (p) line.push({ t: p, role: s.role });
    });
  }
  flush();
  return { v: 1, paragraphs };
}

/** The cloze index a card asks (stored, or the only index of its text). */
export function clozeIndexOf(card: Pick<LocalCardRow, 'kind' | 'front' | 'clozeIndex'>): number | null {
  if (card.kind !== 'cloze') return null;
  if (card.clozeIndex != null) return card.clozeIndex;
  const idx = clozeIndexes(richTextToPlain(parseRichText(card.front)));
  return idx.length === 1 ? idx[0]! : null;
}

export interface CardFaces {
  front: RichText;
  back: RichText;
  /** cloze card whose index cannot be determined (shown as text with a note) */
  clozeProblem: boolean;
}

export function facesOf(card: Pick<LocalCardRow, 'kind' | 'front' | 'back' | 'clozeIndex'>): CardFaces {
  const front = parseRichText(card.front);
  const back = parseRichText(card.back);
  if (card.kind !== 'cloze') return { front, back, clozeProblem: false };
  const idx = clozeIndexOf(card);
  const text = richTextToPlain(front);
  if (idx === null) return { front: clozeRich(text, -1, 'back'), back, clozeProblem: true };
  return { front: clozeRich(text, idx, 'front'), back: { v: 1, paragraphs: [...clozeRich(text, idx, 'back').paragraphs, ...back.paragraphs] }, clozeProblem: false };
}

/** A short plain preview of a card's question (lists). Cloze markers are shown as their answers. */
export function cardPreview(card: Pick<LocalCardRow, 'kind' | 'front' | 'clozeIndex'>, max = 140): string {
  const text = richTextToPlain(parseRichText(card.front));
  const idx = clozeIndexOf(card);
  const shown = card.kind === 'cloze' ? clozeSegments(text, idx ?? -1, 'front').map((s) => s.t).join('') : text;
  const one = shown.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
