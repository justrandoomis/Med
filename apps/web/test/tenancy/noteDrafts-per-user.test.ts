// P1-T1 step 3 — crash-recovery note drafts belong to their writer (ARCHITECTURE_DELTA §4.5; ADR-0003 §3.7): a draft
// is written in the signed-in account's namespace and tagged with its id; recovery (on every signed-in mount) saves only
// the account's own drafts into the account's own database; an untagged draft of R1-a is recovered only by user #1
// (the legacy namespace); a draft is never saved — nor pushed — under another account.
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RichText } from '@medlevo/shared';
import { getDb, MedLevoDB, resetSharedDb } from '../../src/lib/localdb';
import { NOTE_DRAFT_PREFIX, readNoteDrafts, recoverNoteDrafts, writeNoteDraft } from '../../src/features/workspace/data/noteDrafts';
import { setStorageAccount } from '../../src/lib/userStorage';

const OWNER = '01JOWNERAAAAAAAAAAAAAAAAAA';
const A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const body = (t: string): RichText => ({ v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t }] }] });
const draft = (key: string, noteId: string, text: string) => ({ key, noteId, body: body(text), anchor: null, baseText: null });

beforeEach(async () => {
  localStorage.clear();
  setStorageAccount(null);
  resetSharedDb();
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
});
afterEach(() => setStorageAccount(null));

describe('drafts per account', () => {
  it('a draft is written under the writer’s prefix and tagged with its id', () => {
    setStorageAccount({ userId: A, legacy: false });
    writeNoteDraft(draft('k1', 'N1', 'نص غير محفوظ'));
    const raw = localStorage.getItem(`${A}:${NOTE_DRAFT_PREFIX}k1`);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ uid: A, noteId: 'N1' });
    expect(localStorage.getItem(`${NOTE_DRAFT_PREFIX}k1`)).toBeNull();
  });

  it('after another account signs in on the same browser, A’s draft is neither read nor saved under B', async () => {
    setStorageAccount({ userId: A, legacy: false });
    writeNoteDraft(draft('k1', 'N1', 'مسودة الحساب أ'));
    setStorageAccount({ userId: B, legacy: false });
    expect(readNoteDrafts()).toEqual([]);
    expect(await recoverNoteDrafts(getDb())).toBe(0);
    expect(await getDb().notes.count()).toBe(0);
    expect(await getDb().outbox.count()).toBe(0);
    // A signs in again: the draft becomes A's note in A's database
    setStorageAccount({ userId: A, legacy: false });
    expect(await recoverNoteDrafts(getDb())).toBe(1);
    expect(getDb().name).toBe(`medlevo:${A}`);
    expect((await getDb().notes.get('N1'))?.body).toEqual(body('مسودة الحساب أ'));
  });

  it('an untagged R1-a draft is recovered by user #1 (legacy namespace) only — never by another account', async () => {
    localStorage.setItem(`${NOTE_DRAFT_PREFIX}old`, JSON.stringify({ v: 1, key: 'old', noteId: 'OLD', body: body('مسودة قبل الحسابات'), anchor: null, baseText: null, savedAt: 1 }));
    setStorageAccount({ userId: B, legacy: false });
    expect(readNoteDrafts()).toEqual([]);
    expect(await recoverNoteDrafts(getDb())).toBe(0);
    setStorageAccount({ userId: OWNER, legacy: true });
    expect(readNoteDrafts().map((d) => d.noteId)).toEqual(['OLD']);
    expect(await recoverNoteDrafts(getDb())).toBe(1);
    expect(getDb().name).toBe('medlevo');
    expect((await new MedLevoDB('medlevo').notes.get('OLD'))?.body).toEqual(body('مسودة قبل الحسابات'));
  });

  it('a draft tagged with another account found in this namespace is left alone (defence in depth)', () => {
    setStorageAccount({ userId: B, legacy: false });
    localStorage.setItem(`${B}:${NOTE_DRAFT_PREFIX}x`, JSON.stringify({ v: 1, key: 'x', noteId: 'X', body: body('ليست لي'), anchor: null, baseText: null, savedAt: 1, uid: A }));
    expect(readNoteDrafts()).toEqual([]);
  });
});
