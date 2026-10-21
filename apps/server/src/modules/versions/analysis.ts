// The versions module's background analysis of one processed version (job `analyze_version`, enqueued by the processing
// pipeline's follow-up seam, processing/fingerprint.ts). Steps, each independent (a failure in one never hides another):
//   1. page fingerprints (re-made after every processing run);
//   2. lecture identity: number, date, title, subject placement (identity.ts rules);
//   3. page maps: previous version → this one (a replacement), and every stored map involving this version;
//   4. «إصدار جديد من …»: an upload whose pages match ≥ 60 % of another lecture's pages is PROPOSED (never applied).
// Plus the one-time fingerprint backfill of versions processed before this module existed (job `fingerprint_backfill`).
import type { AppContext } from '../../context';
import { detectTools } from '../processing/tools';
import { FINGERPRINT_ALGO, fingerprintsComplete, fingerprintVersion } from '../processing/fingerprint';
import { linkCandidatesFor, LINK_THRESHOLD } from './candidates';
import { analyzeIdentity, proposeNewVersion, type IdentityAnalysis } from './identity';
import { computeAndStorePageMap } from './pagemap';

export const FINGERPRINT_BACKFILL_JOB = 'fingerprint_backfill';

export interface AnalysisOutput {
  version_id: string;
  fingerprints: { pages: number; rendered: number } | null;
  identity: IdentityAnalysis | null;
  page_maps: number;
  new_version_of: { source_id: string; ratio: number } | null;
  warnings: string[];
}

interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  kind: string;
  derived_from_version_id: string | null;
  format: string;
  deleted_at: number | null;
  is_stub: number;
}

export async function runVersionAnalysis(ctx: AppContext, versionId: string, run: { id: string; signal: AbortSignal; progress: (p: { stage: string }) => void }): Promise<AnalysisOutput> {
  const out: AnalysisOutput = { version_id: versionId, fingerprints: null, identity: null, page_maps: 0, new_version_of: null, warnings: [] };
  const v = ctx.db.get<VersionRow>(
    `SELECT v.id, v.source_id, v.version_no, v.kind, v.derived_from_version_id, v.format, s.deleted_at, s.is_stub
       FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?`,
    [versionId],
  );
  if (!v || v.format === 'audio') return out;
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | null> => {
    try {
      run.progress({ stage: name });
      return await fn();
    } catch (e) {
      if (run.signal.aborted) throw e;
      ctx.log.warn({ err: e instanceof Error ? e.message : String(e), versionId, step: name }, 'version analysis step failed');
      out.warnings.push(`${name}: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`);
      return null;
    }
  };

  const fp = await step('fingerprints', () => fingerprintVersion(ctx, versionId, { pdftoppm: detectTools().pdftoppm, signal: run.signal, force: true }));
  out.fingerprints = fp ? { pages: fp.pages, rendered: fp.rendered } : null;
  if (!fp) return out;

  out.identity = await step('identity', () => analyzeIdentity(ctx, v.source_id, versionId, run.id));

  await step('page_maps', () => {
    const pairs = new Set<string>();
    if (v.derived_from_version_id) pairs.add(`${v.derived_from_version_id}|${versionId}`);
    for (const r of ctx.db.all<{ f: string; t: string }>('SELECT from_version_id AS f, to_version_id AS t FROM page_map_run WHERE from_version_id = ? OR to_version_id = ?', [versionId, versionId])) {
      pairs.add(`${r.f}|${r.t}`);
    }
    for (const p of pairs) {
      const [f, t] = p.split('|') as [string, string];
      if (f === t || !fingerprintsComplete(ctx, f) || !fingerprintsComplete(ctx, t)) continue;
      computeAndStorePageMap(ctx, f, t);
      out.page_maps++;
    }
  });

  // a first upload only: a replacement is already a version of its lecture
  if (v.version_no === 1 && v.kind === 'original' && v.deleted_at === null && v.is_stub === 0) {
    await step('new_version', () => {
      const best = linkCandidatesFor(ctx, versionId).find((c) => c.basis === 'fingerprints' && c.ratio >= LINK_THRESHOLD);
      if (!best) return;
      const map = computeAndStorePageMap(ctx, best.version_id, versionId);
      out.page_maps++;
      const matched = map.entries.filter((e) => e.status === 'safe' && e.to_page_id).length;
      const total = map.entries.length;
      const lectureNo = ctx.db.get<{ a: number | null; b: number | null }>('SELECT (SELECT lecture_no FROM source WHERE id = ?) AS a, (SELECT lecture_no FROM source WHERE id = ?) AS b', [best.source_id, v.source_id]);
      const reasons = [...best.basis_ar];
      if (lectureNo?.a !== null && lectureNo?.a !== undefined && lectureNo.a === lectureNo.b) reasons.push(`رقم المحاضرة نفسه (${lectureNo.a}).`);
      const proposed = proposeNewVersion(
        ctx,
        v.source_id,
        versionId,
        {
          field: 'new_version_of',
          source_id: best.source_id,
          version_id: best.version_id,
          title: best.title,
          matched_pages: matched,
          total_pages: total,
          ratio: total ? Math.round((matched / total) * 1000) / 1000 : 0,
          inserted: map.counts.inserted,
          removed: map.counts.removed,
          changed: map.counts.changed + map.counts.moved,
        },
        reasons,
      );
      if (proposed) out.new_version_of = { source_id: best.source_id, ratio: best.ratio };
    });
  }
  return out;
}

/** Versions processed before fingerprints existed (or with an older scheme): fingerprints only, no suggestions. */
export function versionsNeedingFingerprints(ctx: AppContext, limit = 10_000): string[] {
  return ctx.db
    .all<{ id: string }>(
      `SELECT v.id FROM source_version v JOIN source s ON s.id = v.source_id
        WHERE s.deleted_at IS NULL AND v.format <> 'audio' AND v.processing_status IN ('ready','partial','needs_review')
          AND EXISTS (SELECT 1 FROM source_page p LEFT JOIN page_fingerprint f ON f.page_id = p.id AND f.algo = ?
                       WHERE p.version_id = v.id AND f.page_id IS NULL)
        ORDER BY v.created_at LIMIT ?`,
      [FINGERPRINT_ALGO, limit],
    )
    .map((r) => r.id);
}

export async function runFingerprintBackfill(ctx: AppContext, run: { signal: AbortSignal; progress: (p: { stage: string; done?: number; total?: number; unit?: string }) => void }): Promise<{ versions: number }> {
  const ids = versionsNeedingFingerprints(ctx);
  const pdftoppm = detectTools().pdftoppm;
  let done = 0;
  for (const id of ids) {
    if (run.signal.aborted) throw run.signal.reason ?? new Error('aborted');
    try {
      await fingerprintVersion(ctx, id, { pdftoppm, signal: run.signal });
    } catch (e) {
      if (run.signal.aborted) throw e;
      ctx.log.warn({ err: e instanceof Error ? e.message : String(e), versionId: id }, 'fingerprint backfill failed for one version');
    }
    done++;
    run.progress({ stage: 'fingerprints', done, total: ids.length, unit: 'items' });
    // yield between versions: the event loop stays responsive (NFR-OP2)
    await new Promise((r) => setImmediate(r));
  }
  return { versions: done };
}
