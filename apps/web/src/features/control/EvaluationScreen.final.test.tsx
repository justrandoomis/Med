// Round 7 final critic sweep (`e2e/critic-screens.spec.ts`, «control-evaluation» at 1280 px): the empty state of
// «تقييم الجودة» printed the server's how-to-run text with its markdown backticks visible, and the Latin commands and
// paths were reordered by the Arabic paragraph («` npm run eval `», «set=regression|tuning`،`--», «/eval-reports»).
// The commands and paths are now isolated left-to-right code runs; the words around them stay as the server wrote them.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EVAL_AXES, type EvalRate, type EvalReport, type EvaluationOverviewResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { EvaluationScreen } from './EvaluationScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

/** the server's real text (apps/server/src/modules/control/evaluation/store.ts HOW_TO_RUN_AR) */
const HOW =
  'شغّل التقييم على الخادم: `npm run eval` (يرفع ملفات الاختبار إلى مجلد بيانات مؤقت منفصل ثم يحذفه، ويحفظ التقرير JSON وMarkdown في `eval-reports/` ويسجله هنا إن وُجدت قاعدة بيانات الخادم). خيارات: `--set=regression|tuning`، `--axis=key_binding`، `--compare=<تقرير سابق.json>`، `--mode=live` (يحتاج ANTHROPIC_API_KEY). خطوات المقارنة والتراجع في `docs/EVALUATION.md`.';

const overview: EvaluationOverviewResponse = {
  latest: null,
  compare_with_previous: null,
  runs: [],
  catalogue: { version: 'eval-catalogue-2026.10-2', cases: 149, regression: 80, tuning: 69, by_axis: Object.fromEntries(EVAL_AXES.map((a) => [a, { regression: 1, tuning: 1 }])) as EvaluationOverviewResponse['catalogue']['by_axis'] },
  how_to_run_ar: HOW,
};

describe('evaluation empty state (Round 7 final)', () => {
  it('shows the commands as isolated left-to-right code, never the raw backticks', async () => {
    setFetchImpl(async () => json(overview));
    const { container } = render(
      <MemoryRouter>
        <ToastProvider>
          <EvaluationScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText('لم يُسجَّل تقييم بعد');
    const how = container.querySelector('.ml-empty, [class*="empty"]') ?? container;
    expect(how.textContent).not.toContain('`');
    const codes = Array.from(container.querySelectorAll('code')).map((c) => ({ text: c.textContent, dir: c.getAttribute('dir') }));
    expect(codes).toEqual([
      { text: 'npm run eval', dir: 'ltr' },
      { text: 'eval-reports/', dir: 'ltr' },
      { text: '--set=regression|tuning', dir: 'ltr' },
      { text: '--axis=key_binding', dir: 'ltr' },
      { text: '--compare=<تقرير سابق.json>', dir: 'ltr' },
      { text: '--mode=live', dir: 'ltr' },
      { text: 'docs/EVALUATION.md', dir: 'ltr' },
    ]);
    // each code run is isolated from the Arabic around it
    for (const c of Array.from(container.querySelectorAll('code'))) expect(c.parentElement?.tagName.toLowerCase()).toBe('bdi');
    // the Arabic words are all still there
    expect(how.textContent).toContain('شغّل التقييم على الخادم:');
    expect(how.textContent).toContain('خطوات المقارنة والتراجع في');
  });
});

const rate = (passed: number, total: number): EvalRate => ({ passed, total, failed: total - passed, errors: 0, not_run: 0, rate: total ? passed / total : null, ci95: total ? [0.5, 1] : null, small_sample: total < 30 });

describe('evaluation report notes (Round 7 final)', () => {
  it('a note naming a command shows it as code, not between raw backticks', async () => {
    const report: EvalReport = {
      format: 'medlevo-eval-1',
      run_id: 'eval-x',
      label: null,
      mode: 'scripted',
      set_filter: 'all',
      started_at: Date.UTC(2026, 9, 20, 19),
      finished_at: Date.UTC(2026, 9, 20, 19, 1),
      catalogue: { version: 'eval-catalogue-2026.10-2', regression_hash: 'h', cases: 149, regression: 80, tuning: 69 },
      system: { app_version: '0.1.0', git_commit: null, node: 'v22', versions: {}, models: null },
      overall: { regression: rate(80, 80), tuning: rate(69, 69) },
      axes: EVAL_AXES.map((axis) => ({ axis, label_ar: axis, kind: 'deterministic', regression: rate(1, 1), tuning: rate(0, 0) })),
      cases: [],
      blocked: [],
      // the runner's real note (apps/server/src/modules/control/evaluation/runner.ts)
      notes_ar: ['تقييم نموذج حقيقي يحتاج ANTHROPIC_API_KEY وتشغيل `npm run eval -- --mode=live`.'],
    };
    setFetchImpl(async () => json({ ...overview, latest: report, runs: [] }));
    const { container } = render(
      <MemoryRouter>
        <ToastProvider>
          <EvaluationScreen />
        </ToastProvider>
      </MemoryRouter>,
    );
    const note = await screen.findByText(/تقييم نموذج حقيقي يحتاج/);
    expect(note.textContent).not.toContain('`');
    expect(note.querySelector('code')?.textContent).toBe('npm run eval -- --mode=live');
    expect(note.querySelector('code')?.getAttribute('dir')).toBe('ltr');
    expect(container.textContent).not.toMatch(/`npm run eval/);
  });
});
