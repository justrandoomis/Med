// Request validation helpers (zod) → VALIDATION_FAILED with Arabic, per-field issues.
// Values are never echoed back in error details (they may contain private content).
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppError } from './errors';

export interface FieldIssue {
  path: string;
  code: string;
  message: string;
}

const VALIDATION_MESSAGE_AR = 'البيانات المرسلة غير صالحة. راجع الحقول المحددة ثم أعد المحاولة.';

function issueMessageAr(issue: z.core.$ZodIssue): string {
  // Custom refinements may carry their own (Arabic) message.
  if (issue.code === 'custom' && issue.message && /[؀-ۿ]/.test(issue.message)) return issue.message;
  switch (issue.code) {
    case 'invalid_type':
      // zod 4 does not include the input in issues by default; a missing key reads "received undefined"
      return /received undefined/.test(issue.message) ? 'هذا الحقل مطلوب.' : `نوع القيمة غير صحيح (المتوقع: ${issue.expected}).`;
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') return `النص أقصر من الحد الأدنى (${min} أحرف).`;
      if (issue.origin === 'array' || issue.origin === 'set') return `عدد العناصر أقل من الحد الأدنى (${min}).`;
      return `القيمة أصغر من الحد الأدنى (${min}).`;
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `النص أطول من الحد الأقصى (${max} حرفًا).`;
      if (issue.origin === 'array' || issue.origin === 'set') return `عدد العناصر أكبر من الحد الأقصى (${max}).`;
      return `القيمة أكبر من الحد الأقصى (${max}).`;
    }
    case 'invalid_format':
      return 'صيغة القيمة غير صحيحة.';
    case 'invalid_value':
      return 'القيمة غير مسموحة لهذا الحقل.';
    case 'unrecognized_keys':
      return `حقول غير معروفة: ${issue.keys.join('، ')}.`;
    case 'invalid_union':
      return 'القيمة لا تطابق أيًا من الصيغ المسموحة.';
    case 'not_multiple_of':
      return 'القيمة لا تطابق الخطوة المسموحة.';
    case 'invalid_key':
    case 'invalid_element':
      return 'مفتاح أو عنصر غير صالح.';
    default:
      return 'قيمة غير صالحة.';
  }
}

export function zodIssuesToFields(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    code: issue.code,
    message: issueMessageAr(issue),
  }));
}

export function validationError(error: z.ZodError, where: 'body' | 'query' | 'params' | 'value' = 'body'): AppError {
  return new AppError('VALIDATION_FAILED', VALIDATION_MESSAGE_AR, 400, { where, issues: zodIssuesToFields(error) });
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, where: 'body' | 'query' | 'params' | 'value' = 'value'): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw validationError(r.error, where);
  return r.data;
}

export function parseBody<S extends z.ZodType>(schema: S, req: FastifyRequest): z.output<S> {
  return parseWith(schema, req.body ?? {}, 'body');
}

export function parseQuery<S extends z.ZodType>(schema: S, req: FastifyRequest): z.output<S> {
  return parseWith(schema, req.query ?? {}, 'query');
}

export function parseParams<S extends z.ZodType>(schema: S, req: FastifyRequest): z.output<S> {
  return parseWith(schema, req.params ?? {}, 'params');
}

/**
 * Per-route rate limit presets for @fastify/rate-limit (registered with global:false in app.ts).
 * Use as: `app.post('/x', { config: { rateLimit: RATE_LIMITS.upload } }, handler)`.
 */
export const RATE_LIMITS = {
  /** coarse limit on credential endpoints; the precise login limiter lives in modules/auth */
  auth: { max: 30, timeWindow: 60_000 },
  setup: { max: 5, timeWindow: 60_000 },
  upload: { max: 60, timeWindow: 60_000 },
  ai: { max: 30, timeWindow: 60_000 },
  sync: { max: 240, timeWindow: 60_000 },
} as const;
