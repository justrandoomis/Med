// process_source_version job (§13 pipeline): Inspect → Extract/Render → OCR when needed → Layout &
// Visual → Structure → Index → Validate. Real progress in pages; per-page checkpoints so a retry resumes
// without duplicating rows (AC-25); a failing page never fails the whole version (AC-03); an image page
// is never treated as empty (AC-02); diagram relations are never invented (AC-08).
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ProcessJobInput, ProcessingStatus, ProcessingSummary, SourceFormat } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { isJobError, JobError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import type { JobRun, PartialResult } from '../jobs/queue';
import { buildChunks, writeChunks } from './chunks';
import { buildSegments, logicalLineText } from './layout/lines';
import {
  analyzePage,
  bandLines,
  detectPrintedLabels,
  inBottomBand,
  inTopBand,
  OCR_REVIEW_WORD_CONF,
  repeatedBandSignatures,
  type BandLine,
} from './layout/page';
import { serializeTable } from './layout/tables';
import type { Box, DiagramLabel, FigureCandidate, LayoutRegion, PageGeom, TextItem } from './layout/types';
import { boxOf, median } from './layout/types';
import { missedTextSegments, type MissedText } from './coverage';
import type { OcrEngine, OcrResult, OcrWord } from './ocr';
import { extractDocx, extractPptx, type OfficeDocument } from './office';
import { closePdf, extractPage, openPdf, pageLabels, PdfOpenError, pageTextItems, pageView, type PageView } from './pdf';
import { markPageFailed, persistPage, RegionsInUseError, type FigureAsset, type PageRef, type PageUpdate, type ReviewItemInput } from './persist';
import { decodePng, imageSize, isPng, measureImageQuality, type ImageQuality, type RgbaImage } from './png';
import { applyLectureKind, linkFiguresAcrossPages } from './structure';
import { writeSummary } from './summary';
import { hasReversedLamAlef, prepareRegionText, suspicionReasonAr, type SuspicionContext } from './text';
import { convertToPdf, popplerReportsDamage, renderPdfPage, ToolError, type ToolPaths } from './tools';

export const PIPELINE_VERSION = 'process-v1';
export const MAX_ATTEMPTS = 3;
export const RENDER_DPI = 200;
/** pixel budget of one page render (a huge /MediaBox must not produce a multi-gigapixel raster) */
export const MAX_RENDER_PIXELS = 36_000_000;
/** images larger than this are not sent to OCR (memory); they are kept as figures and flagged */
export const MAX_OCR_PIXELS = 40_000_000;

/** Render resolution for a page of `width`×`height` pt: RENDER_DPI unless that exceeds the pixel budget. */
export function renderDpi(width: number, height: number): number {
  const area = Math.max(1, width) * Math.max(1, height);
  const capped = Math.floor(72 * Math.sqrt(MAX_RENDER_PIXELS / area));
  return Math.max(8, Math.min(RENDER_DPI, capped));
}
/** below this many body characters a page is treated as "no digital text" */
export const MIN_BODY_CHARS = 25;

export interface ProcessingHooks {
  /** TEST-ONLY fault injection (never set in production): runs before a page is processed */
  beforePage?: (pageIndex: number, attempt: number) => void | Promise<void>;
  /** TEST-ONLY: runs after a page was persisted but before its checkpoint is recorded */
  afterPagePersist?: (pageIndex: number, attempt: number) => void | Promise<void>;
}

export interface ProcessorDeps {
  ctx: AppContext;
  tools: ToolPaths;
  /** null when the OCR models are not installed */
  ocr: OcrEngine | null;
  hooks: ProcessingHooks;
}

export interface PageOutcome {
  page_index: number;
  status: 'ready' | 'needs_review' | 'failed';
  text_status: string;
  regions: number;
  review_items: number;
  ocr: boolean;
  ligature_fixes: number;
  error_code: string | null;
}

export interface ProcessOutput {
  version_id: string;
  status: ProcessingStatus;
  summary: ProcessingSummary;
  pages_processed: number[];
  ligature_fixes: number;
  chunks: { inserted: number; deleted: number; kept: number };
  lecture_kind: string | null;
  warnings_ar: string[];
}

interface VersionRow {
  id: string;
  source_id: string;
  file_id: string | null;
  original_file_id: string | null;
  display_file_id: string | null;
  mime: string;
  file_name: string | null;
  format: SourceFormat;
  pagination: string;
}

interface PageRow {
  id: string;
  page_index: number;
  printed_label: string | null;
  kind: string;
  width: number | null;
  height: number | null;
  unit: string | null;
  rotation: number;
  render_file_id: string | null;
  section_key: string | null;
}

interface InspectResult {
  format: SourceFormat;
  fileId: string | null;
  pageCount: number;
  bodySize: number | null;
  repeated: string[];
  warnings_ar: string[];
  /** the PDF text layer reverses lam-alef ligatures (absent in checkpoints written before this field) */
  reversedLamAlef?: boolean;
}

interface OcrCheckpoint {
  renderFileId: string | null;
  /** resolution of the render the word boxes refer to (absent in older checkpoints → RENDER_DPI) */
  dpi?: number;
  pxWidth: number | null;
  pxHeight: number | null;
  words: OcrWord[];
  confidence: number | null;
  quality: Pick<ImageQuality, 'lowQuality' | 'reasons' | 'contrast' | 'edgeSharpness' | 'blank'> | null;
  /** G3 / AC-08: places with writing that no OCR word covers (absent in older checkpoints) */
  missed?: MissedText[];
}

/** A page-level failure with a specific Arabic reason (the page is marked failed; other pages continue). */
export class PageFailure extends Error {
  constructor(
    readonly code: string,
    readonly reasonAr: string,
  ) {
    super(code);
    this.name = 'PageFailure';
  }
}

const MSG = {
  versionMissing: 'النسخة المطلوب معالجتها غير موجودة؛ ربما حُذفت نهائيًا.',
  fileMissing: 'لا يوجد ملف مرتبط بهذه النسخة، لذلك لا يمكن معالجتها.',
  pdfPassword: 'ملف PDF محمي بكلمة مرور، لذلك لا يمكن قراءته. أزل الحماية ثم ارفع الملف من جديد.',
  pdfInvalid: 'تعذر فتح ملف PDF: الملف تالف أو ليس PDF صالحًا.',
  officeInvalid: 'تعذرت قراءة الملف: بنية المستند تالفة أو غير مدعومة.',
  converterMissing:
    'تحويل ملفات Word/PowerPoint القديمة (.doc/.ppt) يحتاج LibreOffice على الخادم، وهو غير مثبت. احفظ الملف بصيغة DOCX/PPTX أو PDF ثم ارفعه.',
  conversionTimeout: 'استغرق تحويل الملف بـLibreOffice وقتًا أطول من المسموح فأُوقف التحويل. ستُعاد المحاولة تلقائيًا.',
  conversionFailed: 'فشل LibreOffice في تحويل الملف إلى PDF؛ قد يكون الملف تالفًا أو محميًا بكلمة مرور.',
  noImages: 'لا توجد صور مسجلة في هذه المجموعة لمعالجتها.',
  formatUnsupported: 'هذه الصيغة لا تمر عبر معالجة المستندات (مثل التسجيلات الصوتية).',
  ocrModelsMissing:
    'تحتاج هذه الصفحة التعرف الضوئي على النص (OCR)، لكن نماذج OCR (eng/ara) غير موجودة على الخادم. لم تُعامل الصفحة كصفحة فارغة.',
  rendererMissing:
    'هذه الصفحة صورة ممسوحة وتحتاج OCR، لكن أداة تحويل صفحات PDF إلى صور (poppler: pdftoppm) غير مثبتة على الخادم. لم تُعامل الصفحة كصفحة فارغة.',
  blankUnverified:
    'لا يوجد نص رقمي ولا صور في هذه الصفحة، وتعذّر التحقق بصريًا من أنها فارغة لأن pdftoppm غير مثبت. راجعها في القارئ.',
  contentDamaged:
    'محتوى هذه الصفحة في الملف تالف جزئيًا (تعذّر فك بعض بياناتها)، لذلك تظهر فارغة ولم يُقرأ منها أي نص. لا تُعامل كصفحة فارغة؛ راجعها أو أضف نسخة سليمة من الملف. بقية الصفحات لم تتأثر.',
  noTextFound:
    'هذه الصفحة صورة، لكن التعرف الضوئي (OCR) لم يجد فيها نصًا مقروءًا. قد تكون رسمًا فقط أو مسحًا رديئًا؛ راجعها أو أضف نسخة أوضح.',
  renderFailed: 'تعذر تحويل هذه الصفحة إلى صورة لإجراء OCR (pdftoppm). بقية الصفحات لم تتأثر.',
  ocrFailed: 'فشل محرك التعرف الضوئي (OCR) في قراءة هذه الصفحة. بقية الصفحات لم تتأثر؛ أعد معالجة الصفحة لاحقًا.',
  regionsInUse:
    'لا يمكن استبدال مناطق هذه الصفحة لأن أدلة أو علامات مرتبطة بها بالفعل؛ أُبقي على النسخة السابقة من الصفحة. أنشئ نسخة مصححة من المصدر بدل إعادة معالجتها.',
  interrupted:
    'توقفت المعالجة قبل اكتمال هذه الصفحة (أُلغيت المهمة أو انتهت مهلتها). أي محتوى سابق للصفحة بقي كما هو؛ أعد معالجة الصفحة.',
  ownerReviewed:
    'راجعتَ أو صحّحتَ مناطق في هذه الصفحة بنفسك، لذلك لم تُستبدل بنتيجة استخراج جديدة؛ أُبقي على النسخة السابقة من الصفحة. أنشئ نسخة مصححة من المصدر إذا أردت إعادة استخراجها.',
  imageMissing: 'ملف الصورة لهذه الصفحة غير موجود في التخزين.',
  imageTooLarge: (mp: number) =>
    `الصورة كبيرة جدًا (${mp} ميغابكسل) لقراءتها بالتعرف الضوئي (OCR) على هذا الخادم؛ حُفظت كصورة دون قراءة نصها. صغّر الصورة أو قسّمها ثم ارفعها من جديد.`,
  sectionMissing: 'لم يُعثر على هذا القسم في المستند عند إعادة قراءته.',
  unexpected: 'حدث خطأ غير متوقع أثناء معالجة هذه الصفحة؛ بقية الصفحات لم تتأثر. أعد معالجة الصفحة لاحقًا.',
  pptxDisplayFailed: 'تعذر إنشاء نسخة العرض الثابتة (PDF) للعرض التقديمي بـLibreOffice؛ الشرائح ونصوصها مستخرجة رغم ذلك.',
  pptxDisplayMissing: 'لم تُنشأ نسخة عرض ثابتة (PDF) للعرض التقديمي لأن LibreOffice غير مثبت؛ الشرائح ونصوصها مستخرجة رغم ذلك.',
  textNotRead: (n: number) =>
    `في الصورة كتابة لم يقرأها التعرف الضوئي (${n === 1 ? 'موضع واحد' : n === 2 ? 'موضعان' : `${n} مواضع`})؛ قد يكون النص أو الخيارات ناقصة. قارن بالصورة الأصلية وأضف ما نقص قبل الاعتماد عليه.`,
  lowQuality: (reasons: string[]) =>
    `جودة الصورة منخفضة (${reasons.join('، ')})، لذلك قد يحتوي النص المستخرج بالـOCR على أخطاء لا تظهر في درجة الثقة. راجع النص مقابل الصورة الأصلية قبل الاعتماد عليه.`,
  lowConfidence: (min: number, words: string[]) =>
    `ثقة التعرف الضوئي منخفضة (${Math.round(min)}٪ لأضعف كلمة)${words.length ? ` في: «${words.slice(0, 6).join('»، «')}»` : ''}. قارن النص بصورة الصفحة الأصلية قبل الاعتماد عليه.`,
};

const QUALITY_REASON_AR: Record<'low_contrast' | 'blurred', string> = { low_contrast: 'تباين ضعيف', blurred: 'ضبابية' };

function area(b: Box): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.bottom - b.top);
}

function clip(b: Box, g: PageGeom): Box {
  return { x0: Math.max(0, b.x0), top: Math.max(0, b.top), x1: Math.min(g.width, b.x1), bottom: Math.min(g.height, b.bottom) };
}

function mergeBoxes(boxes: Box[]): Box[] {
  const out = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.top <= b.bottom && b.top <= a.bottom) {
          out[i] = boxOf([a, b]);
          out.splice(j, 1);
          changed = true;
          break;
        }
      }
    }
  }
  return out;
}

function overlapArea(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * OCR words → positioned items in page units. The size of every word is its LINE's row height
 * (tesseract's estimate for the whole line), not the word box — a word without ascenders («a», «—») must not look like
 * smaller text, or lines would be split at ordinary word gaps.
 */
function wordsToItems(words: OcrWord[], map: (x: number, y: number) => [number, number]): TextItem[] {
  return words.map((w) => {
    const [ax, ay] = map(w.x0, w.y0);
    const [bx, by] = map(w.x1, w.y1);
    const [lx0, ly0] = map(w.x0, w.y0);
    const [lx1, ly1] = map(w.x0, w.y0 + (w.lineHeight ?? w.y1 - w.y0));
    const lineH = Math.hypot(lx1 - lx0, ly1 - ly0);
    const top = Math.min(ay, by);
    const bottom = Math.max(ay, by);
    return { text: w.text, x0: Math.min(ax, bx), x1: Math.max(ax, bx), top, bottom, size: Math.max(1, lineH), bold: false, conf: w.conf, line: w.line };
  });
}

/** Labels from OCR words: words grouped into rows and split at large gaps (one label per box text). */
function labelsFromItems(items: TextItem[]): DiagramLabel[] {
  const labels: DiagramLabel[] = [];
  for (const s of buildSegments(items)) {
    const text = logicalLineText(s.items, s.r > s.l ? 'rtl' : 'ltr');
    // arrows and connector glyphs are often read as single letters ("A", "4"): a label needs a real token
    if (!text.split(/\s+/).some((tok) => (tok.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2)) continue;
    if ((s.conf ?? 0) < 50) continue; // noise from photos/arrows, not labels
    labels.push({ text, box: { x0: s.x0, top: s.top, x1: s.x1, bottom: s.bottom }, certainty: 'uncertain', conf: s.conf });
  }
  return labels;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createProcessHandler(deps: ProcessorDeps) {
  return async (run: JobRun<ProcessJobInput>): Promise<ProcessOutput | PartialResult<ProcessOutput>> => {
    const version = deps.ctx.db.get<VersionRow>(
      'SELECT id, source_id, file_id, original_file_id, display_file_id, mime, file_name, format, pagination FROM source_version WHERE id = ?',
      [run.input.version_id],
    );
    if (!version) throw new JobError('VERSION_NOT_FOUND', MSG.versionMissing, { retryable: false });
    const vr = new VersionRun(deps, run, version);
    try {
      return await vr.execute();
    } finally {
      await vr.close();
    }
  };
}

class VersionRun {
  private pdf: PDFDocumentProxy | null = null;
  private pdfFileId: string | null = null;
  private office: OfficeDocument | null = null;
  private officeGeom: PageGeom | null = null;
  private readonly warnings: string[] = [];
  private ligatureFixes = 0;

  constructor(
    private readonly deps: ProcessorDeps,
    private readonly run: JobRun<ProcessJobInput>,
    private readonly version: VersionRow,
  ) {}

  private get ctx(): AppContext {
    return this.deps.ctx;
  }

  async close(): Promise<void> {
    if (this.pdf) await closePdf(this.pdf);
    this.pdf = null;
  }

  private checkAbort(): void {
    if (this.run.signal.aborted) throw this.run.signal.reason ?? new JobError('JOB_ABORTED', 'أُوقفت المهمة.', { retryable: true });
  }

  async execute(): Promise<ProcessOutput | PartialResult<ProcessOutput>> {
    const { ctx, run, version } = this;
    run.progress({ stage: 'inspect' });
    writeSummary(ctx, version.id, 'inspect', run.id);
    const processed: number[] = [];
    try {
      const insp = await run.checkpoint<InspectResult>('inspect', () => this.inspect());
      this.warnings.push(...insp.warnings_ar);
      const all = Array.from({ length: insp.pageCount }, (_, i) => i);
      const targets = run.input.page_indexes?.length
        ? [...new Set(run.input.page_indexes)].filter((i) => i >= 0 && i < insp.pageCount).sort((a, b) => a - b)
        : all;

      for (let k = 0; k < targets.length; k++) {
        this.checkAbort();
        const i = targets[k]!;
        run.progress({ stage: 'extract', done: k, total: targets.length, unit: 'pages' });
        const page = this.pageRow(i);
        if (!page) continue;
        let outcome: PageOutcome;
        try {
          outcome = await run.checkpoint<PageOutcome>(`page:${i}:regions`, async () => {
            await this.deps.hooks.beforePage?.(i, run.attempt);
            ctx.db.run(`UPDATE source_page SET processing_status = 'processing', updated_at = ? WHERE id = ?`, [ctx.clock.now(), page.id]);
            const o = await this.processPage(page, insp);
            await this.deps.hooks.afterPagePersist?.(i, run.attempt);
            return o;
          });
        } catch (e) {
          if (run.signal.aborted || (isJobError(e) && e.retryable)) throw e;
          outcome = this.failPage(page, e);
        }
        this.ligatureFixes += outcome.ligature_fixes;
        processed.push(i);
        writeSummary(ctx, version.id, 'extract', run.id);
      }
      run.progress({ stage: 'extract', done: targets.length, total: targets.length, unit: 'pages' });

      this.checkAbort();
      run.progress({ stage: 'layout' });
      writeSummary(ctx, version.id, 'layout', run.id);
      linkFiguresAcrossPages(ctx, version.id);

      run.progress({ stage: 'structure' });
      writeSummary(ctx, version.id, 'structure', run.id);
      const kind = applyLectureKind(ctx, version.source_id, version.id, run.id);

      this.checkAbort();
      run.progress({ stage: 'index' });
      writeSummary(ctx, version.id, 'index', run.id);
      const chunks = writeChunks(ctx, version.id, version.source_id, buildChunks(ctx, version.id));

      run.progress({ stage: 'validate' });
      const final = writeSummary(ctx, version.id, 'done', run.id, { final: true });
      ctx.audit.record({
        entityType: 'source_version',
        entityId: version.id,
        action: 'process',
        summary: final.summary.stage_label_ar,
        after: { status: final.status, pages_total: final.summary.pages_total, pages_failed: final.summary.pages_failed, job_id: run.id },
        actor: 'job',
        jobId: run.id,
      });
      if (final.status !== 'failed') enqueueQuestionFollowUp(ctx, version.id, run.id);
      const output: ProcessOutput = {
        version_id: version.id,
        status: final.status,
        summary: final.summary,
        pages_processed: processed,
        ligature_fixes: this.ligatureFixes,
        chunks,
        lecture_kind: kind?.kind ?? null,
        warnings_ar: this.warnings,
      };
      if (final.status === 'failed') throw new JobError('NOTHING_READABLE', final.summary.stage_label_ar, { retryable: false, details: output });
      return final.status === 'partial' ? { partial: true, output } : output;
    } catch (e) {
      // finalize the version status when this attempt is the last one (fatal error, cancel, or attempts exhausted)
      const retryable = !isJobError(e) || e.retryable;
      if (!retryable || run.attempt >= MAX_ATTEMPTS) {
        // pages persisted by this run dropped the chunks that pointed at their old regions: rebuild the
        // links and the index from what is stored now, so search never returns chunks of deleted regions
        try {
          // a page interrupted mid-way (cancel, timeout, crash of the last attempt) must not stay "processing"
          ctx.db.run(
            `UPDATE source_page SET processing_status = 'failed', error_code = 'PROCESSING_INTERRUPTED', error_detail = ?,
               text_status = CASE WHEN text_status = 'pending' THEN 'failed' ELSE text_status END, updated_at = ?
             WHERE version_id = ? AND processing_status = 'processing'`,
            [MSG.interrupted, ctx.clock.now(), version.id],
          );
          linkFiguresAcrossPages(ctx, version.id);
          writeChunks(ctx, version.id, version.source_id, buildChunks(ctx, version.id));
        } catch (err) {
          run.log.warn({ err: errorText(err) }, 'could not rebuild chunks after a failed run');
        }
        const label = isJobError(e) ? e.messageAr : undefined;
        const res = writeSummary(ctx, version.id, 'done', run.id, { final: true, ...(label ? { overrideLabelAr: label } : {}) });
        if (res.summary.pages_ready + res.summary.pages_needs_review === 0) writeSummary(ctx, version.id, 'done', run.id, { final: true, overrideStatus: 'failed', ...(label ? { overrideLabelAr: label } : {}) });
      }
      throw e;
    }
  }

  private pageRow(index: number): PageRow | undefined {
    return this.ctx.db.get<PageRow>(
      'SELECT id, page_index, printed_label, kind, width, height, unit, rotation, render_file_id, section_key FROM source_page WHERE version_id = ? AND page_index = ?',
      [this.version.id, index],
    );
  }

  private failPage(page: PageRow, e: unknown): PageOutcome {
    let code = 'PAGE_PROCESSING_FAILED';
    let reason = MSG.unexpected;
    if (e instanceof PageFailure) {
      code = e.code;
      reason = e.reasonAr;
    } else if (e instanceof RegionsInUseError) {
      code = e.reason === 'owner_reviewed' ? 'OWNER_REVIEWED_REGIONS' : 'REGIONS_IN_USE';
      reason = e.reason === 'owner_reviewed' ? MSG.ownerReviewed : MSG.regionsInUse;
    } else if (isJobError(e)) {
      code = e.code;
      reason = e.messageAr;
    } else {
      this.run.log.error({ err: e, page: page.page_index }, 'page processing failed');
    }
    markPageFailed(this.ctx, page.id, code, reason);
    return { page_index: page.page_index, status: 'failed', text_status: 'failed', regions: 0, review_items: 0, ocr: false, ligature_fixes: 0, error_code: code };
  }

  // ───────────────────────────── inspect ─────────────────────────────
  private upsertPage(p: {
    index: number;
    kind: 'page' | 'slide' | 'image' | 'docx_section';
    label: string | null;
    labelOrigin: 'pdf_page_labels' | 'detected_text' | 'slide_number' | null;
    width: number | null;
    height: number | null;
    unit: 'pt' | 'px' | null;
    rotation: number;
    sectionKey?: string | null;
  }): void {
    const now = this.ctx.clock.now();
    this.ctx.db.run(
      `INSERT INTO source_page (id, version_id, page_index, printed_label, printed_label_origin, kind, width, height, unit, rotation, section_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (version_id, page_index) DO UPDATE SET
         printed_label = CASE WHEN source_page.printed_label_origin = 'owner' THEN source_page.printed_label ELSE excluded.printed_label END,
         printed_label_origin = CASE WHEN source_page.printed_label_origin = 'owner' THEN 'owner' ELSE excluded.printed_label_origin END,
         kind = excluded.kind, width = excluded.width, height = excluded.height, unit = excluded.unit, rotation = excluded.rotation,
         section_key = COALESCE(excluded.section_key, source_page.section_key), updated_at = excluded.updated_at`,
      [newId(now), this.version.id, p.index, p.label, p.label ? p.labelOrigin : null, p.kind, p.width, p.height, p.unit, p.rotation, p.sectionKey ?? null, now, now],
    );
  }

  private async inspect(): Promise<InspectResult> {
    const { ctx, version } = this;
    const warnings: string[] = [];
    switch (version.format) {
      case 'pdf': {
        let fileId = version.file_id;
        if (!fileId && version.original_file_id) fileId = await this.convertLegacy();
        if (!fileId) throw new JobError('FILE_MISSING', MSG.fileMissing, { retryable: false });
        const doc = await this.openPdf(fileId);
        const n = doc.numPages;
        const labels = await pageLabels(doc);
        const bands: BandLine[][] = [];
        const sizes: number[] = [];
        const infos: Array<{ width: number; height: number; rotation: number }> = [];
        let reversedLamAlef = false;
        for (let p = 1; p <= n; p++) {
          this.checkAbort();
          // items are in DISPLAY space: bands are the top/bottom the reader sees, also on rotated pages
          const { info, view, items } = await pageTextItems(doc, p);
          const viewGeom = { width: view.width, height: view.height };
          infos.push({ width: info.width, height: info.height, rotation: info.rotation });
          bands.push(bandLines(items, viewGeom));
          if (!reversedLamAlef) reversedLamAlef = items.some((it) => hasReversedLamAlef(it.text));
          for (const it of items) {
            if (inTopBand(it, viewGeom) || inBottomBand(it, viewGeom)) continue;
            const n2 = Math.min(200, it.text.replace(/\s+/g, '').length);
            for (let k = 0; k < n2; k++) sizes.push(Math.round(it.size * 10) / 10);
          }
          this.run.progress({ stage: 'inspect', done: p, total: n, unit: 'pages' });
        }
        const repeated = repeatedBandSignatures(bands);
        const detected = labels ? new Map<number, string>() : detectPrintedLabels(bands);
        const slides = version.pagination === 'slides';
        ctx.db.tx(() => {
          for (let i = 0; i < n; i++) {
            const pdfLabel = labels?.[i]?.trim() || null;
            const label = pdfLabel ?? detected.get(i) ?? null;
            this.upsertPage({
              index: i,
              kind: slides ? 'slide' : 'page',
              label,
              labelOrigin: pdfLabel ? 'pdf_page_labels' : label ? 'detected_text' : null,
              width: infos[i]!.width,
              height: infos[i]!.height,
              unit: 'pt',
              rotation: infos[i]!.rotation,
            });
          }
          ctx.db.run('UPDATE source_version SET page_count = ?, display_file_id = COALESCE(display_file_id, ?) WHERE id = ?', [n, fileId, version.id]);
        });
        return { format: 'pdf', fileId, pageCount: n, bodySize: sizes.length ? median(sizes) : null, repeated: [...repeated], warnings_ar: warnings, reversedLamAlef };
      }
      case 'docx':
      case 'pptx': {
        if (!version.file_id) throw new JobError('FILE_MISSING', MSG.fileMissing, { retryable: false });
        const doc = await this.officeDoc();
        ctx.db.tx(() => {
          for (const p of doc.pages) {
            this.upsertPage({
              index: p.index,
              kind: p.kind,
              label: p.printedLabel,
              labelOrigin: p.printedLabel ? 'slide_number' : null,
              width: p.width,
              height: p.height,
              unit: p.width !== null ? 'pt' : null,
              rotation: 0,
              sectionKey: p.sectionKey,
            });
          }
          if (version.format === 'pptx') ctx.db.run('UPDATE source_version SET page_count = ? WHERE id = ?', [doc.pages.length, version.id]);
        });
        if (version.format === 'pptx') {
          const w = await this.pptxDisplayPdf();
          if (w) warnings.push(w);
        }
        return { format: version.format, fileId: version.file_id, pageCount: doc.pages.length, bodySize: null, repeated: [], warnings_ar: warnings };
      }
      case 'image': {
        const fileId = version.file_id;
        if (!fileId) throw new JobError('FILE_MISSING', MSG.fileMissing, { retryable: false });
        const existing = this.pageRow(0);
        if (!existing) {
          const size = imageSize(await ctx.files.read(fileId));
          const now = ctx.clock.now();
          ctx.db.run(
            `INSERT INTO source_page (id, version_id, page_index, kind, width, height, unit, render_file_id, section_key, created_at, updated_at)
             VALUES (?, ?, 0, 'image', ?, ?, ?, ?, ?, ?, ?)`,
            [newId(now), version.id, size?.width ?? null, size?.height ?? null, size ? 'px' : null, fileId, version.file_name, now, now],
          );
        }
        ctx.db.run('UPDATE source_version SET page_count = 1 WHERE id = ?', [version.id]);
        return { format: 'image', fileId, pageCount: 1, bodySize: null, repeated: [], warnings_ar: warnings };
      }
      case 'image_set': {
        const n = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM source_page WHERE version_id = ?', [version.id])?.n ?? 0;
        if (n === 0) throw new JobError('NO_IMAGES', MSG.noImages, { retryable: false });
        ctx.db.run('UPDATE source_version SET page_count = ? WHERE id = ?', [n, version.id]);
        return { format: 'image_set', fileId: null, pageCount: n, bodySize: null, repeated: [], warnings_ar: warnings };
      }
      default:
        throw new JobError('FORMAT_UNSUPPORTED', MSG.formatUnsupported, { retryable: false });
    }
  }

  private async openPdf(fileId: string): Promise<PDFDocumentProxy> {
    if (this.pdf && this.pdfFileId === fileId) return this.pdf;
    if (this.pdf) await closePdf(this.pdf);
    try {
      this.pdf = await openPdf(await this.ctx.files.read(fileId));
      this.pdfFileId = fileId;
      return this.pdf;
    } catch (e) {
      if (e instanceof PdfOpenError) {
        throw new JobError(e.code, e.code === 'PDF_PASSWORD' ? MSG.pdfPassword : MSG.pdfInvalid, { retryable: false });
      }
      throw e;
    }
  }

  private async officeDoc(): Promise<OfficeDocument> {
    if (this.office) return this.office;
    const fileId = this.version.file_id;
    if (!fileId) throw new JobError('FILE_MISSING', MSG.fileMissing, { retryable: false });
    const buf = await this.ctx.files.read(fileId);
    try {
      if (this.version.format === 'docx') {
        this.office = await extractDocx(buf);
        this.officeGeom = null;
      } else {
        const p = await extractPptx(buf);
        this.office = p;
        this.officeGeom = { width: p.slideWidth, height: p.slideHeight };
        if (p.hiddenSlides.length) this.warnings.push(`شرائح مخفية في العرض: ${p.hiddenSlides.map((i) => i + 1).join('، ')} (استُخرجت نصوصها مع ذلك).`);
      }
    } catch (e) {
      this.run.log.warn({ err: errorText(e) }, 'office document could not be parsed');
      throw new JobError('OFFICE_INVALID', MSG.officeInvalid, { retryable: false });
    }
    return this.office;
  }

  private async convertLegacy(): Promise<string> {
    const { ctx, version } = this;
    const soffice = this.deps.tools.soffice;
    if (!soffice) throw new JobError('CONVERTER_MISSING', MSG.converterMissing, { retryable: false });
    const original = await ctx.files.read(version.original_file_id!);
    const lowerName = (version.file_name ?? '').toLowerCase();
    const inputExt = version.mime === 'application/vnd.ms-powerpoint' || lowerName.endsWith('.ppt') ? 'ppt' : 'doc';
    let pdf: Buffer;
    try {
      pdf = await convertToPdf({ soffice, input: original, inputExt, tmpRoot: ctx.config.tmpDir, timeoutMs: 180_000, signal: this.run.signal });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'TOOL_TIMEOUT') throw new JobError('CONVERSION_TIMEOUT', MSG.conversionTimeout, { retryable: true });
      if (e instanceof ToolError && e.code === 'TOOL_ABORTED') throw this.run.signal.reason ?? e;
      throw new JobError('CONVERSION_FAILED', MSG.conversionFailed, { retryable: false });
    }
    const base = (version.file_name ?? 'document').replace(/\.[^.]+$/, '');
    const stored = await ctx.files.put(pdf, { mime: 'application/pdf', originalName: `${base}.pdf` });
    ctx.db.run('UPDATE source_version SET file_id = COALESCE(file_id, ?), display_file_id = COALESCE(display_file_id, ?) WHERE id = ?', [stored.id, stored.id, version.id]);
    return ctx.db.get<{ file_id: string }>('SELECT file_id FROM source_version WHERE id = ?', [version.id])!.file_id;
  }

  /** Best effort: a fixed PDF rendering of the deck for the reader. Returns an Arabic warning when not produced. */
  private async pptxDisplayPdf(): Promise<string | null> {
    const { ctx, version } = this;
    const soffice = this.deps.tools.soffice;
    if (!soffice) return MSG.pptxDisplayMissing;
    const current = ctx.db.get<{ display_file_id: string | null }>('SELECT display_file_id FROM source_version WHERE id = ?', [version.id]);
    if (current?.display_file_id) return null;
    try {
      const pdf = await convertToPdf({ soffice, input: await ctx.files.read(version.file_id!), inputExt: 'pptx', tmpRoot: ctx.config.tmpDir, timeoutMs: 180_000, signal: this.run.signal });
      const base = (version.file_name ?? 'slides').replace(/\.[^.]+$/, '');
      const stored = await ctx.files.put(pdf, { mime: 'application/pdf', originalName: `${base}.pdf` });
      ctx.db.run('UPDATE source_version SET display_file_id = ? WHERE id = ?', [stored.id, version.id]);
      return null;
    } catch (e) {
      if (this.run.signal.aborted) throw this.run.signal.reason ?? e;
      this.run.log.warn({ err: errorText(e) }, 'pptx display conversion failed');
      return MSG.pptxDisplayFailed;
    }
  }

  // ───────────────────────────── pages ─────────────────────────────
  private async processPage(page: PageRow, insp: InspectResult): Promise<PageOutcome> {
    switch (insp.format) {
      case 'pdf':
        return this.processPdfPage(page, insp);
      case 'docx':
      case 'pptx':
        return this.processOfficePage(page);
      case 'image':
      case 'image_set':
        return this.processImagePage(page);
      default:
        throw new PageFailure('FORMAT_UNSUPPORTED', MSG.formatUnsupported);
    }
  }

  private ocrUnavailable(kind: 'pdf' | 'image'): { code: string; reason: string } | null {
    if (!this.deps.ocr) return { code: 'OCR_UNAVAILABLE', reason: MSG.ocrModelsMissing };
    if (kind === 'pdf' && !this.deps.tools.pdftoppm) return { code: 'RENDERER_MISSING', reason: MSG.rendererMissing };
    return null;
  }

  /**
   * OCR with a coverage check (G3 / AC-08): when the automatic segmentation left text-like ink unread, the page is
   * read again as one uniform block (PSM 6) and the reading that leaves less unread is kept; what is still unread is
   * returned so the page is marked for review. Without a decoded image (non-PNG) only the first reading is made.
   */
  private async recognizeCovered(image: Buffer, decoded: RgbaImage | null): Promise<{ res: OcrResult; missed: MissedText[] }> {
    const first = await this.recognize(image);
    if (!decoded) return { res: first, missed: [] };
    const missed = missedTextSegments(decoded, first.words);
    if (missed.length === 0) return { res: first, missed };
    // keep the first reading (its line order and numbering are better on mixed layouts) and take from the second one
    // only the words that fall where the first one read nothing
    const second = await this.recognize(image, 'block');
    const inMissed = (w: OcrWord) => missed.some((m) => w.x1 >= m.x0 && w.x0 <= m.x1 && Math.min(w.y1, m.y1) - Math.max(w.y0, m.y0) >= 0.3 * (m.y1 - m.y0));
    const lineOffset = first.words.reduce((n, w) => Math.max(n, w.line), 0) + 1;
    const extra = second.words.filter(inMissed).map((w) => ({ ...w, line: w.line + lineOffset }));
    if (extra.length === 0) return { res: first, missed };
    const words = [...first.words, ...extra];
    const merged: OcrResult = { words, confidence: words.reduce((sum, w) => sum + w.conf, 0) / words.length };
    const missed2 = missedTextSegments(decoded, merged.words);
    return missed2.length < missed.length ? { res: merged, missed: missed2 } : { res: first, missed };
  }

  private async recognize(image: Buffer, mode: 'auto' | 'sparse' | 'block' = 'auto') {
    try {
      return await this.deps.ocr!.recognize({ image, mode });
    } catch (e) {
      this.run.log.warn({ err: errorText(e) }, 'ocr failed');
      throw new PageFailure('OCR_FAILED', MSG.ocrFailed);
    }
  }

  private async render(fileId: string, pageNumber: number, dpi: number, crop?: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
    try {
      return await renderPdfPage({
        pdftoppm: this.deps.tools.pdftoppm!,
        pdfPath: this.ctx.files.path(fileId),
        pageNumber,
        dpi,
        crop,
        tmpRoot: this.ctx.config.tmpDir,
        signal: this.run.signal,
      });
    } catch (e) {
      if (this.run.signal.aborted) throw this.run.signal.reason ?? e;
      this.run.log.warn({ err: errorText(e) }, 'render failed');
      throw new PageFailure('RENDER_FAILED', MSG.renderFailed);
    }
  }

  private async processPdfPage(page: PageRow, insp: InspectResult): Promise<PageOutcome> {
    const { ctx, run } = this;
    const fileId = insp.fileId!;
    const doc = await this.openPdf(fileId);
    const content = await extractPage(doc, page.page_index + 1);
    // Layout runs in DISPLAY space (intrinsic /Rotate applied): rows, columns, bands and tables are what the
    // reader sees. Boxes go back to the UNROTATED page box (pageGeom) right before they are stored.
    const pv = pageView(content.info);
    const pageGeom: PageGeom = { width: content.info.width, height: content.info.height };
    const geom: PageGeom = { width: pv.width, height: pv.height };
    const pageArea = geom.width * geom.height;
    const dItems: TextItem[] = content.items.map((it) => ({ ...it, ...pv.toView(it) }));
    const dRules = content.rules.map((r) => pv.rule(r));
    const dpi = renderDpi(geom.width, geom.height);

    const bodyChars = dItems
      .filter((it) => !inTopBand(it, geom) && !inBottomBand(it, geom))
      .reduce((n, it) => n + it.text.replace(/\s+/g, '').length, 0);
    const images = content.images.map((b) => clip(pv.toView(b), geom)).filter((b) => area(b) > 0);
    const noDigitalText = bodyChars < MIN_BODY_CHARS;
    const bodyCharsInside = (b: Box) =>
      dItems
        .filter((it) => !inTopBand(it, geom) && !inBottomBand(it, geom))
        .filter((it) => (it.x0 + it.x1) / 2 >= b.x0 && (it.x0 + it.x1) / 2 <= b.x1 && (it.top + it.bottom) / 2 >= b.top && (it.top + it.bottom) / 2 <= b.bottom)
        .reduce((n, it) => n + it.text.replace(/\s+/g, '').length, 0);
    const isFigure = (b: Box): boolean => {
      const a = area(b);
      if (a < 0.01 * pageArea || b.x1 - b.x0 < 20 || b.bottom - b.top < 20) return false;
      if (a < 0.5 * pageArea) return true;
      // A LARGE picture on a page with real digital text is still a figure (a big diagram with its caption),
      // unless the page text sits on top of it (a background/template) or it fills the page (a scan).
      return !noDigitalText && a < 0.9 * pageArea && bodyCharsInside(b) <= 0.3 * bodyChars;
    };
    const figureBoxes = mergeBoxes(images.filter(isFigure));
    let needsOcr = noDigitalText && (images.length > 0 || content.vectorPaths > 10);
    let pageIssue: { code: string; reason: string; kind: 'unreadable_page' | 'ocr_error' } | null = null;
    if (noDigitalText && !needsOcr) {
      // nothing drawn that we can see in the operator list: verify visually before calling it blank
      if (this.deps.tools.pdftoppm) {
        let diagnostics = '';
        const quick = await renderPdfPage({
          pdftoppm: this.deps.tools.pdftoppm,
          pdfPath: ctx.files.path(fileId),
          pageNumber: page.page_index + 1,
          dpi: 50,
          tmpRoot: ctx.config.tmpDir,
          signal: run.signal,
          onDiagnostics: (stderr) => (diagnostics = stderr),
        }).catch(() => null);
        let blank = false;
        try {
          blank = quick ? measureImageQuality(decodePng(quick)).blank : false;
        } catch {
          blank = false;
        }
        if (!blank) needsOcr = true; // something is drawn: never call it empty without reading it
        // blank only because its content could not be decoded (broken stream, missing image object): a damaged page
        // is a stumble to show (AC-03), never a «ready» empty page (AC-02)
        else if (popplerReportsDamage(diagnostics)) pageIssue = { code: 'PAGE_CONTENT_DAMAGED', reason: MSG.contentDamaged, kind: 'unreadable_page' };
      } else if (bodyChars === 0) {
        pageIssue = { code: 'BLANK_UNVERIFIED', reason: MSG.blankUnverified, kind: 'unreadable_page' };
      }
    }

    let items: TextItem[] = dItems;
    let ocrData: OcrCheckpoint | null = null;
    let ocrUnavailable: { code: string; reason: string } | null = null;
    if (needsOcr) {
      ocrUnavailable = this.ocrUnavailable('pdf');
      if (!ocrUnavailable) {
        ocrData = await run.checkpoint<OcrCheckpoint>(`page:${page.page_index}:ocr`, async () => {
          const png = await this.render(fileId, page.page_index + 1, dpi);
          const stored = await ctx.files.put(png, { mime: 'image/png', originalName: `page-${page.page_index + 1}.png` });
          let quality: OcrCheckpoint['quality'] = null;
          let size: { width: number; height: number } | null = null;
          let decoded: RgbaImage | null = null;
          try {
            const img = decodePng(png);
            decoded = img;
            size = { width: img.width, height: img.height };
            const q = measureImageQuality(img);
            quality = { lowQuality: q.lowQuality, reasons: q.reasons, contrast: q.contrast, edgeSharpness: q.edgeSharpness, blank: q.blank };
          } catch {
            quality = null;
          }
          // coverage is judged on pure scans only (digital text on the page is not in the OCR reading)
          const { res, missed } = await this.recognizeCovered(png, dItems.length === 0 ? decoded : null);
          return { renderFileId: stored.id, dpi, pxWidth: size?.width ?? null, pxHeight: size?.height ?? null, words: res.words, confidence: res.confidence, quality, missed };
        });
        // the render IS the display box (crop box, /Rotate applied): render px / scale = display units
        const ocrScale = (ocrData.dpi ?? RENDER_DPI) / 72;
        const ocrItems = wordsToItems(ocrData.words, (x, y) => [x / ocrScale, y / ocrScale]);
        // digital text wins where both exist (e.g. a digital page number over a scan)
        items = [...dItems, ...ocrItems.filter((o) => !dItems.some((d) => overlapArea(d, o) > 0.5 * area(o)))];
      }
    }

    const regions = analyzePage({
      geom,
      items,
      rules: dRules,
      figures: figureBoxes.map((b): FigureCandidate => ({ ...b, source: 'pdf_image' })),
      origin: needsOcr ? 'ocr' : 'digital',
      bodySize: needsOcr ? 0 : (insp.bodySize ?? 0),
      headerFooter: { repeated: new Set(insp.repeated) },
    });

    // figures: cropped raster for the image asset; labels read by OCR stay UNCERTAIN (no vision model)
    const assets = new Map<string, FigureAsset>();
    const scale = dpi / 72;
    for (const fig of regions.filter((r) => r.kind === 'figure' && r.box)) {
      let assetFile: string | null = null;
      if (this.deps.tools.pdftoppm) {
        const b = fig.box!;
        const crop = { x: b.x0 * scale, y: b.top * scale, w: (b.x1 - b.x0) * scale, h: (b.bottom - b.top) * scale };
        try {
          const png = await this.render(fileId, page.page_index + 1, dpi, crop);
          assetFile = (await ctx.files.put(png, { mime: 'image/png', originalName: `figure-page-${page.page_index + 1}.png` })).id;
          const bigEnough = area(fig.box!) >= 0.03 * pageArea;
          if (!needsOcr && bigEnough && this.deps.ocr && (fig.figure?.labels.length ?? 0) === 0) {
            const res = await this.recognize(png, 'sparse');
            const labelItems = wordsToItems(res.words, (x, y) => [(x + Math.floor(crop.x)) / scale, (y + Math.floor(crop.y)) / scale]);
            const labels = labelsFromItems(labelItems);
            if (labels.length && fig.figure) {
              fig.figure.labels = labels;
              fig.figure.labelsOrigin = 'ocr';
            }
          }
        } catch (e) {
          if (run.signal.aborted) throw run.signal.reason ?? e;
          this.warnings.push(`تعذر قص صورة الشكل في الصفحة ${page.page_index + 1} أو قراءة تسمياته.`);
        }
      }
      assets.set(fig.key, { fileId: assetFile });
    }
    const withDiagrams = addDiagramChildren(regions);

    const quality = ocrData?.quality ?? null;
    const lowQuality = Boolean(quality?.lowQuality);
    const reviews = finalizeRegions(withDiagrams, lowQuality, { reversedLigatures: insp.reversedLamAlef === true });
    regionsToPageSpace(withDiagrams, pv);
    const ocrTextRegions = withDiagrams.filter((r) => r.textOrigin === 'ocr' && r.text && r.kind !== 'diagram' && r.kind !== 'header' && r.kind !== 'footer');
    const digitalTextRegions = withDiagrams.filter((r) => r.textOrigin === 'digital' && r.text && r.kind !== 'header' && r.kind !== 'footer');

    let textStatus: PageUpdate['text_status'];
    if (ocrUnavailable) {
      textStatus = 'needs_ocr';
      pageIssue = { code: ocrUnavailable.code, reason: ocrUnavailable.reason, kind: 'unreadable_page' };
    } else if (ocrData) {
      textStatus = ocrTextRegions.length && digitalTextRegions.length ? 'mixed' : ocrTextRegions.length ? 'ocr' : digitalTextRegions.length ? 'digital' : 'no_text_found';
      if (!ocrTextRegions.length) pageIssue = { code: 'NO_TEXT_FOUND', reason: MSG.noTextFound, kind: 'unreadable_page' };
      else if (lowQuality)
        pageIssue = { code: 'LOW_QUALITY_SCAN', reason: MSG.lowQuality((quality?.reasons ?? []).map((r) => QUALITY_REASON_AR[r])), kind: 'ocr_error' };
      else if (ocrData.missed?.length) pageIssue = { code: 'TEXT_NOT_READ', reason: MSG.textNotRead(ocrData.missed.length), kind: 'ocr_error' };
    } else {
      textStatus = digitalTextRegions.length ? 'digital' : 'no_text_found';
    }
    if (pageIssue) reviews.push({ kind: pageIssue.kind, regionKey: null, reasonAr: pageIssue.reason, details: { code: pageIssue.code, quality, ...(ocrData?.missed?.length ? { not_read: ocrData.missed } : {}) } });
    const needsReview = pageIssue !== null || withDiagrams.some((r) => r.status === 'needs_review');
    const ref: PageRef = this.pageRef(page, pageGeom);
    const res = persistPage(ctx, ref, withDiagrams, assets, reviews, {
      text_status: textStatus,
      processing_status: needsReview ? 'needs_review' : 'ready',
      ocr_confidence: ocrData?.confidence !== null && ocrData?.confidence !== undefined ? Math.round(ocrData.confidence * 10) / 1000 : null,
      has_images: images.length > 0,
      render_file_id: ocrData?.renderFileId ?? null,
      error_code: pageIssue?.code ?? null,
      error_detail: pageIssue?.reason ?? null,
    });
    return {
      page_index: page.page_index,
      status: needsReview ? 'needs_review' : 'ready',
      text_status: textStatus,
      regions: res.regions,
      review_items: res.reviewItems,
      ocr: Boolean(ocrData),
      ligature_fixes: withDiagrams.reduce((n, r) => n + (r.ligatureFixes ?? 0), 0),
      error_code: pageIssue?.code ?? null,
    };
  }

  private async processOfficePage(page: PageRow): Promise<PageOutcome> {
    const { ctx } = this;
    const doc = await this.officeDoc();
    const op = doc.pages[page.page_index];
    if (!op) throw new PageFailure('SECTION_MISSING', MSG.sectionMissing);
    const regions = op.regions.map((r) => ({ ...r }));
    const assets = new Map<string, FigureAsset>();
    for (const img of op.images) {
      const stored = await ctx.files.put(img.data, { mime: img.mime, originalName: img.name });
      assets.set(img.regionKey, { fileId: stored.id });
    }
    const reviews = finalizeRegions(regions, false);
    const textRegions = regions.filter((r) => r.text && r.kind !== 'table_cell');
    const needsReview = regions.some((r) => r.status === 'needs_review');
    const res = persistPage(ctx, this.pageRef(page, this.officeGeom), regions, assets, reviews, {
      text_status: textRegions.length ? 'digital' : 'no_text_found',
      processing_status: needsReview ? 'needs_review' : 'ready',
      ocr_confidence: null,
      has_images: op.images.length > 0 || regions.some((r) => r.kind === 'figure'),
      error_code: null,
      error_detail: null,
      section_key: op.sectionKey,
    });
    return {
      page_index: page.page_index,
      status: needsReview ? 'needs_review' : 'ready',
      text_status: textRegions.length ? 'digital' : 'no_text_found',
      regions: res.regions,
      review_items: res.reviewItems,
      ocr: false,
      ligature_fixes: regions.reduce((n, r) => n + (r.ligatureFixes ?? 0), 0),
      error_code: null,
    };
  }

  private async processImagePage(page: PageRow): Promise<PageOutcome> {
    const { ctx, run, version } = this;
    const fileId = page.render_file_id ?? (version.format === 'image' ? version.file_id : null);
    if (!fileId || !ctx.files.stat(fileId)) throw new PageFailure('IMAGE_MISSING', MSG.imageMissing);
    const meta = ctx.files.stat(fileId);
    const fileName = page.section_key ?? meta?.original_name ?? null;
    const buf = await ctx.files.read(fileId);
    const size = imageSize(buf) ?? (page.width && page.height ? { width: page.width, height: page.height } : null);
    const geom: PageGeom | null = size ? { width: size.width, height: size.height } : null;
    const pixels = size ? size.width * size.height : 0;
    const overOcrBudget = pixels > MAX_OCR_PIXELS;
    let quality: OcrCheckpoint['quality'] = null;
    let decoded: RgbaImage | null = null;
    // Quality metrics only qualify OCR text. An image above the OCR pixel budget is never OCR'd, so it is not decoded
    // either: a full RGBA decode of a 48 MP photo cost ≈ 0.57 GB of memory and 2.6 s for nothing (docs/PERFORMANCE.md).
    if (isPng(buf) && !overOcrBudget) {
      try {
        decoded = decodePng(buf);
        const q = measureImageQuality(decoded);
        quality = { lowQuality: q.lowQuality, reasons: q.reasons, contrast: q.contrast, edgeSharpness: q.edgeSharpness, blank: q.blank };
      } catch {
        quality = null;
        decoded = null;
      }
    }
    const unavailable =
      this.ocrUnavailable('image') ??
      (overOcrBudget ? { code: 'IMAGE_TOO_LARGE', reason: MSG.imageTooLarge(Math.round(pixels / 1e6)) } : null);
    let ocrData: OcrCheckpoint | null = null;
    let regions: LayoutRegion[] = [];
    if (!unavailable) {
      ocrData = await run.checkpoint<OcrCheckpoint>(`page:${page.page_index}:ocr`, async () => {
        const { res, missed } = await this.recognizeCovered(buf, decoded);
        return { renderFileId: null, pxWidth: size?.width ?? null, pxHeight: size?.height ?? null, words: res.words, confidence: res.confidence, quality, missed };
      });
      const items = wordsToItems(ocrData.words, (x, y) => [x, y]);
      const g = geom ?? { width: Math.max(1, ...items.map((i) => i.x1)), height: Math.max(1, ...items.map((i) => i.bottom)) };
      regions = analyzePage({ geom: g, items, rules: [], figures: [], origin: 'ocr', bodySize: 0, headerFooter: { repeated: new Set() }, detectBands: false });
    }
    const assets = new Map<string, FigureAsset>();
    const hasText = regions.some((r) => r.text);
    if (!hasText) {
      // an image without readable text is kept as a figure (the image itself), never as an empty page
      const key = 'imgfig1';
      regions = [
        {
          key,
          kind: 'figure',
          box: geom ? { x0: 0, top: 0, x1: geom.width, bottom: geom.height } : null,
          text: null,
          textOrigin: null,
          figure: { captionKey: null, labels: [], labelsOrigin: null },
        },
      ];
      assets.set(key, { fileId, imageKind: 'unknown' });
    }
    for (const r of regions) r.locator = { ...(r.locator ?? {}), ...(fileName ? { file_name: fileName } : {}) };
    const lowQuality = Boolean(quality?.lowQuality) && hasText;
    const reviews = finalizeRegions(regions, lowQuality);
    let pageIssue: { code: string; reason: string; kind: 'unreadable_page' | 'ocr_error' } | null = null;
    if (unavailable) pageIssue = { code: unavailable.code, reason: unavailable.reason, kind: 'unreadable_page' };
    else if (lowQuality) pageIssue = { code: 'LOW_QUALITY_SCAN', reason: MSG.lowQuality((quality?.reasons ?? []).map((r) => QUALITY_REASON_AR[r])), kind: 'ocr_error' };
    else if (hasText && ocrData?.missed?.length) pageIssue = { code: 'TEXT_NOT_READ', reason: MSG.textNotRead(ocrData.missed.length), kind: 'ocr_error' };
    if (pageIssue) reviews.push({ kind: pageIssue.kind, regionKey: null, reasonAr: pageIssue.reason, details: { code: pageIssue.code, quality, file_name: fileName, ...(ocrData?.missed?.length ? { not_read: ocrData.missed } : {}) } });
    const needsReview = pageIssue !== null || regions.some((r) => r.status === 'needs_review');
    const textStatus: PageUpdate['text_status'] = unavailable ? 'needs_ocr' : hasText ? 'ocr' : 'no_text_found';
    const res = persistPage(ctx, this.pageRef(page, geom), regions, assets, reviews, {
      text_status: textStatus,
      processing_status: needsReview ? 'needs_review' : 'ready',
      ocr_confidence: ocrData?.confidence !== null && ocrData?.confidence !== undefined ? Math.round(ocrData.confidence * 10) / 1000 : null,
      has_images: true,
      render_file_id: fileId,
      error_code: pageIssue?.code ?? null,
      error_detail: pageIssue?.reason ?? null,
    });
    return {
      page_index: page.page_index,
      status: needsReview ? 'needs_review' : 'ready',
      text_status: textStatus,
      regions: res.regions,
      review_items: res.reviewItems,
      ocr: Boolean(ocrData),
      ligature_fixes: regions.reduce((n, r) => n + (r.ligatureFixes ?? 0), 0),
      error_code: pageIssue?.code ?? null,
    };
  }

  private pageRef(page: PageRow, geom: PageGeom | null): PageRef {
    return {
      versionId: this.version.id,
      sourceId: this.version.source_id,
      pageId: page.id,
      pageIndex: page.page_index,
      printedLabel: page.printed_label,
      geom,
    };
  }
}

/** Map every box of a page's regions (region, table + cells, figure/diagram labels) from display space back to the unrotated page box. */
export function regionsToPageSpace(regions: LayoutRegion[], pv: PageView): void {
  if (pv.rotation === 0) return;
  const seen = new Set<object>(); // label objects are shared between a figure and its diagram child
  const mapLabels = (labels: DiagramLabel[] | undefined) => {
    for (const l of labels ?? []) {
      if (seen.has(l)) continue;
      seen.add(l);
      l.box = pv.toPage(l.box);
    }
  };
  for (const r of regions) {
    if (r.box) r.box = pv.toPage(r.box);
    if (r.table && !seen.has(r.table)) {
      seen.add(r.table);
      r.table.box = pv.toPage(r.table.box);
      for (const c of r.table.cells) {
        if (seen.has(c)) continue;
        seen.add(c);
        c.box = pv.toPage(c.box);
      }
    }
    mapLabels(r.figure?.labels);
    mapLabels(r.diagram?.labels);
  }
}

/** Insert a 'diagram' child after every figure that has labels (labels only; edges are never invented). */
function addDiagramChildren(regions: LayoutRegion[]): LayoutRegion[] {
  const out: LayoutRegion[] = [];
  for (const r of regions) {
    out.push(r);
    const labels = r.figure?.labels ?? [];
    if (r.kind !== 'figure' || labels.length === 0) continue;
    out.push({
      key: `${r.key}-diagram`,
      kind: 'diagram',
      box: r.box,
      text: labels.map((l) => l.text).join(' · '),
      textOrigin: r.figure!.labelsOrigin,
      parentKey: r.key,
      diagram: { labels, understanding: r.figure!.labelsOrigin === 'ocr' ? 'labels_ocr_only' : 'not_analyzed' },
      confidence: labels.some((l) => typeof l.conf === 'number')
        ? labels.reduce((s, l) => s + (l.conf ?? 0), 0) / labels.length / 100
        : null,
    });
  }
  return out;
}

/**
 * Final text preparation for every region (bidi cleanup, NFC, lam-alef repair) and review flags:
 * suspicious extraction → needs_review + 'ocr_error' item; low OCR confidence → needs_review + item;
 * low-quality scan → OCR regions needs_review (one page-level item is added by the caller);
 * diagrams → 'uncertain' (labels read without understanding).
 */
export function finalizeRegions(regions: LayoutRegion[], lowQuality: boolean, textCtx: SuspicionContext = {}): ReviewItemInput[] {
  const reviews: ReviewItemInput[] = [];
  const byKey = new Map(regions.map((r) => [r.key, r]));
  // a word-start repair on this page proves the font reverses lam-alef, like the document-level signal
  const reversedLigatures =
    textCtx.reversedLigatures === true ||
    regions.some((r) => r.textOrigin === 'digital' && !!r.text && !r.table && prepareRegionText(r.text).ligatureFixes > 0);
  for (const r of regions) {
    if (r.text && !r.table) {
      // only a PDF text layer has the font-level defect (OCR and office text are logical Unicode)
      const p = prepareRegionText(r.text, { reversedLigatures: reversedLigatures && r.textOrigin === 'digital' });
      r.text = p.text;
      r.suspicions = p.suspicions;
      r.ligatureFixes = p.ligatureFixes;
    }
    if (r.figure) for (const l of r.figure.labels) l.text = prepareRegionText(l.text).text;
    if (r.diagram) for (const l of r.diagram.labels) l.text = prepareRegionText(l.text).text;
  }
  for (const r of regions) {
    if (!r.table) continue;
    let fixes = 0;
    for (const c of r.table.cells) {
      const p = prepareRegionText(c.text);
      c.text = p.text;
      fixes += p.ligatureFixes;
    }
    const caption = r.tableCaptionKey ? (byKey.get(r.tableCaptionKey)?.text ?? null) : null;
    r.text = serializeTable(r.table, caption);
    r.ligatureFixes = fixes;
    r.suspicions = [];
  }
  for (const r of regions) {
    const reasons: string[] = [];
    if (r.suspicions?.length) reasons.push(suspicionReasonAr(r.suspicions));
    const ocrText = r.textOrigin === 'ocr' && r.kind !== 'diagram' && r.text;
    const weakWord = typeof r.minWordConf === 'number' && r.minWordConf < OCR_REVIEW_WORD_CONF;
    const weakRegion = typeof r.confidence === 'number' && r.confidence < OCR_REVIEW_WORD_CONF / 100;
    if (ocrText && (weakWord || weakRegion)) reasons.push(MSG.lowConfidence(r.minWordConf ?? (r.confidence ?? 0) * 100, r.lowConfWords ?? []));
    if (reasons.length) {
      r.status = 'needs_review';
      r.reviewReasonAr = reasons.join(' ');
      reviews.push({
        kind: 'ocr_error',
        regionKey: r.key,
        reasonAr: r.reviewReasonAr,
        details: {
          issues: (r.suspicions ?? []).map((s) => ({ kind: s.kind, token: s.token, context: s.context })),
          ...(typeof r.minWordConf === 'number' ? { min_word_confidence: Math.round(r.minWordConf) } : {}),
          ...(r.lowConfWords?.length ? { low_confidence_words: r.lowConfWords.slice(0, 20) } : {}),
        },
      });
    } else if (r.kind === 'diagram') r.status = 'uncertain';
    else if (lowQuality && r.textOrigin === 'ocr') r.status = 'needs_review';
    else r.status = 'extracted';
  }
  // a table with a flagged cell needs review as a whole
  for (const r of regions) {
    if (r.kind === 'table_cell' && r.status === 'needs_review' && r.parentKey) {
      const parent = byKey.get(r.parentKey);
      if (parent && parent.status !== 'needs_review') parent.status = 'needs_review';
    }
  }
  return reviews;
}

/**
 * Hook for the Question Vault (track C3): once a version is processed, queue question extraction (question
 * sources / previous exams) or lecture ↔ question matching (lectures). Guarded: when the questions module (its
 * job kinds) is absent nothing happens, and a failure here never fails processing. Idempotent per processing run.
 */
function enqueueQuestionFollowUp(ctx: AppContext, versionId: string, processJobId: string): void {
  try {
    const src = ctx.db.get<{ source_type: string }>('SELECT s.source_type FROM source_version v JOIN source s ON s.id = v.source_id WHERE v.id = ?', [versionId]);
    if (!src) return;
    const kind =
      src.source_type === 'question_source' || src.source_type === 'previous_exam' ? 'extract_questions' : src.source_type === 'lecture' ? 'match_questions' : null;
    if (!kind || !ctx.jobs.isRegistered(kind)) return;
    ctx.jobs.enqueue(kind, { version_id: versionId }, { idempotencyKey: `${kind}:${versionId}:${processJobId}`, parentJobId: processJobId });
  } catch (e) {
    ctx.log.warn({ err: e, versionId }, 'could not enqueue the question follow-up job');
  }
}
