// Processing test helpers. Rows are created DIRECTLY (the same contract the sources module follows:
// source + source_version + stored_file, and source_page rows for image/image_set) — the tests never
// depend on the sources upload API.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROCESS_JOB_KIND, type JobView, type ProcessJobInput, type SourceFormat } from '@medlevo/shared';
import { newId } from '../../src/lib/ids';
import { extractZipSafe } from '../../src/lib/safe-zip';
import { MODULES } from '../../src/modules';
import { createProcessingModule, type ProcessingModuleOptions } from '../../src/modules/processing';
import { createTestApp, type TestApp } from '../helpers/app';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'fixtures', 'golden');
export const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function createProcessingApp(opts: ProcessingModuleOptions = {}): Promise<TestApp> {
  return createTestApp({
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule(opts) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  zip: 'application/zip',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
};

export interface AddedSource {
  sourceId: string;
  versionId: string;
}

export interface AddSourceOptions {
  sourceType?: string;
  title?: string;
  /** store the file as an OLE2 original that needs conversion (file_id null) */
  legacy?: boolean;
  /** raw bytes instead of a fixture file */
  data?: Buffer;
  fileName?: string;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export async function addSource(t: TestApp, fixture: string, format: SourceFormat, opts: AddSourceOptions = {}): Promise<AddedSource> {
  const { ctx } = t;
  const fileName = opts.fileName ?? fixture;
  const data = opts.data ?? readFileSync(join(FIXTURES, fixture));
  const ext = fileName.split('.').pop()!.toLowerCase();
  const now = ctx.clock.now();
  const sourceId = newId(now);
  const versionId = newId(now);
  const pagination = format === 'docx' ? 'paragraphs' : format === 'pptx' ? 'slides' : format === 'image' || format === 'image_set' ? 'images' : 'pages';

  let fileId: string | null = null;
  let originalFileId: string | null = null;
  const imagePages: Array<{ fileId: string; path: string }> = [];
  if (format === 'image_set') {
    const zip = await ctx.files.put(data, { mime: 'application/zip', originalName: fileName });
    originalFileId = zip.id;
    const res = await extractZipSafe(data, { maxEntries: 100, maxTotalBytes: 50_000_000, maxRatio: 200 });
    const images = res.accepted.filter((e) => /\.(png|jpe?g)$/i.test(e.path)).sort((a, b) => naturalCompare(a.path.split('/').pop()!, b.path.split('/').pop()!));
    for (const img of images) {
      const stored = await ctx.files.put(img.data!, { mime: 'image/png', originalName: img.path.split('/').pop()! });
      imagePages.push({ fileId: stored.id, path: img.path.split('/').pop()! });
    }
  } else {
    const stored = await ctx.files.put(data, { mime: MIME[ext] ?? 'application/octet-stream', originalName: fileName });
    if (opts.legacy) originalFileId = stored.id;
    else fileId = stored.id;
  }
  if (format === 'image' && fileId) imagePages.push({ fileId, path: fileName });

  ctx.db.tx(() => {
    ctx.db.run(`INSERT INTO source (id, title, source_type, processing_status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`, [
      sourceId,
      opts.title ?? `TEST FIXTURE ${fixture}`,
      opts.sourceType ?? 'lecture',
      now,
      now,
    ]);
    ctx.db.run(
      `INSERT INTO source_version (id, source_id, version_no, kind, file_id, original_file_id, content_hash, mime, file_name, format, pagination, processing_status, created_at)
       VALUES (?, ?, 1, 'original', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [versionId, sourceId, fileId, originalFileId, newId(now), MIME[ext] ?? 'application/octet-stream', fileName, format, opts.legacy && ext === 'ppt' ? 'slides' : pagination, now],
    );
    ctx.db.run('UPDATE source SET current_version_id = ? WHERE id = ?', [versionId, sourceId]);
    imagePages.forEach((p, i) => {
      ctx.db.run(
        `INSERT INTO source_page (id, version_id, page_index, kind, render_file_id, section_key, created_at, updated_at) VALUES (?, ?, ?, 'image', ?, ?, ?, ?)`,
        [newId(now), versionId, i, p.fileId, p.path, now, now],
      );
    });
  });
  return { sourceId, versionId };
}

export async function processVersion(t: TestApp, versionId: string, extra: Partial<ProcessJobInput> = {}): Promise<JobView> {
  const job = t.ctx.jobs.enqueue(PROCESS_JOB_KIND, { version_id: versionId, reason: 'upload', ...extra });
  await t.ctx.jobs.drain();
  return t.ctx.jobs.get(job.id)!;
}

export interface RegionRow {
  id: string;
  page_id: string;
  page_index: number;
  parent_region_id: string | null;
  kind: string;
  reading_order: number;
  text: string | null;
  text_origin: string | null;
  status: string;
  confidence: number | null;
  bbox_json: string | null;
  locator_json: string | null;
  structure_json: string | null;
}

export function regions(t: TestApp, versionId: string, pageIndex?: number): RegionRow[] {
  return t.ctx.db.all<RegionRow>(
    `SELECT r.id, r.page_id, p.page_index, r.parent_region_id, r.kind, r.reading_order, r.text, r.text_origin, r.status, r.confidence,
            r.bbox_json, r.locator_json, r.structure_json
       FROM source_region r JOIN source_page p ON p.id = r.page_id
      WHERE r.version_id = ? ${pageIndex === undefined ? '' : 'AND p.page_index = ?'}
      ORDER BY p.page_index, r.reading_order`,
    pageIndex === undefined ? [versionId] : [versionId, pageIndex],
  );
}

export interface PageRowT {
  id: string;
  page_index: number;
  printed_label: string | null;
  printed_label_origin: string | null;
  kind: string;
  width: number | null;
  height: number | null;
  unit: string | null;
  text_status: string;
  processing_status: string;
  ocr_confidence: number | null;
  error_code: string | null;
  error_detail: string | null;
  render_file_id: string | null;
  section_key: string | null;
}

export function pages(t: TestApp, versionId: string): PageRowT[] {
  return t.ctx.db.all<PageRowT>(
    `SELECT id, page_index, printed_label, printed_label_origin, kind, width, height, unit, text_status, processing_status, ocr_confidence,
            error_code, error_detail, render_file_id, section_key
       FROM source_page WHERE version_id = ? ORDER BY page_index`,
    [versionId],
  );
}

export function pageText(t: TestApp, versionId: string, pageIndex: number): string {
  return regions(t, versionId, pageIndex)
    .map((r) => r.text ?? '')
    .join('\n');
}
