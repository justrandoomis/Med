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
  inputTokens: number;
  outputTokens: number;
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
  generateStructured(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Untrusted content block (uploaded files, OCR, web pages, owner notes…). */
export interface UntrustedBlock {
  /** short trusted label, e.g. "Lecture 3 · p.12 (evidence E1)" */
  label: string;
  text: string;
}
