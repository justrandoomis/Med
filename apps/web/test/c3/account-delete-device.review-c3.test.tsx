// Adversarial review of track C3, R6 (AOS-4.7 «sign-out clearing missing a store»): deleting the account signed this
// device out but left the account's whole local copy behind — its IndexedDB `medlevo:<id>` (notes, ink, cached
// lectures) and its keys — in a browser that may be shared, for an account that no longer exists (nobody can sign in
// to clear it any more). The deletion policy says «تُحذف خزنتك كلها»; this device's copy now goes with it, and nothing
// of another account on the same browser is touched.
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { DeletionPreview } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { MedLevoDB, resetSharedDb } from '../../src/lib/localdb';
import { setStorageAccount } from '../../src/lib/userStorage';
import { afterClear } from '../../src/lib/signOut';
import { PrivacyScreen } from '../../src/features/me/PrivacyScreen';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const preview: DeletionPreview = {
  vault: { sources: 1, annotations: 2, notes: 1, recordings: 0, cards: 0, bytes: 1000 },
  publications: { total: 0, forked_by_others: 0 },
  policy_ar: ['تُحذف خزنتك كلها.'],
  confirm_token: 'tok_1234567890',
  expires_at: Date.now() + 600_000,
  blocked_ar: null,
};

async function seed(name: string): Promise<void> {
  const db = new MedLevoDB(name);
  await db.open();
  await db.kv.put({ key: 'probe', value: 1, updatedAt: 1 });
  db.close();
}

let went: string[] = [];
beforeEach(async () => {
  went = [];
  afterClear.go = (p: string) => void went.push(p);
  localStorage.clear();
  resetSharedDb();
  for (const n of ['medlevo:u1', 'medlevo:u2']) await Dexie.delete(n);
  setStorageAccount({ userId: 'u1', legacy: false });
});
afterEach(() => {
  setFetchImpl(null);
  resetSharedDb();
  setStorageAccount(null);
});

describe('«بياناتك على هذا الجهاز» says what the app does, not more (C3 review R8)', () => {
  it('the local copy is kept from other accounts BY THE APP, and is not encrypted on the device', async () => {
    setFetchImpl(async () => json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404));
    const router = createMemoryRouter([{ path: '/me/privacy', element: <PrivacyScreen /> }], { initialEntries: ['/me/privacy'] });
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    const section = (await screen.findByRole('heading', { name: 'بياناتك على هذا الجهاز' })).closest('section')!;
    expect(section.textContent).toContain('لا يعرضها التطبيق لحساب آخر');
    expect(section.textContent).toContain('غير مشفّرة على الجهاز');
    expect(section.textContent).not.toContain('لا يراها حساب آخر');
  });
});

describe('«حذف الحساب» on this device', () => {
  it('after the server deleted the account, this account’s local data on this device is gone too; another account’s stays', async () => {
    await seed('medlevo:u1');
    await seed('medlevo:u2');
    localStorage.setItem('u1:medlevo.capabilities.v1', '{}');
    localStorage.setItem('u2:medlevo.capabilities.v1', '{}');
    setFetchImpl(async (url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { preview?: boolean }) : {};
      if (url.startsWith('/api/accounts/me/delete')) return body.preview ? json(preview) : json({ status: 'deletion_pending' });
      if (url.startsWith('/api/accounts/me/exports')) return json({ exports: [], included_ar: [], note_ar: '' });
      return json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
    });
    const router = createMemoryRouter(
      [
        { path: '/me/privacy', element: <PrivacyScreen /> },
        { path: '/login', element: <h1>تسجيل الدخول</h1> },
      ],
      { initialEntries: ['/me/privacy'] },
    );
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'احذف حسابي…' }));
    const dialog = await screen.findByRole('dialog', { name: 'حذف الحساب' });
    expect(await within(dialog).findByText(/نسخة حسابك المحفوظة على هذا الجهاز/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('كلمة المرور للتأكيد'), { target: { value: 'secret pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'احذف حسابي نهائيًا' }));
    await waitFor(() => expect(went).toEqual(['/login']));
    expect(await Dexie.exists('medlevo:u1')).toBe(false);
    expect(localStorage.getItem('u1:medlevo.capabilities.v1')).toBeNull();
    expect(await Dexie.exists('medlevo:u2')).toBe(true);
    expect(localStorage.getItem('u2:medlevo.capabilities.v1')).toBe('{}');
  });
});
