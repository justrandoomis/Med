// The evaluation runner (§57): selects cases (set / axis / ids), builds the throwaway harness, uploads and processes
// exactly the fixtures those cases read, evaluates every case, and returns the report (per-axis rates with
// denominators, regression and tuning apart). Used by `npm run eval` (src/cli/eval.ts) and by the tests.
import { randomUUID } from 'node:crypto';
import { EVAL_AXIS_KIND, EVAL_REPORT_FORMAT, type EvalAxis, type EvalCaseResult, type EvalMode, type EvalReport, type EvalSet } from '@medlevo/shared';
import { CATALOGUE, CATALOGUE_VERSION, caseFixture, regressionHash, sourcesFor, type EvalCaseDef } from './catalogue';
import { evaluateCase } from './evaluators';
import { createHarness, loadSources, systemFingerprint } from './harness';
import { rateOf, summarizeAxes } from './report';

export interface RunOptions {
  mode?: EvalMode;
  set?: EvalSet | 'all';
  axes?: EvalAxis[];
  /** case id prefixes (e.g. 'key.' or 'cite.unknown_alias') */
  only?: string[];
  label?: string | null;
  /** an alternative catalogue (tests) */
  catalogue?: readonly EvalCaseDef[];
  repoRoot?: string;
  log?: (line: string) => void;
}

export function selectCases(opts: Pick<RunOptions, 'set' | 'axes' | 'only' | 'catalogue'>): EvalCaseDef[] {
  const all = opts.catalogue ?? CATALOGUE;
  return all.filter(
    (c) =>
      (!opts.set || opts.set === 'all' || c.set === opts.set) &&
      (!opts.axes?.length || opts.axes.includes(c.axis)) &&
      (!opts.only?.length || opts.only.some((p) => c.id === p || c.id.startsWith(p))),
  );
}

export async function runEvaluation(opts: RunOptions = {}): Promise<EvalReport> {
  const mode = opts.mode ?? 'scripted';
  const log = opts.log ?? (() => undefined);
  const catalogue = opts.catalogue ?? CATALOGUE;
  const defs = selectCases(opts);
  const startedAt = Date.now();
  const runId = `eval-${new Date(startedAt).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  log(`MedLevo evaluation ${runId}: ${defs.length} cases (mode ${mode})`);

  const h = await createHarness({ mode, repoRoot: opts.repoRoot, log });
  const cases: EvalCaseResult[] = [];
  const blocked: EvalReport['blocked'] = [];
  let system: EvalReport['system'];
  try {
    system = systemFingerprint(h.ctx, mode, opts.repoRoot);
    const keys = sourcesFor(defs);
    log(`uploading and processing ${keys.length} TEST FIXTURE files through the real pipeline…`);
    await loadSources(h, keys, { repoRoot: opts.repoRoot, log });
    if (h.aiBlockedReasonAr) {
      for (const axis of [...new Set(defs.map((d) => d.axis))].filter((a) => EVAL_AXIS_KIND[a] === 'scripted_ai')) blocked.push({ axis, reason_ar: h.aiBlockedReasonAr });
    }
    for (const def of defs) {
      const t0 = Date.now();
      const v = await evaluateCase(h, def);
      cases.push({ case_id: def.id, axis: def.axis, set: def.set, title_ar: def.title_ar, fixture: caseFixture(def), ...v, ms: Date.now() - t0 });
    }
    const failedSources = [...h.sources.entries()].filter(([, s]) => s.error);
    for (const [k, s] of failedSources) blocked.push({ axis: null, reason_ar: `تعذّر تجهيز ${k}: ${s.error}` });
  } finally {
    await h.close();
  }

  const finishedAt = Date.now();
  const reg = catalogue.filter((c) => c.set === 'regression').length;
  const notes = [
    'كل الحالات على ملفات اختبار اصطناعية (TEST FIXTURE)؛ ليست مرجعًا طبيًا، والنتائج مقيدة بنطاق هذه الحالات وحجمها وطريقة تقييمها.',
    'كل نسبة مكتوبة مع مقامها وفاصل ثقة 95% (Wilson). عينة أقل من 30 حالة «عينة صغيرة» ولا تُعمَّم.',
    'عينة الانحدار مجمّدة عند إصدار الكتالوج ومنفصلة عن أمثلة الضبط (مجموعة Golden Set التي طُوّرت عليها أدوات الاستخراج). ليست بيانات محجوبة عن المطوّرين: أُصلحت عيوب على ملفاتها نفسها في مراحل القبول، فلا تقيس أي من المجموعتين التعميم على ملفات جديدة؛ فائدتها أنها لا تتغير.',
    mode === 'scripted'
      ? 'محاور الذكاء الاصطناعي شُغّلت بمزود مكتوب مسبقًا للتقييم فقط: تقيس ضمانات الخادم (التحقق من الأدلة، الامتناع، عدم الامتناع الزائد)، لا جودة نموذج. تقييم نموذج حقيقي يحتاج ANTHROPIC_API_KEY وتشغيل `npm run eval -- --mode=live`.'
      : 'محاور الذكاء الاصطناعي شُغّلت بالمزود المضبوط على الخادم.',
  ];
  const regressionCases = cases.filter((c) => c.set === 'regression');
  const tuningCases = cases.filter((c) => c.set === 'tuning');
  return {
    format: EVAL_REPORT_FORMAT,
    run_id: runId,
    label: opts.label ?? null,
    mode,
    set_filter: [opts.set ?? 'all', opts.axes?.length ? `axes=${opts.axes.join(',')}` : null, opts.only?.length ? `only=${opts.only.join(',')}` : null].filter(Boolean).join(' '),
    started_at: startedAt,
    finished_at: finishedAt,
    catalogue: { version: CATALOGUE_VERSION, regression_hash: regressionHash(catalogue), cases: catalogue.length, regression: reg, tuning: catalogue.length - reg },
    system,
    overall: { regression: rateOf(regressionCases), tuning: rateOf(tuningCases) },
    axes: summarizeAxes(cases),
    cases,
    blocked,
    notes_ar: notes,
  };
}
