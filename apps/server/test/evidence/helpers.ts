// Evidence / search test helpers: Golden Set fixtures processed by the REAL pipeline (processing helpers),
// plus small SQL builders for rows owned by other tracks (artifacts, links) that the tests need.
import { newId } from '../../src/lib/ids';
import type { AiProvider } from '../../src/modules/ai/types';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';
import { addSource, processVersion, type AddedSource } from '../processing/helpers';

export interface GoldenLibrary {
  t: TestApp;
  h: AuthHeaders;
  lecture: AddedSource;
  reference: AddedSource;
  questions: AddedSource;
}

export async function createEvidenceApp(ai?: AiProvider | null): Promise<TestApp> {
  return createTestApp({
    ai: ai ?? null,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
}

/** Appendicitis lecture + cholecystitis course reference + question source, all processed for real. */
export async function goldenLibrary(ai?: AiProvider | null): Promise<GoldenLibrary> {
  const t = await createEvidenceApp(ai);
  const lecture = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Acute Appendicitis (TEST FIXTURE)' });
  const reference = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf', { sourceType: 'course_reference', title: 'Cholecystitis reference (TEST FIXTURE)' });
  const questions = await addSource(t, 'questions_surgery_course1.pdf', 'pdf', { sourceType: 'question_source', title: 'Surgery question bank (TEST FIXTURE)' });
  for (const s of [lecture, reference, questions]) {
    const job = await processVersion(t, s.versionId);
    if (job.status !== 'completed' && job.status !== 'partial') throw new Error(`processing failed: ${job.status}`);
  }
  const h = await t.login();
  return { t, h, lecture, reference, questions };
}

export interface RegionLite {
  id: string;
  text: string;
  page_id: string;
  page_index: number;
  kind: string;
}

/** The (first) region of a version whose text contains `needle`. */
export function regionWith(t: TestApp, versionId: string, needle: string, kind?: string): RegionLite {
  const rows = t.ctx.db.all<RegionLite>(
    `SELECT r.id, r.text, r.page_id, p.page_index, r.kind FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? AND r.text LIKE ? ${kind ? 'AND r.kind = ?' : ''} ORDER BY p.page_index, r.reading_order`,
    kind ? [versionId, `%${needle}%`, kind] : [versionId, `%${needle}%`],
  );
  if (!rows[0]) throw new Error(`no region containing ${needle}`);
  return rows[0];
}

export function linkReference(t: TestApp, lectureId: string, referenceId: string): void {
  t.ctx.db.run(`INSERT INTO source_link (id, from_source_id, to_source_id, relation, created_at) VALUES (?, ?, ?, 'reference_for', ?)`, [
    newId(),
    referenceId,
    lectureId,
    t.ctx.clock.now(),
  ]);
}

/** A published artifact row (owned by the study-book track; created directly for dependency tests). */
export function insertArtifact(t: TestApp, opts: { sourceId: string; title?: string; frozen?: boolean; status?: string }): string {
  const id = newId();
  const now = t.ctx.clock.now();
  t.ctx.db.run(
    `INSERT INTO artifact (id, lineage_id, version_no, kind, title, primary_source_id, scope_json, params_json, cache_key, rules_version, generator_version, verifier_version, status, is_frozen, created_at, published_at, updated_at)
     VALUES (?, ?, 1, 'explanation', ?, ?, '{}', '{}', ?, 'r', 'g', 'v', ?, ?, ?, ?, ?)`,
    [id, id, opts.title ?? 'Test explanation', opts.sourceId, `key-${id}`, opts.status ?? 'published', opts.frozen ? 1 : 0, now, now, now],
  );
  return id;
}

/** A second version of a source that renders from the SAME file (same text, different version) — layout-only change. */
export function cloneVersion(t: TestApp, sourceId: string, fromVersionId: string, opts: { makeCurrent?: boolean } = {}): string {
  const v = t.ctx.db.get<{ file_id: string; mime: string; file_name: string; format: string; pagination: string }>(
    'SELECT file_id, mime, file_name, format, pagination FROM source_version WHERE id = ?',
    [fromVersionId],
  )!;
  const no = (t.ctx.db.get<{ m: number }>('SELECT MAX(version_no) AS m FROM source_version WHERE source_id = ?', [sourceId])?.m ?? 0) + 1;
  const id = newId();
  t.ctx.db.run(
    `INSERT INTO source_version (id, source_id, version_no, kind, derived_from_version_id, file_id, content_hash, mime, file_name, format, pagination, processing_status, created_at)
     VALUES (?, ?, ?, 'replacement', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, sourceId, no, fromVersionId, v.file_id, newId(), v.mime, v.file_name, v.format, v.pagination, t.ctx.clock.now()],
  );
  if (opts.makeCurrent !== false) t.ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [id, sourceId]);
  return id;
}
