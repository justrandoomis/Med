// AOS-21.8 — LectureVersions: the publisher and the «published official» state are on every version, and a version is
// SHARED by all copies: the students' copies of an official lecture hold the space's version ids (never a re-numbered
// private copy of the version), and a newly published version reaches every holder under the SAME id. The vault rows of
// a copy are a skeleton (is_stub, origin_space_id) pointing back at the one version in the space.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialVersionView } from '@medlevo/shared';
import { inSpaceDb, inVault, publishLecture, publishVersion, type Published, startStudying } from './helpers';
import { createLectureWorld, type LectureWorld, pagesFor, sp, SPACE_A } from '../lectures/world';

let w: LectureWorld;
let pub: Published;
const HOLDERS = ['student', 'contrib', 'contrib2'] as const;

beforeAll(async () => {
  w = await createLectureWorld();
  pub = await publishLecture(w, SPACE_A, 'Renal physiology (TEST FIXTURE)', pagesFor('V1', 2));
  for (const p of HOLDERS) await startStudying(w, p, SPACE_A, pub.lectureId);
}, 300_000);
afterAll(async () => {
  await w?.close();
});

const stubVersions = (p: (typeof HOLDERS)[number]) =>
  inVault(w, p, () =>
    w.t.ctx.db
      .all<{ id: string; is_stub: number; origin_space_id: string | null }>(
        `SELECT v.id, s.is_stub, s.origin_space_id FROM source_version v JOIN source s ON s.id = v.source_id WHERE s.id = ? ORDER BY v.id`,
        [pub.sourceId],
      ),
  );

describe('AOS-21.8 — one version, shared by every copy', () => {
  it('every holder holds the SAME version id as the space, as a stub of that space', () => {
    for (const p of HOLDERS) {
      const rows = stubVersions(p);
      expect(rows.map((r) => r.id), p).toEqual([pub.versionId]);
      expect(rows.every((r) => r.is_stub === 1 && r.origin_space_id === SPACE_A), p).toBe(true);
    }
  });

  it('a new published version reaches every holder under the same id; the space keeps one row per version', async () => {
    const v2 = await publishVersion(w, SPACE_A, pub.lectureId, pagesFor('V2', 2));
    const spaceIds = inSpaceDb(w, SPACE_A, (db) => db.all<{ id: string }>('SELECT id FROM source_version WHERE source_id = ? ORDER BY id', [pub.sourceId]).map((r) => r.id));
    expect(spaceIds).toEqual([pub.versionId, v2].sort());
    for (const p of HOLDERS) expect(stubVersions(p).map((r) => r.id), p).toEqual(spaceIds);
  });

  it('each version carries its publisher and its «published official» state', async () => {
    const versions = (await w.ok<{ versions: OfficialVersionView[] }>('mod', 'GET', sp(SPACE_A, `/lectures/${pub.lectureId}`))).versions;
    expect(versions.length).toBe(2);
    for (const v of versions) {
      expect(v.published_by?.id).toBe(w.id.mod);
      expect(v.published_at).toBeGreaterThan(0);
      expect(['published', 'superseded']).toContain(v.status);
    }
    expect(versions.filter((v) => v.status === 'published')).toHaveLength(1);
  });
});
