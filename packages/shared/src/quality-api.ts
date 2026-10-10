// Quality ops contract (track F5): §57 evaluation reports, §56 client error tracking and daily trend metrics.
// GET/POST /api/control/{evaluation,health,client-errors} — implemented by apps/server/src/modules/control,
// consumed by apps/web/src/features/control. `npm run eval` (apps/server/src/cli/eval.ts) writes the same report.
//
// Honesty rules baked into the shapes (§57): every rate carries its DENOMINATOR and a 95% interval; a sample under
// 30 cases is flagged `small_sample`; a perfect small sample is never rendered as «100%». Axes that need a model are
// run with the evaluation-only scripted provider and say so (`kind: 'scripted_ai'`): they measure the server's
// validation / abstention guarantees, not a model's quality.

// ───────────────────────── evaluation (§57) ─────────────────────────
export const EVAL_AXES = [
  'text_accuracy',
  'negation_numbers',
  'options_completeness',
  'key_binding',
  'citation_validity',
  'claim_support',
  'abstention',
  'over_abstention',
  'image_match',
  'lecture_link',
  'rtl_bidi',
] as const;
export type EvalAxis = (typeof EVAL_AXES)[number];

export const EVAL_AXIS_LABELS_AR: Record<EvalAxis, string> = {
  text_accuracy: 'دقة النص المستخرج',
  negation_numbers: 'حفظ النفي والأرقام والوحدات',
  options_completeness: 'اكتمال الخيارات',
  key_binding: 'ربط مفتاح الإجابة',
  citation_validity: 'صحة الاستشهاد',
  claim_support: 'دعم الادعاء بالدليل',
  abstention: 'الامتناع الصحيح عند غياب الدليل',
  over_abstention: 'عدم الامتناع حين يوجد دليل واضح',
  image_match: 'مطابقة الصورة للطلب',
  lecture_link: 'ربط السؤال بالمحاضرة',
  rtl_bidi: 'تنسيق العربية والإنجليزية (RTL/bidi)',
};

/** deterministic: no model at all · scripted_ai: the server's AI path driven by the evaluation-only scripted provider */
export type EvalAxisKind = 'deterministic' | 'scripted_ai';
export const EVAL_AXIS_KIND: Record<EvalAxis, EvalAxisKind> = {
  text_accuracy: 'deterministic',
  negation_numbers: 'deterministic',
  options_completeness: 'deterministic',
  key_binding: 'deterministic',
  citation_validity: 'deterministic',
  claim_support: 'scripted_ai',
  abstention: 'scripted_ai',
  over_abstention: 'scripted_ai',
  image_match: 'deterministic',
  lecture_link: 'deterministic',
  rtl_bidi: 'deterministic',
};

export const EVAL_SETS = ['regression', 'tuning'] as const;
export type EvalSet = (typeof EVAL_SETS)[number];
export const EVAL_SET_LABELS_AR: Record<EvalSet, string> = {
  regression: 'عينة الانحدار (مجمّدة)',
  tuning: 'أمثلة الضبط',
};

export type EvalMode = 'scripted' | 'live';
export type EvalOutcome = 'pass' | 'fail' | 'error' | 'not_run';
export const EVAL_OUTCOME_LABELS_AR: Record<EvalOutcome, string> = {
  pass: 'نجح',
  fail: 'أخفق',
  error: 'خطأ أثناء التقييم',
  not_run: 'لم يُشغَّل',
};

/** Below this many cases a rate is a «small sample» (said next to it, never generalized). */
export const EVAL_SMALL_SAMPLE = 30;
export const EVAL_REPORT_FORMAT = 'medlevo-eval-1' as const;

export interface EvalCaseResult {
  case_id: string;
  axis: EvalAxis;
  set: EvalSet;
  title_ar: string;
  /** TEST FIXTURE file the case reads (null for pure checks) */
  fixture: string | null;
  outcome: EvalOutcome;
  /** short, readable expected / observed values (synthetic fixture text only — never owner content) */
  expected: string;
  observed: string;
  /** why it failed / errored / was not run (Arabic) */
  reason_ar: string | null;
  ms: number;
}

export interface EvalRate {
  passed: number;
  /** the denominator: pass + fail + error (not_run is left out and counted separately) */
  total: number;
  failed: number;
  errors: number;
  not_run: number;
  /** passed / total, null when total = 0 */
  rate: number | null;
  /** Wilson 95% interval [low, high], null when total = 0 */
  ci95: [number, number] | null;
  small_sample: boolean;
}

/** Percent for a bound; capped at 99 so a rounding artefact never reads as a «100%» perfection claim. */
function boundPct(x: number): string {
  return `${Math.min(99, Math.round(x * 100))}%`;
}

/**
 * The one Arabic wording of a rate (Control Center + reports): always the fraction WITH its denominator and the 95%
 * interval; a perfect sample is «n / n نجحت» with the interval's lower bound, never «100%».
 */
export function evalRateTextAr(r: EvalRate): string {
  if (r.total === 0) return r.not_run ? `لم يُشغَّل (${r.not_run})` : 'لا حالات';
  const [lo, hi] = r.ci95 ?? [0, 1];
  const notRun = r.not_run ? ` · لم يُشغَّل ${r.not_run}` : '';
  const errs = r.errors ? ` · أخطاء تقييم ${r.errors}` : '';
  if (r.passed === r.total) {
    return `${r.passed} / ${r.total} نجحت — الحد الأدنى لفاصل الثقة 95%: ${boundPct(lo)}${r.small_sample ? ' (عينة صغيرة؛ لا يعني ذلك دقة كاملة)' : ''}${errs}${notRun}`;
  }
  return `${r.passed} / ${r.total} — فاصل الثقة 95%: ${boundPct(lo)}–${boundPct(hi)}${r.small_sample ? ' (عينة صغيرة)' : ''}${errs}${notRun}`;
}

export interface EvalAxisSummary {
  axis: EvalAxis;
  label_ar: string;
  kind: EvalAxisKind;
  regression: EvalRate;
  tuning: EvalRate;
}

export interface EvalSystemFingerprint {
  app_version: string;
  /** `git rev-parse HEAD` when available */
  git_commit: string | null;
  node: string;
  /** every version a result depends on (pipeline / OCR, index = chunking, parser, matcher, retrieval, rules, …) */
  versions: Record<string, string>;
  /** models per role when a provider is configured (live mode); null in scripted mode */
  models: Record<string, string | null> | null;
}

export interface EvalReport {
  format: typeof EVAL_REPORT_FORMAT;
  run_id: string;
  label: string | null;
  mode: EvalMode;
  /** 'all' | 'regression' | 'tuning' (+ axis filter when used) */
  set_filter: string;
  started_at: number;
  finished_at: number;
  catalogue: {
    version: string;
    /** sha256 over the regression cases (ids + expected values): runs compare only on the same hash */
    regression_hash: string;
    cases: number;
    regression: number;
    tuning: number;
  };
  system: EvalSystemFingerprint;
  overall: { regression: EvalRate; tuning: EvalRate };
  axes: EvalAxisSummary[];
  cases: EvalCaseResult[];
  /** axes / cases that could not run here, with the reason (e.g. live mode without ANTHROPIC_API_KEY) */
  blocked: Array<{ axis: EvalAxis | null; reason_ar: string }>;
  notes_ar: string[];
}

export interface EvalRunSummary {
  id: string;
  label: string | null;
  mode: EvalMode;
  status: 'completed' | 'failed';
  set_filter: string;
  started_at: number;
  finished_at: number | null;
  catalogue_version: string;
  catalogue_hash: string;
  overall: { regression: EvalRate; tuning: EvalRate } | null;
  error: string | null;
}

export interface EvalCompareAxis {
  axis: EvalAxis;
  label_ar: string;
  base: EvalRate;
  head: EvalRate;
}

export interface EvalCompare {
  base_run_id: string;
  head_run_id: string;
  /** false when the regression sets differ (another catalogue hash) — rates are then not comparable */
  comparable: boolean;
  reason_ar: string | null;
  verdict: 'no_regressions' | 'regressions' | 'not_comparable';
  axes: EvalCompareAxis[];
  /** cases that passed in the base run and do not pass in the head run */
  regressions: Array<{ case_id: string; axis: EvalAxis; set: EvalSet; title_ar: string; base: EvalOutcome; head: EvalOutcome }>;
  /** cases that did not pass in the base run and pass now */
  fixes: Array<{ case_id: string; axis: EvalAxis; set: EvalSet; title_ar: string; base: EvalOutcome; head: EvalOutcome }>;
  /** versions / models that differ between the two runs (what changed) */
  system_changes: Array<{ key: string; base: string | null; head: string | null }>;
}

export interface EvaluationOverviewResponse {
  latest: EvalReport | null;
  /** the latest run compared with the run before it (null with fewer than two runs) */
  compare_with_previous: EvalCompare | null;
  runs: EvalRunSummary[];
  catalogue: { version: string; cases: number; regression: number; tuning: number; by_axis: Record<EvalAxis, { regression: number; tuning: number }> };
  how_to_run_ar: string;
}

// ───────────────────────── client error tracking (§56) ─────────────────────────
export const CLIENT_ERROR_KINDS = ['error', 'unhandledrejection', 'route', 'react'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

/** What the browser sends (already redacted by `redactClientError`; the server redacts again). */
export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string | null;
  /** app path only — never a query string or a hash */
  route?: string | null;
  app_version?: string | null;
  /** occurrences of this fingerprint batched by the client since the last send */
  count?: number;
}

export interface ClientErrorBatchRequest {
  errors: ClientErrorReport[];
}

export interface ClientErrorBatchResponse {
  stored: number;
  dropped: number;
}

export interface ClientErrorView {
  id: string;
  kind: ClientErrorKind;
  message: string;
  stack: string | null;
  route: string | null;
  app_version: string | null;
  /** browser family + major version only */
  user_agent: string | null;
  count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ClientErrorsResponse {
  items: ClientErrorView[];
  total: number;
  retention_ar: string;
}

export const CLIENT_ERROR_RETENTION_DAYS = 30;
export const CLIENT_ERROR_MAX_ROWS = 500;
export const CLIENT_ERROR_MESSAGE_MAX = 300;
export const CLIENT_ERROR_STACK_MAX_FRAMES = 12;

const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// keys, bearer tokens, JWT-like / long hex / long base64 strings
const SECRETISH = /\b(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/=-]+|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})/g;
const KEY_VALUE_SECRET = /\b(password|passwd|token|secret|api[_-]?key|session|cookie|authorization|recovery[_-]?code)\b\s*[:=]\s*\S+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DATA_URL = /\b(?:data|blob):[^\s)'"]+/g;
/** an Arabic-script run of at least 25 letters (with spaces) — likely document / owner text, not a code message */
const LONG_ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff][\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff\s\u064b-\u065f\u060c\u061b\u061f.]{24,}/g;

function stripUrl(raw: string): string {
  // keep only the path of a URL (no origin, no query, no hash)
  try {
    const u = new URL(raw);
    return u.pathname;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

/** Redact free text: secrets, emails, data URLs, URL queries, long quoted segments, long Arabic runs (document text). */
export function redactText(s: string, max = CLIENT_ERROR_MESSAGE_MAX): string {
  let out = String(s ?? '')
    .replace(BIDI_CONTROLS, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ') // eslint-disable-line no-control-regex -- strip control characters from untrusted text
    .replace(DATA_URL, '[data-url]')
    .replace(/\bhttps?:\/\/[^\s)'"]+/g, (m) => stripUrl(m))
    .replace(KEY_VALUE_SECRET, (_m, k: string) => `${k}=[redacted]`)
    .replace(SECRETISH, '[redacted]')
    .replace(EMAIL, '[email]')
    // quoted segments longer than 40 characters may hold document text («…», "…", '…', `…`)
    .replace(/«[^»]{41,}»|"[^"\n]{41,}"|'[^'\n]{41,}'|`[^`\n]{41,}`/g, '[quoted-text]')
    .replace(LONG_ARABIC, ' [نص محذوف] ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}

/** Keep only code locations of a stack: `fn (path:line:col)` / `fn@path:line:col`, origin and query removed. */
export function redactStack(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const frames: string[] = [];
  for (const raw of String(stack).split('\n')) {
    const line = raw.trim();
    // V8: "at fn (http://host/assets/x.js:1:2)" / "at http://host/x.js:1:2"; Firefox / Safari: "fn@http://host/x.js:1:2"
    const m = /^(?:at\s+)?(?:([\w$.<>[\]\s]{0,80}?)\s*\(|([\w$.<>[\]]{0,80})@)?((?:https?|file|webpack|vite):\/\/[^\s)]+|\/[^\s)]+):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const fn = (m[1] ?? m[2] ?? '').trim().replace(/^at\s+/, '');
    const where = `${stripUrl(m[3]!)}:${m[4]}:${m[5]}`;
    frames.push(fn ? `${fn.slice(0, 80)} (${where})` : where);
    if (frames.length >= CLIENT_ERROR_STACK_MAX_FRAMES) break;
  }
  return frames.length ? frames.join('\n') : null;
}

/** App path without query / hash; long id-like segments kept (they are opaque ids, not content). */
export function redactRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const p = stripUrl(String(route).startsWith('/') ? `http://x${route}` : String(route));
  return p.slice(0, 200) || null;
}

/** The one redaction both the browser (before sending) and the server (before storing) apply. */
export function redactClientError(r: ClientErrorReport): Required<Omit<ClientErrorReport, 'count'>> & { count: number } {
  const kind = (CLIENT_ERROR_KINDS as readonly string[]).includes(r.kind) ? r.kind : 'error';
  return {
    kind,
    message: redactText(r.message || '(no message)') || '(no message)',
    stack: redactStack(r.stack),
    route: redactRoute(r.route),
    app_version: r.app_version ? String(r.app_version).replace(/[^\w.+-]/g, '').slice(0, 40) || null : null,
    count: Math.max(1, Math.min(1000, Math.floor(Number(r.count) || 1))),
  };
}

// ───────────────────────── trends (§56) ─────────────────────────
export type TrendSeriesKey = 'claims_checked' | 'citation_invalid' | 'claim_unsupported' | 'sync_ops' | 'sync_rejected' | 'sync_conflict';

export interface TrendSeries {
  key: TrendSeriesKey;
  label_ar: string;
  /** what one unit counts, in words */
  description_ar: string;
  /** one count per day of `days` (oldest → newest) */
  counts: number[];
  total: number;
  /** the series this one is a part of (e.g. citation_invalid ⊂ claims_checked) — the denominator */
  of: TrendSeriesKey | null;
}

export interface HealthTrendsResponse {
  /** owner time zone used for the day boundaries */
  timezone: string;
  /** YYYY-MM-DD, oldest → newest (today last) */
  days: string[];
  series: TrendSeries[];
  generated_at: number;
  notes_ar: string[];
}
