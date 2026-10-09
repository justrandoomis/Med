# ADR-0002 — AI provider: Anthropic adapter behind the orchestrator

- **Status:** accepted (track C2, 2026-10-09)
- **Problem:** explanations, the Study Book, contextual chat, summaries, figure explanations and the independent
  claim verifier need a language model with vision and reliable structured output, without weakening the
  evidence contract (§10, §12), Source Lock (§08) or privacy (§49), and with honest cost/budget reporting (§51, §56).
  No key exists in the development environment: everything must be testable without network or key, and every AI
  feature must say «requires configuration» when no key is set.
- **Options considered:**
  1. Several providers / a generic OpenAI-compatible shim — more surface, weaker typing, no benefit for one owner.
  2. Raw HTTP calls — re-implements retries, streaming, typed errors that the official SDK already provides.
  3. **One adapter (`apps/server/src/modules/ai/providers/anthropic.ts`) on the official `@anthropic-ai/sdk`**, behind
     the existing `AiProvider` interface; the orchestrator keeps all policy (scope check, budget, delimiting,
     schema validation + one repair, usage records).
- **Choice:** option 3, created by `createProviderFromConfig()` only when `ANTHROPIC_API_KEY` is set on the server
  (read through `config.secrets.anthropicApiKey()`; the key lives in a private field of the client wrapper, is never
  logged, returned or serialized; the SDK logger is set to `off`; `authToken: null` so a stray
  `ANTHROPIC_AUTH_TOKEN` is never sent as a second credential).

## Models (defaults and overrides)

| role | tasks | default | override |
|---|---|---|---|
| generation | explain, study_book, chat, summarize, compare, generate_questions, grade_written, case_sim, classify | `claude-opus-5-5` | `MEDLEVO_MODEL_GENERATION` |
| verification | verify_support, validate_question | `claude-opus-5-5` | `MEDLEVO_MODEL_VERIFICATION` |
| vision | vision_figure | `claude-opus-5-5` | `MEDLEVO_MODEL_VISION` |
| — | embed, transcribe | unsupported (the Messages API has neither) → `supports()` false, capability says so | — |

Reasons: Claude Opus 5.5 is the current default model in the claude-api skill (1M context, 128K output, vision,
structured outputs). Medical evidence-grounded generation and support verification are correctness-critical, so the
adapter does not silently downgrade to a cheaper model for cost; the owner may choose another model per role
(e.g. `claude-sonnet-5-5` for verification) — the cost estimate follows the model that actually served. Independence
of the verifier comes from a **separate call** with its own system prompt and no generator context (C1's
`validateClaims`), not from a different model; a different verification model is possible through the override.

Effort: `output_config.effort = high` for every generation/verification/vision task (Opus 5.5 defaults to `medium`;
the skill recommends ≥ high for intelligence-sensitive work), `low` for `classify`. Thinking is adaptive (always on
for Opus 5.5 — `thinking` is never sent as disabled or with a budget). Because reasoning tokens count inside
`max_tokens`, the adapter adds a reasoning headroom (high: 16 000 tokens) to the visible-output budget the caller
asked for (`outputTokenCeiling`), and the orchestrator's worst-case **budget pre-check uses that ceiling**.
No sampling parameters (`temperature`/`top_p`/`top_k` are 400s on these models) and **no tools** are ever sent.

## Request & response handling

* **Structured output:** `output_config.format = {type: 'json_schema', schema}` built from the orchestrator's zod
  schema (`z.toJSONSchema`) by `toStructuredOutputSchema()`: `additionalProperties: false` on every object, `enum` /
  `const` / `anyOf` / `$ref` kept, unsupported constraints (min/max length, ranges, defaults, `minItems > 1`, …) moved
  into descriptions. Records/maps cannot be expressed → no `format`, the prompt asks for JSON. The orchestrator always
  re-validates with zod and allows exactly one repair call (SCHEMA_REJECTED otherwise).
* **Streaming:** `client.beta.messages.stream(...).finalMessage()` — long Study Book sections must not hit
  non-streaming HTTP timeouts. Text blocks are joined and parsed; non-JSON text is handed to the orchestrator's
  JSON extraction / repair.
* **Vision:** PNG/JPEG crops from the private file store (figure `image_asset` renders) are sent as base64 `image`
  blocks before the text; other MIME types are refused before any call.
* **Refusal & truncation:** `stop_reason: "refusal"` → `ProviderError('refusal')`; `"max_tokens"` →
  `ProviderError('truncated')`; `model_context_window_exceeded` → `too_large`. Partial output is never returned
  (AC-25: no half-finished content). Server-side refusal fallback is enabled with `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`) for the Opus 5.x / Fable 5.x / Sonnet 5.5 families as the claude-api skill
  recommends; it re-runs the **same request** (same scope, same delimited evidence) on Anthropic's recommended model,
  so Source Lock is unaffected; the model that actually served is the one recorded. It is not sent for Haiku 5.5
  (no server-side fallback) or older models.
* **Retries / timeouts / abort:** SDK retries 408/409/429/5xx/connection errors with backoff, bounded (`maxRetries`
  2, max 4). The orchestrator passes an `AbortSignal` (its per-call timeout + the job's signal): a job cancel
  propagates unchanged; a timeout becomes `ProviderError('timeout')`.
* **Error mapping:** typed SDK errors, most specific first → `ProviderError(kind)` with the provider request id:
  401 `auth`, 403 `permission`, 404 `not_found`, 400/422 `bad_request`, 413 `too_large`, 429 `rate_limited`,
  ≥ 500 (incl. 529) `overloaded`, network `connection`, timeout `timeout`. The orchestrator turns it into
  `AI_PROVIDER_ERROR` with a **specific Arabic reason** (never the upstream message) and `details.provider_error`.
* **Usage & cost:** usage (input incl. cache writes/reads, output incl. reasoning) → `usage_record` with provider,
  served model, latency, status, request id, source version ids and rules version (no prompt text). Cost is an
  **estimate** from a static price table (first-party list prices cached 2026-10-06, e.g. Opus 5.5 $4 / $20 per 1M,
  cache reads $0.20, cache writes 1.25 × input; Haiku 5.5 long-prompt rates above 100K). An unknown model id is
  estimated at the highest known rate (conservative for the budget guard). Refused/truncated calls record the billed
  usage too, so they count toward the monthly budget.

## Changes outside the adapter (minimal, documented)

* `modules/ai/types.ts`: `ProviderUsage` gains optional `cacheCreationInputTokens` / `cacheReadInputTokens`;
  new `ProviderError` + `ProviderErrorKind`; optional `AiProvider.outputTokenCeiling(task, requested)`.
* `modules/ai/orchestrator.ts`: the worst-case budget check uses `outputTokenCeiling` when present; a
  `ProviderError` keeps its request id / billed usage in the `error` usage record and maps to a specific Arabic
  reason (`AI_PROVIDER_ERROR`, 502, `details: {provider_error, retryable}`). Unclassified errors behave as before.

## Not done / limits

* Never run against the real API in this environment (no key): tested only with a mocked HTTP layer
  (`apps/server/test/ai-provider/anthropic.test.ts`). Real latency, real refusal behaviour and real token usage
  are unverified.
* Prompt caching is not used: the orchestrator puts a per-call random delimiter nonce into the system prompt (an
  injection defence), so a cache prefix would never repeat. Costs are therefore estimated without cache savings.
* Batches API not used (requests are interactive or per-section jobs).
* Prices are a static snapshot; the owner must treat costs as estimates (the UI says so).

## Verification (2026-10-09)

* `npx vitest run --root apps/server test/ai-provider` — 14 passed (mocked HTTP layer through the SDK's `fetch`
  option: request shaping, structured output schema, effort / fallback gating per model, vision blocks, per-role
  models, usage incl. cache tokens, price estimates, refusal / truncation, error mapping with request ids, bounded
  retries on 429 / 529, abort vs timeout, factory + secret handling, orchestrator usage records and the budget
  pre-check with reasoning headroom). No network, no key.
* The rest of the AI pipeline (explanations, Study Book, chat, summaries, figures) is tested with test-only fake
  providers; see `docs/modules/studybook.md` §4. No real model call was made in this environment.

