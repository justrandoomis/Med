// AOS-21.42: the ONE place the app asks for the ai_processing consent outside «الخصوصية والبيانات». An AI action the
// server refuses with CONSENT_REQUIRED (lib/api.ts → offerAiConsent) and the home prompt both call requestAiConsent();
// AiConsentPrompt (mounted once behind the session, app/layouts.tsx) shows the dialog and settles the answer. Requests
// that hit the refusal while the dialog is open share it: one dialog, one answer, each retried once when agreed.

type Asking = { promise: Promise<boolean>; resolve: (granted: boolean) => void };

let asking: Asking | null = null;
/** bumped whenever this account's consent changes here (the home prompt hides itself) */
let consentRevision = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

/** Show the consent dialog (or join the one already open). Resolves true once the consent is recorded. */
export function requestAiConsent(): Promise<boolean> {
  if (asking) return asking.promise;
  let resolve!: (granted: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  asking = { promise, resolve };
  emit();
  return promise;
}

/** The dialog's answer: true = recorded («وافق وفعّل»), false = «ليس الآن» (nothing is sent). */
export function settleAiConsent(granted: boolean): void {
  const a = asking;
  asking = null;
  if (granted) consentRevision++;
  emit();
  a?.resolve(granted);
}

export function isAskingAiConsent(): boolean {
  return asking !== null;
}

export function aiConsentRevision(): number {
  return consentRevision;
}

export function subscribeAiConsent(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
