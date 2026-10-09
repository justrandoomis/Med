// Quick add (§33): one question without a full-file workflow.
//  * pasted text → parsed with the same deterministic parser → an owner question (origin 'owner'); a key the
//    owner gives is an OWNER key, never presented as a source key;
//  * an image / screenshot → stored as an image source of type question_source through the sources module, OCR'd
//    by the processing pipeline, then extracted by the normal extract_questions job (hook after processing).
import { createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { MATCH_QUESTIONS_JOB_KIND, type QuickAddResponse, type QuickAddTextRequest } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { randomToken } from '../../lib/hash';
import { cleanFileName } from '../sources/sniff';
import { registerUpload, type IncomingFile } from '../sources/upload';
import { ownerLink } from './corrections';
import { parseQuestions, type ParserLine } from './parser';
import { createQuestion } from './service';
import { labelInfo } from './text';

function textLines(text: string): ParserLine[] {
  return text.split(/\r?\n/).map((t) => ({
    text: t,
    regionId: null,
    regionKind: 'paragraph',
    pageIndex: 0,
    pageId: null,
    bbox: null,
    regionStatus: 'extracted',
    confidence: null,
    textOrigin: 'owner',
  }));
}

export function quickAddText(ctx: AppContext, body: QuickAddTextRequest): QuickAddResponse {
  const text = body.text.trim();
  if (!text) throw new AppError('VALIDATION_FAILED', 'اكتب نص السؤال أو الصقه.', 400);
  if (body.course_node_id) {
    const n = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [body.course_node_id]);
    if (!n || n.deleted_at !== null) throw new AppError('NOT_FOUND', 'الكورس المحدد غير موجود.', 404);
  }
  const parsed = parseQuestions(textLines(text));
  if (parsed.questions.length > 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `النص يحتوي ${parsed.questions.length} أسئلة. الإضافة السريعة لسؤال واحد؛ لمصدر فيه عدة أسئلة ارفع الملف كمصدر أسئلة.`,
      400,
    );
  }
  const q = parsed.questions[0];
  const stem = q ? q.stem || text : text;
  const options = q?.options ?? [];
  // the key: given explicitly, or typed inline («Answer: B») — both are the OWNER's key
  const keyLabel = body.key_label?.trim() || parsed.keys.find((k) => k.inlineFor || parsed.keys.length === 1)?.keyLabel || null;
  let correct: number[] = [];
  if (keyLabel) {
    const k = labelInfo(keyLabel);
    const idx = k ? options.findIndex((o) => labelInfo(o.label)?.canonical === k.canonical) : -1;
    if (idx < 0) throw new AppError('VALIDATION_FAILED', `لا يوجد خيار بالتسمية «${keyLabel}» في النص.`, 400);
    correct = [idx];
  }
  const course = body.course_node_id ?? (body.lecture_source_id ? (ctx.db.get<{ c: string | null }>('SELECT course_node_id AS c FROM source WHERE id = ?', [body.lecture_source_id])?.c ?? null) : null);
  const created = createQuestion(ctx, {
    origin: 'owner',
    qtype: options.length === 0 ? 'short_answer' : 'sba',
    stem,
    options: options.map((o) => ({ text: o.text, label: o.label })),
    correctOptionIndexes: correct,
    answerStatus: correct.length ? 'owner_key' : options.length ? 'missing_key' : 'not_applicable',
    courseNodeId: course,
  });
  if (body.lecture_source_id) ownerLink(ctx, created.questionId, body.lecture_source_id, 'directly_covered', 'أضفته من المحاضرة بالإضافة السريعة');
  let jobId: string | null = null;
  if (course && ctx.jobs.isRegistered(MATCH_QUESTIONS_JOB_KIND)) {
    jobId = ctx.jobs.enqueue(MATCH_QUESTIONS_JOB_KIND, { question_ids: [created.questionId] }, { idempotencyKey: `${MATCH_QUESTIONS_JOB_KIND}:q:${created.questionId}` }).id;
  }
  return {
    mode: 'text',
    question_id: created.questionId,
    source_id: null,
    version_id: created.versionId,
    job_id: jobId,
    message_ar:
      `أُضيف السؤال إلى خزنتك (${options.length ? `${options.length} خيارات` : 'بلا خيارات'}${correct.length ? '، مع مفتاح حددته بنفسك' : '، دون مفتاح — للتدريب غير المحسوب'}).` +
      (q ? '' : ' لم تُكتشف خيارات مرقمة؛ حُفظ النص كسؤال قصير.'),
  };
}

/** Stream the single uploaded file part to a private temp file; collect fields. */
async function readOneFile(ctx: AppContext, req: FastifyRequest): Promise<{ fields: Record<string, string>; file: IncomingFile | null; cleanup: () => void }> {
  const fields: Record<string, string> = {};
  let file: IncomingFile | null = null;
  const cleanup = () => {
    if (file) rmSync(file.tmpPath, { force: true });
  };
  try {
    const parts = req.parts({ throwFileSizeLimit: false } as Parameters<FastifyRequest['parts']>[0]);
    for await (const part of parts) {
      if (part.type === 'file') {
        if (file) {
          part.file.resume();
          continue;
        }
        const tmpPath = join(ctx.config.tmpDir, `quickadd-${randomToken(12)}`);
        const entry: IncomingFile = { tmpPath, fileName: cleanFileName(part.filename), size: 0, truncated: false };
        file = entry;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            entry.size += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(part.file, meter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
        entry.truncated = part.file.truncated === true;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { fields, file, cleanup };
}

export async function quickAddImage(ctx: AppContext, req: FastifyRequest): Promise<QuickAddResponse> {
  const { fields, file, cleanup } = await readOneFile(ctx, req);
  try {
    if (!file) throw new AppError('VALIDATION_FAILED', 'أرفق صورة السؤال (لقطة شاشة أو صورة).', 400);
    const nodeId = (fields.node_id ?? '').trim();
    if (!nodeId) throw new AppError('VALIDATION_FAILED', 'اختر المجلد أو الكورس الذي يُحفظ فيه السؤال.', 400);
    const node = ctx.db.get<{ deleted_at: number | null }>('SELECT deleted_at FROM library_node WHERE id = ?', [nodeId]);
    if (!node || node.deleted_at !== null) throw new AppError('NOT_FOUND', 'المجلد المحدد غير موجود.', 404);
    const title = (fields.title ?? '').trim().slice(0, 300) || 'سؤال مضاف سريعًا';
    const res = await registerUpload(ctx, file, { nodeId, sourceType: 'question_source', title, onDuplicate: 'create' });
    if (res.status !== 'accepted' || !res.source_id || !res.version_id) {
      throw new AppError('UNSUPPORTED_FORMAT', res.reason_ar ?? 'تعذّر حفظ الصورة.', 400);
    }
    const job = ctx.db.get<{ id: string }>(
      `SELECT id FROM processing_job WHERE kind = 'process_source_version' AND json_extract(input_json, '$.version_id') = ? ORDER BY created_at DESC LIMIT 1`,
      [res.version_id],
    );
    const ocr = ctx.capabilities.get('processing.images');
    return {
      mode: 'image',
      question_id: null,
      source_id: res.source_id,
      version_id: res.version_id,
      job_id: job?.id ?? null,
      message_ar:
        ocr.state === 'available'
          ? 'حُفظت الصورة كمصدر أسئلة. تُقرأ الآن بالتعرف الضوئي (OCR) ثم يُستخرج السؤال تلقائيًا ويظهر في خزنتك؛ ما يُقرأ بثقة منخفضة يذهب إلى قائمة المراجعة.'
          : `حُفظت الصورة كمصدر أسئلة، لكن قراءة الصور غير متاحة على هذا الخادم: ${ocr.reason_ar ?? ''} اكتب نص السؤال بالإضافة السريعة النصية بدلًا من ذلك.`,
    };
  } finally {
    cleanup();
  }
}
