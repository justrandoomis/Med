// Regression tests for the independent review of the learning web track (L2):
//  * each day of the day list is a region named by its heading (the section and its heading used to share one id, so
//    the region labelled itself — its accessible name became every task of the day, and the ids were duplicated);
//  * editing a plan never claims the old plan was archived when archiving failed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PlanPreviewResponse, PlanTaskView, StudyPlanView } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { json, routeFetch, clearDb } from '../../../test/learning/helpers';
import { addDays, dayOf } from '../review/local/time';
import { DayList } from './DayList';
import { PlanEditor } from './PlanEditor';

const T = { timeout: 5000 };
beforeEach(async () => {
  await clearDb();
});
afterEach(() => setFetchImpl(null));

const task = (id: string, day: string, title: string): PlanTaskView => ({ id, plan_id: 'P1', day, kind: 'learn', title_ar: title, ref: { source_id: 'S1', page_from: 1, page_to: 4 }, minutes: 16, status: 'todo', moved_from_day: null });

describe('planner day list accessibility', () => {
  it('ids are unique and every day region is named by its heading only', () => {
    const { container } = render(
      <MemoryRouter>
        <DayList tasks={[task('a', '2026-10-09', 'تعلّم «Shock» — ص 1–4'), task('b', '2026-10-10', 'تعلّم «Shock» — ص 5–8'), task('c', '2026-10-11', 'تعلّم «Shock» — ص 9–12')]} today="2026-10-10" timezone="Asia/Baghdad" dailyMinutes={60} onSet={() => undefined} />
      </MemoryRouter>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of container.querySelectorAll('section.lw-day')) {
      const by = section.getAttribute('aria-labelledby')!;
      expect(by).not.toBe(section.id); // never labelled by itself
      const heading = container.querySelector(`#${CSS.escape(by)}`)!;
      expect(heading.tagName).toBe('H3');
    }
    expect(screen.getByRole('region', { name: 'اليوم — السبت 10 أكتوبر' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'غدًا — الأحد 11 أكتوبر' })).toBeTruthy();
  });
});

describe('editing a plan', () => {
  it('says so when the old plan could not be archived (never a false «أُرشفت»)', async () => {
    const today = dayOf(Date.now(), 'Asia/Baghdad');
    const config = {
      title: 'امتحان الجراحة',
      exam_date: addDays(today, 30),
      source_ids: ['S1'],
      available_weekdays: [0, 1, 2, 3, 4, 6],
      daily_minutes: 60,
      blocked_dates: [],
      include: { learn: true, review: true, mcq: true, flashcards: true, weakness: true },
    };
    const feasibility = { feasible: true, required_minutes: 32, available_minutes: 1500, study_days: 25, summary_ar: 'تتسع الأيام.', unfit_ar: [], estimates_ar: [] };
    const plan = (id: string): StudyPlanView => ({
      id,
      title: config.title,
      status: 'active',
      config,
      timezone: 'Asia/Baghdad',
      version: 1,
      today,
      days_left: 30,
      tasks: [task('t1', today, 'تعلّم «Shock» — ص 1–4')],
      feasibility,
      last_report: null,
      last_rebalanced_at: null,
      behind: 0,
      created_at: 1,
      updated_at: 1,
    });
    const preview: PlanPreviewResponse = { tasks: [task('t1', today, 'تعلّم «Shock» — ص 1–4')], feasibility, today };
    const net = routeFetch({
      'GET /learning/plans/P1': plan('P1'),
      'POST /learning/plans/preview': preview,
      'POST /learning/plans': plan('P2'),
      'POST /learning/plans/P1/archive': () => json({ error: { code: 'INTERNAL', message: 'خطأ في الخادم' } }, 500),
    });
    setFetchImpl(net.fn as never);
    render(
      <MemoryRouter initialEntries={['/planner/P1/edit']}>
        <ToastProvider>
          <Routes>
            <Route path="/planner/:id/edit" element={<PlanEditor />} />
            <Route path="/planner/:id" element={<p>صفحة الخطة</p>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /عاين الخطة/ }, T));
    await screen.findByText('تتسع الأيام.', undefined, T);
    fireEvent.click(screen.getByRole('button', { name: /احفظ كخطة جديدة/ }));
    await screen.findByText('صفحة الخطة', undefined, T);
    expect(await screen.findByText(/تعذّرت أرشفة الخطة السابقة فبقيت نشطة/, undefined, T)).toBeTruthy();
    expect(screen.queryByText(/وأُرشفت السابقة/)).toBeNull();
    expect(net.calls.some((c) => c.method === 'POST' && c.url.includes('/learning/plans/P1/archive'))).toBe(true);
  });
});
