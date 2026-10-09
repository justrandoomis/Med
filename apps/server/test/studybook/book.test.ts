// Study Book (§24): sections from the processed structure, the resumable per-section job (AC-25), stable block
// keys + re-anchoring report on regeneration (AC-22), freeze, staleness on source replacement (AC-26), and
// summaries with honest coverage (§31, AC-03).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StudyBookStatusResponse, StudyBookView, SummaryPreviewResponse } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { planStudyBookSections } from '../../src/modules/studybook/book';
import { multipart } from '../sources/helpers';
import { golden } from '../sources/helpers';
import { content, lectureOnly, regionsIn, S, ScriptedAi, studyLibrary, type StudyLib } from './helpers';

const ai = new ScriptedAi();
let lib: StudyLib;
/** sections whose generator should add an exam pearl (by section title substring), toggled per test */
let pearls = true;
let hookFail: { sectionOrd: number; attempt: number } | null = null;
const hookSeen: Array<{ status: string; sectionStatus: string; blocks: number }> = [];

function bookGenerator(req: Parameters<Parameters<ScriptedAi['always']>[1]>[0]) {
  const regions = regionsIn(req.prompt);
  const blocks: unknown[] = [{ kind: 'heading', sentences: [S.n('قسم من كتاب الدراسة')] }];
  for (const r of regions) {
    if (!r.alias) continue;
    const quote = r.text.replace(/^\[E\d+\] \[R\d+\]\n/, '');
    const first = (quote.split(/(?<=[.!?؟])\s+/)[0] ?? '').trim().slice(0, 220);
    if (!first) continue;
    blocks.push({ kind: 'paragraph', sentences: [S.c(first, [r.alias], 'directly_stated')], explains_regions: [r.region] });
  }
  const firstWithEvidence = regions.find((r) => r.alias);
  if (pearls && firstWithEvidence) {
    const quote = firstWithEvidence.text.replace(/^\[E\d+\] \[R\d+\]\n/, '');
    blocks.push({ kind: 'exam_pearl', sentences: [S.c((quote.split(/(?<=[.!?؟])\s+/)[0] ?? '').trim().slice(0, 220), [firstWithEvidence.alias!], 'directly_stated')], explains_regions: [firstWithEvidence.region] });
  }
  return content(blocks);
}

beforeAll(async () => {
  lib = await studyLibrary(ai, {
    hooks: {
      beforeSectionPublish: ({ artifactId, sectionKey, attempt }) => {
        if (!hookFail) return;
        const sec = lib.t.ctx.db.get<{ ord: number; status: string }>('SELECT ord, status FROM artifact_section WHERE artifact_id = ? AND section_key = ?', [artifactId, sectionKey])!;
        if (sec.ord === hookFail.sectionOrd && attempt === hookFail.attempt) {
          const a = lib.t.ctx.db.get<{ status: string }>('SELECT status FROM artifact WHERE id = ?', [artifactId])!;
          const n = lib.t.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_block WHERE artifact_id = ? AND section_key = ?', [artifactId, sectionKey])!.n;
          hookSeen.push({ status: a.status, sectionStatus: sec.status, blocks: n });
          throw new Error('simulated crash after generation, before the section is written');
        }
      },
    },
  });
  ai.always('study_book', bookGenerator);
}, 180_000);
afterAll(async () => {
  await lib?.t.close();
});
afterEach(() => {
  if (ai.errors.length) {
    const e = ai.errors.splice(0);
    throw new Error(`scripted generator failed: ${e.map(String).join(' | ')}`);
  }
});

async function createBook(extra: Record<string, unknown> = {}): Promise<StudyBookView> {
  const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/books', headers: lib.h, payload: { source_id: lib.lecture.sourceId, scope: lectureOnly(lib), ...extra } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().book as StudyBookView;
}
async function getBook(id: string): Promise<StudyBookView> {
  return (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books/${id}`, headers: lib.h })).json() as StudyBookView;
}

let v1: StudyBookView;

describe('Study Book generation', () => {
  it('plans sections from the processed structure (deterministic, with region ids)', () => {
    const a = planStudyBookSections(lib.t.ctx, lib.lecture.versionId);
    const b = planStudyBookSections(lib.t.ctx, lib.lecture.versionId);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b);
    expect(a.every((s) => s.region_ids.length > 0 && /^s[0-9a-f]{14}$/.test(s.section_key))).toBe(true);
  });

  it('AC-25: an interrupted section is regenerated on retry; finished sections are not generated twice; nothing half-published', async () => {
    const plans = planStudyBookSections(lib.t.ctx, lib.lecture.versionId);
    hookFail = { sectionOrd: 1, attempt: 1 };
    const calls = ai.callsFor('study_book').length;
    const created = await createBook();
    expect(created.artifact).toMatchObject({ kind: 'study_book', status: 'generating', version_no: 1 });
    expect(created.progress).toMatchObject({ sections_total: plans.length, sections_complete: 0 });
    expect(created.job).toBeTruthy();
    await lib.t.ctx.jobs.drain();
    hookFail = null;
    // at the moment of the crash: still generating, the interrupted section had nothing written
    expect(hookSeen).toEqual([{ status: 'generating', sectionStatus: 'generating', blocks: 0 }]);
    v1 = await getBook(created.artifact.id);
    expect(v1.artifact.status).toBe('published');
    expect(v1.job?.status).toBe('completed');
    expect(v1.job?.attempts).toBe(2);
    expect(v1.progress).toMatchObject({ sections_total: plans.length, sections_complete: plans.length, sections_failed: 0 });
    // every section generated exactly once, except the interrupted one (twice)
    expect(ai.callsFor('study_book').length - calls).toBe(plans.length + 1);
    // no duplicates: block keys unique; per-section counts match
    const keys = v1.artifact.blocks.map((b) => b.block_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of v1.sections) expect(v1.artifact.blocks.filter((b) => b.section_key === s.section_key).length).toBe(s.block_count);
    expect(v1.artifact.coverage).toMatchObject({ sections_total: plans.length, sections_covered: plans.length });
    // blocks carry their regions and pages (Lecture Twin), claims linked
    const para = v1.artifact.blocks.find((b) => b.kind === 'paragraph')!;
    expect(para.source_region_ids.length).toBe(1);
    expect(v1.twin.find((x) => x.block_key === para.block_key)!.page_indexes.length).toBe(1);
    const cid = para.content.paragraphs[0]!.runs.find((r) => r.claim)!.claim!;
    expect(v1.artifact.claims[cid]!.verification_status).toBe('linked');
    // the per-section prompt is region-aware, ordered and says not to skip regions
    const prompt = ai.callsFor('study_book').at(-1)!.prompt;
    expect(prompt).toContain('explains_regions');
    expect(regionsIn(prompt).length).toBeGreaterThan(0);
  });

  it('serves the same request from the cache; the source view shows the book with can_generate', async () => {
    const calls = ai.callsFor('study_book').length;
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/books', headers: lib.h, payload: { source_id: lib.lecture.sourceId, scope: lectureOnly(lib) } });
    expect(res.json().cached).toBe(true);
    expect(res.json().book.artifact.id).toBe(v1.artifact.id);
    expect(ai.callsFor('study_book').length).toBe(calls);
    const st = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books?source_id=${lib.lecture.sourceId}`, headers: lib.h })).json() as StudyBookStatusResponse;
    expect(st.book?.artifact.id).toBe(v1.artifact.id);
    expect(st.can_generate).toEqual({ available: true, reason_ar: null });
  });

  it('AC-22: regeneration is a NEW version; notes keep their semantic anchors; vanished blocks are listed needs_reanchor, never moved', async () => {
    const para = v1.artifact.blocks.find((b) => b.kind === 'paragraph')!;
    const pearl = v1.artifact.blocks.find((b) => b.kind === 'exam_pearl')!;
    const noteId = newId();
    const annId = newId();
    const push = await lib.t.app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: lib.h,
      payload: {
        ops: [
          {
            op_id: newId(),
            device_id: 'dev-test',
            entity_type: 'note',
            entity_id: noteId,
            op: 'upsert',
            payload: { body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: 'ملاحظتي على الفقرة' }] }] }, anchor: { type: 'block', lineage_id: v1.artifact.lineage_id, artifact_version: 1, block_key: para.block_key } },
          },
          {
            op_id: newId(),
            device_id: 'dev-test',
            entity_type: 'annotation',
            entity_id: annId,
            op: 'append',
            payload: { kind: 'highlight', anchor: { type: 'block', lineage_id: v1.artifact.lineage_id, artifact_version: 1, block_key: pearl.block_key }, data: { color: 'yellow' }, layer: 'highlight' },
          },
        ],
      },
    });
    expect(push.json().results.map((r: { result: string }) => r.result)).toEqual(['applied', 'applied']);
    const noteBefore = lib.t.ctx.db.get<{ anchor_json: string; rev: number }>('SELECT anchor_json, rev FROM note WHERE id = ?', [noteId])!;

    pearls = false; // the regenerated content has no exam pearls
    const created = await createBook({ regenerate: true });
    expect(created.artifact).toMatchObject({ lineage_id: v1.artifact.lineage_id, version_no: 2, status: 'generating' });
    await lib.t.ctx.jobs.drain();
    pearls = true;
    const v2 = await getBook(created.artifact.id);
    expect(v2.artifact.status).toBe('published');
    // same section + regions + kind → same block keys
    expect(v2.artifact.blocks.map((b) => b.block_key)).toContain(para.block_key);
    expect(v2.artifact.blocks.map((b) => b.block_key)).not.toContain(pearl.block_key);
    expect(v2.reanchor).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_kind: 'note', target_id: noteId, status: 'matched', block_key: para.block_key }),
        expect.objectContaining({ target_kind: 'annotation', target_id: annId, status: 'needs_reanchor', block_key: pearl.block_key, previous_version_no: 1 }),
      ]),
    );
    const item = lib.t.ctx.db.get<{ reason: string }>(`SELECT reason FROM review_queue_item WHERE kind = 'needs_reanchor' AND entity_id = ? AND status = 'open'`, [annId]);
    expect(item?.reason).toContain('تحتاج إعادة ربط');
    // the owner's note and annotation were never modified
    expect(lib.t.ctx.db.get<{ anchor_json: string; rev: number }>('SELECT anchor_json, rev FROM note WHERE id = ?', [noteId])).toEqual(noteBefore);
    expect(lib.t.ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM annotation WHERE id = ?', [annId])!.deleted_at).toBeNull();
    // the previous version is superseded (not frozen)
    expect((await getBook(v1.artifact.id)).artifact.status).toBe('superseded');
    v1 = v2;
  });

  it('freeze keeps a version as the default view even when a newer one is published', async () => {
    const fr = await lib.t.app.inject({ method: 'POST', url: `/api/studybook/books/${v1.artifact.id}/freeze`, headers: lib.h, payload: { frozen: true } });
    expect(fr.json().artifact.is_frozen).toBe(true);
    const created = await createBook({ regenerate: true });
    await lib.t.ctx.jobs.drain();
    const st = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books?source_id=${lib.lecture.sourceId}`, headers: lib.h })).json() as StudyBookStatusResponse;
    expect(st.book!.artifact.id).toBe(v1.artifact.id); // the frozen version stays the default
    expect(st.book!.artifact.status).toBe('published'); // frozen → never superseded silently
    expect(st.book!.newer_version_id).toBe(created.artifact.id);
  });

  it('AC-26: a replacement upload marks the non-frozen book stale and lists it in the alert; the frozen one keeps its version', async () => {
    const latest = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/artifacts/${v1.artifact.id}`, headers: lib.h })).json().artifact;
    const newer = lib.t.ctx.db.get<{ id: string }>(`SELECT id FROM artifact WHERE lineage_id = ? AND version_no = 3`, [latest.lineage_id])!;
    const body = multipart({ note: 'نسخة مصححة (اختبار)' }, [{ name: 'appendicitis v2.pdf', data: golden('lecture_cholecystitis.pdf') }]);
    const up = await lib.t.app.inject({ method: 'POST', url: `/api/sources/${lib.lecture.sourceId}/versions`, headers: { ...lib.h, 'content-type': body.contentType }, payload: body.payload });
    expect(up.statusCode, up.body).toBe(200);
    const st = (id: string) => lib.t.ctx.db.get<{ status: string; stale_reason: string | null }>('SELECT status, stale_reason FROM artifact WHERE id = ?', [id])!;
    expect(st(newer.id).status).toBe('stale');
    expect(st(newer.id).stale_reason).toBeTruthy();
    expect(st(v1.artifact.id).status).toBe('published'); // frozen
    const alerts = (await lib.t.app.inject({ method: 'GET', url: `/api/evidence/alerts?source_id=${lib.lecture.sourceId}`, headers: lib.h })).json().alerts as Array<{ items: Array<{ id: string; frozen: boolean }> }>;
    const items = alerts.flatMap((a) => a.items);
    expect(items.some((i) => i.id === newer.id && !i.frozen)).toBe(true);
    expect(items.some((i) => i.id === v1.artifact.id && i.frozen)).toBe(true);
    // a stale artifact is never served from the cache
    const view = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/books/${newer.id}`, headers: lib.h })).json() as StudyBookView;
    expect(view.artifact.status).toBe('stale');
    // drain the replacement's processing so later tests see a processed source
    await lib.t.ctx.jobs.drain();
  });
});

describe('summaries (§31) — coverage honesty (AC-03)', () => {
  it('a page that is not processed / unreadable makes the summary NOT complete, before and after', async () => {
    // the reference: mark its second page as failed (unreadable)
    const ref = lib.reference;
    const page = lib.t.ctx.db.get<{ id: string; page_index: number }>('SELECT id, page_index FROM source_page WHERE version_id = ? ORDER BY page_index DESC LIMIT 1', [ref.versionId])!;
    lib.t.ctx.db.run(`UPDATE source_page SET processing_status = 'failed', text_status = 'failed' WHERE id = ?`, [page.id]);
    const scope = { mode: 'references_only', reference_source_ids: [ref.sourceId] };
    const prev = (await lib.t.app.inject({ method: 'POST', url: '/api/studybook/summaries/preview', headers: lib.h, payload: { type: 'detailed', source_id: ref.sourceId, scope } })).json() as SummaryPreviewResponse;
    expect(prev.will_be_complete).toBe(false);
    expect(prev.pages_unreadable).toEqual([page.page_index]);
    expect(prev.notes_ar.join(' ')).toContain('غير مقروءة');
    ai.always('summarize', bookGenerator);
    const res = await lib.t.app.inject({ method: 'POST', url: '/api/studybook/summaries', headers: lib.h, payload: { type: 'detailed', source_id: ref.sourceId, scope } });
    expect(res.statusCode, res.body).toBe(200);
    await lib.t.ctx.jobs.drain();
    const v = (await lib.t.app.inject({ method: 'GET', url: `/api/studybook/summaries/${res.json().book.artifact.id}`, headers: lib.h })).json() as StudyBookView;
    expect(v.artifact.kind).toBe('summary');
    expect(v.artifact.status).toBe('published');
    expect(v.artifact.title).not.toContain('كامل');
    expect(v.artifact.coverage!.pages_covered!).toBeLessThan(v.artifact.coverage!.pages_total!);
    expect(v.artifact.coverage!.missing_ar!.join(' ')).toContain('غير مقروءة');
    lib.t.ctx.db.run(`UPDATE source_page SET processing_status = 'ready', text_status = 'digital' WHERE id = ?`, [page.id]);
  });

  it('last-minute / high-yield are labelled as selections, not full coverage', async () => {
    const prev = (await lib.t.app.inject({
      method: 'POST',
      url: '/api/studybook/summaries/preview',
      headers: lib.h,
      payload: { type: 'last_minute', source_id: lib.reference.sourceId, scope: { mode: 'references_only', reference_source_ids: [lib.reference.sourceId] } },
    })).json() as SummaryPreviewResponse;
    expect(prev).toMatchObject({ is_selection: true, will_be_complete: false });
    expect(prev.notes_ar.join(' ')).toContain('انتقاء');
  });
});
