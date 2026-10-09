// AI Orchestrator (§51, ARCHITECTURE §3.5).
//  * no provider → AI_NOT_CONFIGURED (409); nothing pretends to work
//  * Source Lock: every source version passed to a call must belong to the resolved scope (server-enforced)
//  * monthly budget from usage_record ESTIMATED costs → AI_BUDGET_EXCEEDED (never a silently degraded result)
//  * output validated with the zod schema; one bounded repair attempt, then SCHEMA_REJECTED
//  * every provider call writes a usage_record (ok / error / schema_rejected / budget_blocked) — no prompt text
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { AI_TASKS, type AiBudgetStatus, type AiStatusResponse, type AiTask, type AiTaskStatus, type ResolvedScope } from '@medlevo/shared';
import type { Db } from '../../db/db';
import { toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { type Clock, startOfMonthInTz } from '../../lib/time';
import { buildPrompt, estimateTokens } from './prompt';
import { ProviderError, type AiProvider, type ProviderErrorKind, type ProviderImage, type ProviderResponse, type UntrustedBlock } from './types';

/** Version of the explanation/verification rules; recorded with every call and in cache keys. */
export const AI_RULES_VERSION = 'rules-2026.10-1';

export interface GenerateStructuredRequest<T> {
  task: AiTask;
  schema: z.ZodType<T>;
  /** trusted system instructions for this task */
  system: string;
  /** untrusted content — always delimited */
  input: string | UntrustedBlock[];
  /** trusted per-call request appended after the delimited content */
  instruction?: string;
  scope: ResolvedScope;
  sourceVersionIds: string[];
  jobId?: string;
  images?: ProviderImage[];
  maxOutputTokens?: number;
  rulesVersion?: string;
  /** e.g. the job's AbortSignal */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GenerateStructuredResult<T> {
  output: T;
  model: string;
  usageId: string;
}

export interface AiOrchestratorOptions {
  provider: AiProvider | null;
  monthlyBudgetUsd: number;
  timezone: string;
}

type UsageStatus = 'ok' | 'error' | 'schema_rejected' | 'budget_blocked';

const MSG = {
  notConfigured: 'ميزات الذكاء الاصطناعي غير مفعّلة: لم يُضبط مفتاح مزود على الخادم (ANTHROPIC_API_KEY). باقي الميزات الحتمية تعمل دونه.',
  unsupported: 'مزود الذكاء الاصطناعي الحالي لا يدعم هذه المهمة.',
  providerError: 'تعذر الحصول على رد من مزود الذكاء الاصطناعي. أعد المحاولة بعد قليل.',
  schemaRejected: 'رُفضت نتيجة الذكاء الاصطناعي لأنها لم تطابق البنية المطلوبة حتى بعد محاولة تصحيح واحدة. لم يُحفظ شيء منها.',
  outOfScope: 'طُلب استخدام مصدر خارج نطاق المصادر المحدد (Source Lock). وسّع النطاق صراحةً إن أردت.',
};

/** (track C2) specific Arabic reasons for classified provider failures (ProviderError). Never the raw provider text. */
const PROVIDER_ERROR_AR: Record<ProviderErrorKind, string> = {
  auth: 'رفض مزود الذكاء الاصطناعي مفتاح الخادم (ANTHROPIC_API_KEY غير صالح أو أُلغي). حدّث المفتاح في إعدادات الخادم.',
  permission: 'المفتاح المضبوط على الخادم لا يملك صلاحية هذا الطلب لدى المزود.',
  not_found: 'النموذج المحدد غير متاح لهذا الحساب لدى المزود. راجع MEDLEVO_MODEL_* في إعدادات الخادم.',
  bad_request: 'رفض المزود صيغة الطلب. لم يُحفظ شيء؛ أبلغ عن المشكلة إن تكررت.',
  too_large: 'المحتوى المرسل أكبر من الحد الذي يقبله المزود. اختر نطاقًا أو صفحات أقل.',
  rate_limited: 'تجاوز الخادم حد الطلبات لدى مزود الذكاء الاصطناعي بعد إعادة المحاولة. انتظر قليلًا ثم أعد المحاولة.',
  overloaded: 'مزود الذكاء الاصطناعي مشغول أو متعطل مؤقتًا بعد إعادة المحاولة. أعد المحاولة بعد قليل.',
  timeout: 'انتهت مهلة انتظار رد مزود الذكاء الاصطناعي. أعد المحاولة، أو اختر جزءًا أصغر.',
  connection: 'تعذر الاتصال بمزود الذكاء الاصطناعي من الخادم. تحقق من اتصال الخادم بالإنترنت.',
  refusal: 'امتنع النموذج عن إكمال هذا الطلب لأسباب تتعلق بسياسة السلامة لدى المزود. لم يُعرض أي ناتج جزئي.',
  truncated: 'انقطع رد النموذج قبل اكتماله (بلغ الحد الأقصى للطول)، فلم يُستخدم أي جزء منه. جرّب جزءًا أصغر.',
};

function budgetMessage(budget: number): string {
  if (budget <= 0) return 'استدعاءات الذكاء الاصطناعي متوقفة لأن الميزانية الشهرية مضبوطة على 0. ارفع الحد (MEDLEVO_AI_MONTHLY_BUDGET_USD) لتفعيلها.';
  return `بلغت التكلفة التقديرية للذكاء الاصطناعي هذا الشهر الحد الذي حددته (${budget}$). ارفع الحد من إعدادات الخادم أو انتظر بداية الشهر القادم.`;
}

/** Extract JSON from a model text response (tolerates ```json fences and leading prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('no JSON found');
  }
}

export class AiOrchestrator {
  private provider: AiProvider | null;
  private monthlyBudgetUsd: number;
  private readonly timezone: string;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly log: FastifyBaseLogger,
    opts: AiOrchestratorOptions,
  ) {
    this.provider = opts.provider;
    this.monthlyBudgetUsd = opts.monthlyBudgetUsd;
    this.timezone = opts.timezone;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  get configured(): boolean {
    return this.provider !== null;
  }

  budget(): AiBudgetStatus {
    const periodStart = startOfMonthInTz(this.clock.now(), this.timezone);
    const r = this.db.get<{ spent: number | null }>('SELECT SUM(estimated_cost_usd) AS spent FROM usage_record WHERE created_at >= ?', [periodStart]);
    const spent = Math.round((r?.spent ?? 0) * 1e6) / 1e6;
    return {
      monthly_usd: this.monthlyBudgetUsd,
      spent_usd: spent,
      remaining_usd: Math.max(0, Math.round((this.monthlyBudgetUsd - spent) * 1e6) / 1e6),
      period_start: periodStart,
      estimated: true,
    };
  }

  private taskStatus(task: AiTask, budget: AiBudgetStatus): AiTaskStatus {
    const p = this.provider;
    if (!p) return { available: false, reason_ar: MSG.notConfigured };
    if (!p.supports(task)) return { available: false, reason_ar: MSG.unsupported };
    const model = p.modelFor(task);
    if (budget.monthly_usd <= 0 || budget.remaining_usd <= 0) return { available: false, model, reason_ar: budgetMessage(budget.monthly_usd) };
    return { available: true, model };
  }

  status(): AiStatusResponse {
    const budget = this.budget();
    const tasks = Object.fromEntries(AI_TASKS.map((t) => [t, this.taskStatus(t, budget)])) as Record<AiTask, AiTaskStatus>;
    const out: AiStatusResponse = { configured: this.configured, tasks, budget };
    if (this.provider) out.provider = this.provider.name;
    return out;
  }

  isAvailable(task: AiTask): boolean {
    return this.taskStatus(task, this.budget()).available;
  }

  private recordUsage(u: {
    task: AiTask;
    provider: string;
    model: string;
    status: UsageStatus;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cost?: number | null;
    latencyMs?: number | null;
    sourceVersionIds: string[];
    rulesVersion: string;
    requestRef?: string | null;
    jobId?: string | null;
  }): string {
    const now = this.clock.now();
    const id = newId(now);
    this.db.run(
      `INSERT INTO usage_record (id, job_id, task, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms, status,
         source_version_ids_json, rules_version, verification_status, request_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        id,
        u.jobId ?? null,
        u.task,
        u.provider,
        u.model,
        u.inputTokens ?? null,
        u.outputTokens ?? null,
        u.cost ?? 0,
        u.latencyMs ?? null,
        u.status,
        toJson(u.sourceVersionIds),
        u.rulesVersion,
        u.requestRef ?? null,
        now,
      ],
    );
    return id;
  }

  async generateStructured<T>(req: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const provider = this.provider;
    if (!provider) throw new AppError('AI_NOT_CONFIGURED', MSG.notConfigured, 409);
    if (!provider.supports(req.task)) throw new AppError('AI_NOT_CONFIGURED', MSG.unsupported, 409, { task: req.task });

    // Source Lock is enforced here too, not only in retrieval.
    const allowed = new Set(req.scope.versionIds);
    const outside = req.sourceVersionIds.filter((v) => !allowed.has(v));
    if (outside.length > 0) throw new AppError('OUT_OF_SCOPE', MSG.outOfScope, 409, { scope: req.scope.describeAr });

    const rulesVersion = req.rulesVersion ?? AI_RULES_VERSION;
    const model = provider.modelFor(req.task);
    const maxOutputTokens = Math.min(Math.max(req.maxOutputTokens ?? 4096, 16), 64_000);
    const built = buildPrompt(req.system, req.input, req.instruction);
    let jsonSchema: Record<string, unknown> | undefined;
    try {
      jsonSchema = z.toJSONSchema(req.schema) as Record<string, unknown>;
    } catch {
      jsonSchema = undefined; // schemas with transforms are validated after the fact only
    }
    const base = { task: req.task, provider: provider.name, sourceVersionIds: req.sourceVersionIds, rulesVersion, jobId: req.jobId ?? null };

    // budget guard (worst case: full output length, incl. any reasoning headroom the provider adds)
    const budget = this.budget();
    const ceiling = provider.outputTokenCeiling ? provider.outputTokenCeiling(req.task, maxOutputTokens) : maxOutputTokens;
    const worstCase = provider.estimateCostUsd(model, { inputTokens: estimateTokens(built.system + built.prompt), outputTokens: Math.max(ceiling, maxOutputTokens) });
    if (budget.monthly_usd <= 0 || budget.spent_usd + worstCase > budget.monthly_usd) {
      this.recordUsage({ ...base, model, status: 'budget_blocked', cost: 0 });
      throw new AppError('AI_BUDGET_EXCEEDED', budgetMessage(budget.monthly_usd), 409, {
        monthly_usd: budget.monthly_usd,
        spent_usd: budget.spent_usd,
        remaining_usd: budget.remaining_usd,
      });
    }

    const call = async (prompt: string): Promise<{ res: ProviderResponse; latency: number; cost: number }> => {
      const signals = [AbortSignal.timeout(req.timeoutMs ?? 120_000)];
      if (req.signal) signals.push(req.signal);
      const signal = AbortSignal.any(signals);
      const started = Date.now();
      try {
        const res = await provider.generateStructured({
          task: req.task,
          model,
          system: built.system,
          prompt,
          jsonSchema,
          images: req.images,
          maxOutputTokens,
          signal,
        });
        const latency = Date.now() - started;
        return { res, latency, cost: provider.estimateCostUsd(res.model, res.usage) };
      } catch (e) {
        const pe = e instanceof ProviderError ? e : null;
        // a classified failure keeps the provider request id and any billed usage (e.g. a truncated answer)
        this.recordUsage({
          ...base,
          model: pe?.model ?? model,
          status: 'error',
          latencyMs: Date.now() - started,
          inputTokens: pe?.usage?.inputTokens ?? null,
          outputTokens: pe?.usage?.outputTokens ?? null,
          cost: pe?.usage ? provider.estimateCostUsd(pe.model ?? model, pe.usage) : 0,
          requestRef: pe?.requestRef ?? null,
        });
        if (req.signal?.aborted) throw req.signal.reason ?? e;
        this.log.warn({ task: req.task, provider: provider.name, errName: (e as Error)?.name, kind: pe?.kind, requestRef: pe?.requestRef }, 'AI provider call failed');
        if (pe) throw new AppError('AI_PROVIDER_ERROR', PROVIDER_ERROR_AR[pe.kind], 502, { provider_error: pe.kind, retryable: pe.retryable });
        throw new AppError('AI_PROVIDER_ERROR', MSG.providerError, 502);
      }
    };

    const validate = (res: ProviderResponse): { ok: true; value: T } | { ok: false; issues: string[]; raw: string } => {
      let value: unknown;
      const raw = res.json !== undefined ? JSON.stringify(res.json) : (res.text ?? '');
      try {
        value = res.json !== undefined ? res.json : extractJson(res.text ?? '');
      } catch {
        return { ok: false, issues: ['(root): output is not valid JSON'], raw };
      }
      const parsed = req.schema.safeParse(value);
      if (parsed.success) return { ok: true, value: parsed.data };
      const issues = parsed.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
      return { ok: false, issues, raw };
    };

    // attempt 1
    const first = await call(built.prompt);
    const v1 = validate(first.res);
    if (v1.ok) {
      const usageId = this.recordUsage({
        ...base,
        model: first.res.model,
        status: 'ok',
        inputTokens: first.res.usage.inputTokens,
        outputTokens: first.res.usage.outputTokens,
        cost: first.cost,
        latencyMs: first.latency,
        requestRef: first.res.requestRef,
      });
      return { output: v1.value, model: first.res.model, usageId };
    }
    this.recordUsage({
      ...base,
      model: first.res.model,
      status: 'schema_rejected',
      inputTokens: first.res.usage.inputTokens,
      outputTokens: first.res.usage.outputTokens,
      cost: first.cost,
      latencyMs: first.latency,
      requestRef: first.res.requestRef,
    });

    // one bounded repair attempt (budget re-checked)
    const after = this.budget();
    if (after.spent_usd + worstCase > after.monthly_usd) {
      this.recordUsage({ ...base, model, status: 'budget_blocked', cost: 0 });
      throw new AppError('AI_BUDGET_EXCEEDED', budgetMessage(after.monthly_usd), 409);
    }
    const repairPrompt = [
      built.prompt,
      'Your previous answer did not match the required JSON schema. Problems:',
      v1.issues.map((s) => `- ${s}`).join('\n'),
      'Previous answer (for reference, may be truncated):',
      v1.raw.slice(0, 8000),
      'Return ONLY corrected JSON matching the schema. Do not add claims that are not supported by the provided evidence.',
    ].join('\n\n');
    const second = await call(repairPrompt);
    const v2 = validate(second.res);
    const usage2 = {
      ...base,
      model: second.res.model,
      inputTokens: second.res.usage.inputTokens,
      outputTokens: second.res.usage.outputTokens,
      cost: second.cost,
      latencyMs: second.latency,
      requestRef: second.res.requestRef,
    };
    if (v2.ok) {
      const usageId = this.recordUsage({ ...usage2, status: 'ok' });
      return { output: v2.value, model: second.res.model, usageId };
    }
    this.recordUsage({ ...usage2, status: 'schema_rejected' });
    throw new AppError('SCHEMA_REJECTED', MSG.schemaRejected, 422, { issues: v2.issues.slice(0, 10) });
  }
}

