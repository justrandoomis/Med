// Evaluation report (§57): per-axis rates WITH denominators and a Wilson 95% interval, regression and tuning sets kept
// apart, a Markdown rendering that never turns a small perfect sample into «100%», and the side-by-side comparison of
// two runs used by the compare-and-rollback procedure (docs/EVALUATION.md).
import {
  EVAL_AXES,
  EVAL_AXIS_KIND,
  EVAL_AXIS_LABELS_AR,
  EVAL_OUTCOME_LABELS_AR,
  EVAL_SET_LABELS_AR,
  EVAL_SMALL_SAMPLE,
  evalRateTextAr,
  type EvalAxis,
  type EvalAxisSummary,
  type EvalCaseResult,
  type EvalCompare,
  type EvalRate,
  type EvalReport,
  type EvalSet,
} from '@medlevo/shared';

/** Wilson score interval (95%, z = 1.96) — honest for small samples and for 0 / n or n / n. */
export function wilson95(passed: number, total: number): [number, number] | null {
  if (total <= 0) return null;
  const z = 1.959964;
  const p = passed / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  const round = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
  return [round(centre - half), round(centre + half)];
}

export function rateOf(results: Array<Pick<EvalCaseResult, 'outcome'>>): EvalRate {
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let notRun = 0;
  for (const r of results) {
    if (r.outcome === 'pass') passed++;
    else if (r.outcome === 'fail') failed++;
    else if (r.outcome === 'error') errors++;
    else notRun++;
  }
  const total = passed + failed + errors;
  return {
    passed,
    total,
    failed,
    errors,
    not_run: notRun,
    rate: total ? Math.round((passed / total) * 1000) / 1000 : null,
    ci95: wilson95(passed, total),
    small_sample: total < EVAL_SMALL_SAMPLE,
  };
}

export function summarizeAxes(cases: EvalCaseResult[]): EvalAxisSummary[] {
  return EVAL_AXES.map((axis) => {
    const of = (set: EvalSet) => cases.filter((c) => c.axis === axis && c.set === set);
    return { axis, label_ar: EVAL_AXIS_LABELS_AR[axis], kind: EVAL_AXIS_KIND[axis], regression: rateOf(of('regression')), tuning: rateOf(of('tuning')) };
  });
}

// capped at 99: a bound of these sizes is never «100%» (a rounding artefact would read as a perfection claim)
const pct = (x: number) => `${Math.min(99, Math.round(x * 100))}%`;

/** The Arabic wording lives in packages/shared (one text for the Control Center and the reports). */
export const rateTextAr = evalRateTextAr;

/** English mirror used in the Markdown table (the report is read by engineers too). */
export function rateTextEn(r: EvalRate): string {
  if (r.total === 0) return r.not_run ? `not run (${r.not_run})` : '—';
  const [lo, hi] = r.ci95!;
  const extra = `${r.errors ? `, ${r.errors} eval error(s)` : ''}${r.not_run ? `, ${r.not_run} not run` : ''}`;
  if (r.passed === r.total) return `${r.passed}/${r.total} passed (95% CI lower bound ${pct(lo)}${r.small_sample ? ', small sample' : ''})${extra}`;
  return `${r.passed}/${r.total} (95% CI ${pct(lo)}–${pct(hi)}${r.small_sample ? ', small sample' : ''})${extra}`;
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 220);
}

export function renderMarkdown(r: EvalReport): string {
  const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const out: string[] = [];
  out.push(`# MedLevo evaluation report — ${r.run_id}`);
  out.push('');
  out.push(`> Mode: **${r.mode}**${r.mode === 'scripted' ? ' — AI axes ran with the evaluation-only scripted provider: they measure the server\'s validation and abstention guarantees, **not** a model\'s quality.' : ' — AI axes ran with the configured provider.'}`);
  out.push('> Every rate is shown with its denominator and a Wilson 95% interval. A sample under ' + EVAL_SMALL_SAMPLE + ' cases is a small sample; no rate here is an accuracy claim beyond these synthetic TEST FIXTURE cases.');
  out.push('');
  out.push(`* Run: ${when(r.started_at)} → ${when(r.finished_at)}${r.label ? ` · label «${mdCell(r.label)}»` : ''} · set filter: ${r.set_filter}`);
  out.push(`* Catalogue: ${r.catalogue.version} · ${r.catalogue.cases} cases (${r.catalogue.regression} regression, ${r.catalogue.tuning} tuning) · regression hash \`${r.catalogue.regression_hash.slice(0, 16)}\``);
  out.push(`* System: app ${r.system.app_version}${r.system.git_commit ? ` @ ${r.system.git_commit.slice(0, 12)}` : ''} · node ${r.system.node}`);
  out.push(`* Versions: ${Object.entries(r.system.versions).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  if (r.system.models) out.push(`* Models: ${Object.entries(r.system.models).map(([k, v]) => `${k}=${v ?? '—'}`).join(' · ')}`);
  out.push('');
  out.push('## Overall');
  out.push('');
  out.push('| set | result |');
  out.push('|---|---|');
  out.push(`| regression (frozen) | ${rateTextEn(r.overall.regression)} |`);
  out.push(`| tuning examples | ${rateTextEn(r.overall.tuning)} |`);
  out.push('');
  out.push('## Per axis');
  out.push('');
  out.push('| axis | kind | regression | tuning |');
  out.push('|---|---|---|---|');
  for (const a of r.axes) out.push(`| ${a.axis} — ${a.label_ar} | ${a.kind} | ${rateTextEn(a.regression)} | ${rateTextEn(a.tuning)} |`);
  out.push('');
  if (r.blocked.length) {
    out.push('## Not run here');
    out.push('');
    for (const b of r.blocked) out.push(`* ${b.axis ?? 'all'}: ${b.reason_ar}`);
    out.push('');
  }
  const notPassed = r.cases.filter((c) => c.outcome !== 'pass');
  out.push(`## Cases that did not pass (${notPassed.length})`);
  out.push('');
  if (!notPassed.length) out.push('None in this run.');
  else {
    out.push('| case | set | outcome | expected | observed | reason |');
    out.push('|---|---|---|---|---|---|');
    for (const c of notPassed) out.push(`| ${c.case_id} | ${c.set} | ${c.outcome} | ${mdCell(c.expected)} | ${mdCell(c.observed)} | ${mdCell(c.reason_ar ?? '')} |`);
  }
  out.push('');
  out.push('## All cases');
  out.push('');
  out.push('| case | axis | set | outcome | fixture |');
  out.push('|---|---|---|---|---|');
  for (const c of r.cases) out.push(`| ${c.case_id} | ${c.axis} | ${c.set} | ${c.outcome} | ${c.fixture ?? '—'} |`);
  out.push('');
  if (r.notes_ar.length) {
    out.push('## Notes');
    out.push('');
    for (const n of r.notes_ar) out.push(`* ${n}`);
    out.push('');
  }
  return out.join('\n');
}

/** Side-by-side comparison of two runs (base = before the change, head = after it). */
export function compareReports(base: EvalReport, head: EvalReport): EvalCompare {
  const comparable = base.catalogue.regression_hash === head.catalogue.regression_hash;
  const baseById = new Map(base.cases.map((c) => [c.case_id, c]));
  const regressions: EvalCompare['regressions'] = [];
  const fixes: EvalCompare['fixes'] = [];
  for (const h of head.cases) {
    const b = baseById.get(h.case_id);
    if (!b || h.outcome === 'not_run' || b.outcome === 'not_run') continue;
    if (b.outcome === 'pass' && h.outcome !== 'pass') regressions.push({ case_id: h.case_id, axis: h.axis, set: h.set, title_ar: h.title_ar, base: b.outcome, head: h.outcome });
    if (b.outcome !== 'pass' && h.outcome === 'pass') fixes.push({ case_id: h.case_id, axis: h.axis, set: h.set, title_ar: h.title_ar, base: b.outcome, head: h.outcome });
  }
  const keys = new Set([...Object.keys(base.system.versions), ...Object.keys(head.system.versions)]);
  const systemChanges: EvalCompare['system_changes'] = [];
  for (const k of [...keys].sort()) {
    const bv = base.system.versions[k] ?? null;
    const hv = head.system.versions[k] ?? null;
    if (bv !== hv) systemChanges.push({ key: k, base: bv, head: hv });
  }
  const models = new Set([...Object.keys(base.system.models ?? {}), ...Object.keys(head.system.models ?? {})]);
  for (const k of [...models].sort()) {
    const bv = base.system.models?.[k] ?? null;
    const hv = head.system.models?.[k] ?? null;
    if (bv !== hv) systemChanges.push({ key: `model.${k}`, base: bv, head: hv });
  }
  if (base.mode !== head.mode) systemChanges.push({ key: 'mode', base: base.mode, head: head.mode });
  const byAxis = (r: EvalReport) => new Map(r.axes.map((a) => [a.axis, a]));
  const ba = byAxis(base);
  const ha = byAxis(head);
  const axes = EVAL_AXES.filter((a) => ba.has(a) && ha.has(a)).map((axis: EvalAxis) => ({
    axis,
    label_ar: EVAL_AXIS_LABELS_AR[axis],
    base: ba.get(axis)!.regression,
    head: ha.get(axis)!.regression,
  }));
  return {
    base_run_id: base.run_id,
    head_run_id: head.run_id,
    comparable,
    reason_ar: comparable ? null : 'عينة الانحدار مختلفة بين التشغيلين (بصمة الكتالوج تغيرت)، فلا تُقارن النسب مباشرة؛ أعد تشغيل التقييم القديم على الكتالوج الجديد.',
    verdict: !comparable ? 'not_comparable' : regressions.some((x) => x.set === 'regression') ? 'regressions' : 'no_regressions',
    axes,
    regressions,
    fixes,
    system_changes: systemChanges,
  };
}

export function renderCompareMarkdown(c: EvalCompare): string {
  const out: string[] = [];
  out.push(`# Evaluation comparison — ${c.base_run_id} → ${c.head_run_id}`);
  out.push('');
  out.push(`Verdict: **${c.verdict}**${c.reason_ar ? ` — ${c.reason_ar}` : ''}`);
  out.push('');
  out.push('## What changed in the system');
  out.push('');
  if (!c.system_changes.length) out.push('No recorded version or model changed between the two runs.');
  else for (const s of c.system_changes) out.push(`* ${s.key}: ${s.base ?? '—'} → ${s.head ?? '—'}`);
  out.push('');
  out.push('## Regression set per axis (base → head)');
  out.push('');
  out.push('| axis | base | head |');
  out.push('|---|---|---|');
  for (const a of c.axes) out.push(`| ${a.axis} | ${rateTextEn(a.base)} | ${rateTextEn(a.head)} |`);
  out.push('');
  out.push(`## Cases that stopped passing (${c.regressions.length})`);
  out.push('');
  for (const r of c.regressions) out.push(`* ${r.case_id} (${r.set}, ${r.axis}): ${EVAL_OUTCOME_LABELS_AR[r.base]} → ${EVAL_OUTCOME_LABELS_AR[r.head]} — ${r.title_ar}`);
  if (!c.regressions.length) out.push('None.');
  out.push('');
  out.push(`## Cases that now pass (${c.fixes.length})`);
  out.push('');
  for (const r of c.fixes) out.push(`* ${r.case_id} (${EVAL_SET_LABELS_AR[r.set]}, ${r.axis}) — ${r.title_ar}`);
  if (!c.fixes.length) out.push('None.');
  out.push('');
  return out.join('\n');
}
