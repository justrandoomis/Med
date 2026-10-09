// Terminology (§21): /api/studybook/terms is the Study Book contract path for the owner's dictionary. It forwards to
// the evidence module's single implementation (owner of medical_term), so validation, uniqueness, audit and the
// session / CSRF checks are the same. The dictionary reaches the generator as preferred renderings and never edits
// the source text.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MedicalTermView } from '@medlevo/shared';
import { regionWith } from '../evidence/helpers';
import { aliasFor, content, lectureOnly, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;

beforeAll(async () => {
  lib = await studyLibrary(ai);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  if (ai.errors.length) throw new Error(`scripted generator failed: ${ai.errors.splice(0).map(String).join(' | ')}`);
});

describe('terminology dictionary (/api/studybook/terms)', () => {
  it('CRUD through the Study Book path, with the owning module’s validation, uniqueness and audit', async () => {
    const empty = await lib.t.app.inject({ method: 'GET', url: '/api/studybook/terms', headers: lib.h });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().terms).toEqual([]); // nothing is seeded

    const created = await lib.t.app.inject({
      method: 'POST',
      url: '/api/studybook/terms',
      headers: lib.h,
      payload: { term_en: 'Ultrasound', abbreviation: 'US', synonyms: ['sonography'], explanation_ar: 'تصوير بالأمواج فوق الصوتية', accepted_translation_ar: 'الأمواج فوق الصوتية', owner_preferred_ar: 'السونار' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const term = created.json().term as MedicalTermView;
    expect(term).toMatchObject({ term_en: 'Ultrasound', abbreviation: 'US', synonyms: ['sonography'], owner_preferred_ar: 'السونار', origin: 'owner' });

    // the same dictionary is visible through the owning module's path (one table, one implementation)
    const viaEvidence = await lib.t.app.inject({ method: 'GET', url: '/api/evidence/terms', headers: lib.h });
    expect((viaEvidence.json().terms as MedicalTermView[]).map((t) => t.id)).toEqual([term.id]);

    const dup = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/terms', headers: lib.h, payload: { term_en: 'ultrasound' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toMatch(/موجود/);

    const invalid = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/terms', headers: lib.h, payload: { term_en: '' } });
    expect(invalid.statusCode).toBe(400);

    const patched = await lib.t.app.inject({ method: 'PATCH', url: `/api/studybook/terms/${term.id}`, headers: lib.h, payload: { owner_preferred_ar: 'الإيكو' } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().term.owner_preferred_ar).toBe('الإيكو');

    const audit = lib.t.ctx.db.all<{ action: string }>(`SELECT action FROM change_log WHERE entity_type = 'medical_term' AND entity_id = ? ORDER BY rowid`, [term.id]);
    expect(audit.map((a) => a.action)).toEqual(['create', 'update']);

    const missing = await lib.t.app.inject({ method: 'PATCH', url: '/api/studybook/terms/nope', headers: lib.h, payload: { owner_preferred_ar: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('the forwarded path keeps the session and CSRF checks', async () => {
    const anon = await lib.t.app.inject({ method: 'GET', url: '/api/studybook/terms' });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/terms', headers: { cookie: lib.h.cookie }, payload: { term_en: 'CT' } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/terms', headers: { ...lib.h, origin: 'https://evil.example' }, payload: { term_en: 'CT' } });
    expect(badOrigin.statusCode).toBe(403);
    const list = await lib.t.app.inject({ method: 'GET', url: '/api/studybook/terms', headers: lib.h });
    expect((list.json().terms as MedicalTermView[]).some((t) => t.term_en === 'CT')).toBe(false);
  });

  it('preferred renderings reach the generator as trusted preferences; the source text is never edited', async () => {
    const region = regionWith(lib.t, lib.lecture.versionId, 'Ultrasound is the first-line');
    const before = lib.t.ctx.db.get<{ text: string }>('SELECT text FROM source_region WHERE id = ?', [region.id])!.text;
    let seen = '';
    ai.once('explain', (req) => {
      seen = req.prompt;
      return content([{ kind: 'paragraph', sentences: [S.c('Ultrasound is the first-line imaging test in children.', [aliasFor(req, 'Ultrasound is the first-line')], 'directly_stated')] }]);
    });
    const res = await lib.t.app.inject({
      method: 'POST',
      url: '/api/studybook/explain',
      headers: lib.h,
      payload: { action: 'explain', style: 'short', anchor: { source_id: lib.lecture.sourceId, version_id: lib.lecture.versionId, page_id: region.page_id, region_ids: [region.id] }, scope: lectureOnly(lib) },
    });
    expect(res.statusCode, res.body).toBe(200);
    // the owner's preference is in the TRUSTED task part (after the untrusted blocks), never inside an evidence quote
    const task = seen.slice(seen.indexOf('TASK (trusted'));
    expect(task).toContain('OWNER TERMINOLOGY');
    expect(task).toContain('Ultrasound (US) → الإيكو');
    const evidencePart = seen.slice(0, seen.indexOf('TASK (trusted'));
    expect(evidencePart).not.toContain('الإيكو');
    expect(lib.t.ctx.db.get<{ text: string }>('SELECT text FROM source_region WHERE id = ?', [region.id])!.text).toBe(before);

    const del = await lib.t.app.inject({ method: 'DELETE', url: `/api/studybook/terms/${(await lib.t.app.inject({ method: 'GET', url: '/api/studybook/terms', headers: lib.h })).json().terms[0].id}`, headers: lib.h });
    expect(del.statusCode, del.body).toBe(200);
    expect((await lib.t.app.inject({ method: 'GET', url: '/api/studybook/terms', headers: lib.h })).json().terms).toEqual([]);
  });
});
