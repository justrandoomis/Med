// Phase 1 completion, track C2 — AOS-19H.1: ONE stable lecture identity in the space links its versions, the member's
// copies, the private lectures they linked to it, the explanations published on it, and the member's own objects mapped
// to it (annotations, notes, questions, cards, recordings — later phases add kinds, the answer is a list by kind).
// `GET /api/copies/lecture-identity?space_id=&lecture_id=` — a member reads only THEIR side (their vault) plus what every
// member may see (published versions, active explanations); a stranger, another subject's student, a draft or an
// unknown id is «not found». Real channels (pubWorld). Every file and stroke is a TEST FIXTURE generated here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LECTURE_IDENTITY_OBJECT_KINDS, type LectureIdentityLinks, type LinkToOfficialResponse, type OfficialLectureView, type UploadResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { call, ok } from '../channels/helpers';
import { lecturePdf, multipart, pagesFor } from '../lectures/world';
import { createLayer, createPubWorld, inVault, publish, settle, startPersonal, strokes, typedNote, type PubWorld, type Who } from './pubWorld';

let w: PubWorld;
const identity = (who: Who, lectureId = w.lecture.id, spaceId = w.space) => call(w.t, w.p[who].h, 'GET', `/api/copies/lecture-identity?space_id=${spaceId}&lecture_id=${lectureId}`);
const countOf = (l: LectureIdentityLinks, kind: string) => l.objects.find((o) => o.kind === kind)?.count;

beforeAll(async () => {
  w = await createPubWorld(4);
}, 240_000);
afterAll(async () => {
  await w?.close();
});

describe('AOS-19H.1 — one lecture identity links versions, copies, linked private lectures, explanations and objects', () => {
  it('before «ابدأ الدراسة»: the identity and its published version, nothing of the member\'s yet', async () => {
    const l = ok<LectureIdentityLinks>(await identity('zainab'));
    expect(l.identity).toMatchObject({ space_id: w.space, lecture_id: w.lecture.id, title: 'Lecture 5 — Anatomy of the Abdomen', lecture_no: 5, subject_title: 'Anatomy', status: 'published' });
    expect(l.versions).toEqual([expect.objectContaining({ id: w.lecture.versionId, version_no: 1, held: false })]);
    expect(l.stub_source_id).toBeNull();
    expect(l.copies).toEqual([]);
    expect(l.objects.map((o) => o.kind)).toEqual([...LECTURE_IDENTITY_OBJECT_KINDS]);
    expect(l.objects.every((o) => o.count === 0)).toBe(true);
  });

  it('after studying: the copy, its held version and every object kind mapped to the identity', async () => {
    const copy = await startPersonal(w, 'zainab');
    await strokes(w, 'zainab', null, 0, 3);
    await typedNote(w, 'zainab', null, 1, 'ملاحظتي على الشريان الأبهر');
    const stub = w.lecture.sourceId; // stubs keep the space's ids
    inVault(w, 'zainab', () => {
      const db = w.t.ctx.db;
      const now = Date.now();
      // a card and a question made from the lecture, and a recording linked to it (later-phase objects, rows as they exist today)
      db.run(`INSERT INTO flashcard (id, kind, front_json, back_json, source_id, source_version_id, origin, created_at, updated_at) VALUES (?, 'basic', '{}', '{}', ?, ?, 'owner', ?, ?)`, [newId(), stub, w.lecture.versionId, now, now]);
      const q = newId();
      const qv = newId();
      db.run(`INSERT INTO question (id, origin_type, status, created_at, updated_at) VALUES (?, 'owner', 'draft', ?, ?)`, [q, now, now]);
      db.run(
        `INSERT INTO question_version (id, question_id, version_no, kind, qtype, stem_json, extraction_status, answer_status, created_by, created_at) VALUES (?, ?, 1, 'structured', 'short_answer', '{}', 'not_applicable', 'not_applicable', 'owner', ?)`,
        [qv, q, now],
      );
      db.run(`INSERT INTO question_occurrence (id, question_id, question_version_id, source_id, source_version_id, page_ids_json, region_ids_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', '[]', ?)`, [newId(), q, qv, stub, w.lecture.versionId, now]);
      const audio = newId();
      db.run(`INSERT INTO source (id, title, source_type, created_at, updated_at) VALUES (?, 'تسجيل المحاضرة', 'lecture_audio', ?, ?)`, [audio, now, now]);
      db.run(`INSERT INTO audio_recording (id, source_id, linked_source_id, started_at, mime, created_at, updated_at) VALUES (?, ?, ?, ?, 'audio/webm', ?, ?)`, [newId(), audio, stub, now, now, now]);
    });
    const l = ok<LectureIdentityLinks>(await identity('zainab'));
    expect(l.stub_source_id).toBe(stub);
    expect(l.versions[0]).toMatchObject({ id: w.lecture.versionId, held: true });
    expect(l.copies).toEqual([{ id: copy.id, mode: 'personal', publication_id: null }]);
    expect(countOf(l, 'annotation')).toBe(3);
    expect(countOf(l, 'note')).toBe(1);
    expect(countOf(l, 'card')).toBe(1);
    expect(countOf(l, 'question')).toBe(1);
    expect(countOf(l, 'recording')).toBe(1);
    // another member's side is their own: nothing of zainab's shows for hasan
    const h = ok<LectureIdentityLinks>(await identity('hasan'));
    expect(h.copies).toEqual([]);
    expect(h.objects.every((o) => o.count === 0)).toBe(true);
  });

  it('an explanation published on the lecture is linked to the identity (its author sees it as theirs)', async () => {
    await startPersonal(w, 'hasan');
    const layer = await createLayer(w, 'hasan', 'شرحي');
    await strokes(w, 'hasan', layer, 0, 2);
    const pub = await publish(w, 'hasan', [layer], 'شرح حسن للمحاضرة 5');
    await settle(w);
    const z = ok<LectureIdentityLinks>(await identity('zainab'));
    expect(z.publications).toEqual([expect.objectContaining({ id: pub.id, title: 'شرح حسن للمحاضرة 5', head_version_no: 1, status: 'active', mine: false, held: false })]);
    const h = ok<LectureIdentityLinks>(await identity('hasan'));
    expect(h.publications.find((p) => p.id === pub.id)?.mine).toBe(true);
  });

  it('a private lecture linked with «اربط بالمحاضرة الرسمية» is mapped to the identity', async () => {
    const folder = inVault(w, 'zainab', () => {
      const id = newId();
      w.t.ctx.db.run(`INSERT INTO library_node (id, parent_id, kind, title, created_at, updated_at) VALUES (?, NULL, 'folder', 'ملفاتي', ?, ?)`, [id, Date.now(), Date.now()]);
      return id;
    });
    const mp = multipart({ node_id: folder, source_type: 'lecture' }, { name: 'my-lecture5.pdf', data: lecturePdf(pagesFor('Lecture 5', 4, { 3: 'my own last page' })) });
    const res = await w.t.app.inject({ method: 'POST', url: '/api/sources/upload', headers: { ...w.p.zainab.h, 'content-type': mp.contentType }, payload: mp.body });
    expect(res.statusCode, res.body).toBe(200);
    const priv = (res.json() as UploadResponse).results[0]!.source_id!;
    await settle(w);
    await settle(w);
    ok<LinkToOfficialResponse>(await call(w.t, w.p.zainab.h, 'POST', '/api/copies/link', { id: newId(), source_id: priv, space_id: w.space, lecture_id: w.lecture.id, to_version_id: w.lecture.versionId }));
    const l = ok<LectureIdentityLinks>(await identity('zainab'));
    expect(l.linked_private).toEqual([{ source_id: priv, title: expect.any(String) }]);
  });

  it('only a member of the subject reads it; a draft, an unknown id and another subject answer «not found»', async () => {
    expect((await identity('mustafa')).statusCode).toBe(200); // an Assistant of the subject
    for (const who of ['physio', 'ahmad', 'modB'] as const) {
      const r = await identity(who);
      expect(r.statusCode, who).toBe(404);
      expect(r.body).not.toContain('Lecture 5');
    }
    const draft = ok<OfficialLectureView>(await call(w.t, w.p.sara.h, 'POST', w.S('/lectures'), { title: 'Draft lecture 6' }));
    expect((await identity('zainab', draft.id)).statusCode).toBe(404);
    expect((await identity('zainab', newId())).statusCode).toBe(404);
    expect((await identity('zainab', w.lecture.id, w.otherSpace)).statusCode).toBe(404);
    // malformed ids are a validation error, never a lookup
    expect((await call(w.t, w.p.zainab.h, 'GET', '/api/copies/lecture-identity?space_id=x%27&lecture_id=1')).statusCode).toBe(400);
  });
});
