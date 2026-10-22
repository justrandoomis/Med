// Lazy pinning of official regions into the vault (P1-T5 step 2; ARCHITECTURE_DELTA §4.2 `0163_pinned_region`, §6.7;
// ADR-0003 §3.3 «cited regions and their evidence are pinned into the vault lazily»).
//
// A vault stub holds no region text. When a vault artifact CITES a region of an official version (an evidence row, a
// card, a Study Book citation), the region row is copied into the vault under the SAME id — so `evidence.region_id` and
// every citation keep their foreign keys and their text inside the user's own database (Source Lock and the evidence
// contract work exactly as for a private source) — and `pinned_region` records the space, the version and the sha256
// of the text + locator it copied. Published official regions are immutable, so the hash never changes for them; a pin
// is never refreshed silently.
//
// Only regions of versions the vault holds as a stub, of a subject the user is still a member of, are ever pinned;
// anything else answers «not found» exactly like an unknown region.
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context';
import type { Db } from '../../db/db';
import { spaceDb } from './stubs';
import { forksSystem } from './system';

export interface SpaceRegionRow {
  id: string;
  version_id: string;
  page_id: string | null;
  parent_region_id: string | null;
  kind: string;
  reading_order: number;
  bbox_json: string | null;
  locator_json: string | null;
  text: string | null;
  text_origin: string | null;
  lang: string | null;
  confidence: number | null;
  structure_json: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export function regionContentHash(r: Pick<SpaceRegionRow, 'text' | 'locator_json'>): string {
  return createHash('sha256').update(`${r.text ?? ''}\u0000${r.locator_json ?? ''}`).digest('hex');
}

/** The spaces of the bound vault's stubs whose subject the vault's user may still read (member or role). */
export function stubSpaces(ctx: AppContext): Array<{ spaceId: string; db: Db }> {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind !== 'vault') return [];
  const userId = b.viewer?.userId ?? forksSystem(ctx).userOfVault(b.vaultId);
  if (!userId) return [];
  const out: Array<{ spaceId: string; db: Db }> = [];
  for (const r of ctx.db.all<{ s: string }>('SELECT DISTINCT origin_space_id AS s FROM source WHERE is_stub = 1 AND origin_space_id IS NOT NULL AND deleted_at IS NULL')) {
    const m = ctx.authz.memberships.accessToSpace({ userId, deviceId: null, isPlatformAdmin: b.viewer?.isPlatformAdmin ?? false }, r.s);
    if (!m || m.pending) continue;
    const db = spaceDb(ctx, r.s);
    if (db) out.push({ spaceId: r.s, db });
  }
  return out;
}

/** One space of the bound vault's stubs, when its subject may still be read (one membership check, not one per space). */
export function stubSpace(ctx: AppContext, spaceId: string): Db | null {
  const b = ctx.binding.current() ?? ctx.binding.harnessDefault();
  if (!b || b.kind !== 'vault') return null;
  const userId = b.viewer?.userId ?? forksSystem(ctx).userOfVault(b.vaultId);
  if (!userId) return null;
  const m = ctx.authz.memberships.accessToSpace({ userId, deviceId: null, isPlatformAdmin: b.viewer?.isPlatformAdmin ?? false }, spaceId);
  if (!m || m.pending) return null;
  return spaceDb(ctx, spaceId);
}

/** The space (and its db) whose published region this is, when the bound vault holds that version as a stub. */
export function locateStubRegion(ctx: AppContext, regionId: string): { spaceId: string; db: Db; region: SpaceRegionRow } | null {
  for (const s of stubSpaces(ctx)) {
    const region = s.db.get<SpaceRegionRow>('SELECT * FROM source_region WHERE id = ?', [regionId]);
    if (!region) continue;
    const held = ctx.db.get<{ x: number }>(
      `SELECT 1 AS x FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ? AND s.is_stub = 1 AND s.origin_space_id = ?`,
      [region.version_id, s.spaceId],
    );
    if (!held) return null;
    // only text of a PUBLISHED, not taken-down official version leaves the space
    const ok = s.db.get<{ x: number }>(
      `SELECT 1 AS x FROM official_version_publish p JOIN official_lecture l ON l.id = p.lecture_id WHERE p.version_id = ? AND l.takedown_at IS NULL`,
      [region.version_id],
    );
    return ok ? { spaceId: s.spaceId, db: s.db, region } : null;
  }
  return null;
}

/**
 * Copy one official region into the bound vault (idempotent). Returns true when the vault now holds the region (pinned
 * now or before). The page must exist in the stub (it does: pages are part of the stub skeleton).
 */
export function pinStubRegion(ctx: AppContext, regionId: string): boolean {
  if (ctx.db.get('SELECT 1 AS x FROM source_region WHERE id = ?', [regionId])) return true;
  const found = locateStubRegion(ctx, regionId);
  if (!found) return false;
  const r = found.region;
  if (r.page_id && !ctx.db.get('SELECT 1 AS x FROM source_page WHERE id = ?', [r.page_id])) return false;
  const now = ctx.clock.now();
  ctx.db.tx(() => {
    const parent = r.parent_region_id && ctx.db.get('SELECT 1 AS x FROM source_region WHERE id = ?', [r.parent_region_id]) ? r.parent_region_id : null;
    ctx.db.run(
      `INSERT INTO source_region (id, version_id, page_id, parent_region_id, kind, reading_order, bbox_json, locator_json, text, text_origin, lang, confidence, structure_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [r.id, r.version_id, r.page_id, parent, r.kind, r.reading_order, r.bbox_json, r.locator_json, r.text, r.text_origin, r.lang, r.confidence, r.structure_json, r.status, r.created_at, r.updated_at],
    );
    ctx.db.run(`INSERT INTO pinned_region (region_id, space_id, version_id, content_hash, pinned_at, refreshed_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(region_id) DO NOTHING`, [
      r.id,
      found.spaceId,
      r.version_id,
      regionContentHash(r),
      now,
    ]);
  });
  return true;
}

/** The region ids of an official chunk the bound vault may cite (null: not a chunk of a held stub version). */
export function stubChunkRegionIds(ctx: AppContext, chunkId: string): string[] | null {
  for (const s of stubSpaces(ctx)) {
    const c = s.db.get<{ version_id: string; region_ids_json: string }>('SELECT version_id, region_ids_json FROM document_chunk WHERE id = ?', [chunkId]);
    if (!c) continue;
    const held = ctx.db.get('SELECT 1 AS x FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ? AND s.is_stub = 1', [c.version_id]);
    if (!held) return null;
    try {
      const ids = JSON.parse(c.region_ids_json) as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return null;
}

/** Is this region pinned, and does the space still hold the same text? (a difference is reported, never hidden) */
export function pinState(ctx: AppContext, regionId: string): { pinned: boolean; same_as_space: boolean | null } {
  const p = ctx.db.get<{ space_id: string; content_hash: string }>('SELECT space_id, content_hash FROM pinned_region WHERE region_id = ?', [regionId]);
  if (!p) return { pinned: false, same_as_space: null };
  const space = spaceDb(ctx, p.space_id);
  const r = space?.get<Pick<SpaceRegionRow, 'text' | 'locator_json'>>('SELECT text, locator_json FROM source_region WHERE id = ?', [regionId]);
  return { pinned: true, same_as_space: r ? regionContentHash(r) === p.content_hash : null };
}
