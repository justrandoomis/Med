// AOS-18.17 / AOS-21.42 (ARCHITECTURE_DELTA §10.6) — AI cache keys carry the USER and the OFFICIAL dimensions.
//
// A stub of an official lecture has the SAME source / version ids in every member's vault, so two members' requests
// over one official lecture produce the same scope hash. Before this change the cache key was a function of the scope
// and the request only: a private request (include_my_notes) of one student had exactly the key of the same request
// by another student, and any cache two users share (a shared Study Book store, a database moved between vaults by a
// restore) would serve one user's private answer to the other. Now:
//   * a request that touches only official content keys the same for every member (one shared answer is allowed);
//   * a request that touches anything private carries hash(user) — two users never share it;
//   * the origin of every locked version is in the key — an artifact built from a non-official source is never served
//     for an official-lecture request with the same version ids.
// The «served to another user» test puts user A's private artifact where user B's lookup looks and checks it is missed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheKeys, type CacheKeyInput } from '../../src/modules/evidence/cache';
import { resolveScope } from '../../src/modules/evidence/scope';
import { findReusable } from '../../src/modules/studybook/artifacts';
import { inVault, publishLecture, startStudying, type Published } from '../forks/helpers';
import { createLectureWorld, pagesFor, SPACE_A, type LectureWorld, type Person } from '../lectures/world';

let w: LectureWorld;
let pub: Published;

beforeAll(async () => {
  w = await createLectureWorld();
  pub = await publishLecture(w, SPACE_A, 'Renal anatomy (TEST FIXTURE)', pagesFor('L18', 2));
  await startStudying(w, 'student', SPACE_A, pub.lectureId);
  await startStudying(w, 'contrib', SPACE_A, pub.lectureId);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const input = (scope: CacheKeyInput['scope']): CacheKeyInput => ({
  kind: 'explanation:explain',
  scope,
  rulesVersion: 'r',
  generatorVersion: 'g',
  verifierVersion: 'v',
  level: 'standard',
  language: 'ar',
  dialect: 'iraqi',
  settings: {},
  params: { anchor: null, instruction: 'اشرح الصفحة' },
});

function keysOf(person: Person, includeMyNotes: boolean) {
  return inVault(w, person, () => {
    const scope = resolveScope(w.t.ctx, { mode: 'lecture_only', lecture_source_id: pub.sourceId, include_my_notes: includeMyNotes });
    return { scope, ...cacheKeys(w.t.ctx, input(scope)) };
  });
}

/** a published artifact under `key` in the bound vault, depending on the stub version (so canReuse accepts it) */
function plantArtifact(key: string, scopeVersionId: string): string {
  const db = w.t.ctx.db;
  const now = w.t.ctx.clock.now();
  const id = `ART${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  db.run(
    `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version,
       verifier_version, model, status, created_at, published_at, updated_at)
     VALUES (?, ?, 1, 'explanation', 'planted', ?, '{}', '{}', ?, 'r', 'g', 'v', NULL, 'published', ?, ?, ?)`,
    [id, id, pub.sourceId, key, now, now, now],
  );
  db.run(`INSERT INTO artifact_dependency (id, dependent_type, dependent_id, source_version_id, region_id, created_at) VALUES (?, 'artifact', ?, ?, NULL, ?)`, [`D${id}`, id, scopeVersionId, now]);
  return id;
}

describe('AOS-18.17 — the cache key carries the user and the official dimensions', () => {
  it('both members lock the SAME stub version ids (the reason the user dimension is needed)', () => {
    const a = keysOf('student', false);
    const b = keysOf('contrib', false);
    expect(a.scope.versionIds).toEqual([pub.versionId]);
    expect(b.scope.versionIds).toEqual(a.scope.versionIds);
    expect(b.scope.hash).toBe(a.scope.hash);
  });

  it('an official-only request keys the same for every member (one shared answer may be reused)', () => {
    const a = keysOf('student', false);
    const b = keysOf('contrib', false);
    expect(a.dims.viewer).toBe('shared');
    expect(a.dims.origins).toEqual({ [pub.versionId]: `official:${SPACE_A}` });
    expect(b.key).toBe(a.key);
  });

  it("a private request (include_my_notes) carries the user: two members' keys differ, and differ from the shared key", () => {
    const a = keysOf('student', true);
    const b = keysOf('contrib', true);
    expect(a.dims.privateParts).toBe(true);
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(keysOf('student', false).key);
    // a request touching official content has no legacy key: nothing made before the dimensions is reused for it
    expect(a.legacyKey).toBeNull();
  });

  it("user A's cached private answer is NOT served to user B (planted where B's lookup looks)", () => {
    const a = keysOf('student', true);
    const b = keysOf('contrib', true);
    inVault(w, 'contrib', () => {
      const planted = plantArtifact(a.key, pub.versionId);
      expect(findReusable(w.t.ctx, { key: b.key, legacyKey: b.legacyKey, dims: b.dims }, 'explanation')).toBeNull();
      // control: B's own cached answer under B's key is found
      const own = plantArtifact(b.key, pub.versionId);
      expect(findReusable(w.t.ctx, { key: b.key, legacyKey: b.legacyKey, dims: b.dims }, 'explanation')?.id).toBe(own);
      expect(own).not.toBe(planted);
    });
  });

  it('an official-only answer IS shared between members (the intended reuse, ARCHITECTURE_DELTA §10.6)', () => {
    const a = keysOf('student', false);
    inVault(w, 'contrib', () => {
      const planted = plantArtifact(a.key, pub.versionId);
      const b = keysOf('contrib', false);
      expect(findReusable(w.t.ctx, { key: b.key, legacyKey: b.legacyKey, dims: b.dims }, 'explanation')?.id).toBe(planted);
    });
  });

  it('the official dimension: the same version ids from a NON-official source give another key (never served for the official request)', () => {
    const official = keysOf('student', false);
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      const row = db.get<{ is_stub: number; origin_space_id: string | null }>('SELECT is_stub, origin_space_id FROM source WHERE id = ?', [pub.sourceId])!;
      expect(row.is_stub).toBe(1);
      db.run('UPDATE source SET is_stub = 0, origin_space_id = NULL WHERE id = ?', [pub.sourceId]);
      try {
        const scope = resolveScope(w.t.ctx, { mode: 'lecture_only', lecture_source_id: pub.sourceId });
        const own = cacheKeys(w.t.ctx, input(scope));
        expect(scope.versionIds).toEqual(official.scope.versionIds);
        expect(own.dims.origins).toEqual({ [pub.versionId]: 'own' });
        expect(own.key).not.toBe(official.key);
        // and an artifact made from that non-official copy is not found by the official request
        const planted = plantArtifact(own.key, pub.versionId);
        expect(findReusable(w.t.ctx, { key: official.key, legacyKey: official.legacyKey, dims: official.dims }, 'explanation')?.id ?? null).not.toBe(planted);
      } finally {
        db.run('UPDATE source SET is_stub = ?, origin_space_id = ? WHERE id = ?', [row.is_stub, row.origin_space_id, pub.sourceId]);
      }
    });
  });

  it("an artifact a vault made BEFORE the dimensions (its old key) is still reused — only for requests that touch no official content", () => {
    inVault(w, 'student', () => {
      const db = w.t.ctx.db;
      const row = db.get<{ is_stub: number; origin_space_id: string | null }>('SELECT is_stub, origin_space_id FROM source WHERE id = ?', [pub.sourceId])!;
      db.run('UPDATE source SET is_stub = 0, origin_space_id = NULL WHERE id = ?', [pub.sourceId]);
      try {
        const scope = resolveScope(w.t.ctx, { mode: 'lecture_only', lecture_source_id: pub.sourceId });
        const own = cacheKeys(w.t.ctx, { ...input(scope), params: { legacy: true } });
        expect(own.legacyKey).not.toBeNull();
        expect(own.legacyKey).not.toBe(own.key);
        const old = plantArtifact(own.legacyKey!, pub.versionId);
        expect(findReusable(w.t.ctx, own, 'explanation')?.id).toBe(old);
      } finally {
        db.run('UPDATE source SET is_stub = ?, origin_space_id = ? WHERE id = ?', [row.is_stub, row.origin_space_id, pub.sourceId]);
      }
    });
  });
});
