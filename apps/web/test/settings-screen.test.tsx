import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { DEFAULT_OWNER_SETTINGS, FEATURE_KEYS, type CapabilitiesResponse, type FeatureKey, type FeatureStatus } from '@medlevo/shared';
import { ToastProvider } from '../src/design';
import { SettingsScreen } from '../src/features/settings/SettingsScreen';
import { setFetchImpl } from '../src/lib/api';
import { settingsStore } from '../src/lib/settings';
import type { OwnerGateData } from '../src/app/routeTypes';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CAPS: CapabilitiesResponse = {
  features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'not_implemented' } as FeatureStatus])) as Record<FeatureKey, FeatureStatus>,
  ai: { configured: false },
  server_time: 0,
  app_version: 'test',
};

const GATE: OwnerGateData = { mode: 'online', username: 'owner', remainingRecoveryCodes: 10, sessionId: 's1', passwordMinLength: 12 };

function mountSettings() {
  const router = createMemoryRouter(
    [{ id: 'owner', path: '/', loader: () => GATE, children: [{ path: 'settings', element: <SettingsScreen /> }] }],
    { initialEntries: ['/settings'] },
  );
  return render(
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>,
  );
}

afterEach(() => setFetchImpl(null));

describe('Settings screen', () => {
  it('renders with an unknown timezone from the server (falls back to Asia/Baghdad for display) and autosaves the custom instruction without blur', async () => {
    // Regressions: (1) the server only checks that timezone is a string; an unknown zone threw a
    // RangeError from Intl and crashed the screen. (2) the custom instruction was saved only on blur
    // although the header promises automatic saving.
    const patches: Array<Record<string, unknown>> = [];
    let server = { ...DEFAULT_OWNER_SETTINGS, timezone: 'Mars/Olympus' };
    setFetchImpl(async (url, init) => {
      if (url.startsWith('/api/settings')) {
        if (init.method === 'PATCH') {
          const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
          patches.push(patch);
          server = { ...server, ...patch };
        }
        return json({ settings: server });
      }
      if (url.startsWith('/api/auth/sessions')) return json({ sessions: [] });
      if (url.startsWith('/api/capabilities')) return json(CAPS);
      return json({});
    });
    await settingsStore.load();
    expect(settingsStore.get().settings.timezone).toBe('Mars/Olympus');

    mountSettings();
    await screen.findByRole('heading', { level: 1, name: 'الإعدادات' });
    expect(screen.getByText(/الوقت الآن في هذه المنطقة/)).toBeTruthy();
    expect((screen.getByLabelText('المنطقة الزمنية') as HTMLSelectElement).value).toBe('Asia/Baghdad');

    const area = screen.getByLabelText('تعليمات خاصة للشرح');
    fireEvent.change(area, { target: { value: 'اذكر المصطلح الإنجليزي دائمًا' } });
    await waitFor(() => expect(patches).toContainEqual({ custom_instruction: 'اذكر المصطلح الإنجليزي دائمًا' }), { timeout: 3000 });
  });
});
