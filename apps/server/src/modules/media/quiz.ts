// Image Quiz (§32, AC-08, AC-19-style no leak): occlusion masks hide labels with removable, non-destructive layers.
//
//  * The quiz payload never reveals an answer: neutral keys (m1, m2…), mask geometry only — no image id, file id,
//    file name, caption, title, source, page or label. The image is served from a NEUTRAL URL bound to the quiz
//    (owner session) with no file name and no ETag.
//  * PNG images are served with the masks BURNED into a derived copy (the stored original is untouched), so removing
//    an overlay in the browser cannot reveal a label; other formats are served as-is with masks drawn by the client
//    (`masks_rendered: 'client'`, said in the UI).
//  * Only masks with a label whose certainty is NOT 'uncertain' are asked (AC-08); excluded masks are counted with
//    the reason — never with their label.
//  * Answers are append-only. A non-matching answer can be self-marked correct by the owner; it is recorded as such,
//    never as an automatic match.
import {
  OVERLAY_CERTAINTY_LABELS_AR,
  imageQuizAnswerSchema,
  imageQuizCreateSchema,
  normalizeForSearch,
  type ImageQuizAnswerResponse,
  type ImageQuizFinishResponse,
  type ImageQuizView,
} from '@medlevo/shared';
import type { FastifyReply } from 'fastify';
import type { AppContext } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseWith } from '../../lib/http';
import { newId } from '../../lib/ids';
import { decodePng, encodePng, isPng, type RgbaImage } from '../processing/png';
import { getImageRow, summary } from './images';
import { overlaysOf, quizEligibility } from './overlays';

interface QuizRow {
  id: string;
  image_id: string;
  items_json: string;
  excluded_json: string;
  masks_rendered: 'server' | 'client';
  status: 'in_progress' | 'finished';
  created_at: number;
  finished_at: number | null;
}
interface QuizItem {
  key: string;
  overlay_id: string;
}
interface AnswerRow {
  item_key: string;
  overlay_id: string;
  answer: string;
  result: 'correct' | 'incorrect' | 'self_marked_correct';
  created_at: number;
}

const MAX_SERVER_PIXELS = 40_000_000;
const MASK_RGB: [number, number, number] = [96, 104, 120];

function getQuiz(ctx: AppContext, id: string): QuizRow {
  const q = ctx.db.get<QuizRow>('SELECT * FROM image_quiz WHERE id = ?', [id]);
  if (!q) throw new AppError('NOT_FOUND', 'الاختبار غير موجود.', 404);
  return q;
}

/** Normalized answer key: search normalization, punctuation removed, Arabic article tolerated. */
export function answerKey(s: string): string {
  return normalizeForSearch(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => (t.startsWith('ال') && t.length > 3 ? t.slice(2) : t))
    .join(' ');
}

function latestAnswers(ctx: AppContext, quizId: string): Map<string, AnswerRow> {
  const rows = ctx.db.all<AnswerRow>('SELECT item_key, overlay_id, answer, result, created_at FROM image_quiz_answer WHERE quiz_id = ? ORDER BY created_at, id', [quizId]);
  const out = new Map<string, AnswerRow>();
  for (const r of rows) {
    const prev = out.get(r.item_key);
    // the first answer stays the answer; a later self-mark only changes the result
    out.set(r.item_key, prev ? { ...prev, result: r.result } : r);
  }
  return out;
}

function quizView(ctx: AppContext, q: QuizRow): ImageQuizView {
  const items = fromJson<QuizItem[]>(q.items_json, []) ?? [];
  const overlays = new Map(overlaysOf(ctx, q.image_id, { includeDeleted: true }).map((o) => [o.id, o]));
  const answers = latestAnswers(ctx, q.id);
  return {
    id: q.id,
    status: q.status,
    image_url: `/api/media/quiz/${q.id}/image`,
    masks_rendered: q.masks_rendered,
    masks: items.map((i) => {
      const o = overlays.get(i.overlay_id);
      const shape = o && o.shape.type === 'rect' ? o.shape : { type: 'rect' as const, x: 0, y: 0, w: 0, h: 0 };
      return { key: i.key, shape, answered: answers.has(i.key) };
    }),
    prompt_ar: 'اكتب ما تخفيه كل منطقة مرقّمة. يمكنك كتابة المصطلح بالعربية أو الإنجليزية.',
    answers: items
      .filter((i) => answers.has(i.key))
      .map((i) => {
        const a = answers.get(i.key)!;
        return { key: i.key, result: a.result, answer: a.answer, expected: overlays.get(i.overlay_id)?.label ?? '' };
      }),
    excluded: (fromJson<string[]>(q.excluded_json, []) ?? []).map((reason_ar) => ({ reason_ar })),
    created_at: q.created_at,
  };
}

async function canBurn(ctx: AppContext, fileId: string): Promise<boolean> {
  const f = ctx.files.stat(fileId);
  if (!f) return false;
  try {
    const buf = await ctx.files.read(fileId);
    if (!isPng(buf)) return false;
    const img = decodePng(buf);
    return img.width * img.height <= MAX_SERVER_PIXELS;
  } catch {
    return false; // interlaced / unusual PNG → masks drawn by the client (said in the payload)
  }
}

export async function createQuiz(ctx: AppContext, body: unknown): Promise<ImageQuizView> {
  const req = parseWith(imageQuizCreateSchema, body, 'body');
  const img = getImageRow(ctx, req.image_id);
  const all = overlaysOf(ctx, img.id).filter((o) => o.kind === 'occlusion_mask');
  const chosen = req.overlay_ids?.length ? all.filter((o) => req.overlay_ids!.includes(o.id)) : all;
  if (req.overlay_ids?.length && chosen.length !== new Set(req.overlay_ids).size) throw new AppError('NOT_FOUND', 'بعض الأقنعة المحددة غير موجودة على هذه الصورة.', 404);
  const eligible = chosen.filter((o) => quizEligibility(o).eligible);
  const excluded = chosen.filter((o) => !quizEligibility(o).eligible).map((o) => quizEligibility(o).reason_ar!);
  if (eligible.length === 0) {
    throw new AppError('CONFLICT', excluded.length ? `لا يوجد قناع صالح للاختبار: ${[...new Set(excluded)].join(' ')}` : 'لا توجد أقنعة إخفاء على هذه الصورة بعد؛ أضف قناعًا بتسمية مؤكدة أولًا.', 409, {
      excluded: excluded.length,
    });
  }
  // neutral keys in reading position (top → bottom, then right → left for an RTL reader) — not creation order
  const ordered = [...eligible].sort((a, b) => {
    const ra = a.shape.type === 'rect' ? a.shape : { x: 0, y: 0 };
    const rb = b.shape.type === 'rect' ? b.shape : { x: 0, y: 0 };
    return Math.abs(ra.y - rb.y) > 0.02 ? ra.y - rb.y : rb.x - ra.x;
  });
  const items: QuizItem[] = ordered.map((o, i) => ({ key: `m${i + 1}`, overlay_id: o.id }));
  const rendered = img.file_id && (await canBurn(ctx, img.file_id)) ? 'server' : 'client';
  const now = ctx.clock.now();
  const id = newId(now);
  ctx.db.run(
    `INSERT INTO image_quiz (id, image_id, items_json, excluded_json, masks_rendered, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, NULL)`,
    [id, img.id, toJson(items), toJson(excluded), rendered, now],
  );
  return quizView(ctx, getQuiz(ctx, id));
}

export function getQuizView(ctx: AppContext, id: string): ImageQuizView {
  return quizView(ctx, getQuiz(ctx, id));
}

function fillRect(img: RgbaImage, box: { x: number; y: number; w: number; h: number }): void {
  const x0 = Math.max(0, Math.floor(box.x * img.width));
  const y0 = Math.max(0, Math.floor(box.y * img.height));
  const x1 = Math.min(img.width, Math.ceil((box.x + box.w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((box.y + box.h) * img.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = MASK_RGB[0];
      img.data[i + 1] = MASK_RGB[1];
      img.data[i + 2] = MASK_RGB[2];
      img.data[i + 3] = 255;
    }
  }
}

/** Neutral image delivery: no file name, no ETag, no caching. */
export async function sendQuizImage(ctx: AppContext, id: string, reply: FastifyReply): Promise<FastifyReply> {
  const q = getQuiz(ctx, id);
  const img = getImageRow(ctx, q.image_id);
  if (!img.file_id) throw new AppError('NOT_FOUND', 'الصورة غير متاحة.', 404);
  const file = ctx.files.stat(img.file_id);
  if (!file) throw new AppError('NOT_FOUND', 'الصورة غير متاحة.', 404);
  const buf = await ctx.files.read(img.file_id);
  let body: Buffer = buf;
  let type = file.mime;
  if (q.masks_rendered === 'server') {
    const items = fromJson<QuizItem[]>(q.items_json, []) ?? [];
    const overlays = new Map(overlaysOf(ctx, q.image_id, { includeDeleted: true }).map((o) => [o.id, o]));
    const decoded = decodePng(buf);
    const copy: RgbaImage = { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
    for (const i of items) {
      const o = overlays.get(i.overlay_id);
      if (o && o.shape.type === 'rect') fillRect(copy, o.shape);
    }
    body = encodePng(copy);
    type = 'image/png';
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) type = 'application/octet-stream';
  reply.header('content-type', type);
  reply.header('content-length', String(body.length));
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(body);
}

export function answerQuiz(ctx: AppContext, id: string, body: unknown): ImageQuizAnswerResponse {
  const req = parseWith(imageQuizAnswerSchema, body, 'body');
  const q = getQuiz(ctx, id);
  if (q.status === 'finished') throw new AppError('CONFLICT', 'انتهى هذا الاختبار.', 409);
  const items = fromJson<QuizItem[]>(q.items_json, []) ?? [];
  const item = items.find((i) => i.key === req.key);
  if (!item) throw new AppError('NOT_FOUND', 'المنطقة المرقّمة غير موجودة في هذا الاختبار.', 404);
  const overlay = overlaysOf(ctx, q.image_id).find((o) => o.id === item.overlay_id);
  const prev = latestAnswers(ctx, q.id).get(item.key);
  // AC-08 at answer time too: a mask removed, emptied or marked uncertain after the quiz started is never graded as
  // a fixed answer (an earlier answer stays as it was recorded)
  const eligibility = overlay ? quizEligibility(overlay) : { eligible: false, reason_ar: 'أُزيل هذا القناع عن الصورة بعد بدء الاختبار.' };
  if (!prev && !eligibility.eligible) {
    throw new AppError('CONFLICT', `لا تُصحَّح هذه المنطقة: ${eligibility.reason_ar ?? ''}`.trim(), 409, { reason: 'mask_not_eligible' });
  }
  const expected = overlay?.label ?? '';
  const now = ctx.clock.now();
  let result: ImageQuizAnswerResponse['result'];
  if (req.self_mark_correct) {
    if (!prev || prev.result !== 'incorrect') throw new AppError('CONFLICT', 'يمكن اعتبار الإجابة صحيحة بحكمك فقط بعد إجابة لم تطابق التسمية.', 409);
    result = 'self_marked_correct';
  } else {
    if (prev) throw new AppError('CONFLICT', 'أجبت عن هذه المنطقة من قبل؛ الإجابات لا تُستبدل.', 409);
    const accepted = [expected, ...(overlay?.aliases ?? [])].map(answerKey).filter(Boolean);
    result = accepted.includes(answerKey(req.answer)) ? 'correct' : 'incorrect';
  }
  ctx.db.run('INSERT INTO image_quiz_answer (id, quiz_id, item_key, overlay_id, answer, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    newId(now),
    q.id,
    item.key,
    item.overlay_id,
    req.self_mark_correct ? (prev?.answer ?? req.answer) : req.answer,
    result,
    now,
  ]);
  return { key: item.key, result, expected, quiz: quizView(ctx, getQuiz(ctx, id)) };
}

export function finishQuiz(ctx: AppContext, id: string): ImageQuizFinishResponse {
  const q = getQuiz(ctx, id);
  if (q.status !== 'finished') ctx.db.run(`UPDATE image_quiz SET status = 'finished', finished_at = ? WHERE id = ?`, [ctx.clock.now(), q.id]);
  const items = fromJson<QuizItem[]>(q.items_json, []) ?? [];
  const overlays = new Map(overlaysOf(ctx, q.image_id, { includeDeleted: true }).map((o) => [o.id, o]));
  return {
    quiz: quizView(ctx, getQuiz(ctx, id)),
    reveal: {
      image: summary(ctx, getImageRow(ctx, q.image_id)),
      labels: items.map((i) => {
        const o = overlays.get(i.overlay_id);
        return { key: i.key, label: o?.label ?? '', certainty_label_ar: o ? OVERLAY_CERTAINTY_LABELS_AR[o.certainty] : '' };
      }),
    },
  };
}
