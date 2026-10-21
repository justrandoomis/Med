// P1-T1 step 0 — the ADR-0005 §6 capability keys are registered (server: `not_implemented`), but no control or row of a
// later phase is shown (BUILD_PLAN §2 item 5): the Control Center's «القدرات» screen lists exactly today's rows.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FEATURE_KEYS, type CapabilitiesResponse, type FeatureKey, type FeatureStatus } from '@medlevo/shared';

const NEW_KEYS = ['rooms.online', 'nearby.webrtc', 'nearby.lan_hub', 'nearby.native', 'nearby.relay', 'ink.native_surface', 'recording.background', 'ui.eink_mode'];

vi.mock('../../src/features/control/api', () => ({
  controlApi: {
    capabilities: async (): Promise<CapabilitiesResponse> => ({
      features: Object.fromEntries(
        FEATURE_KEYS.map((k) => [k, { key: k, state: 'not_implemented', reason_ar: 'لم تُبنَ هذه الميزة بعد في هذا الإصدار.' } as FeatureStatus]),
      ) as Record<FeatureKey, FeatureStatus>,
      ai: { configured: false },
      server_time: 0,
      app_version: 'test',
    }),
  },
}));

describe('Control Center «القدرات» after the step-0 keys', () => {
  it('lists every Round 7 feature and none of the Academic OS keys', async () => {
    const { CapabilitiesScreen } = await import('../../src/features/control/CapabilitiesScreen');
    const { container } = render(
      <MemoryRouter>
        <CapabilitiesScreen />
      </MemoryRouter>,
    );
    await screen.findByText('المكتبة');
    const rows = container.querySelectorAll('.cc-caps .cc-cap');
    expect(rows).toHaveLength(FEATURE_KEYS.length - NEW_KEYS.length);
    for (const label of ['غرف الدراسة عبر الإنترنت', 'وضع شاشات الحبر الإلكتروني', 'سطح الكتابة الأصلي للقلم', 'التسجيل في الخلفية']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    for (const k of NEW_KEYS) expect(container.textContent).not.toContain(k);
  });
});
