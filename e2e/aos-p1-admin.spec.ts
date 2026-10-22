// Academic OS P1-T4 step 3 — «إدارة القنوات» against the REAL server and the built web app, phone 390 × 844 and desktop
// 1280 × 800 (BUILD_PLAN §3.6; IA §4.10; PRD AOS-18.1, 18.5, 18.6, 18.8, 2.14, 2.15): the platform admin builds a tree
// through the screens (add, edit, move, archive with its impact first), creates a class code and an invite link with its
// QR (shown once), approves the student who joined with it, grants a role here and sees one inherited from above, reads
// the audit filtered by scope and by action, and opens «الإشراف».
import { expect, screenshot, setupOwner, test } from './support';
import type { ChannelNodeView, ChannelTreeResponse, JoinCodesResponse, LecturePublicationsResponse, NotificationsResponse, SecurityAuditResponse } from '@medlevo/shared';
import { axeInLooks, registerStudent, stampFor } from './aos-p1-channels-helpers';
import { anchorOf, buildAosWorld, createLayer, eventually, fixturePages, op, pageIds, publishApi, push, startCopy, textBoxPayload, type AosWorld } from './support/aos-world';

test('«إدارة القنوات»: tree CRUD, codes and QR, members, roles with inheritance, audit by scope, «الإشراف»', async ({ page, api, playwright, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await setupOwner(page);
  const stamp = stampFor(testInfo.project.name);
  const uni = `جامعة الموصل ${stamp}`;
  const med = `كلية الطب ${stamp}`;
  const pharm = `كلية الصيدلة ${stamp}`;
  const subj = `التشريح ${stamp}`;
  const subjRenamed = `التشريح العام ${stamp}`;
  const temp = `قسم مؤقت ${stamp}`;
  const byTitle = async (title: string): Promise<ChannelNodeView> => {
    const tree = await api.get<ChannelTreeResponse>('/api/channels/tree?depth=7');
    const n = tree.nodes.find((x) => x.title === title);
    expect(n, `node «${title}» in the tree`).toBeTruthy();
    return n!;
  };
  const row = (title: string) => page.locator('li.ad-tree__row').filter({ has: page.getByText(title, { exact: true }) });

  await test.step('«أنا» → «إدارة القنوات»: the sections the platform admin may open', async () => {
    await page.goto('/me');
    await page.getByRole('link', { name: /إدارة القنوات/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'إدارة القنوات' })).toBeVisible();
    for (const name of ['الشجرة', 'الأعضاء وطلبات الانضمام', 'الرموز والدعوات', 'الأدوار', 'الإشراف', 'سجل الإجراءات']) {
      await expect(page.getByRole('link', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await screenshot(page, testInfo, 'aos-admin-index');
    expect(await axeInLooks(page, 'admin index')).toEqual([]);
  });

  await test.step('«الشجرة»: a university, two colleges, a subject and a department through the dialogs', async () => {
    await page.getByRole('link', { name: /^الشجرة/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'الشجرة' })).toBeVisible();
    await page.getByRole('button', { name: 'أضف جامعة' }).click();
    let dialog = page.getByRole('dialog', { name: 'جامعة جديدة' });
    await dialog.getByLabel('الاسم', { exact: true }).fill(uni);
    await dialog.getByRole('button', { name: 'أنشئ' }).click();
    await expect(dialog).toBeHidden();
    // the new university becomes the section's scope
    await expect(page.locator('.ad-scope__line')).toContainText(uni);
    for (const [parent, kind, title, policy] of [
      [uni, 'college', med, null],
      [uni, 'college', pharm, null],
      [med, 'subject', subj, 'open_with_code'],
      [med, 'department', temp, null],
    ] as const) {
      await page.getByRole('button', { name: `أضف تحت ${parent}` }).click();
      dialog = page.getByRole('dialog', { name: `عقدة جديدة تحت ${parent}` });
      await dialog.getByLabel('النوع').selectOption(kind);
      await dialog.getByLabel('الاسم', { exact: true }).fill(title);
      if (policy) await dialog.getByLabel('طريقة الانضمام').selectOption(policy);
      await dialog.getByRole('button', { name: 'أنشئ' }).click();
      await expect(dialog).toBeHidden();
      await expect(row(title)).toBeVisible();
    }
    const subject = await byTitle(subj);
    expect(subject.kind).toBe('subject');
    expect(subject.has_space, 'a subject gets its own space').toBe(true);
    expect(subject.join_policy).toBe('open_with_code');
    expect(subject.parent_id).toBe((await byTitle(med)).id);
  });

  await test.step('edit, move (with everything below it) and archive (impact first)', async () => {
    await page.getByRole('button', { name: `عدّل ${subj}` }).click();
    let dialog = page.getByRole('dialog', { name: `تعديل «${subj}»` });
    await dialog.getByLabel('الاسم', { exact: true }).fill(subjRenamed);
    await dialog.getByRole('button', { name: 'احفظ' }).click();
    await expect(dialog).toBeHidden();
    await expect(row(subjRenamed)).toBeVisible();

    await page.getByRole('button', { name: `انقل ${subjRenamed}` }).click();
    dialog = page.getByRole('dialog', { name: `نقل «${subjRenamed}»` });
    await expect(dialog.getByText('اختر الوجهة أولًا.')).toBeVisible();
    await dialog.getByLabel('الوجهة').selectOption({ label: `— ${pharm} (كلية)` });
    await dialog.getByRole('button', { name: 'انقل', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await byTitle(subjRenamed)).parent_id).toBe((await byTitle(pharm)).id);

    await page.getByRole('button', { name: `أرشف ${temp}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(/ستُؤرشف معها 0 عقدة تحتها/);
    await expect(confirm).toContainText('لا يُحذف شيء');
    await confirm.getByRole('button', { name: 'أرشف', exact: true }).click();
    await expect(row(temp).getByText('مؤرشفة')).toBeVisible();
    expect((await byTitle(temp)).status).toBe('archived');
    await screenshot(page, testInfo, 'aos-admin-tree');
    expect(await axeInLooks(page, 'admin tree')).toEqual([]);
  });

  const subject = await byTitle(subjRenamed);
  let inviteLink = '';

  await test.step('«الرموز والدعوات»: a class code and an invite link with its QR, each shown once; revoke the code', async () => {
    await page.goto(`/admin/codes?node=${subject.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'الرموز والدعوات' })).toBeVisible();
    await expect(page.locator('.ad-scope__line')).toContainText(subjRenamed);
    await page.getByRole('button', { name: 'أنشئ', exact: true }).click();
    const fresh = page.getByRole('region', { name: 'رمز الانضمام الجديد' });
    await expect(fresh.locator('code')).toHaveText(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await expect(fresh.getByText(/لن يظهر مرة أخرى/)).toBeVisible();
    const code = (await fresh.locator('code').textContent())!;

    await page.getByRole('radio', { name: /رابط دعوة و QR/ }).click();
    await page.getByRole('button', { name: 'أنشئ', exact: true }).click();
    const link = page.getByRole('region', { name: 'رابط الدعوة الجديد' });
    await expect(link.getByRole('img', { name: /رمز QR/ })).toBeVisible();
    inviteLink = (await link.locator('code').textContent())!.trim();
    expect(inviteLink).toMatch(/\/join\/[A-Za-z0-9_-]{16,}$/);
    await screenshot(page, testInfo, 'aos-admin-codes-qr');
    expect(await axeInLooks(page, 'admin codes')).toEqual([]);

    const codes = await api.get<JoinCodesResponse>(`/api/channels/nodes/${subject.id}/codes`);
    const classCode = codes.codes.find((c) => c.kind === 'class_code')!;
    expect(code.replace('-', '').endsWith(classCode.hint), 'the list shows only the last characters').toBe(true);
    await page.getByRole('button', { name: `ألغِ الرمز …${classCode.hint}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'ألغِ الرمز' }).click();
    await expect(page.locator('li').filter({ hasText: `…${classCode.hint}` }).getByText('أُلغي')).toBeVisible();
    expect((await api.get<JoinCodesResponse>(`/api/channels/nodes/${subject.id}/codes`)).codes.find((c) => c.id === classCode.id)?.revoked_at).not.toBeNull();
  });

  const student = { username: `huda_${stamp}`, display_name: `هدى ${stamp}` };
  await test.step('«الأعضاء وطلبات الانضمام»: the student who used the link waits for approval → approve', async () => {
    const ctx = await playwright.request.newContext({ baseURL });
    try {
      const r = await registerStudent(ctx, student, { invite_token: inviteLink.split('/').pop()! });
      expect(r.membership?.status).toBe('pending');
    } finally {
      await ctx.dispose();
    }
    await page.goto(`/admin/members?node=${subject.id}`);
    await expect(page.getByRole('heading', { level: 1, name: /الأعضاء/ })).toBeVisible();
    const who = page.locator('li').filter({ hasText: student.display_name });
    await expect(who).toBeVisible();
    await screenshot(page, testInfo, 'aos-admin-members');
    expect(await axeInLooks(page, 'admin members')).toEqual([]);
    await who.getByRole('button', { name: `وافق على ${student.display_name}` }).click();
    await expect(page.locator('li').filter({ hasText: student.display_name })).toHaveCount(0);
  });

  await test.step('«الأدوار»: grant «مساعد» here; a role given on the college shows as inherited, managed there', async () => {
    const members = await api.get<{ items: Array<{ user: { id: string; display_name: string } }> }>(`/api/channels/nodes/${subject.id}/members?status=approved`);
    const studentId = members.items.find((m) => m.user.display_name === student.display_name)!.user.id;
    await api.post(`/api/channels/nodes/${(await byTitle(pharm)).id}/roles`, { user_id: studentId, role: 'subject_moderator' });

    await page.goto(`/admin/roles?node=${subject.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'الأدوار' })).toBeVisible();
    const inherited = page.locator('li').filter({ hasText: `موروث من ${pharm}` });
    await expect(inherited).toContainText(student.display_name);
    await expect(inherited).toContainText('مشرف المادة');
    await expect(inherited.getByRole('button')).toHaveCount(0);

    await page.getByLabel('الشخص').selectOption({ label: student.display_name });
    await page.getByLabel('الدور').selectOption('assistant');
    await page.getByRole('button', { name: 'امنح الدور' }).click();
    const here = page.locator('li').filter({ hasText: 'على هذه العقدة' }).filter({ hasText: 'مساعد' });
    await expect(here).toContainText(student.display_name);
    await screenshot(page, testInfo, 'aos-admin-roles');
    expect(await axeInLooks(page, 'admin roles')).toEqual([]);
    await here.getByRole('button', { name: `اسحب دور مساعد من ${student.display_name}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'اسحب الدور' }).click();
    await expect(page.locator('li').filter({ hasText: 'على هذه العقدة' }).filter({ hasText: 'مساعد' })).toHaveCount(0);
  });

  await test.step('«سجل الإجراءات»: the subject’s entries, filtered by action; another scope does not show them', async () => {
    await page.goto(`/admin/audit?node=${subject.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'سجل الإجراءات' })).toBeVisible();
    const list = page.locator('.ad-section ul.ml-list');
    await expect(list).toContainText('إنشاء رمز');
    await expect(list).toContainText('قرار عضوية');
    await expect(list).toContainText('منح دور');
    await page.getByLabel('نوع الإجراء').selectOption('channel_role_grant');
    await expect(list.locator('li').first()).toContainText('منح دور');
    for (const text of await list.locator('li .ad-member__meta').allTextContents()) expect(text).toContain('منح دور');
    await screenshot(page, testInfo, 'aos-admin-audit');
    expect(await axeInLooks(page, 'admin audit')).toEqual([]);
    // the same filter through the API: scoped, no IP addresses
    const scoped = await api.get<SecurityAuditResponse>(`/api/admin/audit?scope_node_id=${subject.id}`);
    expect(scoped.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(scoped)).not.toMatch(/127\.0\.0\.1|"ip"/);
    const other = await api.get<SecurityAuditResponse>(`/api/admin/audit?scope_node_id=${(await byTitle(temp)).id}`);
    expect(other.items.some((e) => (e.summary_ar ?? '').includes(subjRenamed)), 'the archived department’s audit holds none of the subject’s entries').toBe(false);
  });

  await test.step('«الإشراف»: the subject’s queue', async () => {
    await page.goto(`/admin/moderation?node=${subject.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'الإشراف' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'مفتوح' })).toHaveAttribute('aria-checked', 'true');
    // nothing was reported in this new subject: the queue is honestly empty. The journey with a fixture report (a
    // published explanation, reported, hidden and restored through this screen) is the next test.
    await expect(page.getByText('لا توجد بلاغات مفتوحة في هذا النطاق')).toBeVisible();
    await screenshot(page, testInfo, 'aos-admin-moderation');
    expect(await axeInLooks(page, 'admin moderation')).toEqual([]);
  });

  await test.step('nobody else gets the area: a student sees the missing page at /admin', async () => {
    const browser = page.context().browser()!;
    const ctx = await browser.newContext({ baseURL, locale: 'ar-IQ', serviceWorkers: 'block' });
    try {
      const p = await ctx.newPage();
      const other = { username: `omar_${stamp}`, display_name: `عمر ${stamp}` };
      const code = await api.post<{ code: string }>(`/api/channels/nodes/${subject.id}/codes`, { kind: 'class_code', expires_in_hours: 1, requires_approval: true });
      await registerStudent(p.request, other, { code: code.code });
      await p.goto('/admin');
      await expect(p.getByRole('heading', { name: 'هذه الصفحة غير موجودة' })).toBeVisible();
      await p.goto('/me');
      await expect(p.getByRole('heading', { level: 1, name: 'أنا' })).toBeVisible();
      await expect(p.getByRole('link', { name: /إدارة القنوات/ })).toHaveCount(0);
      // node titles are public to signed-in users (§7.3), so a refusal here is 403, never the audit itself
      expect([403, 404]).toContain((await p.request.get(`/api/admin/audit?scope_node_id=${subject.id}`)).status());
    } finally {
      await ctx.close();
    }
  });
});


// Review of P1-T4 step 3: the «الإشراف» journey with a fixture report (BUILD_PLAN §3.6 acceptance), possible now that
// P1-T5 step 3 registers publications. A classmate's course-only explanation is reported; the Subject Moderator (this
// page) hides it with a reason through the screen, the author and the reporter are told, and it is restored.
test('«الإشراف» with a fixture report: hide with a reason through the screen, then restore (Subject Moderator)', async ({ page, playwright, baseURL }, testInfo) => {
  test.setTimeout(420_000);
  const w = await buildAosWorld({
    playwright,
    baseURL: baseURL!,
    project: testInfo.project.name,
    page: { key: 'sara', page },
    people: { sara: { name: 'سارة', role: 'subject_moderator' }, hasan: { name: 'حسن' }, reem: { name: 'ريم' } },
    lecture: { title: 'Lecture 5 — moderation fixture', pages: fixturePages('Lecture 5', 3, 52_000), fileName: 'lecture5.pdf' },
  });
  try {
    const { hasan, reem } = w.people as Record<string, NonNullable<AosWorld['people'][string]>>;
    const copy = await startCopy(w, hasan!, { mode: 'personal' });
    const ids = await pageIds(hasan!, copy.source_id, copy.lecture!.version_id);
    const layer = await createLayer(hasan!, copy.source_id, 'شرحي');
    await push(hasan!, [op('annotation', `${w.stamp}MOD1`.toUpperCase(), textBoxPayload(anchorOf(copy.source_id, copy.lecture!.version_id, ids, 0), 'الشريان الكلوي يتفرع من الأبهر', layer), 'append')]);
    const title = `شرح حسن ${w.stamp}`;
    const pub = await publishApi(w, hasan!, [layer], title);
    await reem!.api.post('/api/moderation/reports', { target: { db: 'system', type: 'publication', id: pub.id }, reason: 'wrong_content', note: 'السهم في الصفحة 1 خاطئ' });
    const listed = async () => (await reem!.api.get<LecturePublicationsResponse>(w.S(`/lectures/${w.lecture.id}/publications`))).items.some((p) => p.id === pub.id);

    await test.step('the report is in the subject’s queue, with its reason and the reporter’s note', async () => {
      await page.goto(`/admin/moderation?node=${w.subject.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'الإشراف' })).toBeVisible();
      const row = page.locator('li.ad-report').filter({ hasText: title });
      await expect(row).toBeVisible();
      await expect(row).toContainText('معلومة خاطئة');
      await expect(row).toContainText('ملاحظة المُبلِّغ: السهم في الصفحة 1 خاطئ');
      await screenshot(page, testInfo, 'aos-admin-moderation-report');
      expect(await axeInLooks(page, 'admin moderation with a report')).toEqual([]);
    });

    await test.step('«أخفِ مع السبب» → the explanation leaves the lists; author and reporter are told', async () => {
      await page.locator('li.ad-report').filter({ hasText: title }).getByRole('button', { name: 'أخفِ مع السبب' }).click();
      const dialog = page.getByRole('dialog', { name: 'أخفِ مع السبب' });
      await dialog.getByLabel('السبب (يقرؤه الكاتب والمُبلِّغ)').fill('معلومة خاطئة في الصفحة 1.');
      await dialog.getByRole('button', { name: 'أخفِ', exact: true }).click();
      await expect(page.getByText('أُخفي المحتوى وأُبلغ الكاتب والمُبلِّغ.')).toBeVisible();
      await expect(page.locator('li.ad-report').filter({ hasText: title })).toHaveCount(0);
      expect(await listed()).toBe(false);
      const told = async (who: NonNullable<AosWorld['people'][string]>) => (await who.api.get<NotificationsResponse>('/api/notifications')).items.some((n) => n.kind === 'moderation');
      await eventually(() => told(hasan!), Boolean, 'the author is told');
      await eventually(() => told(reem!), Boolean, 'the reporter is told');
    });

    await test.step('«اتُّخذ إجراء» → «أعِد الإظهار» with a reason → listed again', async () => {
      await page.getByRole('radio', { name: 'اتُّخذ إجراء' }).click();
      const row = page.locator('li.ad-report').filter({ hasText: title });
      await row.getByRole('button', { name: 'أعِد الإظهار' }).click();
      const dialog = page.getByRole('dialog', { name: 'أعِد الإظهار' });
      await dialog.getByLabel('السبب (يقرؤه الكاتب والمُبلِّغ)').fill('صُحّحت المعلومة.');
      await dialog.getByRole('button', { name: 'أعِد الإظهار', exact: true }).click();
      await expect(page.getByText('أُعيد إظهار المحتوى.')).toBeVisible();
      await expect.poll(listed).toBe(true);
    });
  } finally {
    await w.dispose();
  }
});
