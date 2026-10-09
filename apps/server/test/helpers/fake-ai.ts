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

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
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
    return 'json' in step ? { ...base, json: step.json } : { ...base, text: step.text };
  }
}
