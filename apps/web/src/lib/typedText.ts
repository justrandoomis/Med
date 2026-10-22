// AC-20 / AOS-1.16 on the new editors (track C3): text a person types for other people to read — channel and subject
// titles, lecture titles, explanation titles and summaries, change notes, reasons, a display name — never keeps a bidi
// control character (LRM, RLM, ALM, embeddings, overrides, isolates) or an invisible control character. They arrive
// unseen with pasted text (WhatsApp, Word, PDF viewers) and the renderer isolates English runs itself (AC-20), so they
// are removed AS THE PERSON TYPES OR PASTES: the field shows exactly what will be stored, and the server's refusal of
// such characters (packages/shared `plainTextSchema`) — which the person could not act on, since they are invisible —
// is never reached from these screens.
import { stripBidiControls } from '@medlevo/shared';

// eslint-disable-next-line no-control-regex -- the point: invisible control characters a one-line field must not keep
const CONTROL_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
// eslint-disable-next-line no-control-regex -- multi-line text keeps tab and newlines, nothing else invisible
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g;

/** The text as it will be stored: no bidi control; in a one-line field a pasted line break becomes one space. */
export function cleanTyped(value: string, opts: { multiline?: boolean } = {}): string {
  const noBidi = stripBidiControls(value);
  return opts.multiline ? noBidi.replace(CONTROL_MULTI_LINE, '').replace(/\u2028|\u2029/g, '\n') : noBidi.replace(CONTROL_ONE_LINE, ' ');
}

/** `onChange={typed(setTitle)}` — a one-line field; `typed(setNote, true)` — a multi-line one. */
export function typed(set: (value: string) => void, multiline = false): (e: { target: { value: string } }) => void {
  return (e) => set(cleanTyped(e.target.value, { multiline }));
}
