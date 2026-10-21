// DOCX → display PDF (PRD AOS-2.4, AOS-3.14; ARCHITECTURE_DELTA §2 row 16). A DOCX keeps its paragraph pages and
// locators (the evidence of every citation, §07); LibreOffice makes a fixed-page PDF of it for reading and printing.
// The PDF is stored in `version_rendition` — never in source_version.display_file_id, whose readers assume «PDF page i
// = source page i» (false for paragraph sections). Fonts are checked in the PDF itself: every font the converter used
// must be embedded, so the PDF looks the same on a phone without those fonts.
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import type { DocxRenditionView, VersionFileRole, VersionFilesResponse, VersionFileView } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { removeStoredFileIfUnreferenced } from '../files/blobs';
import { convertToPdf, detectTools, ToolError } from '../processing/tools';
import { DOCX_DISPLAY_JOB } from '../processing/fingerprint';

export const RENDITION_ENGINE = 'LibreOffice (headless)';

const AR = {
  noSoffice: 'إنشاء نسخة عرض PDF من مستند Word يحتاج برنامج LibreOffice على الخادم، وهو غير مثبت. يبقى المستند مقروءًا كفقرات.',
  failed: 'تعذّر تحويل المستند إلى PDF. يبقى المستند مقروءًا كفقرات؛ يمكنك إعادة المحاولة.',
  timeout: 'استغرق التحويل إلى PDF وقتًا أطول من المسموح. يمكنك إعادة المحاولة.',
  remakeFailed: 'تعذّر إنشاء نسخة عرض جديدة؛ بقيت النسخة السابقة كما هي. يمكنك إعادة المحاولة.',
  notEmbedded: (names: string[]) => `بعض الخطوط غير مضمّنة في نسخة العرض (${names.join('، ')}): قد يختلف شكلها على جهاز لا يملكها.`,
};

export interface PdfFontInfo {
  name: string;
  embedded: boolean;
}

/** Page count and fonts of a PDF (embedded = the font program is inside the file). */
export async function inspectPdfFonts(pdf: Uint8Array): Promise<{ pages: number; fonts: PdfFontInfo[] }> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
  const fonts = new Map<string, boolean>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue;
    const subtype = obj.get(PDFName.of('Subtype'))?.toString();
    if (subtype === '/Type0') continue; // its CID descendant carries the descriptor
    const name = (obj.get(PDFName.of('BaseFont'))?.toString() ?? '/?').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
    let embedded = subtype === '/Type3'; // glyphs drawn inside the file
    const fdRef = obj.get(PDFName.of('FontDescriptor'));
    const fd = fdRef ? doc.context.lookup(fdRef) : undefined;
    if (fd instanceof PDFDict) embedded = ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.has(PDFName.of(k)));
    fonts.set(name, (fonts.get(name) ?? false) || embedded);
  }
  return { pages: doc.getPageCount(), fonts: [...fonts].map(([name, embedded]) => ({ name, embedded })).sort((a, b) => a.name.localeCompare(b.name)) };
}

function upsert(ctx: AppContext, versionId: string, r: { status: 'ready' | 'failed' | 'unavailable'; fileId?: string | null; pages?: number | null; fonts?: PdfFontInfo[] | null; reason?: string | null }): void {
  const now = ctx.clock.now();
  ctx.db.run(
    `INSERT INTO version_rendition (version_id, role, file_id, status, page_count, fonts_json, engine, reason, created_at, updated_at)
     VALUES (?, 'docx_display_pdf', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(version_id, role) DO UPDATE SET file_id = COALESCE(excluded.file_id, version_rendition.file_id), status = excluded.status,
       page_count = COALESCE(excluded.page_count, version_rendition.page_count), fonts_json = COALESCE(excluded.fonts_json, version_rendition.fonts_json),
       engine = excluded.engine, reason = excluded.reason, updated_at = excluded.updated_at`,
    [versionId, r.fileId ?? null, r.status, r.pages ?? null, r.fonts ? toJson(r.fonts) : null, RENDITION_ENGINE, r.reason ?? null, now, now],
  );
}

/** The job: convert one DOCX version (idempotent; a failed or missing converter is recorded honestly). */
export async function makeDocxDisplayPdf(ctx: AppContext, versionId: string, signal: AbortSignal, soffice = detectTools().soffice): Promise<{ status: string }> {
  const v = ctx.db.get<{ format: string; file_id: string | null; file_name: string | null }>('SELECT format, file_id, file_name FROM source_version WHERE id = ?', [versionId]);
  if (!v || v.format !== 'docx' || !v.file_id) return { status: 'skipped' };
  if (!soffice) {
    upsert(ctx, versionId, { status: 'unavailable', reason: AR.noSoffice });
    return { status: 'unavailable' };
  }
  // (review) a re-made display PDF replaces the previous one: the old blob is released, and a failed re-run keeps it
  const previous = ctx.db.get<{ file_id: string | null; status: string }>(`SELECT file_id, status FROM version_rendition WHERE version_id = ? AND role = 'docx_display_pdf'`, [versionId]);
  const keptPrevious = !!previous?.file_id && previous.status === 'ready' && !!ctx.files.stat(previous.file_id);
  let pdf: Buffer;
  try {
    pdf = await convertToPdf({ soffice, input: await ctx.files.read(v.file_id), inputExt: 'docx', tmpRoot: ctx.config.tmpDir, timeoutMs: 180_000, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    if (keptPrevious) upsert(ctx, versionId, { status: 'ready', reason: AR.remakeFailed });
    else upsert(ctx, versionId, { status: 'failed', reason: e instanceof ToolError && e.code === 'TOOL_TIMEOUT' ? AR.timeout : AR.failed });
    ctx.log.warn({ err: e instanceof Error ? e.message : String(e), versionId }, 'docx display conversion failed');
    return { status: 'failed' };
  }
  const info = await inspectPdfFonts(pdf);
  const base = (v.file_name ?? 'document').replace(/\.[^.]+$/, '');
  const stored = await ctx.files.put(pdf, { mime: 'application/pdf', originalName: `${base}.pdf` });
  const missing = info.fonts.filter((f) => !f.embedded).map((f) => f.name);
  upsert(ctx, versionId, { status: 'ready', fileId: stored.id, pages: info.pages, fonts: info.fonts, reason: missing.length ? AR.notEmbedded(missing) : null });
  // the replaced PDF is referenced by nothing now (kept only if something else still points at it)
  if (previous?.file_id && previous.file_id !== stored.id) removeStoredFileIfUnreferenced(ctx, previous.file_id);
  return { status: 'ready' };
}

export function renditionView(ctx: AppContext, versionId: string): DocxRenditionView | null {
  const v = ctx.db.get<{ format: string }>('SELECT format FROM source_version WHERE id = ?', [versionId]);
  if (!v || v.format !== 'docx') return null;
  const r = ctx.db.get<{ status: DocxRenditionView['status']; page_count: number | null; fonts_json: string | null; engine: string | null; reason: string | null }>(
    `SELECT status, page_count, fonts_json, engine, reason FROM version_rendition WHERE version_id = ? AND role = 'docx_display_pdf'`,
    [versionId],
  );
  const job = ctx.db.get<{ id: string; status: string }>(
    `SELECT id, status FROM processing_job WHERE kind = ? AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [DOCX_DISPLAY_JOB, versionId],
  );
  const running = job && (job.status === 'queued' || job.status === 'running');
  if (!r) {
    if (running) return { status: 'pending', reason_ar: null, page_count: null, fonts: [], engine: null, job_id: job!.id };
    const reason = detectTools().soffice ? 'لم تُنشأ نسخة عرض PDF لهذا المستند بعد.' : AR.noSoffice;
    return { status: detectTools().soffice ? 'pending' : 'unavailable', reason_ar: reason, page_count: null, fonts: [], engine: null, job_id: null };
  }
  return {
    status: running ? 'pending' : r.status,
    reason_ar: r.reason,
    page_count: r.page_count,
    fonts: fromJson<Array<{ name: string; embedded: boolean }>>(r.fonts_json, []) ?? [],
    engine: r.engine,
    job_id: running ? job!.id : null,
  };
}

/** The files of a version (original as uploaded, the file pages are read from, display PDFs) — AOS-3.14. */
export function versionFiles(ctx: AppContext, versionId: string): VersionFilesResponse {
  const v = ctx.db.get<{ id: string; format: string; file_id: string | null; original_file_id: string | null; display_file_id: string | null }>(
    'SELECT id, format, file_id, original_file_id, display_file_id FROM source_version WHERE id = ?',
    [versionId],
  );
  if (!v) throw new AppError('NOT_FOUND', 'النسخة غير موجودة.', 404);
  const files: VersionFileView[] = [];
  const seen = new Set<string>();
  const add = (role: VersionFileRole, id: string | null) => {
    if (!id || seen.has(id)) return;
    const f = ctx.db.get<{ id: string; original_name: string | null; mime: string; size: number }>('SELECT id, original_name, mime, size FROM stored_file WHERE id = ?', [id]);
    if (!f) return;
    seen.add(id);
    files.push({ role, file_id: f.id, file_name: f.original_name, mime: f.mime, size: f.size });
  };
  add('original', v.original_file_id ?? v.file_id);
  add('rendered', v.file_id);
  add('display_pdf', v.display_file_id);
  const r = ctx.db.get<{ file_id: string | null }>(`SELECT file_id FROM version_rendition WHERE version_id = ? AND role = 'docx_display_pdf' AND status = 'ready'`, [versionId]);
  add('docx_display_pdf', r?.file_id ?? null);
  return { version_id: v.id, format: v.format, files, docx_rendition: renditionView(ctx, versionId) };
}
