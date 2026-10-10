// EVALUATION-ONLY scripted AI provider (§57). It is constructed ONLY by the evaluation runner, inside its own
// throwaway data directory (never registered by createContext, never reachable from the owner's server). Each
// evaluation case scripts what the "model" answers; the server's real pipeline (retrieval, Source Lock, evidence
// aliases, claim validation, abstention, publishing) does everything else. A scripted run therefore measures the
// SERVER's guarantees — that a supported answer is kept and linked (no over-abstention), that an answer without
// valid evidence is not shown as supported, that out-of-scope requests abstain — never the quality of a model. The
// report says so on every scripted axis.
import type { AiTask } from '@medlevo/shared';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../ai/types';

export type EvalVerdict = 'supported' | 'partial' | 'not_supported' | 'contradicted';
export type EvalScriptHandler = (req: ProviderRequest) => unknown;

export class EvalScriptedProvider implements AiProvider {
  readonly name = 'eval-scripted';
  readonly calls: ProviderRequest[] = [];
  /** errors thrown by a script (a needle not found in the prompt, …) — the case is reported as an evaluation error */
  readonly errors: unknown[] = [];
  private readonly queues = new Map<AiTask, EvalScriptHandler[]>();
  /** independent-verifier policy by claim text (default: every claim supported) */
  verdict: (claimText: string) => EvalVerdict = () => 'supported';
  private readonly usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };

  supports(): boolean {
    return true;
  }

  modelFor(): string {
    return 'eval-scripted-1';
  }

  estimateCostUsd(): number {
    return 0;
  }

  once(task: AiTask, h: EvalScriptHandler): this {
    const q = this.queues.get(task) ?? [];
    q.push(h);
    this.queues.set(task, q);
    return this;
  }

  /** forget pending scripts and the verdict policy between cases */
  reset(): void {
    this.queues.clear();
    this.errors.length = 0;
    this.verdict = () => 'supported';
  }

  callsFor(task: AiTask): number {
    return this.calls.filter((c) => c.task === task).length;
  }

  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const base = { model: 'eval-scripted-1', usage: this.usage, requestRef: `eval-${this.calls.length}` };
    const queued = this.queues.get(req.task);
    if (req.task === 'verify_support' && !queued?.length) {
      return { ...base, json: { results: claimsInPrompt(req.prompt).map((c) => ({ index: c.index, verdict: this.verdict(c.text), reason: 'حكم مكتوب مسبقًا لحالة التقييم' })) } };
    }
    const h = queued?.shift();
    if (!h) {
      const e = new Error(`eval-scripted: no script for task ${req.task}`);
      this.errors.push(e);
      throw e;
    }
    let out: unknown;
    try {
      out = h(req);
    } catch (e) {
      this.errors.push(e);
      throw e;
    }
    if (out instanceof Error) throw out;
    return { ...base, json: out };
  }
}

/** `CLAIM [i]: text` lines the independent verifier receives. */
export function claimsInPrompt(prompt: string): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  const re = /CLAIM \[(\d+)\]: ([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ index: Number(m[1]), text: m[2]! });
  return out;
}

/** Evidence blocks of a generator prompt: `[E1]` (optionally `[R2]`) then the quote. */
export function evidenceIn(prompt: string): Array<{ alias: string; text: string }> {
  const out: Array<{ alias: string; text: string }> = [];
  const re = /\n\[(E\d+)\](?: \[(?:R\d+)\])?\n([\s\S]*?)\n<\/untrusted_content/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ alias: m[1]!, text: m[2]! });
  return out;
}

/** The alias the server handed out for the evidence containing `needle` (throws → evaluation error, not a pass). */
export function aliasFor(req: ProviderRequest, needle: string): string {
  const e = evidenceIn(req.prompt).find((x) => x.text.includes(needle));
  if (!e) throw new Error(`eval-scripted: no evidence containing «${needle}» was handed to the generator`);
  return e.alias;
}

/** A generated answer in the GeneratedContent shape: one paragraph of claim sentences. */
export function answerOf(sentences: Array<{ text: string; evidence: string[]; support?: 'directly_stated' | 'derived' }>): unknown {
  return {
    blocks: [{ kind: 'paragraph', sentences: sentences.map((s) => ({ text: s.text, claim: { support_type: s.support ?? 'directly_stated', evidence: s.evidence } })) }],
    abstain: null,
  };
}
