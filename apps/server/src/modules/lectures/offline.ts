// The official offline package of a lecture (P1-T5 step 1; ARCHITECTURE_DELTA §5.5: «official offline packages come
// from lectures/:id/offline-package», never from /api/data, which stays vault-only). The same manifest format as the
// personal Download Manager (data-api.ts `OfflineManifestResponse`, D1/AC-23) for the lecture's HEAD version, listing
// only OFFICIAL content: the source detail, the pages, each page's regions (GET answers of the space's re-mounted read
// routes, produced by those very routes in-process with the requester's own session) and the files (display PDF,
// page images, thumbnails) with exact sizes and sha256. Nobody's annotations or notes are part of it: a student's own
// ink lives in their vault copy («ابدأ الدراسة», step 2).
import { createHash } from 'node:crypto';
import {
  OFFLINE_MANIFEST_FORMAT,
  normalizeOfflinePath,
  type OfficialOfflinePackageResponse,
  type OfflineDataEntry,
  type OfflineDataRole,
  type OfflineFileEntry,
  type SourceFormat,
  type SourceType,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { notFound, type SpaceScope, visibleLecture } from './store';

export type Forward = (path: string) => Promise<{ status: number; body: string }>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function buildOfficialPackage(ctx: AppContext, scope: SpaceScope, lectureId: string, forward: Forward): Promise<OfficialOfflinePackageResponse> {
  const lecture = visibleLecture(ctx, scope, lectureId);
  if (!lecture.head_version_id || lecture.takedown_at) throw notFound(); // a draft has no official package; a takedown removed it
  const S = encodeURIComponent(scope.spaceId);
  const base = `/api/spaces/${S}`;
  const source = ctx.db.get<{ id: string; title: string; source_type: SourceType }>('SELECT id, title, source_type FROM source WHERE id = ?', [lecture.source_id])!;
  const version = ctx.db.get<{ id: string; version_no: number; format: SourceFormat; file_id: string | null; display_file_id: string | null; page_count: number | null; processing_status: string }>(
    'SELECT id, version_no, format, file_id, display_file_id, page_count, processing_status FROM source_version WHERE id = ?',
    [lecture.head_version_id],
  )!;
  const pages = ctx.db.all<{ id: string; page_index: number; render_file_id: string | null; thumbnail_file_id: string | null }>(
    'SELECT id, page_index, render_file_id, thumbnail_file_id FROM source_page WHERE version_id = ? ORDER BY page_index',
    [version.id],
  );

  const data: OfflineDataEntry[] = [];
  const fetchJson = async (role: OfflineDataRole, rawPath: string) => {
    const path = normalizeOfflinePath(rawPath);
    const res = await forward(path);
    if (res.status !== 200) throw new AppError('INTERNAL', 'تعذّر تجهيز جزء من حزمة المحاضرة على الخادم. أعد المحاولة.', 500, { path_role: role, status: res.status });
    data.push({ kind: 'data', role, path, size: Buffer.byteLength(res.body), contains_solutions: false, sha256: sha(res.body) });
  };
  const SRC = encodeURIComponent(source.id);
  await fetchJson('source_detail', `${base}/sources/${SRC}`);
  await fetchJson('pages', `${base}/sources/${SRC}/versions/${encodeURIComponent(version.id)}/pages`);
  for (const p of pages) await fetchJson('page_regions', `${base}/sources/pages/${encodeURIComponent(p.id)}/regions`);

  const files: OfflineFileEntry[] = [];
  const seen = new Set<string>();
  const addFile = (role: OfflineFileEntry['role'], id: string | null, page: { id: string; page_index: number } | null) => {
    if (!id || seen.has(`${role}:${id}`)) return;
    const f = ctx.db.get<{ id: string; sha256: string; size: number; mime: string }>('SELECT id, sha256, size, mime FROM stored_file WHERE id = ?', [id]);
    if (!f) return;
    seen.add(`${role}:${id}`);
    files.push({ kind: 'file', role, file_id: f.id, url: `${base}/files/${encodeURIComponent(f.id)}`, mime: f.mime, size: f.size, sha256: f.sha256, page_id: page?.id ?? null, page_index: page?.page_index ?? null });
  };
  const displayId = version.display_file_id ?? (version.format === 'pdf' ? version.file_id : null);
  addFile('display_pdf', displayId, null);
  if (version.format === 'image' || version.format === 'image_set') for (const p of pages) addFile('page_image', p.render_file_id, p);
  for (const p of pages) addFile('thumbnail', p.thumbnail_file_id, p);

  const entries = [...files, ...data];
  const line = (e: (typeof entries)[number]) => (e.kind === 'file' ? `file:${e.role}:${e.file_id}:${e.sha256}` : `data:${e.path}:${e.sha256}`);
  const contentHash = sha(entries.map(line).sort().join('\n'));
  const fileBytes = files.reduce((a, f) => a + f.size, 0);
  const dataBytes = data.reduce((a, d) => a + d.size, 0);
  const notes: string[] = [];
  if (!displayId && (version.format === 'docx' || version.format === 'pptx')) {
    notes.push(version.format === 'docx' ? 'ملف DOCX يُقرأ دون اتصال من نصّه وفقراته المستخرجة (لا صفحات ثابتة).' : 'لا توجد نسخة PDF للعرض لهذه الشرائح؛ تُقرأ دون اتصال من نصّها المستخرج.');
  }
  return {
    format: OFFLINE_MANIFEST_FORMAT,
    space_id: scope.spaceId,
    lecture_id: lecture.id,
    source: { id: source.id, title: lecture.title, source_type: source.source_type, format: version.format },
    version: { id: version.id, version_no: version.version_no, is_active: true, page_count: version.page_count, processing_status: version.processing_status },
    include_solutions: false,
    generated_at: ctx.clock.now(),
    content_hash: contentHash,
    source_hash: contentHash,
    entries,
    totals: { bytes: fileBytes + dataBytes, file_bytes: fileBytes, data_bytes: dataBytes, files: files.length, data: data.length, solution_bytes: 0 },
    contents: {
      pages: pages.length,
      page_images: files.filter((f) => f.role === 'page_image').length,
      has_display_pdf: files.some((f) => f.role === 'display_pdf'),
      annotations: 0,
      notes: 0,
      note_pages: 0,
      study_book: null,
      questions: { linked: 0, with_solutions: 0 },
      flashcards: 0,
      review_events: 0,
    },
    not_included_ar: [
      'هذه حزمة المحتوى الرسمي فقط: ملاحظاتك وحبرك على المحاضرة تُحفظ في نسختك الخاصة («ابدأ الدراسة») لا هنا.',
      'الشروحات المنشورة والأسئلة المرتبطة والملفات المرفقة بالمادة لا تُنزَّل مع هذه الحزمة.',
      'الشرح والأسئلة الجديدة بالذكاء الاصطناعي والبحث في المادة تحتاج اتصالًا.',
      ...notes,
    ],
  };
}
