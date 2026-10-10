// Media module (track D3): lecture audio layer (§29), Medical Image Explorer + overlays + Image Quiz (§32), AC-08,
// AC-09. See docs/modules/cases-media.md.
//
//   GET    /status                               MediaStatusResponse (what works, what does not and why)
//   GET    /audio                                audio recordings (one per audio source version, created lazily)
//   GET    /audio/:id/stream                     authenticated Range stream (files store)
//   PATCH  /audio/:id {duration_ms}              duration reported by the owner's player
//   GET    /audio/:id/transcript?include_deleted=1
//   POST   /audio/:id/segments                   manual segment
//   POST   /audio/:id/import                     WebVTT / SRT → segments
//   PATCH  /segments/:id · DELETE /segments/:id?base_rev= · POST /segments/:id/restore · GET /segments/:id/revisions
//   POST   /segments/:id/links                   manual link to a page / region
//   DELETE /links/:id · POST /links/:id/confirm  remove a link · confirm an AUTO link
//   GET    /links?page_id=|region_id=|source_id= segments linked to a page (reader integration)
//   GET    /images?kind=&origin=&source_id=&topic_id=&q=&cursor=&limit=  ·  GET /images/:id  ·  PATCH /images/:id/meta
//   POST   /images/:id/overlays · PATCH /overlays/:id · DELETE /overlays/:id
//   POST   /images/match {request}               AC-09 gate over the owner's images (accepted / excluded with reasons)
//   POST   /quiz · GET /quiz/:id · GET /quiz/:id/image · POST /quiz/:id/answer · POST /quiz/:id/finish
//   POST   /recordings (multipart: recording_id, started_at, duration_ms?, node_id?, linked_source_id?, title?; file)
//          in-app recording → my_audio_note source (idempotent by recording_id) · GET /recordings/:id (+ linked strokes)
//          · GET /recordings?source_id=  (track F4)
// Capabilities: workspace.audio → available (playback, manual transcript, subtitle import, manual links, in-app
// recording when the browser supports MediaRecorder — automatic transcription is not available, said in /status); external.images → not implemented with the
// reason (no image provider; external fetch is off by default) — the validation gate exists for a future provider.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { imageRequestSchema, type ImageMatchResponse, type MediaStatusResponse } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { sendStoredFile } from '../files';
import { getAudioRow, listAudio, reportDuration } from './audio';
import { allImageRows, imageDetail, imageListQuery, listImages, patchImageMeta, summary } from './images';
import { confirmLink, createLink, linksTo, removeLink } from './links';
import { createOverlay, deleteOverlay, getOverlayRow, patchOverlay } from './overlays';
import { answerQuiz, createQuiz, finishQuiz, getQuizView, sendQuizImage } from './quiz';
import { createSegment, deleteSegment, importSubtitles, patchSegment, restoreSegment, segmentRevisions, transcript } from './transcripts';
import { getImageRow } from './images';
import { validateImageCandidate } from './validate-image';
import { getRecordingRow, recordingsForSource, recordingView, uploadRecording } from './recordings';

const id = z.string().trim().min(1).max(64);
const idParams = z.object({ id });

const AUDIO_REASON_AR = 'التشغيل والتفريغ اليدوي واستيراد ملفات الترجمة (VTT / SRT) والربط اليدوي بالصفحات والتسجيل داخل التطبيق (عند ضغطك «سجّل» فقط، في متصفح يدعم MediaRecorder) تعمل؛ التفريغ الآلي غير متاح في هذا الإصدار.';
const TRANSCRIPTION_AR = 'التفريغ الآلي (transcription) غير متاح: لا يوجد مزود تفريغ مضبوط على الخادم (مزود الذكاء الاصطناعي الحالي لا يدعم هذه المهمة). لا يُرسل أي تسجيل إلى مزود دون إجراء صريح منك.';
const RECORDING_AR = 'التسجيل داخل التطبيق متاح من مساحة الدراسة («المزيد» ← «سجّل ملاحظة صوتية»): لا يبدأ إلا بضغطك، ويظهر مؤشر التسجيل وزر الإيقاف طوال الوقت، ويُحفظ التسجيل على جهازك أولًا ثم يُرفع كملاحظة صوتية. يحتاج متصفحًا يدعم MediaRecorder وإذنك بالميكروفون.';
const AUTOLINK_AR = 'الربط التلقائي بين الصوت والصفحات غير مبني: لا تُخترع مطابقة زمنية دون أساس. الربط اليدوي متاح، وأي ربط تلقائي مستقبلي يُوسم «تلقائي» ويمكنك تأكيده أو إزالته.';

function externalImagesReason(ctx: AppContext): string {
  return ctx.config.allowExternalFetch
    ? 'البحث الخارجي عن الصور غير مبني في هذا الإصدار (لا يوجد مزود صور). أي نتيجة خارجية مستقبلًا تمر ببوابة التحقق (نوع التصوير، المنطقة، التعليق، العمر) وتُستبعد غير المطابقة مع السبب.'
    : 'البحث الخارجي عن الصور غير متاح: الجلب من الإنترنت معطّل على الخادم (MEDLEVO_ALLOW_EXTERNAL_FETCH) ولا يوجد مزود صور. ابحث في صور مصادرك؛ بوابة التحقق من المطابقة جاهزة لأي مزود مستقبلي.';
}

export function mediaStatus(ctx: AppContext): MediaStatusResponse {
  const transcribe = ctx.ai.status().tasks.transcribe;
  return {
    audio_playback: { state: 'available' },
    manual_transcript: { state: 'available' },
    subtitle_import: { state: 'available' },
    transcription: transcribe.available
      ? { state: 'not_implemented', reason_ar: 'مزود التفريغ متاح لكن ربطه بالتسجيلات لم يُبنَ بعد في هذا الإصدار.' }
      : { state: 'requires_configuration', reason_ar: TRANSCRIPTION_AR },
    recording: { state: 'available', reason_ar: RECORDING_AR },
    auto_linking: { state: 'not_implemented', reason_ar: AUTOLINK_AR },
    image_explorer: { state: 'available' },
    image_quiz: { state: 'available' },
    external_image_search: { state: 'not_implemented', reason_ar: externalImagesReason(ctx) },
  };
}

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('workspace.audio', 'available', AUDIO_REASON_AR);
  ctx.capabilities.set('external.images', 'not_implemented', externalImagesReason(ctx));

  app.get('/status', async (): Promise<MediaStatusResponse> => mediaStatus(ctx));

  // ── audio ──
  app.get('/audio', async () => listAudio(ctx));

  const streamAudio = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id: audioId } = parseParams(idParams, req);
    const a = getAudioRow(ctx, audioId);
    const file = ctx.files.stat(a.file_id);
    if (!file) throw new AppError('NOT_FOUND', 'ملف التسجيل غير موجود.', 404);
    return sendStoredFile(ctx.files, file, req, reply);
  };
  app.get('/audio/:id/stream', streamAudio);

  app.patch('/audio/:id', async (req) => {
    const { id: audioId } = parseParams(idParams, req);
    const body = parseBody(z.object({ duration_ms: z.number().min(1).max(24 * 3600 * 1000) }).strict(), req);
    return reportDuration(ctx, audioId, body.duration_ms);
  });

  app.get('/audio/:id/transcript', async (req) => {
    const { id: audioId } = parseParams(idParams, req);
    const q = parseQuery(z.object({ include_deleted: z.enum(['0', '1']).optional() }).strict(), req);
    return transcript(ctx, audioId, { includeDeleted: q.include_deleted === '1' });
  });
  app.post('/audio/:id/segments', async (req) => createSegment(ctx, parseParams(idParams, req).id, req.body ?? {}));
  app.post('/audio/:id/import', { bodyLimit: 3 * 1024 * 1024 }, async (req) => importSubtitles(ctx, parseParams(idParams, req).id, req.body ?? {}));

  app.patch('/segments/:id', async (req) => patchSegment(ctx, parseParams(idParams, req).id, req.body ?? {}));
  app.delete('/segments/:id', async (req) => {
    const q = parseQuery(z.object({ base_rev: z.coerce.number().int().min(1).optional() }).strict(), req);
    return deleteSegment(ctx, parseParams(idParams, req).id, q.base_rev ?? null);
  });
  app.post('/segments/:id/restore', async (req) => restoreSegment(ctx, parseParams(idParams, req).id));
  app.get('/segments/:id/revisions', async (req) => ({ revisions: segmentRevisions(ctx, parseParams(idParams, req).id) }));
  app.post('/segments/:id/links', async (req) => createLink(ctx, parseParams(idParams, req).id, req.body ?? {}));

  app.delete('/links/:id', async (req) => {
    removeLink(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });
  app.post('/links/:id/confirm', async (req) => confirmLink(ctx, parseParams(idParams, req).id));
  app.get('/links', async (req) => {
    const q = parseQuery(z.object({ page_id: id.optional(), region_id: id.optional(), source_id: id.optional() }).strict(), req);
    if (!q.page_id && !q.region_id && !q.source_id) throw new AppError('BAD_REQUEST', 'حدد صفحة أو منطقة أو مصدرًا.', 400);
    return linksTo(ctx, q);
  });

  // ── in-app recordings (track F4): stored as my_audio_note sources; strokes written meanwhile carry time links ──
  app.post('/recordings', { config: { rateLimit: { max: 120, timeWindow: 60_000 } } }, async (req, reply) => {
    const r = await uploadRecording(ctx, req);
    if (r.created) reply.code(201);
    return r;
  });
  app.get('/recordings/:id', async (req) => ({ recording: recordingView(ctx, getRecordingRow(ctx, parseParams(idParams, req).id)) }));
  app.get('/recordings', async (req) => {
    const q = parseQuery(z.object({ source_id: id }).strict(), req);
    return { recordings: recordingsForSource(ctx, q.source_id) };
  });

  // ── images ──
  app.get('/images', async (req) => listImages(ctx, parseQuery(imageListQuery, req)));
  app.post('/images/match', async (req): Promise<ImageMatchResponse> => {
    const body = parseBody(z.object({ request: imageRequestSchema }).strict(), req);
    const accepted: ImageMatchResponse['accepted'] = [];
    const excluded: ImageMatchResponse['excluded'] = [];
    for (const r of allImageRows(ctx)) {
      const v = validateImageCandidate(
        { modality: r.m_modality ?? r.modality, anatomic_region: r.m_region ?? r.anatomic_region, caption: r.caption, age_group: r.m_age, image_kind: r.m_kind ?? r.image_kind, origin: r.origin },
        body.request,
      );
      (v.accepted ? accepted : excluded).push({ image: summary(ctx, r), validation: v });
    }
    return {
      accepted,
      excluded: excluded.slice(0, 100),
      external: mediaStatus(ctx).external_image_search,
      note_ar: accepted.length
        ? 'صور من مصادرك اجتازت كل فحوص المطابقة. لا تُكتب لها شروح تلقائيًا؛ افتح صفحتها لترى سياقها.'
        : 'لا توجد في مصادرك صورة تطابق الطلب في كل الفحوص؛ لا تُعرض صورة قريبة بدلًا منها.',
    };
  });
  app.get('/images/:id', async (req) => imageDetail(ctx, parseParams(idParams, req).id));
  app.patch('/images/:id/meta', async (req) => patchImageMeta(ctx, parseParams(idParams, req).id, req.body ?? {}));
  app.post('/images/:id/overlays', async (req) => {
    const img = getImageRow(ctx, parseParams(idParams, req).id);
    return createOverlay(ctx, img.id, req.body ?? {});
  });
  app.patch('/overlays/:id', async (req) => {
    const o = getOverlayRow(ctx, parseParams(idParams, req).id);
    getImageRow(ctx, o.image_id);
    return patchOverlay(ctx, o.id, req.body ?? {});
  });
  app.delete('/overlays/:id', async (req) => {
    deleteOverlay(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });

  // ── image quiz ──
  app.post('/quiz', async (req) => createQuiz(ctx, req.body ?? {}));
  app.get('/quiz/:id', async (req) => getQuizView(ctx, parseParams(idParams, req).id));
  app.get('/quiz/:id/image', async (req, reply) => sendQuizImage(ctx, parseParams(idParams, req).id, reply));
  app.post('/quiz/:id/answer', async (req) => answerQuiz(ctx, parseParams(idParams, req).id, req.body ?? {}));
  app.post('/quiz/:id/finish', async (req) => finishQuiz(ctx, parseParams(idParams, req).id));
}
