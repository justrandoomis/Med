// PL-0: the Control Center off-site backup row — honest «not configured» state with the action disabled and its
// reason, the last copy's time / size / result, «نسخ احتياطي الآن», the copies held in R2 with their one-line
// Render-Shell restore command, and the index row reading the same status.
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { OffsiteScreen } from './OffsiteScreen';
import { offsiteSummaryAr, type OffsiteRunView, type OffsiteStatusResponse } from './offsite';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => setFetchImpl(null));

const T0 = Date.UTC(2026, 9, 20, 0, 15);
const runView = (o: Partial<OffsiteRunView> = {}): OffsiteRunView => ({
  id: 'r1',
  trigger: 'schedule',
  status: 'uploaded',
  status_label_ar: 'رُفعت مشفّرة بعد التحقق منها',
  stage: 'done',
  stage_label_ar: 'اكتملت',
  created_at: T0,
  finished_at: T0 + 60_000,
  size: 5 * 1024 * 1024,
  archive_size: 5 * 1024 * 1024 - 300,
  object_key: 'medlevo/backups/medlevo-backup-20261020-001500Z-abcd1234.tar.gz.mlenc',
  parts: 1,
  parts_resumed: 0,
  verify_status: 'passed',
  retention: { kept: 1, deleted: 0, deleted_local: 0, errors_ar: [] },
  warnings_ar: [],
  error_ar: null,
  job: null,
  ...o,
});
const base = (o: Partial<OffsiteStatusResponse> = {}): OffsiteStatusResponse => ({
  configured: true,
  problems_ar: [],
  target: { bucket: 'medlevo-backups', endpoint_host: 'acct.r2.cloudflarestorage.com', prefix: 'medlevo/' },
  encryption: { key_id: '0123456789abcdef0123456789abcdef' },
  schedule: { time: '03:15', timezone: 'Asia/Baghdad', next_run_at: T0 + 86_400_000 },
  retention: { keep_daily: 7, keep_weekly: 4, keep_local: 1 },
  running: null,
  last: runView(),
  last_success: runView(),
  recent: [runView()],
  restore_command: 'medlevo-restore-offsite --latest',
  notes_ar: ['ملاحظة'],
  ...o,
});

const wrap = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <OffsiteScreen />
      </ToastProvider>
    </MemoryRouter>,
  );

describe('off-site backup screen', () => {
  it('not configured: says so, lists what is missing, and the action is disabled with its reason', async () => {
    setFetchImpl(async () =>
      json(base({ configured: false, problems_ar: ['إعداد النسخ خارج الخادم ناقص: MEDLEVO_R2_BUCKET غير مضبوط.'], target: null, encryption: null, last: null, last_success: null, recent: [] })),
    );
    wrap();
    expect(await screen.findByText(/غير مُعدّ: لا نسخة خارج الخادم/)).toBeTruthy();
    expect(screen.getByText(/MEDLEVO_R2_BUCKET/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: 'نسخ احتياطي الآن' });
    expect(btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(btn.getAttribute('aria-describedby')).toBe('cc-offsite-why');
    expect(document.getElementById('cc-offsite-why')?.textContent).toContain('غير مُعدّ');
  });

  it('configured: shows the last copy with its size, starts a run, and lists the R2 copies with their restore commands', async () => {
    const calls: string[] = [];
    setFetchImpl(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/data/offsite/run')) return json({ run: runView({ id: 'r2', status: 'running', stage: 'backup', stage_label_ar: 'إنشاء نسخة على الخادم' }) });
      if (url.endsWith('/api/data/offsite/remote'))
        return json({ objects: [{ key: 'k', file_name: 'medlevo-backup-20261020-001500Z-abcd1234.tar.gz', size: 1234, created_at: T0, last_modified: T0, restore_command: 'medlevo-restore-offsite --key medlevo-backup-20261020-001500Z-abcd1234.tar.gz' }] });
      return json(base());
    });
    wrap();
    expect(await screen.findByText(/آخر نسخة مشفّرة في R2/)).toBeTruthy();
    expect(screen.getAllByText('5.0 MB').length).toBeGreaterThan(0);
    expect(screen.getByText('medlevo-restore-offsite --latest')).toBeTruthy();
    // (PL-0 review) the switch is a variable the owner ADDS in Render → Environment (render.yaml must not pin it)
    expect(document.body.textContent).toMatch(/أضف المتغير\s*MEDLEVO_DATA_DIR/);
    // (PL-0 review) the Render navigation path keeps its order in RTL: every English step is its own isolated run
    // (an un-isolated «MedLevo ← Shell» is laid out as one LTR run and its arrow then points the wrong way)
    const steps = screen.getByRole('heading', { name: 'الاستعادة من هاتفك' }).closest('section')!;
    const isolated = [...steps.querySelectorAll('bdi')].map((b) => b.textContent);
    for (const term of ['Render', 'MedLevo', 'Shell', 'Environment', 'MEDLEVO_DATA_DIR']) expect(isolated).toContain(term);
    for (const li of steps.querySelectorAll('li')) {
      const bare = [...li.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('');
      expect(bare).not.toMatch(/[A-Za-z]\s*←\s*[A-Za-z]/);
    }
    fireEvent.click(screen.getByRole('button', { name: 'نسخ احتياطي الآن' }));
    await waitFor(() => expect(calls).toContain('POST /api/data/offsite/run'));
    fireEvent.click(screen.getByRole('button', { name: 'اعرض النسخ المحفوظة في R2' }));
    expect(await screen.findByText('medlevo-restore-offsite --key medlevo-backup-20261020-001500Z-abcd1234.tar.gz')).toBeTruthy();
    // restore is never a button on this screen
    expect(screen.queryByRole('button', { name: /^(استعد|استعادة)/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^انسخ/ }).length).toBeGreaterThan(1);
  });
});

describe('offsiteSummaryAr', () => {
  const fmt = (ms: number) => new Date(ms).toISOString();
  it('says when the latest attempt failed after the last success, and when nothing succeeded yet', () => {
    const failed = runView({ id: 'f', status: 'failed', status_label_ar: 'فشلت', created_at: T0 + 1000, error_ar: 'رفض' });
    expect(offsiteSummaryAr(base({ last: failed }), fmt)).toContain('فشلت آخر محاولة');
    expect(offsiteSummaryAr(base({ last: failed, last_success: null }), fmt)).toContain('لا توجد نسخة ناجحة بعد');
    expect(offsiteSummaryAr(base({ running: runView({ status: 'running', stage_label_ar: 'تشفيرها ورفعها إلى Cloudflare R2' }) }), fmt)).toContain('جارٍ الآن');
    expect(offsiteSummaryAr(base({ last: null, last_success: null }), fmt)).toContain('03:15');
  });
});
