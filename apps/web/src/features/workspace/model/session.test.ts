import { describe, expect, it } from 'vitest';
import type { StudySessionDTO } from '@medlevo/shared';
import { decideStart, locationsDiffer, newerElsewhere, type LocalSession } from './session';

const ME = 'DEVICE_ME';
const OTHER = 'DEVICE_IPAD';
const base = { url: {}, deviceId: ME, versionIds: ['V1', 'V2'], activeVersionId: 'V1' } as const;

const local = (p: Partial<LocalSession> = {}): LocalSession => ({ id: 'SESS1', sourceId: 'S1', versionId: 'V1', location: { page_index: 4, zoom: 1.5, page_offset: 0.3 }, rev: 2, updatedAt: 1000, ...p });
const server = (p: Partial<StudySessionDTO> = {}): StudySessionDTO => ({
  id: 'SESS1', source_id: 'S1', version_id: 'V1', mode: 'learn', view: 'original', location: { page_index: 9, zoom: 2 }, scope: null, device_id: OTHER, rev: 3, created_at: 1, updated_at: 2000, ...p,
});

describe('session restore precedence (§46)', () => {
  it('opens an explicit URL place as asked, continuing the same session', () => {
    const d = decideStart({ ...base, url: { pageIndex: 2 }, local: local(), server: server() });
    expect(d).toMatchObject({ from: 'url', sessionId: 'SESS1', versionId: 'V1', conflict: null });
    expect(d.location.page_index).toBe(2);
    expect(d.location.page_offset).toBe(0);
    // a URL version switch is honoured; a version that does not exist is ignored
    expect(decideStart({ ...base, url: { versionId: 'V2' }, local: local(), server: null })).toMatchObject({ from: 'url', versionId: 'V2', location: { page_index: 0 } });
    expect(decideStart({ ...base, url: { versionId: 'NOPE' }, local: local(), server: null }).from).toBe('local');
  });

  it('prefers this device’s own position (offline-safe)', () => {
    const d = decideStart({ ...base, local: local(), server: null });
    expect(d).toMatchObject({ from: 'local', sessionId: 'SESS1', rev: 2, keepZoom: true, conflict: null });
    expect(d.location.page_index).toBe(4);
  });

  it('asks — never applies silently — when another device saved a newer, different position', () => {
    const d = decideStart({ ...base, local: local(), server: server() });
    expect(d.from).toBe('local');
    expect(d.location.page_index).toBe(4); // still where this device was
    expect(d.conflict?.location.page_index).toBe(9);
  });

  it('does not ask when the newer copy is at the same place, or is not newer', () => {
    expect(decideStart({ ...base, local: local(), server: server({ location: { page_index: 4, zoom: 3 } }) }).conflict).toBeNull();
    expect(decideStart({ ...base, local: local({ rev: 5 }), server: server({ rev: 3 }) }).conflict).toBeNull();
    // a different session row: compared by time
    expect(decideStart({ ...base, local: local({ id: 'A', updatedAt: 5000 }), server: server({ id: 'B', updated_at: 2000 }) }).conflict).toBeNull();
    expect(decideStart({ ...base, local: local({ id: 'A', updatedAt: 1000 }), server: server({ id: 'B', updated_at: 2000 }) }).conflict?.id).toBe('B');
  });

  it('takes a newer copy written by this same device (another tab) without asking', () => {
    const d = decideStart({ ...base, local: local(), server: server({ device_id: ME }) });
    expect(d).toMatchObject({ from: 'server', rev: 3, conflict: null });
    expect(d.location.page_index).toBe(9);
  });

  it('adopts the server position when there is nothing local; keeps zoom only from the same device', () => {
    const d = decideStart({ ...base, local: null, server: server() });
    expect(d).toMatchObject({ from: 'server', sessionId: 'SESS1', rev: 3, keepZoom: false, conflict: null });
    expect(decideStart({ ...base, local: null, server: server({ device_id: ME }) }).keepZoom).toBe(true);
  });

  it('starts at the first page of the active version otherwise; ignores sessions of deleted versions', () => {
    expect(decideStart({ ...base, local: null, server: null })).toMatchObject({ from: 'default', sessionId: null, versionId: 'V1', location: { page_index: 0 } });
    expect(decideStart({ ...base, local: local({ versionId: 'GONE' }), server: null }).from).toBe('default');
  });

  it('helpers: page/version difference and "newer elsewhere"', () => {
    expect(locationsDiffer({ versionId: 'V1', location: { page_index: 1, zoom: 1 } }, { versionId: 'V1', location: { page_index: 1, zoom: 3 } })).toBe(false);
    expect(locationsDiffer({ versionId: 'V1', location: { page_index: 1 } }, { versionId: 'V2', location: { page_index: 1 } })).toBe(true);
    expect(newerElsewhere(server({ device_id: ME }), local(), ME)).toBe(false);
    expect(newerElsewhere(server({ rev: 2 }), local({ rev: 2 }), ME)).toBe(false);
  });
});
