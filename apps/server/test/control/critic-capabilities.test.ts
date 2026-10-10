// Critic round regression (§46, §61): «التصدير PDF» was registered as plainly `available` although no PDF exporter
// exists — PDF is the HTML export printed by the browser, without the owner's ink. The capability now carries
// that limit so the Control Center can say it (it shows `reason_ar` of available features as «الحدود»).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilitiesResponse } from '@medlevo/shared';
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

describe('capabilities state their limits', () => {
  it('export.pdf is available only through browser printing, and says the ink is not printed', async () => {
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as CapabilitiesResponse;
    const pdf = caps.features['export.pdf'];
    expect(pdf.state).toBe('available');
    expect(pdf.reason_ar).toContain('المتصفح');
    expect(pdf.reason_ar).toContain('لا يوجد مُصدِّر PDF على الخادم');
    expect(pdf.reason_ar).toContain('الكتابة بالقلم');
    // the other limited-but-working features keep their stated limits
    expect(caps.features['workspace.audio'].reason_ar).toContain('التفريغ الآلي');
  });

  it('the Control Center says what leaves the server, to which provider, for which tasks (§49)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/control/intelligence', headers: h });
    expect(res.statusCode).toBe(200);
    const notes = (res.json() as { notes_ar: string[] }).notes_ar.join(' ');
    expect(notes).toContain('ما يغادر الخادم');
    expect(notes).toContain('Anthropic');
    expect(notes).toContain('داخل النطاق المحدد فقط');
    expect(notes).toContain('لا يُرسل الملف الأصلي');
    expect(notes).toContain('لا يوجد تشفير من طرف إلى طرف');
  });
});
