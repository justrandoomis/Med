// Control Center quality ops (track F5): the evaluation view (rates with denominators, never «100%», regression apart
// from tuning, what failed and why, comparison with the previous run, empty state with how to run) and the system
// health view (daily trends with their denominators, the day-by-day table, the redacted client error sink and its
// confirmed, audited clear).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EVAL_AXES, type ClientErrorsResponse, type EvalCaseResult, type EvalRate, type EvalReport, type EvaluationOverviewResponse, type HealthTrendsResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { EvaluationScreen } from './EvaluationScreen';
import { HealthScreen } from './HealthScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

function rate(passed: number, total: number, notRun = 0): EvalRate {
  return { passed, total, failed: total - passed, errors: 0, not_run: notRun, rate: total ? passed / total : null, ci95: total ? [passed === total ? 0.72 : 0.5, passed === total ? 1 : 0.95] : null, small_sample: total < 30 };
}
const res = (id: string, outcome: EvalCaseResult['outcome'], set: EvalCaseResult['set'] = 'regression'): EvalCaseResult => ({
  case_id: id,
  axis: 'over_abstention',
  set,
  title_ar: `حالة ${id}`,
  fixture: 'golden/lecture_appendicitis.pdf',
  outcome,
  expected: '{"supported_shown":true}',
  observed: '{"status":"abstained"}',
  reason_ar: outcome === 'pass' ? null : 'امتنع النظام مع وجود دليل واضح في المحاضرة.',
  ms: 3,
});
function report(id: string): EvalReport {
  return {
    format: 'medlevo-eval-1',
    run_id: id,
    label: 'قبل تغيير التقطيع',
    mode: 'scripted',
    set_filter: 'all',
    started_at: Date.UTC(2026, 9, 10, 9),
    finished_at: Date.UTC(2026, 9, 10, 9, 1),
    catalogue: { version: 'eval-catalogue-2026.10-1', regression_hash: 'h', cases: 149, regression: 80, tuning: 69 },
    system: { app_version: '0.1.0', git_commit: null, node: 'v22', versions: { index: 'chunk-v1' }, models: null },
    overall: { regression: rate(4, 5), tuning: rate(12, 12) },
    axes: EVAL_AXES.map((axis) => ({ axis, label_ar: axis === 'over_abstention' ? 'عدم الامتناع حين يوجد دليل واضح' : axis === 'key_binding' ? 'ربط مفتاح الإجابة' : axis, kind: axis === 'over_abstention' ? 'scripted_ai' : 'deterministic', regression: axis === 'over_abstention' ? rate(4, 5) : rate(0, 0), tuning: axis === 'key_binding' ? rate(12, 12) : rate(0, 0) })),
    cases: [res('ok1', 'pass'), res('bad1', 'fail')],
    blocked: [],
    notes_ar: ['كل الحالات على ملفات اختبار اصطناعية.'],
  };
}
const overview = (latest: EvalReport | null, compare: EvaluationOverviewResponse['compare_with_previous'] = null): EvaluationOverviewResponse => ({
  latest,
  compare_with_previous: compare,
  runs: latest ? [{ id: latest.run_id, label: null, mode: 'scripted', status: 'completed', set_filter: 'all', started_at: latest.started_at, finished_at: latest.finished_at, catalogue_version: 'v', catalogue_hash: 'h', overall: latest.overall, error: null }] : [],
  catalogue: { version: 'eval-catalogue-2026.10-1', cases: 149, regression: 80, tuning: 69, by_axis: Object.fromEntries(EVAL_AXES.map((a) => [a, { regression: 1, tuning: 1 }])) as EvaluationOverviewResponse['catalogue']['by_axis'] },
  how_to_run_ar: 'شغّل التقييم على الخادم: `npm run eval`',
});

const wrap = (ui: React.ReactNode) =>
  render(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );

describe('evaluation view', () => {
  it('without a recorded run: says how to run it and what the catalogue holds', async () => {
    setFetchImpl(async () => json(overview(null)));
    wrap(<EvaluationScreen />);
    expect(await screen.findByText('لم يُسجَّل تقييم بعد')).toBeTruthy();
    expect(screen.getByText(/npm run eval/)).toBeTruthy();
    expect(screen.getByText(/149 حالة — 80 في عينة الانحدار و69 من أمثلة الضبط/)).toBeTruthy();
  });

  it('shows every rate with its denominator, regression apart from tuning, never «100%»; lists what failed with its reason', async () => {
    setFetchImpl(async () =>
      json(
        overview(report('eval-2'), {
          base_run_id: 'eval-1',
          head_run_id: 'eval-2',
          comparable: true,
          reason_ar: null,
          verdict: 'regressions',
          axes: [],
          regressions: [{ case_id: 'bad1', axis: 'over_abstention', set: 'regression', title_ar: 'حالة bad1', base: 'pass', head: 'fail' }],
          fixes: [],
          not_compared: [],
          system_changes: [{ key: 'index', base: 'chunk-v1', head: 'chunk-v2' }],
        }),
      ),
    );
    wrap(<EvaluationScreen />);
    expect(await screen.findByRole('heading', { name: 'آخر تقييم' })).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toContain('4 / 5');
    expect(body).toContain('12 / 12 نجحت');
    expect(body).toContain('عينة صغيرة');
    expect(body).not.toMatch(/100\s?%/);
    // status is words + icon, not colour alone
    expect(screen.getAllByText('كلها نجحت').length).toBeGreaterThan(0);
    expect(screen.getAllByText('لم تنجح 1').length).toBeGreaterThan(0);
    // the axis table names the method
    expect(screen.getByRole('region', { name: 'نتائج المحاور' }).textContent).toContain('مسار الذكاء الاصطناعي بمزود مكتوب مسبقًا');
    // the failed case, its reason, expected vs observed on demand
    const failed = screen.getByRole('heading', { name: /ما لم ينجح/ }).closest('section')!;
    expect(within(failed).getByText('حالة bad1')).toBeTruthy();
    expect(within(failed).getByText('امتنع النظام مع وجود دليل واضح في المحاضرة.')).toBeTruthy();
    expect(within(failed).getByText('{"status":"abstained"}')).toBeTruthy();
    // the comparison and what changed in the system
    expect(screen.getByText(/1 حالة من عينة الانحدار كانت تنجح ولم تعد تنجح/)).toBeTruthy();
    expect(screen.getByText('index: chunk-v1 → chunk-v2')).toBeTruthy();
    expect(screen.getByRole('link', { name: /نزّل التقرير الكامل/ }).getAttribute('href')).toBe('/api/control/evaluation/runs/eval-2/report.md');
    expect(screen.getByText('مزود مكتوب مسبقًا للتقييم فقط: يقيس ضمانات الخادم (الأدلة، الامتناع)، لا جودة نموذج.')).toBeTruthy();
  });

  it('(review F5) regression cases the previous run passed and this one skipped: «not comparable», listed — never «no regression»', async () => {
    setFetchImpl(async () =>
      json(
        overview(report('eval-3'), {
          base_run_id: 'eval-2',
          head_run_id: 'eval-3',
          comparable: false,
          reason_ar: '1 حالة من عينة الانحدار نجحت في التشغيل الأساس ولم تُقيَّم في هذا التشغيل؛ لا يمكن القول إنه لا تراجع.',
          verdict: 'not_comparable',
          axes: [],
          regressions: [],
          fixes: [],
          not_compared: [{ case_id: 'sup1', axis: 'claim_support', set: 'regression', title_ar: 'حالة sup1', base: 'pass', head: 'not_run' }],
          system_changes: [],
        }),
      ),
    );
    wrap(<EvaluationScreen />);
    expect(await screen.findByText(/لا يمكن القول إنه لا تراجع/)).toBeTruthy();
    expect(screen.queryByText('لا حالة من عينة الانحدار كانت تنجح ثم توقفت.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'نجحت سابقًا ولم تُقيَّم في هذا التشغيل' })).toBeTruthy();
    expect(screen.getByText('حالة sup1 — لم يُشغَّل')).toBeTruthy();
  });

  it('a server error is one honest sentence with a retry', async () => {
    setFetchImpl(async () => json({ error: { code: 'INTERNAL', message: 'حدث خطأ في الخادم.' } }, 500));
    wrap(<EvaluationScreen />);
    expect(await screen.findByText('حدث خطأ في الخادم.')).toBeTruthy();
  });
});

const trends: HealthTrendsResponse = {
  timezone: 'Asia/Baghdad',
  days: ['2026-10-08', '2026-10-09', '2026-10-10'],
  series: [
    { key: 'claims_checked', label_ar: 'جمل طبية فُحصت', description_ar: 'كل جملة', counts: [10, 0, 5], total: 15, of: null },
    { key: 'citation_invalid', label_ar: 'استشهادات مرفوضة', description_ar: 'دليل غير صالح', counts: [1, 0, 0], total: 1, of: 'claims_checked' },
    { key: 'claim_unsupported', label_ar: 'جمل لم يثبتها الدليل', description_ar: 'قيمة مختلفة', counts: [0, 0, 2], total: 2, of: 'claims_checked' },
    { key: 'sync_ops', label_ar: 'تغييرات وصلت من أجهزتك', description_ar: 'كل عملية', counts: [3, 4, 5], total: 12, of: null },
    { key: 'sync_rejected', label_ar: 'تغييرات رفضها الخادم', description_ar: 'نسخة أحدث', counts: [0, 0, 0], total: 0, of: 'sync_ops' },
    { key: 'sync_conflict', label_ar: 'تعارضات حُفظت فيها النسختان', description_ar: 'جهازان', counts: [0, 1, 0], total: 1, of: 'sync_ops' },
  ],
  generated_at: 1,
  notes_ar: ['أعداد يومية حقيقية؛ لا نسب مئوية.'],
};
const errors: ClientErrorsResponse = {
  items: [{ id: 'E1', kind: 'unhandledrejection', message: "Cannot read properties of undefined (reading 'map')", stack: 'QuestionList (/assets/index.js:12:345)', route: '/questions', app_version: '0.1.0', user_agent: 'Chrome 131', count: 3, first_seen_at: Date.UTC(2026, 9, 9), last_seen_at: Date.UTC(2026, 9, 10) }],
  total: 1,
  retention_ar: 'تُحفظ أخطاء الواجهة 30 يومًا بعد آخر ظهور.',
};

describe('system health view', () => {
  it('each failure count sits next to its denominator; the exact numbers are in a table; no percentages', async () => {
    setFetchImpl(async (url) => json(String(url).includes('/control/health') ? trends : { ...errors, items: [], total: 0 }));
    wrap(<HealthScreen />);
    expect(await screen.findByRole('heading', { name: 'يومًا بيوم' })).toBeTruthy();
    expect(screen.getAllByText('استشهادات مرفوضة').length).toBe(2); // the metric and its table column
    expect(screen.getByText('1 من 15 جملة فُحصت في آخر 3 يومًا.')).toBeTruthy();
    expect(screen.getByText('2 من 15 جملة فُحصت في آخر 3 يومًا.')).toBeTruthy();
    expect(screen.getByText('لا شيء في آخر 3 يومًا (فُحص 12).')).toBeTruthy();
    expect(screen.getByText('1 من 12 تغيير وصل في آخر 3 يومًا.')).toBeTruthy();
    const table = screen.getByRole('region', { name: 'الأعداد اليومية' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('10/10')).toBeTruthy();
    // the strips are decorative: the numbers are in the sentence and the table
    expect(document.querySelectorAll('svg.cc-strip[aria-hidden="true"]').length).toBe(4);
    expect(document.body.textContent).not.toMatch(/\d\s?%/);
    expect(await screen.findByText('لا أخطاء مسجلة')).toBeTruthy();
  });

  it('lists redacted client errors with count, page and browser; clearing asks first and calls DELETE', async () => {
    const calls: string[] = [];
    let cleared = false;
    setFetchImpl(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url).includes('/control/health')) return json(trends);
      if (init?.method === 'DELETE') {
        cleared = true;
        return json({ deleted: 1 });
      }
      return json(cleared ? { ...errors, items: [], total: 0 } : errors);
    });
    wrap(<HealthScreen />);
    expect(await screen.findByText("Cannot read properties of undefined (reading 'map')")).toBeTruthy();
    // the whole log is one item here: no «newest n of total» line
    expect(screen.queryByText(/يُعرض أحدث/)).toBeNull();
    expect(screen.getByText(/3 مرات/)).toBeTruthy();
    expect(screen.getByText('/questions')).toBeTruthy();
    expect(screen.getByText('Chrome 131')).toBeTruthy();
    expect(screen.getByText('عملية لم تكتمل (وعد مرفوض)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'امسح السجل' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/لا يمس هذا أي ملاحظة أو كتابة أو مصدر/)).toBeTruthy();
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'امسح السجل' }));
    await waitFor(() => expect(calls.some((c) => c.startsWith('DELETE') && c.includes('/api/control/client-errors'))).toBe(true));
    expect(await screen.findByText('لا أخطاء مسجلة')).toBeTruthy();
  });

  it('(review F5) a log longer than the page says it shows the newest n of the total', async () => {
    setFetchImpl(async (url) => json(String(url).includes('/control/health') ? trends : { ...errors, total: 240 }));
    wrap(<HealthScreen />);
    expect(await screen.findByText('يُعرض أحدث 1 من 240 خطأ مختلف مسجل.')).toBeTruthy();
  });
});
