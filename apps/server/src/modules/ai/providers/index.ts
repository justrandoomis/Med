// Provider factory. Adapters live in this folder (one file per provider).
//
// Rules for adapters:
//  * read the key ONLY via config.secrets.anthropicApiKey() — never log it, never return it, never store it
//    in a serializable property
//  * implement AiProvider (types.ts): supports(task), modelFor(task), estimateCostUsd(), generateStructured()
//  * return the ACTUAL model id that served the request and the provider request id (no content)
//  * no tools that can reach the network or files
//
// Anthropic (ADR-0002): returned when ANTHROPIC_API_KEY is set on the server. Without a key this returns null
// and every AI feature reports `requires_configuration` / AI_NOT_CONFIGURED honestly — nothing pretends to work.
import type { AppConfig } from '../../../config';
import type { AiProvider } from '../types';
import { AnthropicProvider } from './anthropic';

export { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL, PRICE_TABLE, priceFor, toStructuredOutputSchema, TASK_ROLE, TASK_EFFORT } from './anthropic';

export function createProviderFromConfig(config: AppConfig): AiProvider | null {
  const key = config.secrets.anthropicApiKey();
  if (!key) return null;
  return new AnthropicProvider({ apiKey: key, models: config.ai.models });
}
