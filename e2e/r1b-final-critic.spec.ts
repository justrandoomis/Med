// Release R1-b + N1 final critic pass (2026-10-21) — the reader's top bar on a wide screen (desktop, iPad landscape).
//
// Found at 1280 px with the study rail open: after parity N1 added its tools, the writing bar took its whole content
// width. The top bar's middle slot never shrank (`flex: none`) while the title slot and the search / zoom slot were
// allowed to collapse to nothing, so the title, the page chip and the zoom group lay UNDER the writing tools (the
// zoom-out button and «المزيد من أدوات الكتابة» could not be tapped; e2e specs had to reach the bar by keyboard). The
// writing bar already folds what does not fit into «المزيد» — it just was never given less room.
// Checked here at desktop / tablet-landscape widths, after the owner has used a few tools (the bar then also shows the
// previous tool) and reloaded, with the study rail open and closed: every control of the top bar can be hit at its
// centre (nothing lies over it), and the writing bar keeps «المزيد».
import type { Page } from '@playwright/test';
import { pickInkTool } from './g6-helpers';
import { expect, openWorkspace, setupOwner, test } from './support';

/** Top-bar controls whose centre is covered by something else (another control lying over them). */
async function coveredTopbarControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bar = document.querySelector('.wk-topbar');
    if (!bar) return ['no top bar'];
    const out: string[] = [];
    for (const el of Array.from(bar.querySelectorAll<HTMLElement>('button, a[href], h1'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"], .ml-visually-hidden')) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit === el || el.contains(hit))) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
        const over = hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('aria-label') ? `[${hit.getAttribute('aria-label')}]` : ''}` : 'nothing';
        out.push(`${el.tagName.toLowerCase()} «${name}» under ${over}`);
      }
    }
    return out;
  });
}

test('R1-b final critic: on a wide reader nothing in the top bar lies under the writing bar', async ({ page, api }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the wide top bar (the phone has its own two-row bar, checked by n1-writing)');
  test.setTimeout(180_000);
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const up = await api.uploadFixture(course.id, 'lecture_appendicitis.pdf', { sourceType: 'lecture', onDuplicate: 'create', title: `R1-b top bar ${Date.now().toString(36)}` });
  expect((await api.waitForProcessing(up.version_id)).job?.status).toBe('completed');
  const rail = page.locator('.wk-topbar').getByRole('button', { name: 'لوحة الدراسة', exact: true });
  // a few tools used (pen, eraser, shapes, pen): the bar shows the previous tool too
  await openWorkspace(page, up.source_id, { pageIndex: 0 });
  for (const tool of [/^القلم/, /^الممحاة/, /^الأشكال/, /^القلم/]) await pickInkTool(page, tool);
  for (const width of [1280, 1180, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await openWorkspace(page, up.source_id, { pageIndex: 0 });
    const bar = page.getByRole('toolbar', { name: 'أدوات الكتابة' });
    await expect(bar).toBeVisible();
    for (const railOpen of [true, false]) {
      if ((await rail.getAttribute('aria-pressed')) !== String(railOpen)) await rail.click();
      await expect(rail).toHaveAttribute('aria-pressed', String(railOpen));
      // the writing bar measures its room after a resize: give it a few frames
      await page.waitForTimeout(400);
      await expect.poll(() => coveredTopbarControls(page), { message: `${width} px, study rail ${railOpen ? 'open' : 'closed'}`, timeout: 5_000 }).toEqual([]);
      await expect(bar.getByRole('button', { name: 'المزيد من أدوات الكتابة' })).toBeVisible();
    }
  }
});
