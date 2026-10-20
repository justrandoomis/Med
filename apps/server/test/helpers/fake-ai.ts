// TEST-ONLY deterministic AI provider. Never registered in production code paths.
import type { AiTask } from '@medlevo/shared';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';

export type FakeStep = { json: unknown } | { text: string } | { error: Error };

export interface FakeAiOptions {
  steps?: FakeStep[];
  /** tasks this provider supports (default: all) */
  supports?: AiTask[] | 'all';
  model?: string;
  usage?: ProviderUsage;
  /** USD per 1M input / output tokens used by estimateCostUsd */
  pricePerMInput?: number;
  pricePerMOutput?: number;
}

/**
 * (Round 7 H4) Streams `text` to `req.onTextDelta` in small chunks (one event-loop turn apart, like a real stream),
 * stops with an AbortError when the request's signal aborts, and can hold mid-stream (`pause`) so a test can cancel
 * while the draft is on screen.
 */
export async function streamFake(req: ProviderRequest, text: string, opts: { chunk?: number; pause?: { afterChunks: number; until: Promise<void> } | null } = {}): Promise<void> {
  if (!req.onTextDelta) return;
  const size = Math.max(1, opts.chunk ?? 23);
  let n = 0;
  for (let i = 0; i < text.length; i += size) {
    if (req.signal.aborted) throw req.signal.reason ?? new DOMException('aborted', 'AbortError');
    req.onTextDelta(text.slice(i, i + size));
    n++;
    if (opts.pause && n === opts.pause.afterChunks) {
      await Promise.race([opts.pause.until, new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }))]);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
  if (req.signal.aborted) throw req.signal.reason ?? new DOMException('aborted', 'AbortError');
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly streamsText = true;
  readonly calls: ProviderRequest[] = [];
  private readonly steps: FakeStep[];
  private readonly supported: AiTask[] | 'all';
  private readonly model: string;
  private readonly usage: ProviderUsage;
  private readonly priceIn: number;
  private readonly priceOut: number;

  constructor(opts: FakeAiOptions = {}) {
    this.steps = [...(opts.steps ?? [])];
    this.supported = opts.supports ?? 'all';
    this.model = opts.model ?? 'fake-model-1';
    this.usage = opts.usage ?? { inputTokens: 1000, outputTokens: 500 };
    this.priceIn = opts.pricePerMInput ?? 3;
    this.priceOut = opts.pricePerMOutput ?? 15;
  }

  push(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }

  supports(task: AiTask): boolean {
    return this.supported === 'all' || this.supported.includes(task);
  }

  modelFor(): string {
    return this.model;
  }

  estimateCostUsd(_model: string, usage: ProviderUsage): number {
    return (usage.inputTokens * this.priceIn + usage.outputTokens * this.priceOut) / 1_000_000;
  }

  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const step = this.steps.shift();
    if (!step) throw new Error('FakeAiProvider: no scripted response left');
    if ('error' in step) throw step.error;
    const base = { model: this.model, usage: this.usage, requestRef: `fake-${this.calls.length}` };
    await streamFake(req, 'json' in step ? JSON.stringify(step.json) : step.text);
    return 'json' in step ? { ...base, json: step.json } : { ...base, text: step.text };
  }
}
