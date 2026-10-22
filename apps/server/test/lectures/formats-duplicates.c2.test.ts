// Phase 1 completion, track C2 — inside a subject space:
//   * AOS-2.3 / 18.3: Subject Moderators upload PDF, PPTX, DOCX and image files; each is processed in the space; the
//     uploader is recorded and shown; access follows the space (a stranger gets the missing-item 404 on the file);
//     several lectures uploaded at once («bulk»: one draft per file) are numbered from their files and listed in order
//     (AOS-2.2, server part);
//   * AOS-3.6: the duplicate answer names only what the uploader can see — the same bytes as a published lecture name it,
//     the same bytes as another contributor's hidden draft give no title and no hint; across two accounts' vaults the
//     shared blob store never tells (`POST /api/sources/upload`, route level).
// Every file is a TEST FIXTURE (the golden set's synthetic files and generated PDFs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfficialLectureDetail, OfficialLectureView, OfficialLecturesResponse, UploadOfficialVersionResponse, UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { inVault } from '../forks/helpers';
import { FIXTURES } from '../processing/helpers';
import { createLectureWorld, drain, inSpace, lecturePdf, pagesFor, SPACE_A, sp, type LectureWorld, type Person } from './world';

let w: LectureWorld;
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const MIME: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  pdf: 'application/pdf',
};

async function draft(who: Person, title: string, extra: Record<string, unknown> = {}): Promise<OfficialLectureView> {
  return w.ok<OfficialLectureView>(who, 'POST', sp(SPACE_A, '/lectures'), { title, ...extra });
}
async function upload(who: Person, lectureId: string, name: string, data: Buffer): Promise<UploadOfficialVersionResponse> {
  const ext = name.split('.').pop()!;
  const res = await w.upload(who, sp(SPACE_A, `/lectures/${lectureId}/upload`), { name, data, mime: MIME[ext] ?? 'application/octet-stream' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as UploadOfficialVersionResponse;
}

beforeAll(async () => {
  w = await createLectureWorld();
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('AOS-2.3 / 18.3 — PDF, PPTX, DOCX and images in a subject; the uploader is recorded; access follows the space', () => {
  const cases = [
    { file: 'slides_shock.pptx', format: 'pptx' },
    { file: 'lecture_notes_shock.docx', format: 'docx' },
    { file: 'scanned_page.png', format: 'image' },
    { file: 'lecture_appendicitis.pdf', format: 'pdf' },
  ] as const;
  for (const c of cases) {
    it(`${c.format}: uploaded, processed in the space, published with its uploader; strangers get «not found»`, async () => {
      const l = await draft('mod', `Format ${c.format} (TEST FIXTURE)`);
      const up = await upload('mod', l.id, c.file, fixture(c.file));
      await drain(w);
      const d = await w.ok<OfficialLectureDetail>('mod', 'GET', sp(SPACE_A, `/lectures/${l.id}`));
      const v = d.versions.find((x) => x.id === up.version_id)!;
      expect(['ready', 'partial', 'needs_review'], `${c.format}: ${v.processing_status}`).toContain(v.processing_status);
      expect(v.uploaded_by?.id).toBe(w.id.mod);
      expect(inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ format: string }>('SELECT format FROM source_version WHERE id = ?', [up.version_id])!.format)).toBe(c.format);
      await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${l.id}/versions/${up.version_id}/publish`), {});
      // a member reads it; the head carries who published it (shown with «رسمي», AOS-4.5 / 19I.2)
      const seen = await w.ok<OfficialLectureDetail>('student', 'GET', sp(SPACE_A, `/lectures/${l.id}`));
      expect(seen.uploaded_by.id).toBe(w.id.mod);
      expect(seen.head_version).toMatchObject({ id: up.version_id, published_by: { id: w.id.mod } });
      const sourceId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ s: string }>('SELECT source_id AS s FROM official_lecture WHERE id = ?', [l.id])!.s);
      const pages = await w.req('student', 'GET', sp(SPACE_A, `/sources/${sourceId}/versions/${up.version_id}/pages`));
      expect(pages.statusCode, pages.body).toBe(200);
      // a stranger (member of nothing) and another subject's moderator never reach it
      const fileId = inSpace(w, SPACE_A, () => w.t.ctx.db.get<{ f: string }>('SELECT COALESCE(file_id, original_file_id) AS f FROM source_version WHERE id = ?', [up.version_id])!.f);
      for (const who of ['outsider', 'modB'] as const) expect((await w.req(who, 'GET', sp(SPACE_A, `/files/${fileId}`))).statusCode, who).toBe(404);
      expect((await w.req('student', 'GET', sp(SPACE_A, `/files/${fileId}`))).statusCode).toBe(200);
    }, 180_000);
  }

  it('a contributor\'s PPTX is recorded as theirs and waits for a moderator (not visible to students before)', async () => {
    const l = await draft('contrib', 'Contributor slides (TEST FIXTURE)');
    const up = await upload('contrib', l.id, 'shock-slides-contrib.pptx', fixture('slides_shock.pptx'));
    await drain(w);
    const d = await w.ok<OfficialLectureDetail>('mod', 'GET', sp(SPACE_A, `/lectures/${l.id}`));
    expect(d.status).toBe('in_review');
    expect(d.versions.find((v) => v.id === up.version_id)?.uploaded_by?.id).toBe(w.id.contrib);
    expect((await w.req('student', 'GET', sp(SPACE_A, `/lectures/${l.id}`))).statusCode).toBe(404);
  }, 180_000);

  it('several lectures uploaded at once (one draft per file) are numbered from their files and listed in order', async () => {
    const files = [
      ['Lecture 23 bulk renal.pdf', pagesFor('Bulk renal', 2)],
      ['Lecture 21 bulk cardiac.pdf', pagesFor('Bulk cardiac', 2)],
      ['Lecture 22 bulk lungs.pdf', pagesFor('Bulk lungs', 2)],
    ] as const;
    const ids: string[] = [];
    for (const [name, pages] of files) {
      const l = await draft('mod', name.replace(/\.pdf$/, ''));
      ids.push(l.id);
      await upload('mod', l.id, name, lecturePdf(pages as unknown as string[][]));
    }
    await drain(w);
    const list = await w.ok<OfficialLecturesResponse>('mod', 'GET', sp(SPACE_A, '/lectures?limit=100'));
    const mine = list.items.filter((i) => ids.includes(i.id));
    expect(mine.map((i) => i.lecture_no)).toEqual([21, 22, 23]);
    expect(mine.every((i) => i.lecture_no_origin === 'detected')).toBe(true);
  }, 180_000);
});

describe('AOS-3.6 — duplicate answers name only what the uploader can see', () => {
  it('the same bytes as a PUBLISHED lecture: the answer names it; as another contributor\'s hidden draft: no title, no hint', async () => {
    const published = lecturePdf(pagesFor('Dup published', 2));
    const A = await draft('mod', 'Published original (TEST FIXTURE)');
    const ua = await upload('mod', A.id, 'orig.pdf', published);
    await drain(w);
    await w.ok('mod', 'POST', sp(SPACE_A, `/lectures/${A.id}/versions/${ua.version_id}/publish`), {});
    const B = await draft('contrib', 'My copy of it (TEST FIXTURE)');
    const ub = await upload('contrib', B.id, 'mine.pdf', published);
    expect(ub.duplicate_of).toMatchObject({ lecture_id: A.id, title: 'Published original (TEST FIXTURE)', version_no: 1 });
    expect(ub.duplicate_note_ar).toContain('Published original (TEST FIXTURE)');

    const hidden = lecturePdf(pagesFor('Dup hidden draft', 2));
    const C = await draft('contrib2', 'Secret draft of contrib2 (TEST FIXTURE)');
    await upload('contrib2', C.id, 'secret.pdf', hidden);
    const D = await draft('contrib', 'Innocent upload (TEST FIXTURE)');
    const raw = await w.upload('contrib', sp(SPACE_A, `/lectures/${D.id}/upload`), { name: 'innocent.pdf', data: hidden });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).not.toContain('Secret draft');
    expect(raw.body).not.toContain(C.id);
    expect((raw.json() as UploadOfficialVersionResponse).duplicate_of ?? null).toBeNull();
    // a moderator sees every draft: the answer names it
    const E = await draft('mod', 'Moderator upload (TEST FIXTURE)');
    const ue = await upload('mod', E.id, 'mod.pdf', hidden);
    expect(ue.duplicate_of).toMatchObject({ lecture_id: C.id });
  });

  it('two accounts, one blob: the second vault upload gets a NEW source, no title and no hint (route level)', async () => {
    const folder = (who: Person) =>
      inVault(w, who, () => {
        const id = newId();
        w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, Date.now(), Date.now()]);
        return id;
      });
    const fs = folder('student');
    const fo = folder('outsider');
    const bytes = lecturePdf(pagesFor('Private vault dup', 2));
    const first = await w.upload('student', '/api/sources/upload', { name: 'student-private.pdf', data: bytes }, { node_id: fs, source_type: 'lecture' });
    expect(first.statusCode, first.body).toBe(200);
    const r1 = (first.json() as UploadResponse).results[0]!;
    expect(r1.status).toBe('accepted');
    const second = await w.upload('outsider', '/api/sources/upload', { name: 'outsider.pdf', data: bytes }, { node_id: fo, source_type: 'lecture' });
    expect(second.statusCode, second.body).toBe(200);
    const r2 = (second.json() as UploadResponse).results[0]!;
    expect(r2.status).toBe('accepted');
    expect(r2.duplicate_of).toBeUndefined();
    expect(r2.source_id).not.toBe(r1.source_id);
    expect(second.body).not.toContain('student-private');
    // the same user uploading it again IS told (it is their own source)
    const again = await w.upload('student', '/api/sources/upload', { name: 'again.pdf', data: bytes }, { node_id: fs, source_type: 'lecture' });
    const r3 = (again.json() as UploadResponse).results[0]!;
    expect(r3.status).toBe('duplicate');
    expect(r3.duplicate_of).toMatchObject({ source_id: r1.source_id });
  });
});
