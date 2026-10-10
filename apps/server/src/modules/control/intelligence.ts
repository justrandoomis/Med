// Intelligence (§48, §51, §56): AI status per task and model, the monthly budget, and usage summaries by month /
// task / model from usage_record. Every cost is an ESTIMATE computed from token counts with a static price table
// (labelled so everywhere) — never presented as a provider invoice.
import {
  AI_TASKS,
  AI_TASK_LABELS_AR,
  MODEL_ROLES,
  MODEL_ROLE_LABELS_AR,
  type AiTask,
  type IntelligenceResponse,
  type ModelRole,
  type ModelRoleView,
  type UsageBucket,
  type UsageMonth,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { startOfMonthInTz } from '../../lib/time';
import { TASK_ROLE } from '../ai/providers';

export const MODEL_ENV: Record<ModelRole, string> = {
  generation: 'MEDLEVO_MODEL_GENERATION',
  verification: 'MEDLEVO_MODEL_VERIFICATION',
  vision: 'MEDLEVO_MODEL_VISION',
};

export const ESTIMATE_NOTE_AR = 'التكاليف تقديرية محسوبة من عدد الرموز وجدول أسعار ثابت، وليست فاتورة المزود. راجع لوحة المزود للمبلغ الفعلي.';

/** §49 «وثق ما يغادر الجهاز، إلى أي مزود، لأي مهمة»: said in the Control Center whether or not a provider is set. */
export const DATA_EGRESS_NOTE_AR =
  'ما يغادر الخادم عند ضبط المزود (Anthropic): مع كل طلب ذكاء اصطناعي تُرسل نصوص من مصادرك داخل النطاق المحدد فقط (كتاب الدراسة يرسل نص المحاضرة مقطعًا مقطعًا)، وسؤالك أو النص الذي حددته، وإجابتك المكتوبة عند تقييمها، وصورة الشكل المقصوصة عند شرح شكل، وتعليماتك الخاصة للشرح، وملاحظاتك فقط إن أدرجتها في النطاق. لا يُرسل الملف الأصلي ولا كلمات المرور أو المفاتيح، ولا يُعطى النموذج أدوات أو وصولًا إلى الإنترنت. المزود يقرأ هذا المحتوى ليجيب، فلا يوجد تشفير من طرف إلى طرف. القراءة الآلية (OCR) والبحث يعملان على الخادم نفسه.';

export function tasksOfRole(role: ModelRole): AiTask[] {
  return AI_TASKS.filter((t) => TASK_ROLE[t] === role);
}

export function modelRoles(ctx: AppContext): ModelRoleView[] {
  const st = ctx.ai.status();
  return MODEL_ROLES.map((role) => {
    const tasks = tasksOfRole(role);
    const model = st.configured ? (tasks.map((t) => st.tasks[t]?.model).find((m): m is string => !!m) ?? null) : null;
    return { role, label_ar: MODEL_ROLE_LABELS_AR[role], model, env_var: MODEL_ENV[role], tasks };
  });
}

interface UsageRow {
  task: string;
  model: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  created_at: number;
}

function emptyBucket(key: string, label: string): UsageBucket {
  return { key, label_ar: label, calls: 0, ok: 0, errors: 0, schema_rejected: 0, budget_blocked: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 };
}

function add(b: UsageBucket, r: UsageRow): void {
  b.calls++;
  if (r.status === 'ok') b.ok++;
  else if (r.status === 'schema_rejected') b.schema_rejected++;
  else if (r.status === 'budget_blocked') b.budget_blocked++;
  else b.errors++;
  b.input_tokens += r.input_tokens ?? 0;
  b.output_tokens += r.output_tokens ?? 0;
  b.estimated_cost_usd += r.estimated_cost_usd ?? 0;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function finalize(b: UsageBucket): UsageBucket {
  return { ...b, estimated_cost_usd: round6(b.estimated_cost_usd) };
}

const MONTH_NAMES_AR = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

/** Usage per month (owner timezone) for the last `months` months, newest first; months without calls are listed with zeros. */
export function usageByMonth(ctx: AppContext, months = 6): UsageMonth[] {
  const tz = ctx.settings.get().timezone;
  const now = ctx.clock.now();
  const starts: number[] = [];
  let s = startOfMonthInTz(now, tz);
  for (let i = 0; i < months; i++) {
    starts.push(s);
    s = startOfMonthInTz(s - 1, tz);
  }
  const oldest = starts[starts.length - 1]!;
  const rows = ctx.db.all<UsageRow>(
    'SELECT task, model, status, input_tokens, output_tokens, estimated_cost_usd, created_at FROM usage_record WHERE created_at >= ? ORDER BY created_at',
    [oldest],
  );
  return starts.map((start, idx) => {
    const end = idx === 0 ? Number.POSITIVE_INFINITY : starts[idx - 1]!;
    const local = new Date(start + 12 * 3600 * 1000); // mid-day of the 1st: safely inside the month for any offset
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(local);
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const label = `${MONTH_NAMES_AR[Number(m) - 1] ?? m} ${y}`;
    const total = emptyBucket(`${y}-${m}`, label);
    const byTask = new Map<string, UsageBucket>();
    const byModel = new Map<string, UsageBucket>();
    for (const r of rows) {
      if (r.created_at < start || r.created_at >= end) continue;
      add(total, r);
      const t = byTask.get(r.task) ?? emptyBucket(r.task, AI_TASK_LABELS_AR[r.task as AiTask] ?? r.task);
      add(t, r);
      byTask.set(r.task, t);
      const mb = byModel.get(r.model) ?? emptyBucket(r.model, r.model);
      add(mb, r);
      byModel.set(r.model, mb);
    }
    const sortCost = (a: UsageBucket, b: UsageBucket) => b.estimated_cost_usd - a.estimated_cost_usd || b.calls - a.calls;
    return {
      ...finalize(total),
      month: `${y}-${m}`,
      period_start: start,
      by_task: [...byTask.values()].map(finalize).sort(sortCost),
      by_model: [...byModel.values()].map(finalize).sort(sortCost),
    };
  });
}

export function intelligence(ctx: AppContext): IntelligenceResponse {
  const ai = ctx.ai.status();
  const s = ctx.settings.get();
  const notes = [
    ai.configured
      ? 'النماذج تُضبط على الخادم لكل دور (توليد، تحقق، رؤية). تغييرها يحتاج تعديل الإعداد وإعادة تشغيل الخادم؛ عاين أثره هنا أولًا.'
      : 'لا يوجد مزود ذكاء اصطناعي مهيأ على الخادم (ANTHROPIC_API_KEY)، فكل ميزات الذكاء الاصطناعي متوقفة مع ذكر السبب. القراءة والبحث والأسئلة والمراجعة تعمل دونه.',
    'تغيير نموذج أو قاعدة شرح أو أولوية مصادر لا يعيد توليد مكتبتك تلقائيًا أبدًا: يتغير فقط ما تطلبه بعد ذلك.',
    ESTIMATE_NOTE_AR,
    DATA_EGRESS_NOTE_AR,
  ];
  return {
    ai,
    roles: modelRoles(ctx),
    usage: { months: usageByMonth(ctx), estimated: true, note_ar: ESTIMATE_NOTE_AR },
    rules: {
      explanation_level: s.explanation_level,
      dialect: s.dialect,
      custom_instruction: s.custom_instruction,
      socratic_default: s.socratic_default,
      check_question_density: s.check_question_density,
      answer_style: s.answer_style,
    },
    notes_ar: notes,
  };
}
