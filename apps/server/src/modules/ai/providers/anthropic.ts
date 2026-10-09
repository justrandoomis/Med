// Anthropic adapter (ADR-0002, §51). Implements AiProvider with the official @anthropic-ai/sdk.
//
//  * key: passed in by createProviderFromConfig (config.secrets.anthropicApiKey()); kept in a private field,
//    never logged, never returned. The SDK's own logger is switched off (it could print request metadata).
//  * per-task model: generation / verification / vision (MEDLEVO_MODEL_* overrides; defaults in ADR-0002)
//  * structured output: `output_config.format = {type:'json_schema', schema}` built from the orchestrator's zod
//    schema (unsupported constraints are moved into descriptions; the orchestrator re-validates with zod)
//  * streaming + finalMessage() (long Study Book sections must not hit HTTP timeouts), bounded SDK retries
//    (429 / 5xx / connection), per-call timeout and abort via the orchestrator's signal
//  * vision: PNG/JPEG crops from the file store as base64 image blocks (task 'vision_figure')
//  * refusal (stop_reason "refusal") / truncation ("max_tokens") are ProviderErrors: partial output is NEVER
//    returned. Server-side refusal fallback (`fallbacks: "default"`) is enabled where the model supports it;
//    the response's `model` (the one that actually served) is what gets recorded.
//  * usage → ESTIMATED cost from a static price table (USD / 1M tokens, cached 2026-10-06). Unknown models
//    are estimated at the highest known rate (conservative for the budget guard).
//  * no tools are ever sent: the model cannot reach URLs, files or other services (§49, AC-29).
import Anthropic from '@anthropic-ai/sdk';
import type { AiTask } from '@medlevo/shared';
import { ProviderError, type AiProvider, type ProviderErrorKind, type ProviderRequest, type ProviderResponse, type ProviderUsage } from '../types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/** Model role per task. Verification is a SEPARATE call (own system prompt, no generator context). */
export type ModelRole = 'generation' | 'verification' | 'vision';

export const TASK_ROLE: Record<AiTask, ModelRole | null> = {
  explain: 'generation',
  study_book: 'generation',
  chat: 'generation',
  summarize: 'generation',
  compare: 'generation',
  generate_questions: 'generation',
  grade_written: 'generation',
  case_sim: 'generation',
  classify: 'generation',
  verify_support: 'verification',
  validate_question: 'verification',
  vision_figure: 'vision',
  // the Messages API offers neither embeddings nor audio transcription → honestly unsupported
  embed: null,
  transcribe: null,
};

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Effort per task: evidence-grounded medical generation and verification are intelligence-sensitive (≥ high). */
export const TASK_EFFORT: Record<AiTask, Effort> = {
  explain: 'high',
  study_book: 'high',
  chat: 'high',
  summarize: 'high',
  compare: 'high',
  generate_questions: 'high',
  grade_written: 'high',
  case_sim: 'high',
  verify_support: 'high',
  validate_question: 'high',
  vision_figure: 'high',
  classify: 'low',
  embed: 'low',
  transcribe: 'low',
};

/** Output tokens reserved for adaptive reasoning on top of the requested visible output (reasoning counts in max_tokens). */
const REASONING_HEADROOM: Record<Effort, number> = { low: 4_000, medium: 8_000, high: 16_000, xhigh: 24_000, max: 32_000 };
const MAX_OUTPUT_TOKENS = 128_000;

export interface ModelPrice {
  /** USD per 1M uncached input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read input tokens */
  cacheRead: number;
  /** prompts above this many input tokens use the `long` rates (Haiku 5.5) */
  longAbove?: number;
  long?: { input: number; output: number };
}

/** ESTIMATES (first-party list prices, cached 2026-10-06; not an invoice). Cache writes ≈ 1.25 × input. */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, longAbove: 100_000, long: { input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};
const CONSERVATIVE_PRICE: ModelPrice = { input: 10, output: 50, cacheRead: 1 };

/** Price entry for a model id (exact, else the longest table key the id starts with, e.g. a dated id). */
export function priceFor(model: string): { price: ModelPrice; known: boolean } {
  const exact = PRICE_TABLE[model];
  if (exact) return { price: exact, known: true };
  const key = Object.keys(PRICE_TABLE)
    .filter((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}@`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { price: PRICE_TABLE[key]!, known: true } : { price: CONSERVATIVE_PRICE, known: false };
}

/** `output_config.effort` is accepted by these model families (it is a 400 on e.g. Haiku 4.5 / Sonnet 4.5). */
function supportsEffort(model: string): boolean {
  return /^claude-(opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|haiku-5|fable-5|mythos-5)/.test(model);
}

/** Server-side refusal fallback (`fallbacks: "default"`, beta header) — Claude API, these families only. */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
}
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'maxItems', 'uniqueItems', 'default', 'examples', 'propertyNames', 'minProperties', 'maxProperties', 'format',
]);
const STRING_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/**
 * JSON Schema → the subset structured outputs accept: `additionalProperties: false` on every object, enum/const/
 * anyOf/$ref kept, unsupported constraints (lengths, ranges, defaults, minItems > 1 …) moved into the description
 * (the orchestrator still validates them with zod). Throws on records/maps (additionalProperties ≠ false), which
 * structured outputs cannot express — the caller then falls back to prompt-only JSON.
 */
export function toStructuredOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
    const src = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const notes: string[] = [];
    for (const [k, v] of Object.entries(src)) {
      if (k === '$schema' || k === 'id' || k === '$id') continue;
      if (k === 'properties' && v && typeof v === 'object') {
        out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)]));
      } else if (k === '$defs' || k === 'definitions') {
        out.$defs = Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([dk, dv]) => [dk, walk(dv)]));
      } else if (k === 'items') {
        out.items = walk(v);
      } else if (k === 'anyOf' || k === 'oneOf') {
        out.anyOf = (v as unknown[]).map(walk);
      } else if (k === 'allOf') {
        out.allOf = (v as unknown[]).map(walk);
      } else if (k === 'additionalProperties') {
        if (v !== false && !(typeof v === 'object' && v !== null && Object.keys(v).length === 0)) {
          throw new Error('structured outputs: maps/records (additionalProperties) are not supported');
        }
      } else if (k === 'minItems') {
        if (v === 0 || v === 1) out.minItems = v;
        else notes.push(`minItems: ${JSON.stringify(v)}`);
      } else if (k === 'format' && typeof v === 'string' && STRING_FORMATS.has(v)) {
        out.format = v;
      } else if (UNSUPPORTED_SCHEMA_KEYS.has(k)) {
        notes.push(`${k}: ${JSON.stringify(v)}`);
      } else {
        out[k] = v;
      }
    }
    if (out.type === 'object' || (out.properties && !out.type)) {
      out.additionalProperties = false;
      if (!out.properties) out.properties = {};
    }
    if (notes.length) out.description = [typeof out.description === 'string' ? out.description : null, `{${notes.join(', ')}}`].filter(Boolean).join('\n\n');
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  models?: { generation?: string | null; verification?: string | null; vision?: string | null };
  /** SDK retries for 408/409/429/5xx/connection errors (bounded; default 2) */
  maxRetries?: number;
  /** per-request ceiling in ms (the orchestrator's signal usually aborts earlier) */
  requestTimeoutMs?: number;
  /** tests only: a mocked HTTP layer */
  fetch?: typeof fetch;
  baseURL?: string;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly #client: Anthropic;
  readonly #models: Record<ModelRole, string>;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new Error('AnthropicProvider: missing API key');
    this.#maxRetries = Math.min(Math.max(opts.maxRetries ?? 2, 0), 4);
    this.#timeoutMs = opts.requestTimeoutMs ?? 10 * 60 * 1000;
    this.#client = new Anthropic({
      apiKey: opts.apiKey,
      authToken: null, // never send a second credential from the environment (401 when both are set)
      maxRetries: this.#maxRetries,
      timeout: this.#timeoutMs,
      logLevel: 'off', // the SDK logger could print request metadata; prompts/keys are never logged
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
    this.#models = {
      generation: opts.models?.generation?.trim() || ANTHROPIC_DEFAULT_MODEL,
      verification: opts.models?.verification?.trim() || ANTHROPIC_DEFAULT_MODEL,
      vision: opts.models?.vision?.trim() || ANTHROPIC_DEFAULT_MODEL,
    };
  }

  /** never serialize the client (it holds the key) */
  toJSON(): Record<string, unknown> {
    return { name: this.name, models: this.#models };
  }

  supports(task: AiTask): boolean {
    return TASK_ROLE[task] !== null && TASK_ROLE[task] !== undefined;
  }

  modelFor(task: AiTask): string {
    const role = TASK_ROLE[task] ?? 'generation';
    return this.#models[role];
  }

  outputTokenCeiling(task: AiTask, requested: number): number {
    return Math.min(MAX_OUTPUT_TOKENS, requested + REASONING_HEADROOM[TASK_EFFORT[task] ?? 'high']);
  }

  estimateCostUsd(model: string, usage: ProviderUsage): number {
    const { price } = priceFor(model);
    const cacheRead = Math.max(0, usage.cacheReadInputTokens ?? 0);
    const cacheWrite = Math.max(0, usage.cacheCreationInputTokens ?? 0);
    const uncached = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
    const long = price.long && price.longAbove !== undefined && usage.inputTokens > price.longAbove ? price.long : null;
    const pin = long?.input ?? price.input;
    const pout = long?.output ?? price.output;
    const usd = (uncached * pin + cacheWrite * pin * 1.25 + cacheRead * price.cacheRead + usage.outputTokens * pout) / 1_000_000;
    return Math.round(usd * 1e8) / 1e8;
  }

  /** The request body (exported for tests through buildParams). */
  buildParams(req: ProviderRequest): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
    const model = req.model;
    const effort = TASK_EFFORT[req.task] ?? 'high';
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      if (!IMAGE_MIMES.has(img.mime)) throw new ProviderError('bad_request', { model });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mime as 'image/png', data: Buffer.from(img.data).toString('base64') } });
    }
    content.push({ type: 'text', text: req.prompt });

    let format: Anthropic.Beta.Messages.BetaJSONOutputFormat | null = null;
    if (req.jsonSchema) {
      try {
        format = { type: 'json_schema', schema: toStructuredOutputSchema(req.jsonSchema) };
      } catch {
        format = null; // inexpressible schema → the prompt asks for JSON; the orchestrator validates with zod
      }
    }
    const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
    if (supportsEffort(model)) outputConfig.effort = effort;
    if (format) outputConfig.format = format;

    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: this.outputTokenCeiling(req.task, req.maxOutputTokens),
      system: req.system,
      messages: [{ role: 'user', content }],
      ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    };
    if (supportsDefaultFallback(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    return params;
  }

  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    const params = this.buildParams(req);
    let message: Anthropic.Beta.Messages.BetaMessage;
    let requestRef: string | null = null;
    try {
      const stream = this.#client.beta.messages.stream(params, { signal: req.signal, timeout: this.#timeoutMs, maxRetries: this.#maxRetries });
      message = await stream.finalMessage();
      requestRef = stream.request_id ?? null;
    } catch (e) {
      throw this.mapError(e, req);
    }
    const usage = toUsage(message.usage);
    const served = message.model || req.model;
    if (message.stop_reason === 'refusal') throw new ProviderError('refusal', { requestRef, usage, model: served });
    if (message.stop_reason === 'max_tokens') throw new ProviderError('truncated', { requestRef, usage, model: served });
    if (message.stop_reason === 'model_context_window_exceeded') throw new ProviderError('too_large', { requestRef, usage, model: served });

    const text = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const out: ProviderResponse = { model: served, usage, requestRef: requestRef ?? undefined };
    try {
      out.json = JSON.parse(text);
    } catch {
      out.text = text; // the orchestrator extracts JSON / runs its single repair attempt
    }
    return out;
  }

  private mapError(e: unknown, req: ProviderRequest): unknown {
    const ref = (err: unknown) => (err instanceof Anthropic.APIError ? (err.requestID ?? null) : null);
    const make = (kind: ProviderErrorKind, retryable: boolean, status: number | null = null) => new ProviderError(kind, { retryable, status, requestRef: ref(e), model: req.model });
    // most specific first (APIConnectionTimeoutError ⊂ APIConnectionError ⊂ APIError in the TS SDK)
    if (e instanceof Anthropic.APIUserAbortError || req.signal.aborted) {
      const reason = req.signal.reason as { name?: string } | undefined;
      if (reason?.name === 'TimeoutError') return make('timeout', true);
      return e; // the caller (job cancel) aborted: propagate unchanged
    }
    if (e instanceof Anthropic.APIConnectionTimeoutError) return make('timeout', true);
    if (e instanceof Anthropic.APIConnectionError) return make('connection', true);
    if (e instanceof Anthropic.AuthenticationError) return make('auth', false, 401);
    if (e instanceof Anthropic.PermissionDeniedError) return make('permission', false, 403);
    if (e instanceof Anthropic.NotFoundError) return make('not_found', false, 404);
    if (e instanceof Anthropic.RateLimitError) return make('rate_limited', true, 429);
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError) return make('bad_request', false, e.status ?? 400);
    if (e instanceof Anthropic.InternalServerError) return make('overloaded', true, e.status ?? 500);
    if (e instanceof Anthropic.APIError) {
      const status = typeof e.status === 'number' ? e.status : null;
      if (status === 413) return make('too_large', false, 413);
      return make(status !== null && status >= 500 ? 'overloaded' : 'bad_request', status !== null && status >= 500, status);
    }
    if (e instanceof ProviderError) return e;
    return make('connection', true);
  }
}

function toUsage(u: Anthropic.Beta.Messages.BetaUsage | null | undefined): ProviderUsage {
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (u?.input_tokens ?? 0) + cacheWrite + cacheRead,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
  };
}
