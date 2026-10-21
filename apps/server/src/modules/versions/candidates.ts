// Link candidates (ARCHITECTURE_DELTA §6.1 «Spotting a likely new version», §6.9 step 1; PRD AOS-3.11, 19H.2, 19H.3).
//
// `matchLinkCandidates` is a PURE service (no database, no I/O): given the fingerprints of one version and of candidate
// versions, it returns the candidates that are the same file (sha256) or share ≥ 60 % of the CANDIDATE's pages through
// the order-preserving page matcher. P1-T5 reuses it to find the official twin of a private lecture inside the caller's
// own vault (the space fingerprints are read through `ctx.dbs`; nothing about the private file leaves the vault).
// The database helpers below only pick which versions are worth comparing in THIS database.
import type { LinkCandidateInput, LinkCandidateView, PageFingerprintInput } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { readFingerprints } from '../processing/fingerprint';
import { alignPages, changeOf } from './pagemap';

/** share of the candidate's pages that must have a safe counterpart (design: ≥ 60 %) */
export const LINK_THRESHOLD = 0.6;

export interface MatchDetails {
  matched: number;
  total: number;
  ratio: number;
  inserted: number;
  removed: number;
  changed: number;
}

/** Page-level comparison of a candidate (old) against the target (new): how many of its pages survive safely. */
export function compareFingerprints(candidate: PageFingerprintInput[], target: PageFingerprintInput[]): MatchDetails {
  const res = alignPages(candidate, target);
  let matched = 0;
  let removed = 0;
  let changed = 0;
  for (const e of res.entries) {
    const change = changeOf({ ...e, to_page_id: e.to?.page_id ?? null });
    if (e.status === 'safe' && e.to) matched++;
    if (change === 'removed') removed++;
    if (change === 'changed' || change === 'moved') changed++;
  }
  const total = candidate.length;
  return { matched, total, ratio: total ? matched / total : 0, inserted: res.inserted.length, removed, changed };
}

/**
 * The candidates that are the same lecture as `target`: identical bytes (sha256), or ≥ `threshold` of the candidate's
 * pages matched safely. Best first (sha256, then the share of matched pages). Pure and deterministic.
 */
export function matchLinkCandidates(target: LinkCandidateInput, candidates: readonly LinkCandidateInput[], threshold = LINK_THRESHOLD): LinkCandidateView[] {
  const out: LinkCandidateView[] = [];
  for (const c of candidates) {
    if (c.version_id === target.version_id) continue;
    if (c.content_hash && c.content_hash === target.content_hash) {
      out.push({
        source_id: c.source_id,
        version_id: c.version_id,
        title: c.title,
        basis: 'sha256',
        matched_pages: c.pages.length,
        total_pages: c.pages.length,
        ratio: 1,
        basis_ar: ['الملف نفسه بايتًا ببايت (البصمة sha256 متطابقة).'],
      });
      continue;
    }
    if (c.pages.length === 0 || target.pages.length === 0) continue;
    const m = compareFingerprints(c.pages, target.pages);
    if (m.ratio < threshold) continue;
    out.push({
      source_id: c.source_id,
      version_id: c.version_id,
      title: c.title,
      basis: 'fingerprints',
      matched_pages: m.matched,
      total_pages: m.total,
      ratio: Math.round(m.ratio * 1000) / 1000,
      basis_ar: [
        `تتطابق ${m.matched} من ${m.total} صفحة (${Math.round(m.ratio * 100)}%) بالنص أو بصورة الصفحة.`,
        ...(m.inserted ? [`صفحات جديدة: ${m.inserted}`] : []),
        ...(m.changed ? [`صفحات تغيّرت: ${m.changed}`] : []),
        ...(m.removed ? [`صفحات حُذفت: ${m.removed}`] : []),
      ],
    });
  }
  return out.sort((a, b) => (a.basis === b.basis ? 0 : a.basis === 'sha256' ? -1 : 1) || b.ratio - a.ratio || b.matched_pages - a.matched_pages || (a.source_id < b.source_id ? -1 : 1));
}

// ───────────────────────────── this database ─────────────────────────────
export function candidateInput(ctx: AppContext, versionId: string): LinkCandidateInput | null {
  const v = ctx.db.get<{ id: string; source_id: string; title: string; content_hash: string }>(
    'SELECT v.id, v.source_id, s.title, v.content_hash FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?',
    [versionId],
  );
  return v ? { source_id: v.source_id, version_id: v.id, title: v.title, content_hash: v.content_hash, pages: readFingerprints(ctx, v.id) } : null;
}

/**
 * Versions worth comparing with `versionId`: the CURRENT (or frozen) version of every other live source that shares
 * at least one page text hash or the file sha256. Bounded; never a scan of every page pair.
 */
export function prefilterCandidates(ctx: AppContext, versionId: string, limit = 25): string[] {
  const rows = ctx.db.all<{ version_id: string; shared: number }>(
    `WITH mine AS (SELECT DISTINCT text_norm_hash AS h FROM page_fingerprint WHERE version_id = ? AND text_norm_hash IS NOT NULL),
          me AS (SELECT source_id, content_hash FROM source_version WHERE id = ?),
          live AS (SELECT s.id AS source_id, COALESCE(s.frozen_version_id, s.current_version_id) AS version_id FROM source s, me
                    WHERE s.deleted_at IS NULL AND s.id <> me.source_id AND COALESCE(s.frozen_version_id, s.current_version_id) IS NOT NULL)
     SELECT l.version_id, (SELECT COUNT(*) FROM page_fingerprint f WHERE f.version_id = l.version_id AND f.text_norm_hash IN (SELECT h FROM mine))
                          + (SELECT COUNT(*) FROM source_version v, me WHERE v.id = l.version_id AND v.content_hash = me.content_hash) * 1000 AS shared
       FROM live l
      WHERE shared > 0
      ORDER BY shared DESC
      LIMIT ?`,
    [versionId, versionId, limit],
  );
  return rows.map((r) => r.version_id);
}

/** Link candidates of one version inside this database (best first). */
export function linkCandidatesFor(ctx: AppContext, versionId: string): LinkCandidateView[] {
  const target = candidateInput(ctx, versionId);
  if (!target) return [];
  const cands = prefilterCandidates(ctx, versionId)
    .map((v) => candidateInput(ctx, v))
    .filter((c): c is LinkCandidateInput => !!c);
  return matchLinkCandidates(target, cands);
}
