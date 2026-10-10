// Download Manager / backups / export screens against a mocked server, and the PWA update prompt + setup token.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BackupsListResponse, ExportFormatsResponse, OfflineManifestResponse } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { getDb } from '../../lib/localdb';
import type { OfflineDownload } from '../../lib/offline';
import { BackupsPanel } from './BackupsPanel';
import { DownloadsPanel } from './DownloadsPanel';
import { ExportPanel } from './ExportPanel';
import { UpdateBanner } from './UpdateBanner';


const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const mount = (node: React.ReactNode, path = '/offline') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>{node}</ToastProvider>
    </MemoryRouter>,
  );

afterEach(async () => {
  setFetchImpl(null);
  vi.unstubAllGlobals();
  const db = getDb();
  await Promise.all([db.offlineSources.clear(), db.blobs.clear(), db.apiCache.clear(), db.outbox.clear(), db.notes.clear()]);
});

const record: OfflineDownload = {
  sourceId: 'S1',
  versionId: 'V1',
  versionNo: 1,
  title: 'Acute Appendicitis',
  sourceType: 'lecture',
  format: 'pdf',
  sizeBytes: 2 * 1024 * 1024,
  pageCount: 4,
  downloadedAt: Date.UTC(2026, 9, 9, 10),
  parts: ['pdf', 'pages'],
  contentHash: 'H1',
  includeSolutions: true,
  fileIds: ['F1'],
  apiKeys: ['offline:/api/sources/S1'],
  fileBytes: 2 * 1024 * 1024 - 100,
  dataBytes: 100,
  solutionBytes: 0,
  contents: { pages: 4, page_images: 0, has_display_pdf: true, annotations: 2, notes: 1, note_pages: 0, study_book: { artifact_id: 'A1', version_no: 1, status: 'published', blocks: 9, is_frozen: false }, questions: { linked: 3, with_solutions: 3 }, flashcards: 2, review_events: 3 },
  notIncluded: [],
};

const manifest: OfflineManifestResponse = {
  format: 'medlevo-offline-1',
  source: { id: 'S2', title: 'Cholecystitis', source_type: 'lecture', format: 'pdf' },
  version: { id: 'V2', version_no: 1, is_active: true, page_count: 2, processing_status: 'ready' },
  include_solutions: true,
  generated_at: 1,
  content_hash: 'H2',
  entries: [
    { kind: 'file', role: 'display_pdf', file_id: 'F2', url: '/api/files/F2', mime: 'application/pdf', size: 1000, sha256: 'x', page_id: null, page_index: null },
    { kind: 'data', role: 'question_detail', path: '/api/questions/Q1', size: 500, contains_solutions: true, sha256: 'y' },
  ],
  totals: { bytes: 1500, file_bytes: 1000, data_bytes: 500, files: 1, data: 1, solution_bytes: 500 },
  contents: { pages: 2, page_images: 0, has_display_pdf: true, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 1, with_solutions: 1 }, flashcards: 0, review_events: 0 },
  not_included_ar: ['الشرح والأسئلة والملخصات الجديدة بالذكاء الاصطناعي تحتاج اتصالًا (لا تعمل دون اتصال ولا تُعرض أي «معالجة» وهمية).'],
};

describe('DownloadsPanel', () => {
  let urls: string[];
  beforeEach(async () => {
    urls = [];
    await getDb().offlineSources.put(record);
    setFetchImpl(async (url) => {
      urls.push(url);
      if (url.startsWith('/api/library/tree'))
        return json({ nodes: [], sources: [{ id: 'S1', title: 'Acute Appendicitis', source_type: 'lecture', active_version_id: 'V1', format: 'pdf', page_count: 4, processing_status: 'ready', deleted_at: null, last_opened_at: 2 }, { id: 'S2', title: 'Cholecystitis', source_type: 'lecture', active_version_id: 'V2', format: 'pdf', page_count: 2, processing_status: 'ready', deleted_at: null, last_opened_at: 1 }] });
      if (url.startsWith('/api/data/offline/S2/manifest')) return json({ ...manifest, include_solutions: url.includes('include_solutions=1'), contents: { ...manifest.contents, questions: { linked: 1, with_solutions: url.includes('include_solutions=1') ? 1 : 0 } } });
      return json({}, 404);
    });
  });

  it('lists what is on the device with real sizes, says a download is not a backup, and removal keeps the owner\'s writing', async () => {
    mount(<DownloadsPanel />);
    const here = await screen.findByRole('region', { name: /^على هذا الجهاز/ });
    const row = (await within(here).findByText('Acute Appendicitis', { selector: 'bdi' })).closest('li')!;
    expect(row.textContent).toContain('2.0 MB');
    expect(row.textContent).toContain('كتاب الدراسة');
    expect(row.textContent).toContain('3 أسئلة مع الحلول');
    expect(document.body.textContent).toContain('وليس نسخة احتياطية');
    expect(document.body.textContent).toContain('ما لم يُزامَن منها لا يُحذف أبدًا');
    fireEvent.click(within(row).getByRole('button', { name: /أزِل من الجهاز/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('كتاباتك وملاحظاتك');
    fireEvent.click(within(dialog).getByRole('button', { name: 'أزِل التنزيل' }));
    await waitFor(async () => expect(await getDb().offlineSources.count()).toBe(0));
  });

  it('download dialog: exact size, contents line by line, solutions flagged and optional, what needs a connection', async () => {
    mount(<DownloadsPanel />);
    const pick = (await screen.findByText('Cholecystitis', { selector: 'bdi' })).closest('li')!;
    fireEvent.click(within(pick).getByRole('button', { name: 'تنزيل' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/مع الحلول ومفاتيح الإجابة/);
    expect(dialog.textContent).toContain('1.5 KB');
    expect(dialog.textContent).toContain('تحتاج اتصالًا');
    const box = within(dialog).getByRole('checkbox', { name: /نزّل الأسئلة مع حلولها/ });
    fireEvent.click(box);
    await within(dialog).findByText(/دون الحلول/);
    expect(urls.some((u) => u.includes('/api/data/offline/S2/manifest') && u.includes('include_solutions=0'))).toBe(true);
    // the source already on the device is marked, not offered again
    expect(screen.getAllByText('على هذا الجهاز').length).toBeGreaterThan(0);
  });
});

describe('BackupsPanel', () => {
  it('lists backups with honest verification state and runs a restore check', async () => {
    const calls: string[] = [];
    const list: BackupsListResponse = {
      backups: [
        { id: 'B2', file_name: 'b2.tar.gz', status: 'completed', status_label_ar: 'اكتملت', origin: 'api', size: 4096, sha256: 'ab'.repeat(32), created_at: 2, finished_at: 3, summary: { tables: 90, rows: 1200, files: 7, file_bytes: 3000, migrations: 11 }, warnings_ar: [], error_ar: null, job: null, verification: null, download_url: '/api/data/backups/B2/download' },
        { id: 'B1', file_name: 'b1.tar.gz', status: 'completed', status_label_ar: 'اكتملت', origin: 'cli', size: 4000, sha256: 'cd'.repeat(32), created_at: 1, finished_at: 1, summary: null, warnings_ar: [], error_ar: null, job: null, verification: { status: 'passed', verified_at: 5, summary_ar: 'نجحت الاستعادة التجريبية في مجلد منفصل.', checks_failed: [] }, download_url: '/api/data/backups/B1/download' },
      ],
      included_ar: ['قاعدة البيانات كاملة'],
      excluded_ar: ['secret.key (مفتاح الخادم السري)'],
      storage_note_ar: 'احتفظ بها خارج هذا الجهاز.',
    };
    setFetchImpl(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url === '/api/data/backups' && (init.method ?? 'GET') === 'GET') return json(list);
      if (url === '/api/data/backups/B2/verify') return json({ backup: list.backups[0] });
      if (url === '/api/data/backups' && init.method === 'POST') return json({ backup: list.backups[0] });
      return json({}, 404);
    });
    mount(<BackupsPanel />);
    await screen.findByText(/لم تُختبر استعادة هذه النسخة بعد/);
    expect(document.body.textContent).toContain('اختُبرت الاستعادة');
    expect(document.body.textContent).toContain('secret.key');
    expect(screen.getAllByRole('link', { name: /نزّل النسخة/ })[0]!.getAttribute('href')).toBe('/api/data/backups/B2/download');
    fireEvent.click(screen.getAllByRole('button', { name: /تحقّق من الاستعادة/ })[0]!);
    await waitFor(() => expect(calls).toContain('POST /api/data/backups/B2/verify'));
    fireEvent.click(screen.getByRole('button', { name: /أنشئ نسخة احتياطية الآن/ }));
    await waitFor(() => expect(calls).toContain('POST /api/data/backups'));
  });
});

describe('ExportPanel', () => {
  it('exports a chosen source in the chosen format and states that PDF is printed by the browser', async () => {
    const fetched: string[] = [];
    const formats: ExportFormatsResponse = {
      formats: [
        { format: 'md', label_ar: 'Markdown', note_ar: 'نص منظم.' },
        { format: 'html', label_ar: 'HTML للطباعة', note_ar: 'للطباعة.' },
        { format: 'json', label_ar: 'JSON كامل', note_ar: 'منظم.' },
      ],
      pdf_note_ar: 'PDF عبر الطباعة من المتصفح: افتح تصدير HTML ثم «طباعة».',
      other: [{ key: 'export.docx', label_ar: 'DOCX', available: false, reason_ar: 'غير مبني.' }],
    };
    setFetchImpl(async (url) => {
      if (url === '/api/data/export/formats') return json(formats);
      if (url === '/api/library/tree') return json({ nodes: [], sources: [{ id: 'S1', title: 'Acute Appendicitis', source_type: 'lecture', deleted_at: null }] });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return new Response('# export', { status: 200, headers: { 'content-type': 'text/markdown', 'content-disposition': "attachment; filename=\"x.md\"; filename*=UTF-8''%D9%85%D8%B5%D8%AF%D8%B1.md" } });
    });
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      created.push('blob:1');
      return 'blob:1';
    });
    URL.revokeObjectURL = vi.fn();
    mount(<ExportPanel />);
    await screen.findByText(/PDF عبر الطباعة من المتصفح/);
    expect(document.body.textContent).toContain('DOCX');
    fireEvent.change(screen.getByLabelText('المصدر'), { target: { value: 'S1' } });
    fireEvent.click(screen.getByRole('radio', { name: 'HTML للطباعة' }));
    fireEvent.click(screen.getByRole('button', { name: /نزّل الملف/ }));
    await waitFor(() => expect(fetched).toEqual(['/api/data/export/source/S1?format=html']));
    expect(created).toHaveLength(1);
  });
});

describe('UpdateBanner (PWA update prompt on every route)', () => {
  it('warns about unsynced writes and asks before reloading (never automatic)', async () => {
    const { writeAndEnqueue, getSyncEngine } = await import('../../lib/sync');
    const db = getDb();
    await writeAndEnqueue(db, db.notes, { id: 'N1', updatedAt: 1, syncState: 'pending_sync', body: { v: 1, paragraphs: [] } }, { entity_type: 'note', op: 'upsert' });
    await getSyncEngine().refresh();
    const update = vi.fn();
    mount(<UpdateBanner needRefresh offlineReady={false} onUpdate={update} onDismiss={() => undefined} />, '/study/S1');
    expect(await screen.findByText(/تغيير واحد لم يُزامَن/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /تحديث الآن/ }));
    expect(update).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('ولن يُحذف');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حدّث الآن' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it('without pending writes it updates on the first press; offline-ready links the Download Manager in the shell', async () => {
    const { getSyncEngine } = await import('../../lib/sync');
    await getSyncEngine().refresh();
    const update = vi.fn();
    const { unmount } = mount(<UpdateBanner needRefresh offlineReady={false} onUpdate={update} onDismiss={() => undefined} />, '/library');
    fireEvent.click(await screen.findByRole('button', { name: /تحديث الآن/ }));
    expect(update).toHaveBeenCalledTimes(1);
    unmount();
    mount(<UpdateBanner needRefresh={false} offlineReady onUpdate={update} onDismiss={() => undefined} />, '/library');
    expect(screen.getByRole('link', { name: 'مدير التنزيلات' }).getAttribute('href')).toBe('/offline');
  });
});
