// Download Manager — server side (§47, AC-23). For one source version, lists EVERYTHING the study workspace needs to
// work without a connection, with exact sizes and hashes:
//   files: the display PDF (or page images for image sources) and thumbnails
//   data:  the exact GET answers the app requests (source detail, pages, each page's regions, the owner's
//          annotations / notes / last session / reading progress, the Study Book for the version with its claims
//          and evidence views, the lecture's linked questions and — when asked — their details WITH solutions,
//          flashcards + review events made from the source).
// The data answers are produced by the real routes (forwarded in-process with the owner's own cookie), so an
// offline copy is byte-for-byte what the app would have received online — no second implementation of any view.
import { createHash } from 'node:crypto';
import {
  OFFLINE_MANIFEST_FORMAT,
  normalizeOfflinePath,
  type LectureQuestionsResponse,
  type OfflineBundleEntry,
  type OfflineDataEntry,
  type OfflineDataRole,
  type OfflineFileEntry,
  type OfflineLearningResponse,
  type OfflineManifestResponse,
  type SourceAnnotationsResponse,
  type StudyBookStatusResponse,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { AppError } from '../../lib/errors';

/** GET the given path in-process as the owner (status + raw body). */
export type Forward = (path: string) => Promise<{ status: number; body: string }>;

interface SourceRow {
  id: string;
  title: string;
  source_type: OfflineManifestResponse['source']['source_type'];
  current_version_id: string | null;
  frozen_version_id: string | null;
  deleted_at: number | null;
}
interface VersionRow {
  id: string;
  source_id: string;
  version_no: number;
  format: OfflineManifestResponse['source']['format'];
  file_id: string | null;
  display_file_id: string | null;
  page_count: number | null;
  processing_status: string;
}
interface PageRow {
  id: string;
  page_index: number;
  render_file_id: string | null;
  thumbnail_file_id: string | null;
}
interface FileRow {
  id: string;
  sha256: string;
  size: number;
  mime: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function resolveOfflineTarget(ctx: AppContext, sourceId: string, versionId?: string | null): { source: SourceRow; version: VersionRow; activeId: string | null } {
  const source = ctx.db.get<SourceRow>('SELECT id, title, source_type, current_version_id, frozen_version_id, deleted_at FROM source WHERE id = ?', [sourceId]);
  if (!source) throw new AppError('NOT_FOUND', 'المصدر غير موجود.', 404);
  if (source.deleted_at) throw new AppError('CONFLICT', 'المصدر في سلة المحذوفات؛ استعده أولًا ثم نزّله.', 409);
  const activeId = source.frozen_version_id ?? source.current_version_id;
  const vid = versionId ?? activeId;
  if (!vid) throw new AppError('CONFLICT', 'لا يوجد إصدار قابل للتنزيل لهذا المصدر بعد.', 409);
  const version = ctx.db.get<VersionRow>(
    'SELECT id, source_id, version_no, format, file_id, display_file_id, page_count, processing_status FROM source_version WHERE id = ?',
    [vid],
  );
  if (!version || version.source_id !== source.id) throw new AppError('NOT_FOUND', 'الإصدار المطلوب لا يخص هذا المصدر.', 404);
  return { source, version, activeId };
}

/** Flashcards made from the source + their review events (read-only, for offline review). */
export function learningForSource(ctx: AppContext, sourceId: string): OfflineLearningResponse {
  const cards = ctx.db.all<{
    id: string;
    kind: string;
    front_json: string;
    back_json: string;
    source_id: string | null;
    source_version_id: string | null;
    evidence_ids_json: string;
    origin: string;
    suspended: number;
    rev: number;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  }>('SELECT * FROM flashcard WHERE source_id = ? AND deleted_at IS NULL ORDER BY created_at, id', [sourceId]);
  const ids = cards.map((c) => c.id);
  const events: OfflineLearningResponse['review_events'] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    events.push(
      ...ctx.db.all<OfflineLearningResponse['review_events'][number]>(
        `SELECT id, card_id, rating, reviewed_at, duration_ms, device_id FROM review_event WHERE card_id IN (${chunk.map(() => '?').join(',')}) ORDER BY reviewed_at, id`,
        chunk,
      ),
    );
  }
  return {
    source_id: sourceId,
    flashcards: cards.map((c) => ({
      id: c.id,
      kind: c.kind,
      front: fromJson(c.front_json),
      back: fromJson(c.back_json),
      source_id: c.source_id,
      source_version_id: c.source_version_id,
      evidence_ids: fromJson<string[]>(c.evidence_ids_json, []) ?? [],
      origin: c.origin,
      suspended: !!c.suspended,
      rev: c.rev,
      created_at: c.created_at,
      updated_at: c.updated_at,
      deleted_at: c.deleted_at,
    })),
    review_events: events,
  };
}

interface Built {
  manifest: OfflineManifestResponse;
  bundle: OfflineBundleEntry[];
}

export async function buildOfflinePackage(
  ctx: AppContext,
  forward: Forward,
  opts: { sourceId: string; versionId?: string | null; includeSolutions: boolean },
): Promise<Built> {
  const { source, version, activeId } = resolveOfflineTarget(ctx, opts.sourceId, opts.versionId);
  const S = encodeURIComponent(source.id);
  const V = encodeURIComponent(version.id);
  const pages = ctx.db.all<PageRow>('SELECT id, page_index, render_file_id, thumbnail_file_id FROM source_page WHERE version_id = ? ORDER BY page_index', [version.id]);

  const data: Array<OfflineDataEntry & { body: unknown }> = [];
  const notes_ar: string[] = [];

  const fetchJson = async (role: OfflineDataRole, rawPath: string, o: { optional?: boolean; solutions?: boolean } = {}): Promise<unknown> => {
    const path = normalizeOfflinePath(rawPath);
    const res = await forward(path);
    if (res.status !== 200) {
      if (o.optional) return null;
      throw new AppError('INTERNAL', 'تعذّر تجهيز جزء من محتوى التنزيل على الخادم. أعد المحاولة.', 500, { path_role: role, status: res.status });
    }
    const body = JSON.parse(res.body) as unknown;
    data.push({ kind: 'data', role, path, size: Buffer.byteLength(res.body), contains_solutions: !!o.solutions, sha256: sha(res.body), body });
    return body;
  };

  await fetchJson('source_detail', `/api/sources/${S}`);
  await fetchJson('pages', `/api/sources/${S}/versions/${V}/pages`);
  for (const p of pages) await fetchJson('page_regions', `/api/sources/pages/${encodeURIComponent(p.id)}/regions`);
  const ann = (await fetchJson('annotations', `/api/annotations/source/${S}?version_id=${V}`, { optional: true })) as SourceAnnotationsResponse | null;
  const notes = (await fetchJson('notes', `/api/annotations/notes?source_id=${S}`, { optional: true })) as { notes: unknown[] } | null;
  await fetchJson('needs_reanchor', `/api/annotations/needs-reanchor?source_id=${S}`, { optional: true });
  await fetchJson('latest_session', `/api/annotations/sessions/latest?source_id=${S}`, { optional: true });
  await fetchJson('reading_progress', `/api/annotations/progress/${S}`, { optional: true });

  // Study Book: the default view for the source (frozen > published > latest) — only if it belongs to THIS version
  let studyBook: OfflineManifestResponse['contents']['study_book'] = null;
  const bookStatus = (await fetchJson('study_book_status', `/api/studybook/books?source_id=${S}`, { optional: true })) as StudyBookStatusResponse | null;
  const book = bookStatus?.book ?? null;
  if (book) {
    const forVersion = book.artifact.scope.version_ids.includes(version.id);
    if (forVersion) {
      await fetchJson('study_book', `/api/studybook/books/${encodeURIComponent(book.artifact.id)}`, { optional: true });
      studyBook = {
        artifact_id: book.artifact.id,
        version_no: book.artifact.version_no,
        status: book.artifact.status,
        blocks: book.artifact.blocks.length,
        is_frozen: book.artifact.is_frozen,
      };
    } else {
      notes_ar.push('كتاب الدراسة المتاح مبني على إصدار آخر من المصدر، لذلك لم يُضمَّن مع هذا الإصدار.');
    }
  } else if (bookStatus) {
    notes_ar.push('لا يوجد كتاب دراسة منشور لهذا المصدر بعد.');
  }

  // Questions linked to the lecture (this page / other pages / course-only) + details with solutions on request
  let linked = 0;
  let withSolutions = 0;
  const lectureQs = (await fetchJson('lecture_questions', `/api/questions/for-lecture/${S}`, { optional: true })) as LectureQuestionsResponse | null;
  if (lectureQs) {
    for (const p of pages) await fetchJson('lecture_questions', `/api/questions/for-lecture/${S}?page_id=${encodeURIComponent(p.id)}`, { optional: true });
    const ids = [...new Set(lectureQs.items.map((i) => i.question_id))];
    linked = ids.length;
    if (opts.includeSolutions) {
      for (const qid of ids) {
        if (await fetchJson('question_detail', `/api/questions/${encodeURIComponent(qid)}`, { optional: true, solutions: true })) withSolutions++;
      }
    } else if (ids.length) {
      notes_ar.push('اخترت عدم تنزيل حلول الأسئلة: تظهر قائمة الأسئلة المرتبطة دون مفاتيح الإجابة.');
    }
  }

  // this module's own view: built directly (the same JSON the route serialises), not forwarded — a forwarded call
  // would count against the route's per-address rate limit and could fail a download for no real reason
  const learning = learningForSource(ctx, source.id);
  {
    const body = JSON.stringify(learning);
    data.push({ kind: 'data', role: 'learning', path: normalizeOfflinePath(`/api/data/offline/${S}/learning`), size: Buffer.byteLength(body), contains_solutions: false, sha256: sha(body), body: learning });
  }

  // files
  const fileRow = (id: string) => ctx.db.get<FileRow>('SELECT id, sha256, size, mime FROM stored_file WHERE id = ?', [id]);
  const files: OfflineFileEntry[] = [];
  const seenFiles = new Set<string>();
  const addFile = (role: OfflineFileEntry['role'], id: string | null, page: PageRow | null) => {
    if (!id || seenFiles.has(`${role}:${id}`)) return;
    const f = fileRow(id);
    if (!f) return;
    seenFiles.add(`${role}:${id}`);
    files.push({ kind: 'file', role, file_id: f.id, url: `/api/files/${encodeURIComponent(f.id)}`, mime: f.mime, size: f.size, sha256: f.sha256, page_id: page?.id ?? null, page_index: page?.page_index ?? null });
  };
  const displayId = version.display_file_id ?? (version.format === 'pdf' ? version.file_id : null);
  addFile('display_pdf', displayId, null);
  if (version.format === 'image' || version.format === 'image_set') {
    for (const p of pages) addFile('page_image', p.render_file_id, p);
  }
  for (const p of pages) addFile('thumbnail', p.thumbnail_file_id, p);
  if (!displayId && (version.format === 'docx' || version.format === 'pptx')) {
    notes_ar.push(version.format === 'docx' ? 'ملف DOCX يُقرأ دون اتصال من نصّه وفقراته المستخرجة (لا صفحات ثابتة).' : 'لا توجد نسخة PDF للعرض لهذه الشرائح؛ تُقرأ دون اتصال من نصّها المستخرج.');
  }

  const entries = [...files, ...data.map(({ body: _b, ...e }) => e)];
  const fileBytes = files.reduce((a, f) => a + f.size, 0);
  const dataBytes = data.reduce((a, d) => a + d.size, 0);
  const contentHash = sha(
    entries
      .map((e) => (e.kind === 'file' ? `file:${e.role}:${e.file_id}:${e.sha256}` : `data:${e.path}:${e.sha256}`))
      .sort()
      .join('\n'),
  );

  const not_included_ar = [
    'الشرح والأسئلة والملخصات الجديدة بالذكاء الاصطناعي تحتاج اتصالًا (لا تعمل دون اتصال ولا تُعرض أي «معالجة» وهمية).',
    'البحث الخارجي ومعالجة ملفات جديدة على الخادم تحتاج اتصالًا.',
    'المراجع والمصادر الأخرى التي يستشهد بها كتاب الدراسة لا تُنزَّل مع هذا المصدر؛ الاستشهاد بصفحة غير محمّلة يقول ذلك صراحة.',
    'الأصل الذي استُخرج منه كل سؤال (ملف مصدر الأسئلة) لا يُنزَّل هنا؛ نزّل مصدر الأسئلة نفسه إن احتجته.',
    ...notes_ar,
  ];

  const manifest: OfflineManifestResponse = {
    format: OFFLINE_MANIFEST_FORMAT,
    source: { id: source.id, title: source.title, source_type: source.source_type, format: version.format },
    version: { id: version.id, version_no: version.version_no, is_active: version.id === activeId, page_count: version.page_count, processing_status: version.processing_status },
    include_solutions: opts.includeSolutions,
    generated_at: ctx.clock.now(),
    content_hash: contentHash,
    entries,
    totals: {
      bytes: fileBytes + dataBytes,
      file_bytes: fileBytes,
      data_bytes: dataBytes,
      files: files.length,
      data: data.length,
      solution_bytes: data.filter((d) => d.contains_solutions).reduce((a, d) => a + d.size, 0),
    },
    contents: {
      pages: pages.length,
      page_images: files.filter((f) => f.role === 'page_image').length,
      has_display_pdf: files.some((f) => f.role === 'display_pdf'),
      annotations: ann?.annotations.length ?? 0,
      notes: notes?.notes.length ?? 0,
      note_pages: ann?.note_pages.length ?? 0,
      study_book: studyBook,
      questions: { linked, with_solutions: withSolutions },
      flashcards: learning.flashcards.length,
      review_events: learning.review_events.length,
    },
    not_included_ar,
  };
  return { manifest, bundle: data.map((d) => ({ path: d.path, role: d.role, contains_solutions: d.contains_solutions, sha256: d.sha256, body: d.body })) };
}
