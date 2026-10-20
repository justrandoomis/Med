// Critic round regression (§46, §61): «التصدير PDF» was registered as plainly `available` although no PDF exporter
// existed — PDF was the HTML export printed by the browser, without the owner's ink. The capability carries its limits
// so the Control Center can say them (it shows `reason_ar` of available features as «الحدود»). Round 7 H4 built the
// server exporter; the stated limits changed with it (flattened copy, not editable ink; Word → PDF needs LibreOffice).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CapabilitiesResponse } from '@medlevo/shared';
import { detectTools } from '../../src/modules/processing/tools';
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
  it('export.pdf states what the server PDF is (flattened, not editable ink) and what needs LibreOffice', async () => {
    // (Round 7 H4) a server PDF exporter now exists (test/data/h4-pdf-export.test.ts): the capability no longer says
    // «no server exporter»; it says the annotated PDF is a FLATTENED copy that keeps the appearance — not editable ink —
    // and whether Word → PDF works on this server (LibreOffice).
    const caps = (await t.app.inject({ method: 'GET', url: '/api/capabilities', headers: h })).json() as CapabilitiesResponse;
    const pdf = caps.features['export.pdf'];
    expect(pdf.state).toBe('available');
    expect(pdf.reason_ar).toContain('مسطحة تحفظ المظهر');
    expect(pdf.reason_ar).toMatch(/لا حبر قابل للتحرير|يعمل/);
    expect(pdf.reason_ar).toContain(detectTools().soffice ? 'محوَّلة من Word' : 'يحتاج LibreOffice');
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
