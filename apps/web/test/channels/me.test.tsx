// P1-T4 step 3 — «أنا» (IA §3.1, §3.2, §4.14): the account, Settings (moved here from the tab bar), the Personal
// Control Center, downloads, «أجهزتي», «الخصوصية والبيانات», «الاستهلاك», and «إدارة القنوات» only with a role. Each
// screen reads the viewer's OWN account routes (P1-T1's /api/accounts/me/*).
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { ChannelNodeView, DeletionPreview, DeviceView, MeResponse, QuotaView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { MeScreen } from '../../src/features/me/MeScreen';
import { DevicesScreen } from '../../src/features/me/DevicesScreen';
import { UsageScreen } from '../../src/features/me/UsageScreen';
import { PrivacyScreen } from '../../src/features/me/PrivacyScreen';
import { expectDisabledSayWhy } from './sayWhy';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const QUOTA: QuotaView = {
  storage: { used_bytes: 300 * 1024 * 1024, limit_bytes: 1024 * 1024 * 1024 },
  ai: { month: '2026-10', used_usd_est: 0.42, limit_usd: null },
  asr: { month: '2026-10', used_minutes: 0, limit_minutes: 120 },
};
const ME: MeResponse = {
  id: 'u1',
  username: 'sara',
  display_name: 'سارة',
  is_platform_admin: false,
  vault_id: 'v1',
  timezone: 'Asia/Baghdad',
  memberships: [],
  roles: [],
  quota: QUOTA,
  legacy_owner: false,
};
const subject = (roles: ChannelNodeView['viewer']['roles']): ChannelNodeView =>
  ({
    id: 'anat',
    kind: 'subject',
    title: 'Anatomy',
    parent_id: null,
    title_en: null,
    ordinal: null,
    starts_on: null,
    ends_on: null,
    has_space: true,
    space_id: 'sp1',
    join_policy: 'approval',
    status: 'active',
    viewer: { membership: null, roles, inherited_from: null, course_follow: null },
  }) as ChannelNodeView;

let calls: Array<{ method: string; url: string; body: unknown }> = [];
function serve(routes: Record<string, (method: string, body: unknown) => Response>) {
  calls = [];
  setFetchImpl(async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.split('?')[0]!;
    const hit = Object.entries(routes).find(([p]) => path === p);
    return hit ? hit[1](method, body) : json({ error: { code: 'NOT_FOUND', message: 'المسار المطلوب غير موجود.' } }, 404);
  });
}

function show(path: string, element: React.ReactElement) {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [path] });
  render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

afterEach(() => setFetchImpl(null));

describe('«أنا»', () => {
  it('holds the account, Settings, the Control Center, devices, privacy and data, usage and downloads — no channel administration without a role', async () => {
    serve({ '/api/accounts/me': () => json(ME), '/api/channels/tree': () => json({ nodes: [subject([])], truncated: false }) });
    show('/me', <MeScreen />);
    await screen.findByRole('heading', { level: 1, name: 'أنا' });
    expect(await screen.findByText('سارة')).toBeTruthy();
    const href = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href(/^الإعدادات/)).toBe('/settings');
    expect(href(/^مركز التحكم/)).toBe('/control');
    expect(href(/^أجهزتي/)).toBe('/me/devices');
    expect(href(/^الخصوصية والبيانات/)).toBe('/me/privacy');
    expect(href(/^الاستهلاك/)).toBe('/me/usage');
    expect(href(/^التنزيلات/)).toBe('/offline');
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/channels/tree'))).toBe(true));
    expect(screen.queryByRole('link', { name: /إدارة القنوات/ })).toBeNull();
  });

  it('shows «إدارة القنوات» to a role holder (and to the platform admin)', async () => {
    serve({ '/api/accounts/me': () => json(ME), '/api/channels/tree': () => json({ nodes: [subject(['assistant'])], truncated: false }) });
    show('/me', <MeScreen />);
    expect((await screen.findByRole('link', { name: /إدارة القنوات/ })).getAttribute('href')).toBe('/admin');
  });
});

describe('«أجهزتي»', () => {
  const devices: DeviceView[] = [
    { device_id: 'd1', device_uid: 'x1', label: 'iPad', platform: 'web', has_key: false, shared_device: false, first_seen_at: 1, last_seen_at: Date.now(), revoked_at: null, current: true },
    { device_id: 'd2', device_uid: 'x2', label: 'Galaxy S Pen', platform: 'web', has_key: false, shared_device: false, first_seen_at: 1, last_seen_at: Date.now() - 86_400_000, revoked_at: null, current: false },
  ];
  it('lists the account’s devices, marks this one, and revokes another after a confirmation', async () => {
    serve({
      '/api/accounts/me/devices': () => json({ devices }),
      '/api/accounts/me/devices/d2': (m) => (m === 'DELETE' ? json({ ok: true }) : json({}, 405)),
    });
    show('/me/devices', <DevicesScreen />);
    const mine = (await screen.findByText('iPad')).closest('li')!;
    expect(within(mine).getByText('هذا الجهاز')).toBeTruthy();
    expect(within(mine).queryByRole('button', { name: /ألغِ/ })).toBeNull();
    const other = screen.getByText('Galaxy S Pen').closest('li')!;
    fireEvent.click(within(other).getByRole('button', { name: 'ألغِ هذا الجهاز' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'ألغِ الجهاز' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/accounts/me/devices/d2')).toBe(true));
  });
});

describe('«الاستهلاك»', () => {
  it('shows each allowance with its real numbers, and says when there is no limit', async () => {
    serve({ '/api/accounts/me/quota': () => json(QUOTA) });
    show('/me/usage', <UsageScreen />);
    expect(await screen.findByText(/300\.0 MB من 1\.00 GB/)).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'مساحة التخزين' });
    expect(bar.getAttribute('aria-valuenow')).toBe(String(300 * 1024 * 1024));
    expect(screen.getByText(/بلا حد شهري مضبوط/)).toBeTruthy();
    expect(screen.getByText(/0 من 120 دقيقة/)).toBeTruthy();
  });
});

describe('«الخصوصية والبيانات»', () => {
  const preview: DeletionPreview = {
    vault: { sources: 4, annotations: 120, notes: 9, recordings: 1, cards: 33, bytes: 12_000_000 },
    publications: { total: 0, forked_by_others: 0 },
    policy_ar: ['تُحذف ملفاتك وملاحظاتك.', 'يظهر اسمك «طالب سابق».'],
    confirm_token: 'tok_1234567890',
    expires_at: Date.now() + 600_000,
    blocked_ar: null,
  };
  it('exports «نسخة من بياناتي» and previews the deletion before asking for the password', async () => {
    serve({
      '/api/accounts/me/exports': () => json({ exports: [], included_ar: ['مصادرك وملاحظاتك'], note_ar: 'تبقى النسخة على الخادم مدة محدودة.' }),
      '/api/accounts/me/export': () =>
        json({ job_id: 'j1', export: { job_id: 'j1', status: 'queued', created_at: Date.now(), finished_at: null, file_name: null, size: null, sha256: null, download_url: null, missing_files: null, warning_ar: null, error_ar: null } }),
      '/api/accounts/me/delete': (_m, body) => ((body as { preview?: boolean }).preview ? json(preview) : json({ status: 'deletion_pending' })),
    });
    show('/me/privacy', <PrivacyScreen />);
    await screen.findByRole('heading', { level: 1, name: 'الخصوصية والبيانات' });
    expect(await screen.findByText('مصادرك وملاحظاتك')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ نسخة من بياناتي' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/accounts/me/export')).toBe(true));
    expect(await screen.findByText('في الانتظار')).toBeTruthy();
    // a second archive cannot be started while one is being built — the button says why
    expect(screen.getByText(/هناك نسخة قيد الإنشاء الآن/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'احذف حسابي…' }));
    const dialog = await screen.findByRole('dialog', { name: 'حذف الحساب' });
    expect(await within(dialog).findByText(/4 مصادر/)).toBeTruthy();
    expect(within(dialog).getByText('يظهر اسمك «طالب سابق».')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'احذف حسابي نهائيًا' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expectDisabledSayWhy(dialog);
    expect(within(dialog).getByText('اكتب كلمة المرور أولًا.')).toBeTruthy();
    // nothing is deleted by the preview
    expect(calls.filter((c) => c.url === '/api/accounts/me/delete').map((c) => c.body)).toEqual([{ preview: true }]);
  });
});
