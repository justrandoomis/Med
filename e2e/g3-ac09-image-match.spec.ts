// G3 / AC-09 — an image of another modality or region is excluded from «find an example», with the reason, and
// nothing is written to present it as the requested example. REAL server + real processing of the derived fixture
// fixtures/acceptance/g3_image_atlas.pdf (ten drawn TEST FIXTURE pictures whose printed captions say what each is),
// then the «ابحث عن مثال مطابق في صوري» panel of /media in the browser. No AI is involved (and none exists here).
import { join } from 'node:path';
import type { ImageListResponse } from '@medlevo/shared';
import { ACCEPTANCE_DIR, uploadFile } from './g1-helpers';
import { expect, screenshot, setupOwner, test } from './support';

const CAPTION = {
  xray: 'Figure 1: Chest X-ray showing a right-sided pneumothorax',
  ct: 'Figure 2: CT chest showing a right-sided pneumothorax',
  abdomen: 'Figure 3: Abdominal X-ray showing dilated small bowel loops',
  denied: 'Figure 4: Chest X-ray: no evidence of pneumothorax',
  drawing: "Figure 5: Chest X-ray appearance of a tension pneumothorax (artist's illustration)",
  ultrasound: 'Figure 6: Ultrasound of the chest',
  arabic: 'صورة أشعة سينية للصدر تُظهر استرواح الصدر',
  resolved: 'Figure 8: Follow-up chest X-ray after chest drain insertion: resolved pneumothorax',
  child: 'Figure 9: Chest X-ray of a child showing a left pneumothorax',
  composite: 'Figure 10: Chest X-ray and CT side by side',
};

test('AC-09: «find an example in my images» — mismatched modality / region / denied / drawn / ambiguous images are excluded with reasons', async ({ page, api }, testInfo) => {
  await setupOwner(page);
  const { course } = await api.createNotebookAndCourse();
  const atlas = await uploadFile(api, course.id, join(ACCEPTANCE_DIR, 'g3_image_atlas.pdf'), { sourceType: 'course_reference', title: 'Chest imaging atlas (TEST FIXTURE)' });
  expect(['completed', 'partial']).toContain((await api.waitForProcessing(atlas.version_id)).job?.status);
  const images = (await api.get<ImageListResponse>(`/api/media/images?source_id=${atlas.source_id}`)).images;
  expect(images, 'all ten figures of the atlas are images of the library').toHaveLength(10);

  // The library may hold images from other specs (re-runnable on a used server): judge by caption.
  const accepted = page.getByRole('list', { name: 'صور مطابقة' }).locator('li');
  const excludedBox = page.locator('.md-match details');

  async function search(modality: string, region: string, finding: string) {
    await page.getByRole('textbox', { name: 'نوع التصوير', exact: true }).fill(modality);
    await page.getByRole('textbox', { name: 'المنطقة التشريحية', exact: true }).fill(region);
    await page.getByRole('textbox', { name: 'العلامة المطلوبة (ومرادفاتها)', exact: true }).fill(finding);
    const done = page.waitForResponse((r) => r.url().endsWith('/api/media/images/match') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'ابحث', exact: true }).click();
    expect((await done).status()).toBe(200);
    await expect(page.locator('.md-match')).toBeVisible();
  }
  const reasonsFor = (caption: string) => excludedBox.locator('.md-excluded > li').filter({ hasText: caption }).first();

  await test.step('X-ray · chest · pneumothorax (+ Arabic synonym): the three true examples only', async () => {
    await page.goto('/media');
    await search('X-ray', 'chest', 'pneumothorax، استرواح الصدر');
    await expect(accepted.filter({ hasText: CAPTION.xray }).first()).toBeVisible();
    await expect(accepted.filter({ hasText: CAPTION.arabic }).first()).toBeVisible();
    await expect(accepted.filter({ hasText: CAPTION.child }).first()).toBeVisible();
    for (const c of [CAPTION.ct, CAPTION.abdomen, CAPTION.denied, CAPTION.drawing, CAPTION.ultrasound, CAPTION.resolved, CAPTION.composite]) await expect(accepted.filter({ hasText: c })).toHaveCount(0);
    await expect(page.locator('.md-match')).toContainText('لا تُكتب لها شروح تلقائيًا');
    await excludedBox.locator('summary').click();
    await expect(reasonsFor(CAPTION.ct)).toContainText('تصوير مقطعي (CT) لا يطابق المطلوب');
    await expect(reasonsFor(CAPTION.ultrasound)).toContainText('أمواج فوق صوتية (Ultrasound) لا يطابق');
    await expect(reasonsFor(CAPTION.abdomen)).toContainText('تختلف عن المطلوبة');
    await expect(reasonsFor(CAPTION.denied)).toContainText('منفية أو مستبعدة');
    await expect(reasonsFor(CAPTION.resolved)).toContainText('منفية أو مستبعدة');
    await expect(reasonsFor(CAPTION.drawing)).toContainText('رسم تعليمي');
    await expect(reasonsFor(CAPTION.composite)).toContainText('أكثر من نوع تصوير');
    // the excluded list carries only the gate's reasons — no explanation text, no «example» wording
    await expect(excludedBox).not.toContainText('مثال على');
    await screenshot(page, testInfo, 'g3-ac09-xray', { fullPage: true });
  });

  await test.step('Arabic request: «أشعة سينية» · «الصدر» · «استرواح الصدر» → the Arabic-captioned X-ray only', async () => {
    await page.goto('/media');
    await search('أشعة سينية', 'الصدر', 'استرواح الصدر');
    await expect(accepted.filter({ hasText: CAPTION.arabic }).first()).toBeVisible();
    for (const c of [CAPTION.xray, CAPTION.ct, CAPTION.child, CAPTION.resolved]) await expect(accepted.filter({ hasText: c })).toHaveCount(0);
    await screenshot(page, testInfo, 'g3-ac09-arabic', { fullPage: true });
  });

  await test.step('CT request: the CT figure, never the composite caption', async () => {
    await page.goto('/media');
    await search('CT', 'thorax', 'pneumothorax');
    await expect(accepted.filter({ hasText: CAPTION.ct }).first()).toBeVisible();
    await expect(accepted.filter({ hasText: CAPTION.composite })).toHaveCount(0);
    await expect(accepted.filter({ hasText: CAPTION.xray })).toHaveCount(0);
    // external image search is not available here — said so, not hidden
    await expect(page.getByText(/^البحث الخارجي:/)).toBeVisible();
  });
});
