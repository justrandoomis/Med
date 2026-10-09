// AI provider abstraction (§51). Providers are adapters; the orchestrator owns policy
// (availability, budget, scope checks, untrusted-content delimiting, schema validation, usage records).
import type { AiTask } from '@medlevo/shared';

export { AI_TASKS, type AiTask } from '@medlevo/shared';

export interface ProviderImage {
  mime: string;
  data: Uint8Array;
}

export interface ProviderRequest {
  task: AiTask;
  /** model chosen by the provider for this task (provider may override with an alias) */
  model: string;
  /** full system prompt including the untrusted-content policy */
  system: string;
  /** user turn: delimited untrusted content + trusted request */
  prompt: string;
  /** JSON Schema of the expected output (when convertible from the zod schema) */
  jsonSchema?: Record<string, unknown>;
  images?: ProviderImage[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ProviderUsage {
  /** all input tokens billed for the request (uncached + cache writes + cache reads) */
  inputTokens: number;
  /** all output tokens billed (includes the model's internal reasoning tokens) */
  outputTokens: number;
  /** (track C2, optional) part of inputTokens written to the provider's prompt cache */
  cacheCreationInputTokens?: number;
  /** (track C2, optional) part of inputTokens read from the provider's prompt cache */
  cacheReadInputTokens?: number;
}

/**
 * (track C2) A classified provider failure. Adapters throw it so the orchestrator can record the provider
 * request id / any billed usage and show a specific Arabic reason — never the provider's raw message.
 */
export type ProviderErrorKind =
  | 'auth' // 401: key invalid / revoked
  | 'permission' // 403
  | 'not_found' // 404: unknown model id (e.g. a wrong MEDLEVO_MODEL_* override)
  | 'bad_request' // 400 / 422
  | 'too_large' // 413
  | 'rate_limited' // 429 (after the SDK's bounded retries)
  | 'overloaded' // 529 / 5xx (after retries)
  | 'timeout'
  | 'connection'
  | 'refusal' // stop_reason "refusal" (after any server-side fallback)
  | 'truncated'; // stop_reason "max_tokens": incomplete output is never returned

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestRef: string | null;
  /** billed usage when the provider produced (unusable) output */
  readonly usage: ProviderUsage | null;
  readonly model: string | null;
  constructor(kind: ProviderErrorKind, opts: { retryable?: boolean; status?: number | null; requestRef?: string | null; usage?: ProviderUsage | null; model?: string | null } = {}) {
    super(`provider error: ${kind}`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? null;
    this.requestRef = opts.requestRef ?? null;
    this.usage = opts.usage ?? null;
    this.model = opts.model ?? null;
  }
}

export interface ProviderResponse {
  /** structured output if the provider returns parsed JSON (tool/structured output) */
  json?: unknown;
  /** raw text output (parsed as JSON when `json` is absent) */
  text?: string;
  /** the actual model that served the request */
  model: string;
  usage: ProviderUsage;
  /** provider request id (no content) */
  requestRef?: string;
}

export interface AiProvider {
  readonly name: string;
  supports(task: AiTask): boolean;
  /** model used for a task (for status display and usage records) */
  modelFor(task: AiTask): string;
  /** ESTIMATED cost in USD for the given usage (not an invoice) */
  estimateCostUsd(model: string, usage: ProviderUsage): number;
  /**
   * (track C2, optional) the largest number of output tokens a call may bill for `requested` visible output
   * tokens (e.g. + reasoning headroom). The orchestrator's worst-case budget check uses it.
   */
  outputTokenCeiling?(task: AiTask, requested: number): number;
  generateStructured(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Untrusted content block (uploaded files, OCR, web pages, owner notes…). */
export interface UntrustedBlock {
  /** short trusted label, e.g. "Lecture 3 · p.12 (evidence E1)" */
  label: string;
  text: string;
}
