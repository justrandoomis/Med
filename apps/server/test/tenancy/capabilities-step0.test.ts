// P1-T1 step 0 — every Phase 1 capability key of ADR-0005 §6 is registered and honest: `not_implemented` (with the
// Arabic reason) until the track that builds it probes it. Nothing about today's keys changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilitiesResponse } from '@medlevo/shared';
import { createTestApp, type TestApp } from '../helpers/app';

// (P1-T2 step 2 built `ui.eink_mode`: it is checked separately below; the others stay not built)
const ADR_0005_KEYS = ['rooms.online', 'nearby.webrtc', 'nearby.lan_hub', 'nearby.native', 'nearby.relay', 'ink.native_surface', 'recording.background'];

let t: TestApp;
let caps: CapabilitiesResponse;
beforeAll(async () => {
  t = await createTestApp();
  const h = await t.login();
  caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as CapabilitiesResponse;
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('capability keys of ADR-0005 §6 (P1-T1 step 0)', () => {
  it('each new key is reported, and only as not built yet, with a reason in Arabic', () => {
    for (const k of ADR_0005_KEYS) {
      const f = (caps.features as Record<string, { key: string; state: string; reason_ar?: string }>)[k];
      expect(f, k).toBeDefined();
      expect(f!.key).toBe(k);
      expect(f!.state, k).toBe('not_implemented');
      expect(f!.reason_ar, k).toMatch(/[؀-ۿ]/);
    }
  });

  it('ui.eink_mode is available once P1-T2 built the e-ink display mode', () => {
    expect(caps.features['ui.eink_mode'].state).toBe('available');
  });

  it('today’s keys keep their states (the registry only grew)', () => {
    expect(caps.features.library.state).toBe('available');
    expect(caps.features['workspace.ink'].state).toBe('available');
    expect(caps.features.sync.state).toBe('available');
  });
});
