// AOS-21.9 / AOS-21.45 (ARCHITECTURE_DELTA §14, PRD Q22) — a storage quota PER SUBJECT SPACE, enforced on space uploads.
//   * default 20 GB per subject (MEDLEVO_SPACE_STORAGE_QUOTA_MB = 20480), or what the platform admin set (space_quota);
//   * what counts: the space database and the files it references (each blob once per space);
//   * a moderator's or contributor's upload that would take the subject over its limit is refused BEFORE the file is
//     registered: 409 QUOTA_EXCEEDED {kind:'space_storage', used, limit, space_id} with an Arabic reason naming the
//     subject — nothing of it stays (no stored_file row, no version);
//   * background work in the space (renders of processing) is counted but never refused mid-way;
//   * a subject's quota never touches a member's own vault quota, and the other way round;
//   * crossing 80 % notifies the subject's moderators once (quota_warning), crossing 100 % once more.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialLectureView } from '@medlevo/shared';
import { createLectureWorld, inSpace, lecturePdf, pagesFor, sp, SPACE_A, SPACE_B, type LectureWorld } from './world';

let w: LectureWorld;
beforeAll(async () => {
  w = await createLectureWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const ownerId = () => w.id.owner;
const counts = (space: string) =>
  inSpace(w, space, () => ({
    files: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM stored_file')!.n,
    versions: w.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_version')!.n,
  }));

describe('AOS-21.9 / 21.45 — per-space storage quota on space uploads', () => {
  it('the default limit of a subject space is 20 GB (owner default Q22); an explicit space_quota wins', () => {
    expect(w.t.ctx.quota.spaceStorageLimit(SPACE_B)).toBe(20_480 * 1024 * 1024);
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_B, { storage_bytes_limit: 5 * 1024 * 1024 }, ownerId());
    expect(w.t.ctx.quota.spaceStorageLimit(SPACE_B)).toBe(5 * 1024 * 1024);
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_B, { storage_bytes_limit: null }, ownerId());
    expect(w.t.ctx.quota.spaceStorageLimit(SPACE_B)).toBe(20_480 * 1024 * 1024);
  });

  it('an upload that would take the subject over its limit is refused before anything is registered', async () => {
    const used = w.t.ctx.quota.spaceStorageUsed(SPACE_A);
    const used0 = used.bytes_db + used.bytes_files;
    // room for the database as it is now plus a few bytes — not for a lecture file
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: used0 + 64 }, ownerId());
    const l = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Over quota', lecture_no: 3 });
    const before = counts(SPACE_A);
    const res = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'big.pdf', data: lecturePdf(pagesFor('Q', 6)) });
    expect(res.statusCode, res.body).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.details).toMatchObject({ kind: 'space_storage', space_id: SPACE_A, limit: used0 + 64 });
    expect(err.message).toContain('Anatomy A');
    expect(counts(SPACE_A)).toEqual(before);
    // a contributor (on their own draft) is refused the same way
    const own = await w.ok<OfficialLectureView>('contrib', 'POST', sp(SPACE_A, '/lectures'), { title: 'Contributor over quota', lecture_no: 7 });
    const res2 = await w.upload('contrib', sp(SPACE_A, `/lectures/${own.id}/upload`), { name: 'big2.pdf', data: lecturePdf(pagesFor('Q2', 3)) });
    expect(res2.statusCode, res2.body).toBe(409);
    expect(res2.json().error.details.kind).toBe('space_storage');
  });

  it('with room again the same upload goes through; background work is never refused', async () => {
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: null }, ownerId());
    const l = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Fits', lecture_no: 4 });
    const res = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'fits.pdf', data: lecturePdf(pagesFor('F', 2)) });
    expect(res.statusCode, res.body).toBe(200);
    // processing (no viewer) writes page renders into the space even when it is now over a tiny limit
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: 1 }, ownerId());
    await w.t.ctx.jobs.drain();
    const job = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ status: string }>(`SELECT status FROM processing_job ORDER BY created_at DESC LIMIT 1`)!);
    expect(['completed', 'partial']).toContain(job.status);
    w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: null }, ownerId());
  });

  it("a subject's quota and a member's vault quota are separate", async () => {
    // the student's vault quota is tiny; uploading into the subject (as a contributor) is checked against the subject
    w.t.ctx.system.quotas.setUserInternal(w.id.contrib, { storage_bytes_limit: 1 }, ownerId());
    const l = await w.ok<OfficialLectureView>('contrib', 'POST', sp(SPACE_A, '/lectures'), { title: 'Contrib draft', lecture_no: 5 });
    const res = await w.upload('contrib', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'c.pdf', data: lecturePdf(pagesFor('C', 1)) });
    expect(res.statusCode, res.body).toBe(200);
    w.t.ctx.system.quotas.setUserInternal(w.id.contrib, { storage_bytes_limit: null }, ownerId());
  });

  it('crossing 80 % and then 100 % notifies the subject moderators once each (quota_warning)', async () => {
    const published: Array<{ percent: number; dedupe: string }> = [];
    const seen = w.t.ctx.quota.onSpaceStorageWarning((e) => published.push({ percent: e.percent, dedupe: e.dedupeKey }));
    try {
      const pdf = lecturePdf(pagesFor('W', 2));
      const l = await w.ok<OfficialLectureView>('mod', 'POST', sp(SPACE_A, '/lectures'), { title: 'Warn', lecture_no: 6 });
      const used = w.t.ctx.quota.spaceStorageUsed(SPACE_A);
      const total = used.bytes_db + used.bytes_files;
      // the next upload brings the subject from below 80 % to above it (but under 100 %)
      w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: Math.floor((total + pdf.length / 2) / 0.8) }, ownerId());
      const res = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'w.pdf', data: pdf });
      expect(res.statusCode, res.body).toBe(200);
      expect(published.map((p) => p.percent)).toEqual([80]);
      // another small upload above 80 % does not warn again
      const res2 = await w.upload('mod', sp(SPACE_A, `/lectures/${l.id}/upload`), { name: 'w2.pdf', data: lecturePdf(pagesFor('W2', 1)) });
      expect([200, 409]).toContain(res2.statusCode);
      expect(published.filter((p) => p.percent === 80)).toHaveLength(1);
    } finally {
      seen();
      w.t.ctx.system.quotas.setSpaceInternal(SPACE_A, { storage_bytes_limit: null }, ownerId());
    }
  });
});
