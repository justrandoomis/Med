// Order-preserving old ↔ new page map between two versions (ARCHITECTURE_DELTA §6.2, PRD AOS-3.12, Scenario 4).
//
// 1. Candidates: pages with the same normalised text hash, MinHash Jaccard ≥ 0.85, or — for pages without text — a
//    dHash distance ≤ 6/64 (found through a hash index and MinHash bands, never by comparing every pair blindly).
// 2. Alignment: the maximum-weight common subsequence over page order (weighted LIS over the sparse candidate pairs),
//    so inserted pages, removed pages and moved blocks resolve to ONE counterpart each and the map never reorders pages.
// 3. Between two aligned pairs, an equal number of old and new pages are paired as «changed» (uncertain); otherwise the
//    most similar pairs (≥ 0.3) are paired in order and the rest are «removed» / «inserted». A page whose identical
//    copy sits elsewhere (crossing the order) is «moved» (uncertain). A page with two near-equal candidates inside the
//    same gap is uncertain.
// 4. Status: `safe` (+ `layout_safe` when the text-region geometry, or the image, is the same) or `uncertain` / `none`.
//    The owner's decisions (`confirmed`, `rejected`) are kept across recomputations and constrain the alignment: a
//    decided page never gets an automatic counterpart, and a confirmed pair that crosses another confirmed pair is
//    kept as the owner set it (review fix; `pm2`).
// 5. A page with little text is identified by its picture: equal short captions on different pictures are not «safe».
//
// THE SERVICE OTHER TRACKS CALL: `getPageMap(ctx, fromVersionId, toVersionId)` (P1-T2 step 3 `reanchor_copy`), returning
// the stable `VersionPageMap` of packages/shared/src/academic/versions.ts. Thresholds are versioned in `PAGE_MAP_ALGO`;
// they are starting points tuned on the labelled TEST FIXTURES only, not measured on real course files.
import {
  emptyChangeCounts,
  type InsertedPage,
  type PageChangeKind,
  type PageFingerprintInput,
  type PageMapEntry,
  type PageMapMethod,
  type PageMapStatus,
  type VersionPageMap,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { detectTools } from '../processing/tools';
import { FINGERPRINT_ALGO, fingerprintsComplete, fingerprintVersion, hammingHex, MIN_TEXT_CHARS, minhashSimilarity, readFingerprints } from '../processing/fingerprint';

export const THRESHOLDS = {
  /** MinHash Jaccard for a «same page» candidate */
  jaccardSafe: 0.85,
  /** dHash Hamming distance (of 64) for pages without text */
  dhashSafe: 6,
  /** minimum similarity to pair two pages inside a gap as «changed» when the gap sizes differ */
  low: 0.3,
  /** two candidates closer than this are «near-equal» */
  near: 0.02,
} as const;

export const PAGE_MAP_ALGO = `pm2:j${THRESHOLDS.jaccardSafe}:d${THRESHOLDS.dhashSafe}:low${THRESHOLDS.low}|${FINGERPRINT_ALGO}`;

/** A fixed owner decision the alignment must respect. */
export interface PageDecision {
  from_page_id: string;
  status: 'confirmed' | 'rejected';
  to_page_id: string | null;
}

export interface DraftEntry {
  from: PageFingerprintInput;
  to: PageFingerprintInput | null;
  status: PageMapStatus;
  method: PageMapMethod;
  layout_safe: boolean;
  text_score: number | null;
  image_distance: number | null;
  /** set by the alignment: this pair crosses the page order of the aligned pairs */
  moved?: boolean;
  decided_by: 'auto' | 'owner' | 'moderator';
}

export interface AlignResult {
  entries: DraftEntry[];
  inserted: PageFingerprintInput[];
}

const hasText = (p: PageFingerprintInput) => p.text_len >= MIN_TEXT_CHARS && !!p.minhash;

interface Sim {
  score: number;
  method: PageMapMethod;
  text_score: number | null;
  image_distance: number | null;
  identical: boolean;
}

/** How alike two pages are (0 = no evidence); `safe` says whether it reaches a candidate threshold. */
export function pageSimilarity(a: PageFingerprintInput, b: PageFingerprintInput): Sim & { safe: boolean } {
  const image_distance = a.dhash && b.dhash ? hammingHex(a.dhash, b.dhash) : null;
  // (review) a page with little text is identified by its picture: the same short caption («Figure 1», «Case 2») on a
  // different picture is NOT the same page — the images decide whenever both were rendered
  const pictureDiffers = (!hasText(a) || !hasText(b)) && image_distance !== null && image_distance > THRESHOLDS.dhashSafe;
  if (a.text_norm_hash && a.text_norm_hash === b.text_norm_hash && !pictureDiffers) return { score: 1, method: 'identical', text_score: 1, image_distance, identical: true, safe: true };
  if (hasText(a) && hasText(b)) {
    const j = minhashSimilarity(a.minhash!, b.minhash!);
    return { score: j, method: 'text_similarity', text_score: j, image_distance, identical: false, safe: j >= THRESHOLDS.jaccardSafe };
  }
  if (!hasText(a) && !hasText(b) && image_distance !== null) {
    const s = 1 - image_distance / 64;
    return { score: s, method: 'image_similarity', text_score: null, image_distance, identical: false, safe: image_distance <= THRESHOLDS.dhashSafe };
  }
  // one page has text and the other does not, or nothing to compare
  const j = a.minhash && b.minhash ? minhashSimilarity(a.minhash, b.minhash) : null;
  return { score: j ?? 0, method: 'text_similarity', text_score: j, image_distance, identical: false, safe: false };
}

/** Same layout: equal text-region geometry, else (no geometry) equal-enough page images. */
function layoutSame(a: PageFingerprintInput, b: PageFingerprintInput, sim: Sim): boolean {
  if (a.layout_hash && b.layout_hash) return a.layout_hash === b.layout_hash;
  if (sim.image_distance !== null) return sim.image_distance <= THRESHOLDS.dhashSafe;
  return false;
}

/** Candidate pairs (sparse): identical text hashes, MinHash band collisions, and image-only pages. */
function candidatePairs(from: PageFingerprintInput[], to: PageFingerprintInput[]): Array<{ i: number; j: number; sim: Sim }> {
  const seen = new Set<number>();
  const out: Array<{ i: number; j: number; sim: Sim }> = [];
  const consider = (i: number, j: number) => {
    const key = i * (to.length + 1) + j;
    if (seen.has(key)) return;
    seen.add(key);
    const s = pageSimilarity(from[i]!, to[j]!);
    if (s.safe) out.push({ i, j, sim: s });
  };
  const byHash = new Map<string, number[]>();
  to.forEach((p, j) => {
    if (p.text_norm_hash) byHash.set(p.text_norm_hash, [...(byHash.get(p.text_norm_hash) ?? []), j]);
  });
  // 16 bands × 4 rows: pages with Jaccard ≥ 0.85 share a band with probability > 0.9999
  const BANDS = 16;
  const ROWS = 4;
  const bandKey = (sig: Uint32Array, b: number) => `${b}:${Array.from(sig.subarray(b * ROWS, b * ROWS + ROWS)).join(',')}`;
  const byBand = new Map<string, number[]>();
  to.forEach((p, j) => {
    if (!hasText(p)) return;
    for (let b = 0; b < BANDS; b++) {
      const k = bandKey(p.minhash!, b);
      byBand.set(k, [...(byBand.get(k) ?? []), j]);
    }
  });
  const imageOnlyTo = to.map((p, j) => (!hasText(p) && p.dhash ? j : -1)).filter((j) => j >= 0);
  from.forEach((p, i) => {
    if (p.text_norm_hash) for (const j of byHash.get(p.text_norm_hash) ?? []) consider(i, j);
    if (hasText(p)) {
      for (let b = 0; b < BANDS; b++) for (const j of byBand.get(bandKey(p.minhash!, b)) ?? []) consider(i, j);
    } else if (p.dhash) {
      for (const j of imageOnlyTo) consider(i, j);
    }
  });
  return out;
}

/** Maximum-weight strictly increasing (in both orders) subsequence of candidate pairs. */
function heaviestChain(pairs: Array<{ i: number; j: number; w: number }>, m: number): number[] {
  const order = pairs.map((_, k) => k).sort((a, b) => pairs[a]!.i - pairs[b]!.i || pairs[b]!.j - pairs[a]!.j);
  // Fenwick tree over j (1-based) of the best chain value ending at a pair with that j, and the pair index
  const treeVal = new Float64Array(m + 1);
  const treeIdx = new Int32Array(m + 1).fill(-1);
  const best = new Float64Array(pairs.length);
  const prev = new Int32Array(pairs.length).fill(-1);
  const query = (j: number): [number, number] => {
    let v = 0;
    let idx = -1;
    for (let x = j; x > 0; x -= x & -x) {
      if (treeVal[x]! > v) {
        v = treeVal[x]!;
        idx = treeIdx[x]!;
      }
    }
    return [v, idx];
  };
  const update = (j: number, v: number, idx: number) => {
    for (let x = j; x <= m; x += x & -x) {
      if (v > treeVal[x]!) {
        treeVal[x] = v;
        treeIdx[x] = idx;
      }
    }
  };
  let top = -1;
  let topVal = 0;
  for (const k of order) {
    const p = pairs[k]!;
    const [v, idx] = query(p.j); // pairs with j' < p.j (1-based p.j + 1 - 1)
    best[k] = v + p.w;
    prev[k] = idx;
    update(p.j + 1, best[k]!, k);
    if (best[k]! > topVal) {
      topVal = best[k]!;
      top = k;
    }
  }
  const chain: number[] = [];
  for (let k = top; k !== -1; k = prev[k]!) chain.push(k);
  return chain.reverse();
}

/**
 * The pure page matcher. `from` and `to` are the pages of the two versions in page order. Owner decisions are fixed:
 * a confirmed pair is always kept (an anchor of the order when it does not cross another confirmed pair), a rejected
 * page has no counterpart, and no decided page ever gets an automatic counterpart.
 */
export function alignPages(from: PageFingerprintInput[], to: PageFingerprintInput[], decisions: readonly PageDecision[] = []): AlignResult {
  const toIndex = new Map(to.map((p, j) => [p.page_id, j]));
  const fromIndex = new Map(from.map((p, i) => [p.page_id, i]));
  const decided = new Map(decisions.filter((d) => fromIndex.has(d.from_page_id)).map((d) => [d.from_page_id, d]));
  // (review) EVERY page with a human decision is fixed: it never gets an automatic counterpart (its stored row is the
  // owner's), even when its confirmed page crosses another confirmed pair or no longer exists. Confirmed new pages are
  // taken out of the automatic candidates, so no other old page can point at them.
  const decidedFrom = new Set([...decided.keys()].map((id) => fromIndex.get(id)!));
  const confirmed: Array<{ i: number; j: number }> = [];
  const confirmedTo = new Set<number>();
  for (const d of decided.values()) {
    if (d.status !== 'confirmed' || !d.to_page_id || !toIndex.has(d.to_page_id)) continue;
    const j = toIndex.get(d.to_page_id)!;
    if (confirmedTo.has(j)) continue; // one old page per new page (decidePage keeps it so; stale rows are ignored)
    confirmedTo.add(j);
    confirmed.push({ i: fromIndex.get(d.from_page_id)!, j });
  }

  const cands = candidatePairs(from, to).filter((c) => !decidedFrom.has(c.i) && !confirmedTo.has(c.j));
  const candsOf = new Map<number, typeof cands>();
  for (const c of cands) {
    const list = candsOf.get(c.i);
    if (list) list.push(c);
    else candsOf.set(c.i, [c]);
  }
  const pairs: Array<{ i: number; j: number; w: number; sim: Sim; fixed: boolean }> = cands.map((c) => ({ ...c, w: c.sim.score, fixed: false }));
  // a confirmed pair outweighs any number of automatic ones
  for (const { i, j } of confirmed) pairs.push({ i, j, w: 10_000, sim: { ...pageSimilarity(from[i]!, to[j]!) }, fixed: true });
  const chain = heaviestChain(pairs, to.length).map((k) => pairs[k]!);

  const entries: Array<DraftEntry | null> = from.map(() => null);
  const usedTo = new Set<number>();
  const mk = (i: number, j: number | null, sim: Sim | null, status: PageMapStatus, extra: Partial<DraftEntry> = {}): DraftEntry => ({
    from: from[i]!,
    to: j === null ? null : to[j]!,
    status,
    method: sim?.method ?? 'text_similarity',
    layout_safe: false,
    text_score: sim?.text_score ?? null,
    image_distance: sim?.image_distance ?? null,
    decided_by: 'auto',
    ...extra,
  });
  for (const c of chain) {
    const sim = c.sim;
    if (c.fixed) {
      entries[c.i] = mk(c.i, c.j, sim, 'confirmed', { method: 'owner', layout_safe: layoutSame(from[c.i]!, to[c.j]!, sim), decided_by: 'owner' });
    } else {
      entries[c.i] = mk(c.i, c.j, sim, 'safe', { layout_safe: sim.method === 'image_similarity' ? true : layoutSame(from[c.i]!, to[c.j]!, sim) });
    }
    usedTo.add(c.j);
  }
  // confirmed pairs the order-preserving chain could not hold (they cross another confirmed pair): still the owner's
  for (const { i, j } of confirmed) {
    if (entries[i]) continue;
    const sim = pageSimilarity(from[i]!, to[j]!);
    entries[i] = mk(i, j, sim, 'confirmed', { method: 'owner', layout_safe: layoutSame(from[i]!, to[j]!, sim), decided_by: 'owner' });
    usedTo.add(j);
  }

  // near-equal alternatives inside the same gap → uncertain (the order alone does not decide)
  const anchors = chain.map((c) => ({ i: c.i, j: c.j }));
  for (let a = 0; a < chain.length; a++) {
    const c = chain[a]!;
    if (c.fixed) continue;
    const lo = a > 0 ? anchors[a - 1]!.j : -1;
    const hi = a + 1 < anchors.length ? anchors[a + 1]!.j : to.length;
    const alt = (candsOf.get(c.i) ?? []).some((o) => o.j !== c.j && o.j > lo && o.j < hi && Math.abs(o.sim.score - c.sim.score) <= THRESHOLDS.near);
    if (alt) entries[c.i] = { ...entries[c.i]!, status: 'uncertain', layout_safe: false };
  }

  // gaps between consecutive anchors
  const bounds = [{ i: -1, j: -1 }, ...anchors, { i: from.length, j: to.length }];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const oldGap: number[] = [];
    const newGap: number[] = [];
    for (let i = bounds[g]!.i + 1; i < bounds[g + 1]!.i; i++) if (!entries[i] && !decidedFrom.has(i)) oldGap.push(i);
    for (let j = bounds[g]!.j + 1; j < bounds[g + 1]!.j; j++) if (!usedTo.has(j)) newGap.push(j);
    if (oldGap.length === 0 || newGap.length === 0) continue;
    if (oldGap.length === newGap.length) {
      oldGap.forEach((i, k) => {
        const j = newGap[k]!;
        entries[i] = mk(i, j, pageSimilarity(from[i]!, to[j]!), 'uncertain');
        usedTo.add(j);
      });
      continue;
    }
    // order-preserving best pairs inside the gap (small: an O(a·b) table)
    const A = oldGap.length;
    const B = newGap.length;
    const sims = oldGap.map((i) => newGap.map((j) => pageSimilarity(from[i]!, to[j]!)));
    const dp: number[][] = Array.from({ length: A + 1 }, () => new Array<number>(B + 1).fill(0));
    for (let x = A - 1; x >= 0; x--) {
      for (let y = B - 1; y >= 0; y--) {
        const s = sims[x]![y]!.score;
        dp[x]![y] = Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!, s >= THRESHOLDS.low ? s + dp[x + 1]![y + 1]! : 0);
      }
    }
    let x = 0;
    let y = 0;
    while (x < A && y < B) {
      const s = sims[x]![y]!.score;
      if (s >= THRESHOLDS.low && dp[x]![y] === s + dp[x + 1]![y + 1]!) {
        entries[oldGap[x]!] = mk(oldGap[x]!, newGap[y]!, sims[x]![y]!, 'uncertain');
        usedTo.add(newGap[y]!);
        x++;
        y++;
      } else if (dp[x]![y] === dp[x + 1]![y]) x++;
      else y++;
    }
  }

  // moved: a page without a counterpart whose identical (or near-identical) copy is a still unused new page
  for (let i = 0; i < from.length; i++) {
    if (entries[i] || decidedFrom.has(i)) continue;
    const c = (candsOf.get(i) ?? []).filter((o) => !usedTo.has(o.j)).sort((a, b) => b.sim.score - a.sim.score)[0];
    if (c) {
      entries[i] = mk(i, c.j, c.sim, 'uncertain', { moved: true });
      usedTo.add(c.j);
    }
  }

  const out: DraftEntry[] = entries.map((e, i) => {
    if (e) return e;
    const d = decided.get(from[i]!.page_id);
    if (d?.status === 'rejected') return mk(i, null, null, 'rejected', { method: 'owner', decided_by: 'owner' });
    // a confirmed decision whose new page no longer exists: no counterpart, and still the owner's row (never replaced)
    if (d) return mk(i, null, null, 'none', { method: 'owner', decided_by: 'owner' });
    return mk(i, null, null, 'none');
  });
  return { entries: out, inserted: to.filter((_, j) => !usedTo.has(j)) };
}

/** What happened to each page, derived from the entries (also for rows read back from the database). */
export function changeOf(e: { status: PageMapStatus; to_page_id: string | null; method: PageMapMethod; text_score: number | null; image_distance?: number | null; layout_safe: boolean; moved?: boolean }): PageChangeKind {
  if (!e.to_page_id || e.status === 'none' || e.status === 'rejected') return 'removed';
  if (e.moved) return 'moved';
  // (review) a page compared by its picture is «unchanged» only when the pictures are close; an uncertain pair of two
  // different pictures is «changed», never «لم تتغير»
  const sameImage = e.method === 'image_similarity' && e.image_distance !== null && e.image_distance !== undefined && e.image_distance <= THRESHOLDS.dhashSafe;
  const identical = e.method === 'identical' || sameImage || (e.text_score !== null && e.text_score >= 0.999);
  if (e.status === 'safe' || e.status === 'confirmed') return identical ? 'unchanged' : 'edited';
  // uncertain: an ambiguous duplicate is unchanged (it only needs confirming); a rewritten page is changed
  return identical ? 'unchanged' : 'changed';
}

/** Marks entries whose target crosses the order of the safe/confirmed entries (used for rows read back). */
function markMoved<T extends { from_page_index: number; to_page_index: number | null; status: PageMapStatus; moved?: boolean }>(entries: T[]): T[] {
  const anchors = entries.filter((e) => e.to_page_index !== null && (e.status === 'safe' || e.status === 'confirmed'));
  return entries.map((e) => {
    if (e.status !== 'uncertain' || e.to_page_index === null) return e;
    const before = anchors.filter((a) => a.from_page_index < e.from_page_index).at(-1);
    const after = anchors.find((a) => a.from_page_index > e.from_page_index);
    const crosses = (before && before.to_page_index! > e.to_page_index) || (after && after.to_page_index! < e.to_page_index);
    return crosses ? { ...e, moved: true } : e;
  });
}

// ───────────────────────────── persistence ─────────────────────────────
interface MapRow {
  from_page_id: string;
  to_page_id: string | null;
  method: PageMapMethod;
  text_score: number | null;
  image_distance: number | null;
  layout_safe: number;
  status: PageMapStatus;
}

function versionPagesExist(ctx: AppContext, versionId: string): boolean {
  return !!ctx.db.get('SELECT 1 AS x FROM source_version WHERE id = ?', [versionId]);
}

/** Human decisions stored for this pair (kept across recomputations). */
export function decisionsOf(ctx: AppContext, fromVersionId: string, toVersionId: string): PageDecision[] {
  return ctx.db.all<PageDecision>(
    `SELECT from_page_id, status, to_page_id FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? AND status IN ('confirmed','rejected')`,
    [fromVersionId, toVersionId],
  );
}

/** Compute the map from stored fingerprints and store it (synchronous, cheap: no rendering). */
export function computeAndStorePageMap(ctx: AppContext, fromVersionId: string, toVersionId: string): VersionPageMap {
  if (fromVersionId === toVersionId) throw new AppError('BAD_REQUEST', 'لا يمكن مقارنة نسخة بنفسها.', 400);
  const from = readFingerprints(ctx, fromVersionId);
  const to = readFingerprints(ctx, toVersionId);
  const res = alignPages(from, to, decisionsOf(ctx, fromVersionId, toVersionId));
  const now = ctx.clock.now();
  let map: VersionPageMap | null = null;
  ctx.db.tx(() => {
    ctx.db.run(`DELETE FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? AND status NOT IN ('confirmed','rejected')`, [fromVersionId, toVersionId]);
    for (const e of res.entries) {
      if (e.decided_by !== 'auto') continue; // the human row is already there
      ctx.db.run(
        // a human row for the same page always wins (never overwritten, never a constraint failure)
        `INSERT INTO version_page_map (from_version_id, to_version_id, from_page_id, to_page_id, method, text_score, image_distance, layout_safe, status, algo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(from_version_id, to_version_id, from_page_id) DO NOTHING`,
        [fromVersionId, toVersionId, e.from.page_id, e.to?.page_id ?? null, e.method, e.text_score, e.image_distance, e.layout_safe ? 1 : 0, e.status, PAGE_MAP_ALGO, now],
      );
    }
    ctx.db.run(
      `INSERT INTO page_map_run (from_version_id, to_version_id, status, algo, counts_json, reason, computed_at) VALUES (?, ?, 'ready', ?, NULL, NULL, ?)
       ON CONFLICT(from_version_id, to_version_id) DO UPDATE SET status = 'ready', algo = excluded.algo, reason = NULL, computed_at = excluded.computed_at`,
      [fromVersionId, toVersionId, PAGE_MAP_ALGO, now],
    );
    map = readPageMap(ctx, fromVersionId, toVersionId)!;
    ctx.db.run('UPDATE page_map_run SET counts_json = ? WHERE from_version_id = ? AND to_version_id = ?', [JSON.stringify(map.counts), fromVersionId, toVersionId]);
  });
  return map!;
}

/** The stored map is current: computed with this algorithm, after the newest fingerprint of either version. */
export function pageMapIsCurrent(ctx: AppContext, fromVersionId: string, toVersionId: string): boolean {
  const run = ctx.db.get<{ algo: string; computed_at: number; status: string }>('SELECT algo, computed_at, status FROM page_map_run WHERE from_version_id = ? AND to_version_id = ?', [fromVersionId, toVersionId]);
  if (!run || run.status !== 'ready' || run.algo !== PAGE_MAP_ALGO) return false;
  const newest = ctx.db.get<{ t: number | null }>('SELECT MAX(created_at) AS t FROM page_fingerprint WHERE version_id IN (?, ?)', [fromVersionId, toVersionId])?.t ?? 0;
  return newest <= run.computed_at;
}

/** Read a stored map (null: never computed). */
export function readPageMap(ctx: AppContext, fromVersionId: string, toVersionId: string): VersionPageMap | null {
  const run = ctx.db.get<{ algo: string; computed_at: number }>(`SELECT algo, computed_at FROM page_map_run WHERE from_version_id = ? AND to_version_id = ? AND status = 'ready'`, [fromVersionId, toVersionId]);
  if (!run) return null;
  const fromPages = ctx.db.all<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE version_id = ? ORDER BY page_index', [fromVersionId]);
  const toPages = ctx.db.all<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE version_id = ? ORDER BY page_index', [toVersionId]);
  const toIdx = new Map(toPages.map((p) => [p.id, p.page_index]));
  const rows = new Map(
    ctx.db
      .all<MapRow>('SELECT from_page_id, to_page_id, method, text_score, image_distance, layout_safe, status FROM version_page_map WHERE from_version_id = ? AND to_version_id = ?', [fromVersionId, toVersionId])
      .map((r) => [r.from_page_id, r]),
  );
  const raw = fromPages.map((p) => {
    const r = rows.get(p.id);
    const toId = r?.to_page_id && toIdx.has(r.to_page_id) ? r.to_page_id : null;
    return {
      from_page_id: p.id,
      from_page_index: p.page_index,
      to_page_id: toId,
      to_page_index: toId ? toIdx.get(toId)! : null,
      status: (r ? (toId || r.status === 'rejected' || r.status === 'none' ? r.status : 'none') : 'none') as PageMapStatus,
      method: (r?.method ?? 'text_similarity') as PageMapMethod,
      layout_safe: r?.layout_safe === 1,
      text_score: r?.text_score ?? null,
      image_distance: r?.image_distance ?? null,
      decided_by: (r && (r.status === 'confirmed' || r.status === 'rejected') ? (r.method === 'moderator' ? 'moderator' : 'owner') : 'auto') as PageMapEntry['decided_by'],
      moved: false as boolean | undefined,
    };
  });
  const entries: PageMapEntry[] = markMoved(raw).map(({ moved, ...e }) => ({ ...e, change: changeOf({ ...e, moved }) }));
  const used = new Set(entries.map((e) => e.to_page_id).filter(Boolean));
  const inserted: InsertedPage[] = toPages.filter((p) => !used.has(p.id)).map((p) => ({ to_page_id: p.id, to_page_index: p.page_index }));
  const counts = emptyChangeCounts();
  for (const e of entries) counts[e.change]++;
  counts.inserted = inserted.length;
  return { from_version_id: fromVersionId, to_version_id: toVersionId, algo: run.algo, computed_at: run.computed_at, entries, inserted, counts };
}

/** Make sure both versions carry current fingerprints (renders only pages without text; may take seconds). */
export async function ensureFingerprints(ctx: AppContext, versionIds: string[], signal?: AbortSignal): Promise<void> {
  const pdftoppm = detectTools().pdftoppm;
  for (const v of versionIds) {
    if (!fingerprintsComplete(ctx, v)) await fingerprintVersion(ctx, v, { pdftoppm, signal });
  }
}

/**
 * THE page-map service (stable; P1-T2 step 3 `reanchor_copy` calls it): the order-preserving map from `fromVersionId`
 * to `toVersionId`, computing fingerprints and the map when missing or stale, and keeping the owner's decisions.
 * Never moves, copies or deletes anything else. Throws NOT_FOUND for an unknown version.
 *
 * Use `isCopyTarget(entry)` (shared) to decide whether an item of `entry.from_page_id` may be copied to
 * `entry.to_page_id`; coordinate-anchored items additionally need `entry.layout_safe` or `entry.status === 'confirmed'`.
 */
export async function getPageMap(ctx: AppContext, fromVersionId: string, toVersionId: string, opts: { signal?: AbortSignal } = {}): Promise<VersionPageMap> {
  if (!versionPagesExist(ctx, fromVersionId) || !versionPagesExist(ctx, toVersionId)) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  await ensureFingerprints(ctx, [fromVersionId, toVersionId], opts.signal);
  if (pageMapIsCurrent(ctx, fromVersionId, toVersionId)) return readPageMap(ctx, fromVersionId, toVersionId)!;
  return computeAndStorePageMap(ctx, fromVersionId, toVersionId);
}

/** Store an owner's decision on one page of a map, then recompute the automatic rest around it. */
export function decidePage(
  ctx: AppContext,
  fromVersionId: string,
  toVersionId: string,
  d: { from_page_id: string; action: 'confirm' | 'reject' | 'reset'; to_page_id?: string },
): VersionPageMap {
  const fromPage = ctx.db.get<{ id: string }>('SELECT id FROM source_page WHERE id = ? AND version_id = ?', [d.from_page_id, fromVersionId]);
  if (!fromPage) throw new AppError('NOT_FOUND', 'الصفحة ليست من النسخة السابقة.', 404);
  const current = readPageMap(ctx, fromVersionId, toVersionId);
  if (!current) throw new AppError('CONFLICT', 'لم تُحسب مطابقة الصفحات بين هاتين النسختين بعد. انتظر انتهاء التحليل ثم أعد المحاولة.', 409);
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? AND from_page_id = ?', [fromVersionId, toVersionId, d.from_page_id]);
    if (d.action === 'reset') return;
    let to: string | null = null;
    if (d.action === 'confirm') {
      to = d.to_page_id ?? current.entries.find((e) => e.from_page_id === d.from_page_id)?.to_page_id ?? null;
      if (!to) throw new AppError('VALIDATION_FAILED', 'اختر الصفحة المقابلة في النسخة الجديدة.', 400);
      if (!ctx.db.get('SELECT 1 AS x FROM source_page WHERE id = ? AND version_id = ?', [to, toVersionId])) throw new AppError('NOT_FOUND', 'الصفحة المختارة ليست من النسخة الجديدة.', 404);
      // one old page per new page: a new page already confirmed for another old page is released
      ctx.db.run(`DELETE FROM version_page_map WHERE from_version_id = ? AND to_version_id = ? AND to_page_id = ? AND status = 'confirmed'`, [fromVersionId, toVersionId, to]);
    }
    const auto = current.entries.find((e) => e.from_page_id === d.from_page_id);
    ctx.db.run(
      `INSERT INTO version_page_map (from_version_id, to_version_id, from_page_id, to_page_id, method, text_score, image_distance, layout_safe, status, algo, created_at)
       VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?)`,
      [fromVersionId, toVersionId, d.from_page_id, to, auto?.to_page_id === to ? auto.text_score : null, auto?.to_page_id === to ? auto.image_distance : null, auto?.to_page_id === to && auto.layout_safe ? 1 : 0, d.action === 'confirm' ? 'confirmed' : 'rejected', PAGE_MAP_ALGO, now],
    );
    ctx.audit.record({
      entityType: 'source_version',
      entityId: toVersionId,
      action: 'page_map_decision',
      summary: d.action === 'confirm' ? 'أكّدت مقابلة صفحة بين نسختين' : 'رفضت مقابلة صفحة بين نسختين',
      after: { from_version_id: fromVersionId, from_page_id: d.from_page_id, to_page_id: to, decision: d.action },
    });
  });
  return computeAndStorePageMap(ctx, fromVersionId, toVersionId);
}
