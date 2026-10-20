// Round 7 H4 (§30 «عند streaming، ميّز المسودة التي لم تجتز الفحص عن النتيجة المنشورة»): the client of the
// streaming explain / chat endpoints. POST + fetch (EventSource cannot POST nor send the CSRF header), the body read
// as Server-Sent Events. The draft is shown labelled «مسودة لم تُتحقق بعد» — muted, never with citation chips — and is
// REPLACED by the verified result; sentences verification removed from what the draft showed are listed as removed.
import type { ReactNode } from 'react';
import { STREAM_DRAFT_LABEL_AR, type StudyDraftBlock, type StudyStreamEvent, type StudyStreamPhase } from '@medlevo/shared';
import { StatusPill } from '../../design';
import { ApiError, apiErrorFromResponse, apiFetch, OFFLINE_MESSAGE_AR, UNREACHABLE_MESSAGE_AR } from '../../lib/api';
import { BidiText } from '../evidence';

const CUT_AR = 'انقطع البث قبل وصول النتيجة المتحقَّق منها؛ لم يُعتمد شيء من المسودة. أعد المحاولة.';

/** POST `body` to a streaming endpoint; `onEvent` sees every event; resolves with the `final` result. */
export async function postStudyStream<T>(path: string, body: unknown, opts: { signal?: AbortSignal; onEvent?: (e: StudyStreamEvent<T>) => void }): Promise<{ result: T; removed: Array<{ text: string; reason_ar: string }>; hadDraft: boolean }> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method: 'POST',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'x-medlevo-csrf': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    throw new ApiError({ code: offline ? 'OFFLINE' : 'NETWORK_ERROR', status: 0, offline: true, message: offline ? OFFLINE_MESSAGE_AR : UNREACHABLE_MESSAGE_AR });
  }
  if (!res.ok) throw await apiErrorFromResponse(res);
  if (!res.body) throw new ApiError({ code: 'BAD_RESPONSE', status: res.status, message: CUT_AR });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (chunk: string): { done: true; value: Awaited<ReturnType<typeof postStudyStream<T>>> } | null => {
    const data = chunk
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('\n');
    if (!data) return null; // a keep-alive comment
    let ev: StudyStreamEvent<T>;
    try {
      ev = JSON.parse(data) as StudyStreamEvent<T>;
    } catch {
      return null;
    }
    opts.onEvent?.(ev);
    if (ev.type === 'error') throw new ApiError({ code: ev.error.code as ApiError['code'], status: 200, message: ev.error.message });
    if (ev.type === 'final') return { done: true, value: { result: ev.result, removed: ev.removed, hadDraft: ev.had_draft } };
    return null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const r = handle(chunk);
      if (r) {
        void reader.cancel().catch(() => undefined);
        return r.value;
      }
    }
    if (done) break;
  }
  if (buf.trim()) {
    const r = handle(buf);
    if (r) return r.value;
  }
  throw new ApiError({ code: 'BAD_RESPONSE', status: res.status, message: CUT_AR });
}

/** The live state a streaming request shows while it runs. */
export interface StreamView {
  phase: StudyStreamPhase | null;
  phaseLabel: string | null;
  blocks: StudyDraftBlock[];
  attempt: 1 | 2;
  restartNote: string | null;
  note: string | null;
}
export const EMPTY_STREAM: StreamView = { phase: null, phaseLabel: null, blocks: [], attempt: 1, restartNote: null, note: null };

/** Folds one event into the view (pure; the screens keep it in state). */
export function reduceStream<T>(v: StreamView, e: StudyStreamEvent<T>): StreamView {
  switch (e.type) {
    case 'phase':
      return { ...v, phase: e.phase, phaseLabel: e.label_ar };
    case 'draft':
      return { ...v, blocks: e.blocks, attempt: e.attempt, note: e.note_ar };
    case 'restart':
      return { ...v, blocks: [], attempt: 2, restartNote: e.reason_ar };
    default:
      return v;
  }
}

/** The unverified draft: labelled, muted, no chips, announced politely only by its label (not word by word). */
export function StreamDraft({ view, actions }: { view: StreamView; actions?: ReactNode }) {
  return (
    <section className="sb-draft" aria-label={STREAM_DRAFT_LABEL_AR} aria-busy="true">
      <div className="sb-draft__head">
        <StatusPill tone="warning">{STREAM_DRAFT_LABEL_AR}</StatusPill>
        {view.phaseLabel && (
          <span className="sb-draft__phase" role="status">
            {view.phaseLabel}
          </span>
        )}
        {actions}
      </div>
      {view.restartNote && <p className="sb-draft__restart">{view.restartNote}</p>}
      {view.blocks.length > 0 ? (
        <>
          {view.note && <p className="sb-draft__note">{view.note}</p>}
          <div className="sb-draft__body">
            {view.blocks.map((b, i) =>
              b.kind === 'heading' ? (
                <BidiText key={i} as="p" className="sb-draft__heading" text={b.sentences.join(' ')} />
              ) : (
                <BidiText key={i} as="p" className="sb-draft__p" text={b.sentences.join(' ')} />
              ),
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** After the verified result replaced a draft: what was on screen and did not survive verification, shown as removed. */
export function DraftOutcome({ hadDraft, removed }: { hadDraft: boolean; removed: Array<{ text: string; reason_ar: string }> }) {
  if (!hadDraft) return null;
  return (
    <section className="sb-draft-outcome" aria-label="ما تغيّر عن المسودة">
      <p className="sb-draft-outcome__lede">
        {removed.length
          ? `استُبدلت المسودة بالنتيجة بعد التحقق. حُذفت منها ${removed.length === 1 ? 'جملة واحدة' : removed.length === 2 ? 'جملتان' : `${removed.length} جمل`} لم تجتز التحقق:`
          : 'استُبدلت المسودة بالنتيجة بعد التحقق.'}
      </p>
      {removed.length > 0 && (
        <ul className="sb-draft-outcome__list">
          {removed.map((r, i) => (
            <li key={i}>
              <del>
                <BidiText as="span" text={r.text} />
              </del>
              <span className="sb-draft-outcome__reason">{r.reason_ar}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
