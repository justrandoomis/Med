// The EvaluationCase store and run history (§57) in the server's database (control module, migration 0710).
//   * evaluation_case: the catalogue upserted by id (axis, set, input = the check, expected, reviewer, origin,
//     fixture). A case dropped from the catalogue is RETIRED (retired_at), never deleted.
//   * evaluation_run: one row per recorded `npm run eval` (report JSON + Markdown). The 50 newest are kept.
import {
  EVAL_AXES,
  type EvalAxis,
  type EvalCompare,
  type EvalReport,
  type EvalRunSummary,
  type EvaluationOverviewResponse,
} from '@medlevo/shared';
import { fromJson, toJson, type Db } from '../../../db/db';
import { CATALOGUE, CATALOGUE_VERSION, caseFixture, type EvalCaseDef } from './catalogue';
import { compareReports, renderMarkdown } from './report';

export const RUNS_KEPT = 50;

/** who reviewed the expected values (§57 «مع تمييز من راجع ماذا») */
export const REVIEWED_BY: Record<'golden' | 'acceptance' | 'f5', string> = {
  golden: 'fixtures/golden/expected.json — authored with the fixtures, checked against pdftotext/pdfinfo by the orchestrator',
  acceptance: 'acceptance groups G3–G5 (fixtures/acceptance/README.md + their acceptance tests)',
  f5: 'track F5 (behavioural checks written for the evaluation; expected values follow the evidence contract, ARCHITECTURE §3.6)',
};

function reviewerOf(c: EvalCaseDef): { reviewed_by: string; origin: string } {
  const fx = caseFixture(c);
  const behavioural = c.check.type === 'claim_citation' || c.check.type === 'claim_support' || c.check.type === 'chat' || c.check.type === 'detect_dir' || c.check.type === 'bidi_isolation' || c.check.type === 'image_caption';
  if (behavioural) return { reviewed_by: REVIEWED_BY.f5, origin: 'catalogue:behavioural' };
  if (fx?.startsWith('acceptance/')) return { reviewed_by: REVIEWED_BY.acceptance, origin: 'catalogue:acceptance_fixture' };
  return { reviewed_by: REVIEWED_BY.golden, origin: 'catalogue:golden_set' };
}

/** Upsert the code catalogue into evaluation_case; retire rows no longer in it. Returns counts. */
export function syncCatalogue(db: Db, now: number, catalogue: readonly EvalCaseDef[] = CATALOGUE): { upserted: number; retired: number } {
  let upserted = 0;
  let retired = 0;
  db.tx(() => {
    for (const c of catalogue) {
      const who = reviewerOf(c);
      // only a NEW or CHANGED case is written: a boot with an unchanged catalogue writes nothing, so a restored database
      // stays row-for-row identical to its backup (AC-30) and updated_at means «the case changed»
      const r = db.run(
        `INSERT INTO evaluation_case (id, axis, input_json, expected_json, reviewed_by, origin, created_at, set_kind, title, fixture, catalogue_version, retired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET axis = excluded.axis, input_json = excluded.input_json, expected_json = excluded.expected_json,
           reviewed_by = excluded.reviewed_by, origin = excluded.origin, set_kind = excluded.set_kind, title = excluded.title,
           fixture = excluded.fixture, catalogue_version = excluded.catalogue_version, retired_at = NULL, updated_at = excluded.updated_at
         WHERE evaluation_case.axis IS NOT excluded.axis OR evaluation_case.input_json IS NOT excluded.input_json
           OR evaluation_case.expected_json IS NOT excluded.expected_json OR evaluation_case.reviewed_by IS NOT excluded.reviewed_by
           OR evaluation_case.origin IS NOT excluded.origin OR evaluation_case.set_kind IS NOT excluded.set_kind
           OR evaluation_case.title IS NOT excluded.title OR evaluation_case.fixture IS NOT excluded.fixture
           OR evaluation_case.catalogue_version IS NOT excluded.catalogue_version OR evaluation_case.retired_at IS NOT NULL`,
        [c.id, c.axis, toJson(c.check), toJson(c.expected ?? null), who.reviewed_by, who.origin, now, c.set, c.title_ar, caseFixture(c), CATALOGUE_VERSION, now],
      );
      upserted += r.changes > 0 ? 1 : 0;
    }
    const ids = new Set(catalogue.map((c) => c.id));
    for (const r of db.all<{ id: string }>('SELECT id FROM evaluation_case WHERE retired_at IS NULL')) {
      if (!ids.has(r.id)) {
        db.run('UPDATE evaluation_case SET retired_at = ?, updated_at = ? WHERE id = ?', [now, now, r.id]);
        retired++;
      }
    }
  });
  return { upserted, retired };
}

/** Store a finished report (and keep the newest RUNS_KEPT runs). */
export function recordRun(db: Db, report: EvalReport, now: number): void {
  db.tx(() => {
    db.run(
      `INSERT INTO evaluation_run (id, started_at, finished_at, status, mode, set_filter, label, system_json, catalogue_version, catalogue_hash, report_json, report_md, error, created_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        report.run_id,
        report.started_at,
        report.finished_at,
        report.mode,
        report.set_filter,
        report.label,
        toJson(report.system),
        report.catalogue.version,
        report.catalogue.regression_hash,
        toJson(report),
        renderMarkdown(report),
        now,
      ],
    );
    const old = db.all<{ id: string }>('SELECT id FROM evaluation_run ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?', [RUNS_KEPT]);
    for (const r of old) db.run('DELETE FROM evaluation_run WHERE id = ?', [r.id]);
  });
}

interface RunRow {
  id: string;
  label: string | null;
  mode: 'scripted' | 'live';
  status: 'completed' | 'failed';
  set_filter: string;
  started_at: number;
  finished_at: number | null;
  catalogue_version: string;
  catalogue_hash: string;
  report_json: string;
  report_md: string;
  error: string | null;
}

function summaryOf(r: RunRow): EvalRunSummary {
  const rep = fromJson<EvalReport>(r.report_json);
  return {
    id: r.id,
    label: r.label,
    mode: r.mode,
    status: r.status,
    set_filter: r.set_filter,
    started_at: r.started_at,
    finished_at: r.finished_at,
    catalogue_version: r.catalogue_version,
    catalogue_hash: r.catalogue_hash,
    overall: rep?.overall ?? null,
    error: r.error,
  };
}

export function getRun(db: Db, id: string): { report: EvalReport; markdown: string } | null {
  const r = db.get<RunRow>('SELECT * FROM evaluation_run WHERE id = ?', [id]);
  const report = r ? fromJson<EvalReport>(r.report_json) : null;
  return r && report ? { report, markdown: r.report_md } : null;
}

export const HOW_TO_RUN_AR =
  'شغّل التقييم على الخادم: `npm run eval` (يرفع ملفات الاختبار إلى مجلد بيانات مؤقت منفصل ثم يحذفه، ويحفظ التقرير JSON وMarkdown في eval-reports/ ويسجله هنا إن وُجدت قاعدة بيانات الخادم). خيارات: `--set=regression|tuning`، `--axis=key_binding`، `--compare=<تقرير سابق.json>`، `--mode=live` (يحتاج ANTHROPIC_API_KEY). خطوات المقارنة والتراجع في docs/EVALUATION.md.';

export function evaluationOverview(db: Db, catalogue: readonly EvalCaseDef[] = CATALOGUE): EvaluationOverviewResponse {
  const rows = db.all<RunRow>('SELECT * FROM evaluation_run ORDER BY started_at DESC, id DESC LIMIT 20');
  const latest = rows[0] ? fromJson<EvalReport>(rows[0].report_json) : null;
  let compare: EvalCompare | null = null;
  if (latest && rows[1]) {
    const prev = fromJson<EvalReport>(rows[1].report_json);
    if (prev) compare = compareReports(prev, latest);
  }
  const byAxis = Object.fromEntries(EVAL_AXES.map((a) => [a, { regression: 0, tuning: 0 }])) as Record<EvalAxis, { regression: number; tuning: number }>;
  for (const c of catalogue) byAxis[c.axis][c.set]++;
  const reg = catalogue.filter((c) => c.set === 'regression').length;
  return {
    latest,
    compare_with_previous: compare,
    runs: rows.map(summaryOf),
    catalogue: { version: CATALOGUE_VERSION, cases: catalogue.length, regression: reg, tuning: catalogue.length - reg, by_axis: byAxis },
    how_to_run_ar: HOW_TO_RUN_AR,
  };
}
