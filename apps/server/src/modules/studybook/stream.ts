// Round 7 H4 (§30 «عند streaming، ميّز المسودة التي لم تجتز الفحص عن النتيجة المنشورة»): Server-Sent Events for the
// explain and chat answers. The same pipeline runs (Source Lock, retrieval, generation, claim-by-claim verification,
// publish); while the model writes, its text is shown as an UNVERIFIED draft — labelled «مسودة لم تُتحقق بعد», never
// stored, never cited — and the `final` event replaces it with the verified result and lists the sentences that
// verification REMOVED (so nothing that was on screen disappears silently).
//
//   phase      retrieving → generating → verifying
//   draft      the whole draft so far (blocks of sentences read from the partial JSON), throttled
//   restart    the first answer failed the required structure: its draft is void, the single repair attempt starts
//   final      exactly the non-streaming response + `removed` + `had_draft`
//   error      {code, message} — the same Arabic reasons as the JSON endpoints
//
// The owner closing the connection (or pressing «أوقف») aborts the provider call through the request's signal.
// Auth, CSRF and rate limits are those of every other mutation (the routes are ordinary POSTs).
import { PassThrough } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { STREAM_DRAFT_LABEL_AR, STREAM_DRAFT_NOTE_AR, STUDY_STREAM_PHASE_LABELS_AR, type StudyStreamEvent, type StudyStreamPhase } from '@medlevo/shared';
import { isAppError } from '../../lib/errors';
import type { AiTextEvent } from '../ai';
import { draftFromPartialJson } from './draft';

export interface StudyStreamHooks {
  signal: AbortSignal;
  onPhase: (phase: Exclude<StudyStreamPhase, 'retrieving'>) => void;
  onText: (e: AiTextEvent) => void;
}

export interface StudyStreamOptions {
  /** minimum ms between two draft events (default 120) */
  throttleMs?: number;
  /** keep-alive comment interval (default 15 s) */
  keepAliveMs?: number;
}

const RESTART_AR = 'لم تطابق المسودة البنية المطلوبة، فأُلغيت وتُعاد كتابتها مرة واحدة. لا يُستخدم شيء من المسودة الأولى.';
const INTERNAL_AR = 'حدث خطأ داخلي غير متوقع في الخادم. أعد المحاولة، وإذا تكرر فراجع سجل الخادم.';

/** Runs `run` and streams its draft / phases / result as SSE on `reply`. */
export function sendStudyStream<TFinal>(
  req: FastifyRequest,
  reply: FastifyReply,
  run: (hooks: StudyStreamHooks) => Promise<TFinal>,
  removedOf: (result: TFinal) => Array<{ text: string; reason_ar: string }>,
  opts: StudyStreamOptions = {},
): FastifyReply {
  const out = new PassThrough();
  const ac = new AbortController();
  const throttleMs = opts.throttleMs ?? 120;
  let ended = false;
  const write = (e: StudyStreamEvent<TFinal>) => {
    if (ended || out.destroyed) return;
    out.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  // the owner went away (closed the tab, pressed «أوقف»): stop the model call
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished && !ac.signal.aborted) ac.abort(new DOMException('the client closed the stream', 'AbortError'));
  });

  let raw = '';
  let attempt: 1 | 2 = 1;
  let lastSent = '';
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hadDraft = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const blocks = draftFromPartialJson(raw);
    const key = JSON.stringify(blocks);
    if (key === lastSent || blocks.length === 0) return;
    lastSent = key;
    lastAt = Date.now();
    hadDraft = true;
    write({ type: 'draft', attempt, blocks, label_ar: STREAM_DRAFT_LABEL_AR, note_ar: STREAM_DRAFT_NOTE_AR });
  };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, throttleMs - (Date.now() - lastAt));
    timer = setTimeout(flush, wait);
  };
  const hooks: StudyStreamHooks = {
    signal: ac.signal,
    onPhase: (phase) => {
      if (phase === 'verifying') flush(); // the whole draft is on screen before it is checked
      write({ type: 'phase', phase, label_ar: STUDY_STREAM_PHASE_LABELS_AR[phase] });
    },
    onText: (e) => {
      if (e.type === 'restart') {
        flush(); // what was written is on screen before it is voided
        raw = '';
        lastSent = '';
        attempt = 2;
        write({ type: 'restart', attempt: 2, reason_ar: RESTART_AR });
        return;
      }
      if (e.attempt !== attempt) return;
      raw += e.text;
      schedule();
    },
  };
  const keepAlive = setInterval(() => {
    if (!ended && !out.destroyed) out.write(': keep-alive\n\n');
  }, opts.keepAliveMs ?? 15_000);
  keepAlive.unref?.();

  void (async () => {
    try {
      write({ type: 'phase', phase: 'retrieving', label_ar: STUDY_STREAM_PHASE_LABELS_AR.retrieving });
      const result = await run(hooks);
      if (timer) clearTimeout(timer);
      timer = null;
      write({ type: 'final', result, removed: removedOf(result), had_draft: hadDraft });
    } catch (e) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!ac.signal.aborted) {
        if (isAppError(e)) write({ type: 'error', error: { code: e.code, message: e.messageAr } });
        else {
          req.log.error({ err: e }, 'study stream failed');
          write({ type: 'error', error: { code: 'INTERNAL', message: INTERNAL_AR } });
        }
      }
    } finally {
      clearInterval(keepAlive);
      ended = true;
      out.end();
    }
  })();

  reply.header('content-type', 'text/event-stream; charset=utf-8');
  reply.header('cache-control', 'no-store');
  reply.header('x-accel-buffering', 'no');
  return reply.send(out);
}
