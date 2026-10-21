// P1-T1 step 3 — per-user browser keys (lib/userStorage.ts; ADR-0003 §3.7, ARCHITECTURE_DELTA §4.5): every key of an
// account carries its `<userId>:` prefix; user #1's claimed legacy namespace (the keys of R1-a) has none and is never
// visible to another account; device keys (display, last account, legacy claim) are shared on purpose; a blocked
// storage never throws. And no source file but the helper touches localStorage / sessionStorage (the lint rule too).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAccountKeys,
  deviceStorage,
  legacyClaimHolder,
  namespacePrefix,
  onStorageAccountChange,
  recordLegacyClaim,
  setStorageAccount,
  storageAccount,
  userSession,
  userStorage,
} from '../../src/lib/userStorage';

const A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setStorageAccount(null);
});
afterEach(() => setStorageAccount(null));

describe('namespaces', () => {
  it('before the sign-in state is known the legacy namespace is used (today’s keys, unprefixed)', () => {
    expect(storageAccount()).toBeNull();
    expect(namespacePrefix()).toBe('');
    userStorage.set('medlevo.library.rootSort', 'title');
    expect(localStorage.getItem('medlevo.library.rootSort')).toBe('title');
  });

  it('an account writes under its prefix and never reads the legacy namespace or another account', () => {
    localStorage.setItem('medlevo.note-draft.k1', 'legacy draft');
    localStorage.setItem(`${A}:medlevo.note-draft.k2`, 'A draft');
    setStorageAccount({ userId: B, legacy: false });
    expect(userStorage.get('medlevo.note-draft.k1')).toBeNull();
    expect(userStorage.get('medlevo.note-draft.k2')).toBeNull();
    userStorage.set('medlevo.note-draft.k3', 'B draft');
    expect(localStorage.getItem(`${B}:medlevo.note-draft.k3`)).toBe('B draft');
    expect(userStorage.keys('medlevo.note-draft.')).toEqual(['medlevo.note-draft.k3']);
    userStorage.set('medlevo.note-draft.k3', null);
    expect(localStorage.getItem(`${B}:medlevo.note-draft.k3`)).toBeNull();
  });

  it('user #1 with the legacy claim keeps the keys of R1-a in place and does not see other accounts', () => {
    localStorage.setItem('medlevo.note-draft.k1', 'legacy draft');
    localStorage.setItem(`${B}:medlevo.note-draft.k3`, 'B draft');
    setStorageAccount({ userId: A, legacy: true });
    expect(userStorage.get('medlevo.note-draft.k1')).toBe('legacy draft');
    expect(userStorage.keys('medlevo.note-draft.')).toEqual(['medlevo.note-draft.k1']);
  });

  it('sessionStorage follows the same rule (selection draft, back stack)', () => {
    setStorageAccount({ userId: A, legacy: false });
    userSession.set('medlevo.workspace.back.v1', '[]');
    expect(sessionStorage.getItem(`${A}:medlevo.workspace.back.v1`)).toBe('[]');
    setStorageAccount({ userId: B, legacy: false });
    expect(userSession.get('medlevo.workspace.back.v1')).toBeNull();
  });

  it('device keys are shared on purpose (display, last account, the legacy claim)', () => {
    setStorageAccount({ userId: B, legacy: false });
    deviceStorage.set('medlevo.display.v1', '{"eink":true}');
    expect(localStorage.getItem('medlevo.display.v1')).toBe('{"eink":true}');
    expect(legacyClaimHolder()).toBeNull();
    recordLegacyClaim(A);
    expect(legacyClaimHolder()).toBe(A);
  });

  it('clearing one account removes only its own keys', () => {
    localStorage.setItem('medlevo.x', 'legacy');
    localStorage.setItem(`${A}:medlevo.x`, 'a');
    localStorage.setItem(`${B}:medlevo.x`, 'b');
    expect(clearAccountKeys(A)).toBe(1);
    expect(Object.keys(localStorage).sort()).toEqual([`${B}:medlevo.x`, 'medlevo.x'].sort());
  });

  it('listeners hear an account change once; a bad id is refused', () => {
    const seen: Array<[string | null, string | null]> = [];
    const off = onStorageAccountChange((a, p) => seen.push([a?.userId ?? null, p?.userId ?? null]));
    setStorageAccount({ userId: A, legacy: true });
    setStorageAccount({ userId: A, legacy: true });
    setStorageAccount({ userId: B, legacy: false });
    off();
    expect(seen).toEqual([
      [A, null],
      [B, A],
    ]);
    expect(() => setStorageAccount({ userId: 'not ok:', legacy: false })).toThrow();
  });

  it('blocked storage never throws (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(userStorage.set('k', 'v')).toBe(false);
    spy.mockRestore();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(userStorage.get('k')).toBeNull();
  });
});

describe('only lib/userStorage.ts touches browser storage (ARCHITECTURE_DELTA §4.5)', () => {
  it('no other source file uses localStorage or sessionStorage', () => {
    const root = join(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith(join('lib', 'userStorage.ts'))) {
          // code only: comments may name the storage
          const code = readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
          if (/\b(localStorage|sessionStorage)\b/.test(code)) offenders.push(p.slice(root.length + 1));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
