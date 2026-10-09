// Document processing module (track A2). Registers the process_source_version job, declares the honest
// state of processing.* capabilities, and exposes GET /api/processing/status (which converters and OCR
// models this server really has). The sources module creates source/version/file rows and enqueues jobs.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROCESS_JOB_KIND, type FeatureKey, type ProcessJobInput, type ProcessingToolsStatusResponse } from '@medlevo/shared';
import type { AppContext, ModuleOptions, ModulePlugin } from '../../context';
import { INDEX_VERSION } from './chunks';
import { OCR_ENGINE_LABEL, OcrEngine, ocrModelsAvailable } from './ocr';
import { createProcessHandler, MAX_ATTEMPTS, PIPELINE_VERSION, type ProcessingHooks } from './pipeline';
import { detectTools, type ToolPaths } from './tools';

export { PIPELINE_VERSION } from './pipeline';
export { INDEX_VERSION } from './chunks';

export interface ProcessingModuleOptions {
  /** override detected tool paths (null = treat as not installed) — used by tests and diagnostics */
  tools?: Partial<ToolPaths>;
  /** false = behave as if the OCR models were not installed */
  ocr?: boolean;
  /** TEST-ONLY fault injection hooks */
  hooks?: ProcessingHooks;
}

export const processJobInputSchema = z
  .object({
    version_id: z.string().min(1).max(64),
    page_indexes: z.array(z.number().int().min(0).max(100_000)).max(5000).optional(),
    reason: z.enum(['upload', 'reprocess', 'replacement']).optional(),
  })
  .strict();

const PROCESSING_FEATURES: FeatureKey[] = [
  'processing.pdf',
  'processing.docx',
  'processing.pptx',
  'processing.images',
  'processing.zip',
  'processing.ocr',
  'processing.legacy_office',
  'processing.vision',
];

const AR = {
  pdftoppmPurpose: 'تحويل صفحات PDF الممسوحة إلى صور للتعرف الضوئي، وقص صور الأشكال.',
  pdftoppmMissing: 'poppler (pdftoppm) غير مثبت: صفحات PDF الممسوحة تُعلَّم «تحتاج OCR» ولا تُقرأ، ولا تُقص صور الأشكال.',
  sofficePurpose: 'تحويل ملفات .doc/.ppt القديمة إلى PDF، وإنشاء نسخة عرض ثابتة لملفات PPTX.',
  sofficeMissing: 'LibreOffice غير مثبت: لا يمكن تحويل ملفات .doc/.ppt، ولا تُنشأ نسخة عرض ثابتة لملفات PPTX.',
  tesseractPurpose: 'التعرف الضوئي المحلي على النص العربي والإنجليزي (لا يغادر أي ملف الجهاز).',
  tesseractMissing: 'نماذج OCR (eng/ara) غير موجودة ضمن حزم الخادم: لا يمكن قراءة الصور والصفحات الممسوحة.',
  ocrNeedsRenderer: 'التعرف الضوئي للصور يعمل، لكن صفحات PDF الممسوحة تحتاج poppler (pdftoppm) لتحويلها إلى صور قبل OCR، وهو غير مثبت.',
  pptxNoDisplay: 'تُستخرج الشرائح ونصوصها وترتيبها، لكن نسخة العرض الثابتة (PDF) تحتاج LibreOffice غير المثبت على الخادم.',
  imagesNoOcr: 'معالجة الصور تحتاج نماذج OCR غير المثبتة؛ تُحفظ الصور كأشكال دون قراءة نصها.',
  legacyMissing: 'ملفات Word وPowerPoint القديمة (.doc/.ppt) تحتاج تثبيت LibreOffice على الخادم لتحويلها. احفظها بصيغة DOCX/PPTX أو PDF.',
  vision:
    'فهم الرسوم والمخططات بالرؤية الحاسوبية غير مبني بعد: تُستخرج تسميات الرسم بالـOCR فقط وتُعلَّم «غير مؤكدة»، ولا تُستنتج العلاقات أو الأسهم.',
};

function declareCapabilities(ctx: AppContext, tools: ToolPaths, ocrOk: boolean): void {
  ctx.capabilities.set('processing.pdf', 'available');
  ctx.capabilities.set('processing.docx', 'available');
  ctx.capabilities.set('processing.pptx', 'available', tools.soffice ? undefined : AR.pptxNoDisplay);
  if (ocrOk) {
    ctx.capabilities.set('processing.images', 'available');
    ctx.capabilities.set('processing.zip', 'available');
  } else {
    ctx.capabilities.set('processing.images', 'requires_configuration', AR.imagesNoOcr);
    ctx.capabilities.set('processing.zip', 'requires_configuration', AR.imagesNoOcr);
  }
  if (!ocrOk) ctx.capabilities.set('processing.ocr', 'requires_configuration', AR.tesseractMissing);
  else if (!tools.pdftoppm) ctx.capabilities.set('processing.ocr', 'requires_configuration', AR.ocrNeedsRenderer);
  else ctx.capabilities.set('processing.ocr', 'available');
  if (tools.soffice) ctx.capabilities.set('processing.legacy_office', 'available');
  else ctx.capabilities.set('processing.legacy_office', 'requires_configuration', AR.legacyMissing);
  ctx.capabilities.set('processing.vision', 'not_implemented', AR.vision);
}

export function createProcessingModule(opts: ProcessingModuleOptions = {}): ModulePlugin {
  return async function processingModule(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
    const tools = detectTools(opts.tools);
    const ocrOk = opts.ocr !== false && ocrModelsAvailable().ok;
    const ocr = ocrOk ? new OcrEngine(ctx.config.dataDir) : null;
    declareCapabilities(ctx, tools, ocrOk);

    ctx.jobs.register<ProcessJobInput, unknown>(PROCESS_JOB_KIND, {
      version: PIPELINE_VERSION,
      maxAttempts: MAX_ATTEMPTS,
      timeoutMs: 60 * 60 * 1000,
      concurrency: 1, // CPU-bound (pdfjs, OCR); one version at a time keeps the owner's device responsive
      inputSchema: processJobInputSchema as unknown as z.ZodType<ProcessJobInput>,
      handler: createProcessHandler({ ctx, tools, ocr, hooks: opts.hooks ?? {} }),
    });

    app.addHook('onClose', async () => {
      await ocr?.close();
    });

    app.get('/status', async (): Promise<ProcessingToolsStatusResponse> => {
      const tool = (available: boolean, purpose: string, missing: string, engine?: string) => ({
        available,
        purpose_ar: purpose,
        ...(available ? {} : { reason_ar: missing }),
        ...(engine ? { engine } : {}),
      });
      return {
        tools: {
          pdftoppm: tool(Boolean(tools.pdftoppm), AR.pdftoppmPurpose, AR.pdftoppmMissing, 'poppler pdftoppm'),
          soffice: tool(Boolean(tools.soffice), AR.sofficePurpose, AR.sofficeMissing, 'LibreOffice (headless)'),
          tesseract: tool(ocrOk, AR.tesseractPurpose, AR.tesseractMissing, OCR_ENGINE_LABEL),
        },
        features: PROCESSING_FEATURES.map((k) => ctx.capabilities.get(k)),
        pipeline_version: PIPELINE_VERSION,
        index_version: INDEX_VERSION,
      };
    });
  };
}

export default createProcessingModule();
