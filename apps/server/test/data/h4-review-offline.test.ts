// Round 7 — independent review of track H4 item 7 (offline «تغيّر المحتوى» only when the SOURCE changed). The H4 split
// moved the owner's annotations / notes / session / progress / learning answers into owner_hash, but two answers that
// stayed in source_hash also carry the owner's own activity:
//   * the source detail's last_opened_at (set every time the owner OPENS the source online) and is_favorite;
//   * a linked question's detail (downloaded with solutions, the default): its attempt counts.
// So opening the lecture, or answering one of its questions, made «تحقّق من التحديث» say «تغيّر المحتوى على الخادم منذ
// التنزيل». Those fields are now hashed with the owner's data; a real change of the source still moves source_hash.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OfflineManifestResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { dataLibrary, getJson, type DataLib } from './helpers';

let lib: DataLib;
beforeAll(async () => {
  lib = await dataLibrary();
}, 240_000);
afterAll(async () => {
  await lib?.t.close();
});

const manifest = async () => {
  const m = await getJson<OfflineManifestResponse>(lib, `/api/data/offline/${lib.lecture.sourceId}/manifest`);
  expect(m.status, m.raw).toBe(200);
  return m.body;
};

describe('review H4 — the owner opening, starring or answering does not read as a content change', () => {
  it('opening the source and starring it: source_hash unchanged, owner_hash moves', async () => {
    const m0 = await manifest();
    lib.t.clock.advance(60_000);
    const open = await lib.t.app.inject({ method: 'POST', url: `/api/sources/${lib.lecture.sourceId}/open`, headers: lib.h });
    expect(open.statusCode, open.body).toBe(200);
    const m1 = await manifest();
    expect(m1.source_hash).toBe(m0.source_hash);
    expect(m1.owner_hash).not.toBe(m0.owner_hash);
    lib.t.clock.advance(60_000);
    const star = await lib.t.app.inject({ method: 'PATCH', url: `/api/sources/${lib.lecture.sourceId}`, headers: lib.h, payload: { is_favorite: true } });
    expect(star.statusCode, star.body).toBe(200);
    const m2 = await manifest();
    expect(m2.source_hash).toBe(m0.source_hash);
    expect(m2.owner_hash).not.toBe(m1.owner_hash);
  });

  it('an attempt on a linked question: source_hash unchanged, owner_hash moves', async () => {
    const m0 = await manifest();
    const detail = m0.entries.find((e) => e.kind === 'data' && e.role === 'question_detail');
    expect(detail, 'the lecture has linked questions downloaded with solutions').toBeTruthy();
    const qid = decodeURIComponent(detail!.kind === 'data' ? detail!.path.split('/').pop()! : '');
    const qv = lib.t.ctx.db.get<{ v: string }>('SELECT current_version_id AS v FROM question WHERE id = ?', [qid])!.v;
    const now = lib.t.ctx.clock.now();
    lib.t.ctx.db.run(`INSERT INTO question_attempt (id, question_id, question_version_id, is_correct, scored, answered_at, created_at) VALUES (?, ?, ?, 1, 1, ?, ?)`, [newId(now), qid, qv, now, now]);
    const m1 = await manifest();
    expect(m1.source_hash).toBe(m0.source_hash);
    expect(m1.owner_hash).not.toBe(m0.owner_hash);
  });

  it('a real change of the source (its title) still moves source_hash', async () => {
    const m0 = await manifest();
    const res = await lib.t.app.inject({ method: 'PATCH', url: `/api/sources/${lib.lecture.sourceId}`, headers: lib.h, payload: { title: 'Acute Appendicitis — renamed (TEST FIXTURE)' } });
    expect(res.statusCode, res.body).toBe(200);
    const m1 = await manifest();
    expect(m1.source_hash).not.toBe(m0.source_hash);
  });
});
