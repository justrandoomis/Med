// Critic round regression (honest statuses, §44): the Weakness Center said «الحالات السريرية وOSCE لا تُجمع بعد: لا
// توجد بيانات محاولات لها في هذا الإصدار» although clinical cases, OSCE stations and viva ARE built and their attempts
// are stored with a report. The true limit is narrower: this center does not read them yet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WeaknessListResponse } from '@medlevo/shared';
import { type AuthHeaders, createTestApp, type TestApp } from '../helpers/app';

let t: TestApp;
let h: AuthHeaders;
beforeAll(async () => {
  t = await createTestApp();
  ({ headers: h } = await t.setupOwner());
});
afterAll(async () => {
  await t.close();
});

describe('weakness center sources note', () => {
  it('says cases/OSCE are not read here yet — never that no attempt data exists', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/learning/weakness', headers: h });
    expect(res.statusCode).toBe(200);
    const note = (res.json() as WeaknessListResponse).sources_note_ar.join(' ');
    expect(note).toMatch(/OSCE/);
    expect(note).not.toContain('لا توجد بيانات محاولات');
    expect(note).toContain('لا يقرؤها في هذا الإصدار');
    expect(note).toContain('تقرير كل محاولة');
  });
});
