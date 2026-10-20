// Round 7 H4 (§30): the readable UNVERIFIED draft of a streaming answer. The model writes the GeneratedContent JSON
// ({blocks:[{kind, sentences:[{text, claim}]…}], abstain, coverage_note}); while it streams, this tolerant scanner reads
// the sentence texts written so far out of the PARTIAL JSON — the last one may be unfinished. Nothing else is taken:
// no evidence aliases, no claim types (a draft cites nothing), and model-made «citations» in the text are stripped
// (they are never shown as real ones — G2 / AC-06). The draft is labelled by the caller and never stored.
import type { StudyDraftBlock } from '@medlevo/shared';
import { stripPseudoCitations } from '../evidence/services';

type Frame = { t: 'obj'; key: string | null; expectKey: boolean } | { t: 'arr'; index: number };

/** Sentence texts per block from a partial GeneratedContent (or figure output `{content:{blocks…}}`) JSON text. */
export function draftFromPartialJson(raw: string, opts: { maxBlocks?: number; maxChars?: number } = {}): StudyDraftBlock[] {
  const maxBlocks = opts.maxBlocks ?? 80;
  const maxChars = opts.maxChars ?? 20_000;
  const blocks = new Map<number, StudyDraftBlock>();
  const stack: Frame[] = [];
  let i = 0;
  const n = raw.length;

  /** path of keys / indexes from the root to the current position */
  const path = (): Array<string | number> => {
    const out: Array<string | number> = [];
    for (const f of stack) {
      if (f.t === 'obj') {
        if (f.key !== null) out.push(f.key);
      } else out.push(f.index);
    }
    return out;
  };
  const blockIndexOf = (p: Array<string | number>): number | null => {
    const at = p.indexOf('blocks');
    if (at < 0 || at > 1 || (at === 1 && p[0] !== 'content')) return null;
    const idx = p[at + 1];
    return typeof idx === 'number' ? idx : null;
  };
  const blockAt = (idx: number): StudyDraftBlock => {
    let b = blocks.get(idx);
    if (!b) {
      b = { kind: null, sentences: [] };
      blocks.set(idx, b);
    }
    return b;
  };

  /** reads a JSON string starting at raw[i] === '"'; returns the decoded text and whether it was closed */
  const readString = (): { text: string; closed: boolean } => {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = raw[i]!;
      if (c === '"') {
        i++;
        return { text: out, closed: true };
      }
      if (c === '\\') {
        if (i + 1 >= n) {
          i = n;
          break;
        }
        const e = raw[i + 1]!;
        if (e === 'u') {
          const hex = raw.slice(i + 2, i + 6);
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            i = n;
            break;
          }
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        out += map[e] ?? '';
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return { text: out, closed: false };
  };

  const afterValue = () => {
    const top = stack[stack.length - 1];
    if (top?.t === 'obj') {
      top.key = null;
      top.expectKey = true;
    }
  };

  while (i < n) {
    const c = raw[i]!;
    if (c === '{') {
      stack.push({ t: 'obj', key: null, expectKey: true });
      i++;
    } else if (c === '[') {
      stack.push({ t: 'arr', index: 0 });
      i++;
    } else if (c === '}' || c === ']') {
      stack.pop();
      afterValue();
      i++;
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top?.t === 'arr') top.index++;
      else if (top?.t === 'obj') {
        top.key = null;
        top.expectKey = true;
      }
      i++;
    } else if (c === ':') {
      const top = stack[stack.length - 1];
      if (top?.t === 'obj') top.expectKey = false;
      i++;
    } else if (c === '"') {
      const top = stack[stack.length - 1];
      if (top?.t === 'obj' && top.expectKey) {
        const k = readString();
        top.key = k.text;
        continue;
      }
      const p = path();
      const s = readString();
      const bi = blockIndexOf(p);
      if (bi !== null && bi < maxBlocks) {
        const last = p[p.length - 1];
        if (last === 'kind' && p.length === (p[0] === 'content' ? 4 : 3)) blockAt(bi).kind = s.text;
        else if (last === 'text') {
          const text = stripPseudoCitations(s.text).replace(/\s+/g, ' ').trim();
          if (text) blockAt(bi).sentences.push(text);
        }
      }
      if (s.closed) afterValue();
    } else {
      // numbers, true / false / null, whitespace
      if (!/\s/.test(c)) {
        while (i < n && !/[,}\]\s]/.test(raw[i]!)) i++;
        afterValue();
        continue;
      }
      i++;
    }
  }

  const out = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b).filter((b) => b.sentences.length > 0);
  // bound what one event carries
  let total = 0;
  const bounded: StudyDraftBlock[] = [];
  for (const b of out) {
    const kept: string[] = [];
    for (const s of b.sentences) {
      if (total + s.length > maxChars) break;
      kept.push(s);
      total += s.length;
    }
    if (kept.length) bounded.push({ kind: b.kind, sentences: kept });
    if (total >= maxChars) break;
  }
  return bounded;
}
