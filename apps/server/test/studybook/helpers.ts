// Study Book test helpers: a TEST-ONLY scripted AI provider that answers per task (the generator from a
// script, the independent verifier by parsing the claims it receives), and prompt parsers so a scripted
// generator can cite the aliases the server actually handed out. Golden Set sources are processed by the
// REAL pipeline (evidence helpers).
import type { AiTask } from '@medlevo/shared';
import type { AiProvider, ProviderRequest, ProviderResponse, ProviderUsage } from '../../src/modules/ai/types';
import { MODULES } from '../../src/modules';
import { createProcessingModule } from '../../src/modules/processing';
import { createStudybookModule, type StudybookModuleOptions } from '../../src/modules/studybook';
import { createTestApp, type TestApp } from '../helpers/app';
import { addSource, processVersion, type AddedSource } from '../processing/helpers';

export type Verdict = 'supported' | 'partial' | 'not_supported' | 'contradicted';
export type Handler = (req: ProviderRequest) => unknown;

/** Deterministic per-task provider. Generators are queued (`once`) or permanent (`always`). */
export class ScriptedAi implements AiProvider {
  readonly name = 'fake';
  readonly calls: ProviderRequest[] = [];
  /** exceptions thrown by scripted handlers (assertions inside generators) */
  readonly errors: unknown[] = [];
  private readonly queues = new Map<AiTask, Handler[]>();
  private readonly permanent = new Map<AiTask, Handler>();
  /** verifier policy by claim text (default: supported) */
  verdict: (claimText: string) => Verdict = () => 'supported';
  private readonly unsupported: Set<AiTask>;
  model = 'fake-model-1';
  usage: ProviderUsage = { inputTokens: 1000, outputTokens: 400 };

  constructor(opts: { unsupported?: AiTask[] } = {}) {
    this.unsupported = new Set(opts.unsupported ?? []);
  }

  once(task: AiTask, h: Handler): this {
    const q = this.queues.get(task) ?? [];
    q.push(h);
    this.queues.set(task, q);
    return this;
  }

  always(task: AiTask, h: Handler): this {
    this.permanent.set(task, h);
    return this;
  }

  callsFor(task: AiTask): ProviderRequest[] {
    return this.calls.filter((c) => c.task === task);
  }

  supports(task: AiTask): boolean {
    return !this.unsupported.has(task);
  }
  modelFor(): string {
    return this.model;
  }
  estimateCostUsd(_m: string, u: ProviderUsage): number {
    return (u.inputTokens * 3 + u.outputTokens * 15) / 1_000_000;
  }

  async generateStructured(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const base = { model: this.model, usage: this.usage, requestRef: `fake-${this.calls.length}` };
    if (req.task === 'verify_support' && !this.queues.get('verify_support')?.length && !this.permanent.has('verify_support')) {
      return { ...base, json: { results: claimsInPrompt(req.prompt).map((c) => ({ index: c.index, verdict: this.verdict(c.text), reason: 'سبب الاختبار' })) } };
    }
    const h = this.queues.get(req.task)?.shift() ?? this.permanent.get(req.task);
    if (!h) {
      const e = new Error(`ScriptedAi: no handler for task ${req.task}`);
      this.errors.push(e);
      throw e;
    }
    let out: unknown;
    try {
      out = h(req);
    } catch (e) {
      // a failing scripted assertion surfaces in the test output (the orchestrator would hide it as a provider error)
      this.errors.push(e);
      throw e;
    }
    if (out instanceof Error) throw out;
    if (out && typeof out === 'object' && 'text' in (out as Record<string, unknown>) && Object.keys(out as object).length === 1) return { ...base, text: String((out as { text: string }).text) };
    return { ...base, json: out };
  }
}

/** `CLAIM [i]: text` lines the verifier receives. */
export function claimsInPrompt(prompt: string): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  const re = /CLAIM \[(\d+)\]: ([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ index: Number(m[1]), text: m[2]! });
  return out;
}

export interface PromptEvidence {
  alias: string;
  region?: string;
  text: string;
}

/** Evidence blocks of a generator prompt: `[E1]` (optionally `[R2]`) then the quote. */
export function evidenceIn(prompt: string): PromptEvidence[] {
  const out: PromptEvidence[] = [];
  const re = /\n\[(E\d+)\](?: \[(R\d+)\])?\n([\s\S]*?)\n<\/untrusted_content/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ alias: m[1]!, region: m[2], text: m[3]! });
  return out;
}

/** Region aliases (study book): `[Rn]` with or without evidence. */
export function regionsIn(prompt: string): Array<{ region: string; alias: string | null; text: string }> {
  const out: Array<{ region: string; alias: string | null; text: string }> = [];
  const re = /<untrusted_content [^>]*label="(?:evidence (E\d+) = )?region (R\d+)[^"]*">\n([\s\S]*?)\n<\/untrusted_content/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ alias: m[1] ?? null, region: m[2]!, text: m[3]! });
  return out;
}

export function aliasFor(req: ProviderRequest, needle: string): string {
  const e = evidenceIn(req.prompt).find((x) => x.text.includes(needle));
  if (!e) throw new Error(`no evidence alias containing «${needle}» in the prompt`);
  return e.alias;
}

export const S = {
  /** a claim sentence */
  c: (text: string, evidence: string[], support: 'directly_stated' | 'derived' | 'synthesized' | 'externally_supplemented' = 'derived', extra: Record<string, unknown> = {}) => ({
    text,
    claim: { support_type: support, evidence },
    ...extra,
  }),
  /** a non-medical sentence */
  n: (text: string) => ({ text, claim: null }),
};

export function content(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return { blocks, abstain: null, ...extra };
}

export interface StudyLib {
  t: TestApp;
  h: Awaited<ReturnType<TestApp['login']>>;
  lecture: AddedSource;
  reference: AddedSource;
}

export async function createStudyApp(ai: AiProvider | null, opts: StudybookModuleOptions & { env?: Record<string, string> } = {}): Promise<TestApp> {
  return createTestApp({
    ai,
    env: opts.env,
    modules: MODULES.map((m) =>
      m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m.name === 'studybook' ? { ...m, plugin: createStudybookModule({ hooks: opts.hooks }) } : m,
    ),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
}

/** Appendicitis lecture + cholecystitis reference, processed by the real pipeline. */
export async function studyLibrary(ai: AiProvider | null, opts: StudybookModuleOptions & { env?: Record<string, string> } = {}): Promise<StudyLib> {
  const t = await createStudyApp(ai, opts);
  const lecture = await addSource(t, 'lecture_appendicitis.pdf', 'pdf', { sourceType: 'lecture', title: 'Acute Appendicitis (TEST FIXTURE)' });
  const reference = await addSource(t, 'lecture_cholecystitis.pdf', 'pdf', { sourceType: 'course_reference', title: 'Cholecystitis reference (TEST FIXTURE)' });
  for (const s of [lecture, reference]) {
    const job = await processVersion(t, s.versionId);
    if (job.status !== 'completed' && job.status !== 'partial') throw new Error(`processing failed: ${job.status}`);
  }
  const h = await t.login();
  return { t, h, lecture, reference };
}

export function lectureOnly(lib: StudyLib) {
  return { mode: 'lecture_only' as const, lecture_source_id: lib.lecture.sourceId };
}

export function withRefs(lib: StudyLib) {
  return { mode: 'lecture_plus_references' as const, lecture_source_id: lib.lecture.sourceId, reference_source_ids: [lib.reference.sourceId] };
}
