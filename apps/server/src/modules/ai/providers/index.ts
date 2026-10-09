// Provider factory. Adapters live in this folder (one file per provider).
//
// NOT IMPLEMENTED YET: the Anthropic adapter (`anthropic.ts`, using @anthropic-ai/sdk) is built by a
// later track after reading the claude-api skill. Until then this factory returns null and every AI
// feature reports `requires_configuration` / AI_NOT_CONFIGURED honestly — nothing pretends to work.
//
// Rules for adapters:
//  * read the key ONLY via config.secrets.anthropicApiKey() — never log it, never return it, never store it
//  * implement AiProvider (types.ts): supports(task), modelFor(task), estimateCostUsd(), generateStructured()
//  * return the ACTUAL model id that served the request and the provider request id (no content)
//  * no tools that can reach the network or files
import type { AppConfig } from '../../../config';
import type { AiProvider } from '../types';

export function createProviderFromConfig(_config: AppConfig): AiProvider | null {
  return null;
}
