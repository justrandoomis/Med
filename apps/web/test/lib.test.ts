import { describe, expect, it } from 'vitest';
import type { CapabilitiesResponse, FeatureKey, FeatureStatus } from '@medlevo/shared';
import { FEATURE_KEYS } from '@medlevo/shared';
import { resolveFeature } from '../src/lib/capabilities';
import { dayKey, formatDateTime, formatRelative, isValidTimeZone } from '../src/lib/time';
import { describeDevice } from '../src/lib/deviceId';
import { safeNext } from '../src/app/guards';
import { aggregateState, backoffDelay, describeSyncSnapshot, entityStateFromOps, type SyncSnapshot } from '../src/lib/sync';

function caps(over: Partial<Record<FeatureKey, Partial<FeatureStatus>>> = {}): CapabilitiesResponse {
  const features = Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, { key: k, state: 'available', ...(over[k] ?? {}) } as FeatureStatus]),
  ) as Record<FeatureKey, FeatureStatus>;
  return { features, ai: { configured: false }, server_time: 0, app_version: 'test' };
}

describe('capabilities', () => {
  it('passes the server reason through for unavailable features', () => {
    const data = caps({ 'ai.explain': { state: 'requires_configuration', reason_ar: 'لم يُضبط مفتاح AI على الخادم.' } });
    expect(resolveFeature(data, 'ai.explain', true)).toEqual({ available: false, state: 'requires_configuration', reason: 'لم يُضبط مفتاح AI على الخادم.' });
  });
  it('marks network-bound features as requiring a connection while offline', () => {
    const data = caps();
    expect(resolveFeature(data, 'upload', false).state).toBe('requires_connection');
    expect(resolveFeature(data, 'workspace.ink', false).available).toBe(true);
  });
  it('is unavailable (with a reason) while unknown', () => {
    const r = resolveFeature(null, 'library', true);
    expect(r.available).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe('time (owner timezone)', () => {
  it('formats in Asia/Baghdad with Latin digits', () => {
    const ms = Date.UTC(2026, 9, 9, 21, 30); // 00:30 next day in Baghdad (UTC+3)
    expect(dayKey(ms, 'Asia/Baghdad')).toBe('2026-10-10');
    expect(dayKey(ms, 'UTC')).toBe('2026-10-09');
    expect(formatDateTime(ms, 'Asia/Baghdad')).toMatch(/10/);
    expect(formatDateTime(ms, 'Asia/Baghdad')).not.toMatch(/[٠-٩]/);
  });
  it('relative dates follow calendar days in the owner zone', () => {
    const now = Date.UTC(2026, 9, 10, 9, 0);
    expect(formatRelative(now - 10_000, now)).toBe('الآن');
    expect(formatRelative(now - 26 * 3600_000, now, 'Asia/Baghdad')).toMatch(/أمس/);
  });
  it('validates zones', () => {
    expect(isValidTimeZone('Asia/Baghdad')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('misc helpers', () => {
  it('describes devices in Arabic', () => {
    expect(describeDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Version/17.0 Mobile Safari/604.1', 5)).toBe('Safari على iPad');
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 5)).toBe('Safari على iPad');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', 0)).toBe('Chrome على Windows');
  });
  it('only allows same-app post-login redirects', () => {
    expect(safeNext('/library?x=1')).toBe('/library?x=1');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/login')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
  it('backoff grows exponentially with jitter and a cap', () => {
    expect(backoffDelay(1, 1000, 60_000, () => 0.5)).toBe(1000);
    expect(backoffDelay(4, 1000, 60_000, () => 0.5)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(2, 1000, 60_000, () => 0)).toBe(1600);
  });
  it('entity state is null when no local ops exist', () => {
    expect(entityStateFromOps([], true)).toBeNull();
  });
});

describe('global save state', () => {
  const snap = (p: Partial<SyncSnapshot>): SyncSnapshot => {
    const base: SyncSnapshot = { online: true, running: true, phase: 'idle', pending: 0, conflicts: 0, errors: 0, lastSyncedAt: null, lastError: null, nextRetryAt: null, authRequired: false, pullFailed: false, state: 'synced' };
    const s = { ...base, ...p };
    return { ...s, state: aggregateState(s) };
  };
  it('never says «تمت المزامنة» while the server has signed this device out', () => {
    // Regression: authRequired with nothing pending aggregated to 'synced'.
    expect(snap({ authRequired: true }).state).toBe('error');
    expect(describeSyncSnapshot(snap({ authRequired: true }))).toMatch(/تسجّل الدخول/);
    expect(snap({ authRequired: true, pending: 2 }).state).toBe('saved_locally');
    expect(snap({}).state).toBe('synced');
  });
});
