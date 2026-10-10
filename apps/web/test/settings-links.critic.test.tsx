// Critic round regression (navigation: every screen reachable where the owner looks for it): «قواعد الشرح» and
// «قاموس المصطلحات» shape every explanation, but Settings → «القراءة والشرح» did not lead to them (only the Control
// Center's AI section and the reader's explain tab did).
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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

afterEach(() => setFetchImpl(null));

describe('Settings → reading & explanation', () => {
  it('links to the explanation rules and the term dictionary', async () => {
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/settings')) return json({ settings: DEFAULT_OWNER_SETTINGS });
      if (url.startsWith('/api/auth/sessions')) return json({ sessions: [] });
      if (url.startsWith('/api/capabilities')) return json(CAPS);
      return json({});
    });
    await settingsStore.load();
    const router = createMemoryRouter([{ id: 'owner', path: '/', loader: () => GATE, children: [{ path: 'settings', element: <SettingsScreen /> }] }], { initialEntries: ['/settings'] });
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'الإعدادات' });
    const rules = screen.getByRole('link', { name: /قواعد الشرح لكل مادة/ });
    const terms = screen.getByRole('link', { name: /قاموس المصطلحات/ });
    expect(rules.getAttribute('href')).toBe('/explanation-rules');
    expect(terms.getAttribute('href')).toBe('/terms');
    // both sit inside the «القراءة والشرح» section
    const section = document.getElementById('reading')!;
    expect(section.contains(rules) && section.contains(terms)).toBe(true);
  });
});
