// AOS-21.9 / 21.45 — review of track C1 (2026-10-22): per-user quota accounting and copies of official lectures.
//
// PRD §6.2 (storage per student): official content is paid ONCE by its subject space («≈ 1.1 GB for 1,800 processed
// lectures once, ≈ 1.5 MB of stubs per student»), and ARCHITECTURE_DELTA §14 charges official / shared content to the
// space, not to students. A copy («ابدأ الدراسة», a course follow's fan-out, linking a private lecture) puts a STUB in
// the student's vault whose stored_file rows point at the space's blobs. The vault quota summed every stored_file row,
// so each official lecture a student studies — or that a course follow adds by itself when a moderator publishes — was
// charged to the student a second time: a moderator's uploads filled a student's quota until the student's OWN uploads
// were refused with QUOTA_EXCEEDED.
// Now a vault's quota counts the files its own content references; a file referenced ONLY by stubs of official
// lectures is the space's (counted in the space quota). The same bytes uploaded by the student themselves count again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuotaView } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { makePdf, text } from '../helpers/pdfgen';
import { inVault, publishLecture, startStudying, type Published } from '../forks/helpers';
import { createLectureWorld, drain, type LectureWorld, type Person } from '../lectures/world';
import { SPACE_A } from '../lectures/world';

let w: LectureWorld;
let pub: Published;
let officialPdf: Buffer;

/** A text PDF padded with a long content-stream comment (uncompressed): `kb` KiB per page. TEST FIXTURE. */
function bigPdf(label: string, pages: number, kb: number): Buffer {
  return makePdf(
    Array.from({ length: pages }, (_, i) => ({
      content: [
        text(72, 720, 13, `${label} page ${i + 1}: the renal artery arises from the abdominal aorta`),
        text(72, 690, 13, `Anatomy notes ${label} section ${i + 1} with distinct wording number ${i * 7 + 3}`),
        `%${'Q'.repeat(kb * 1024)}`,
      ].join('\n'),
    })),
  );
}

function folderOf(person: Person): string {
  return inVault(w, person, () => {
    const id = newId();
    const now = Date.now();
    w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, now, now]);
    return id;
  });
}

async function privateUpload(person: Person, name: string, data: Buffer) {
  return w.upload(person, '/api/sources/upload', { name, data }, { node_id: folderOf(person), source_type: 'lecture' });
}

beforeAll(async () => {
  w = await createLectureWorld();
  officialPdf = bigPdf('BIGQ', 2, 300);
  pub = await publishLecture(w, SPACE_A, 'Big official lecture (TEST FIXTURE)', [['placeholder']]);
  // the published version is replaced by the big file (same helper path as a moderator's upload)
  const up = await w.upload('mod', `/api/spaces/${SPACE_A}/lectures/${pub.lectureId}/upload`, { name: 'big.pdf', data: officialPdf });
  expect(up.statusCode, up.body).toBe(200);
  const v = up.json() as { version_id: string };
  await drain(w);
  await w.ok('mod', 'POST', `/api/spaces/${SPACE_A}/lectures/${pub.lectureId}/versions/${v.version_id}/publish`, {});
  await drain(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const quota = async (p: Person = 'student') => (await w.ok<QuotaView>(p, 'GET', '/api/accounts/me/quota')).storage.used_bytes;

describe('AOS-21.9 (review) — a copy of an official lecture is not charged to the student a second time', () => {
  it('starting to study an official lecture leaves the student quota (almost) unchanged', async () => {
    expect(officialPdf.length).toBeGreaterThan(500_000);
    const before = await quota();
    await startStudying(w, 'student', SPACE_A, pub.lectureId);
    await drain(w);
    // the stub's file rows exist in the vault (the copy works as before) …
    const stubFiles = inVault(w, 'student', () => w.t.ctx.db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM stored_file')!.n);
    expect(stubFiles).toBeGreaterThanOrEqual(officialPdf.length);
    // … but the official blobs are the space's bytes: only the stub's rows in the database count for the student
    const after = await quota();
    expect(after - before).toBeLessThan(officialPdf.length / 2);
  });

  it("a moderator's uploads never push a following member over their quota: their own upload still fits", async () => {
    // contrib2 has room for its database and a small upload of its own — not for the official lecture a second time
    const used = await quota('contrib2');
    w.t.ctx.system.quotas.setUserInternal(w.id.contrib2, { storage_bytes_limit: used + 400_000 }, w.id.owner);
    try {
      await startStudying(w, 'contrib2', SPACE_A, pub.lectureId);
      await drain(w);
      const res = await privateUpload('contrib2', 'my-notes.pdf', bigPdf('MINE', 1, 40));
      expect(res.statusCode, res.body).toBe(200);
      // before the fix: «rejected» — «لا توجد مساحة كافية في حسابك …» (the official lecture was charged to contrib2)
      expect((res.json() as { results: Array<{ status: string }> }).results[0]!.status, res.body).toBe('accepted');
    } finally {
      w.t.ctx.system.quotas.setUserInternal(w.id.contrib2, { storage_bytes_limit: null }, w.id.owner);
    }
  });

  it('a file that is ALSO the user\'s own (uploaded privately before it became official) keeps counting', async () => {
    // the student uploads a PDF privately; later the moderator publishes the same bytes; the student studies it
    const ownPdf = bigPdf('OWNFIRST', 1, 200);
    const up = await privateUpload('student', 'own-first.pdf', ownPdf);
    expect((up.json() as { results: Array<{ status: string }> }).results[0]!.status, up.body).toBe('accepted');
    await drain(w);
    const withOwn = await quota();
    const official = await w.ok<{ id: string }>('mod', 'POST', `/api/spaces/${SPACE_A}/lectures`, { title: 'Same bytes, official', lecture_no: 9 });
    const res = await w.upload('mod', `/api/spaces/${SPACE_A}/lectures/${official.id}/upload`, { name: 'own-first.pdf', data: ownPdf });
    expect(res.statusCode, res.body).toBe(200);
    await drain(w);
    await w.ok('mod', 'POST', `/api/spaces/${SPACE_A}/lectures/${official.id}/versions/${(res.json() as { version_id: string }).version_id}/publish`, {});
    await drain(w);
    await startStudying(w, 'student', SPACE_A, official.id);
    await drain(w);
    // the stub reuses the student's own row (same sha256): it is still the student's file and still counts
    const after = await quota();
    expect(after).toBeGreaterThanOrEqual(withOwn);
    expect(after - withOwn).toBeLessThan(ownPdf.length / 2);
  });

  it('the official file is counted once, in the subject space quota', () => {
    const used = w.t.ctx.quota.spaceStorageUsed(SPACE_A);
    expect(used.bytes_files).toBeGreaterThanOrEqual(officialPdf.length);
  });
});
