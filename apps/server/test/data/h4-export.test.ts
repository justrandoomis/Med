// Round 7 H4 item 6 — the full JSON export (§46 «manifest للنسخة الكاملة يربط الملفات بمعرفاتها ونسخها») must carry the
// owner's pictures placed on pages (annotation_image: image_key → stored file) and the figure readings (the model's
// derived reading AND the owner's reviewed structure, with their status) — before H4 neither table was exported, so a
// picture's key pointed at nothing in the export and an owner's figure review was lost. Still never a secret.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExportManifest } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { brainApp, call, createCourse, insertLecture, type BApp } from '../brain/helpers';

let t: BApp;
beforeAll(async () => {
  t = await brainApp();
});
afterAll(async () => t.close());

describe('full JSON export: annotation images and figure readings', () => {
  it('exports annotation_image (image_key → file id + sha256 in the manifest links) and figure_reading rows with the owner review', async () => {
    const course = (await createCourse(t, 'Export (TEST)')).id;
    const l = insertLecture(t, course, 'Fig (TEST)', [[{ kind: 'figure', text: '' }, { kind: 'caption', text: 'Figure 1: TEST flow' }]]);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
    const file = await t.ctx.files.put(png, { mime: 'image/png', originalName: 'pasted.png' });
    const now = t.ctx.clock.now();
    t.ctx.db.run(`INSERT INTO annotation_image (image_key, file_id, mime, bytes, width, height, referenced, device_id, created_at) VALUES ('IMGKEY_TEST_1', ?, 'image/png', ?, 1, 1, 1, 'DEV', ?)`, [
      file.id,
      png.length,
      now,
    ]);
    const reviewed = { type: 'diagram', nodes: [{ id: 'n1', label: 'Start', certainty: 'read' }, { id: 'n2', label: 'End', certainty: 'read' }], edges: [{ from: 'n1', to: 'n2', certainty: 'read' }], understanding: 'structure_read' };
    const readingId = newId(now);
    t.ctx.db.run(
      `INSERT INTO figure_reading (id, figure_region_id, page_id, version_id, source_id, status, structure_json, reviewed_structure_json, direction, model, created_at, updated_at, reviewed_at, review_note)
       VALUES (?, ?, ?, ?, ?, 'owner_reviewed', ?, ?, 'top_down', 'TEST-MODEL', ?, ?, ?, 'TEST review note')`,
      [readingId, l.regionIds[0]![0], l.pageIds[0], l.versionId, l.sourceId, JSON.stringify({ ...reviewed, nodes: reviewed.nodes.map((n) => ({ ...n, certainty: 'uncertain' })) }), JSON.stringify(reviewed), now, now, now],
    );
    const res = await call(t).get('/api/data/export/all?format=json');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { manifest: ExportManifest; data: Record<string, Array<Record<string, unknown>>> };
    const img = body.data.annotation_image?.find((r) => r.image_key === 'IMGKEY_TEST_1');
    expect(img).toMatchObject({ image_key: 'IMGKEY_TEST_1', file_id: file.id, mime: 'image/png', bytes: png.length });
    const fr = body.data.figure_reading?.find((r) => r.id === readingId);
    expect(fr).toMatchObject({ status: 'owner_reviewed', review_note: 'TEST review note', direction: 'top_down' });
    expect(JSON.parse(String(fr!.reviewed_structure_json))).toEqual(reviewed);
    // the manifest names each entity and links the picture's key to its file (by id AND content hash)
    expect(body.manifest.entities).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'annotation_image', id: 'IMGKEY_TEST_1' }), expect.objectContaining({ type: 'figure_reading', id: readingId })]));
    expect(body.manifest.links).toEqual(expect.arrayContaining([{ entity_type: 'annotation_image', entity_id: 'IMGKEY_TEST_1', file_id: file.id, sha256: file.sha256, role: 'image' }]));
    expect(body.manifest.files.find((f) => f.file_id === file.id)).toMatchObject({ sha256: file.sha256, mime: 'image/png' });
    expect(body.manifest.notes_ar.join(' ')).toContain('قراءات الأشكال');
    // nothing secret came along
    expect(res.body).not.toContain('password_hash');
    expect(res.body).not.toContain('token_hash');
  });
});
