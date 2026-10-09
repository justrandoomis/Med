import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProcessingStatusResponse, UploadFileResult } from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { ApiError, setFetchImpl } from '../../lib/api';
import { capabilitiesStore } from '../../lib/capabilities';
import { confidenceLabel } from '../sources/PagesPanel';
import { toPatch } from '../sources/MetadataForm';
import { batchSummary, describeItem, describeResult, type QueueItem } from './results';
import { UploadRow } from './UploadScreen';
import { postMultipart, setXhrFactory, type XhrLike } from './uploadXhr';

afterEach(() => {
  setFetchImpl(null);
  setXhrFactory(null);
  capabilitiesStore.reset(null);
});

/** Capabilities as the server would report them (only the keys these tests need). */
function setReader(state: 'available' | 'not_implemented') {
  capabilitiesStore.reset({
    features: { 'workspace.reader': { state, reason_ar: state === 'available' ? undefined : 'مساحة الدراسة غير متاحة بعد.' } },
    ai: { configured: false },
    server_time: 0,
    app_version: 'test',
  } as unknown as Parameters<typeof capabilitiesStore.reset>[0]);
}

const file = (name: string, size = 2048) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });
const item = (over: Partial<QueueItem>): QueueItem => ({ key: 'k', file: file('lecture.pdf'), status: 'waiting', sent: 0, total: 2048, ...over });

describe('upload result presentation', () => {
  it('accepted / rejected / duplicate each carry text + tone, never colour alone', () => {
    expect(describeResult({ file_name: 'a.pdf', status: 'accepted', size: 1, detected_format: 'pdf', suggested_source_type: 'lecture' })).toEqual({
      tone: 'success',
      label: 'قُبل',
      detail: 'اكتُشف: PDF، النوع المقترح: محاضرة',
    });
    const rej = describeResult({ file_name: 'x.pdf', status: 'rejected', size: 1, reason_ar: 'ملف PDF محمي بكلمة مرور.' });
    expect(rej).toEqual({ tone: 'danger', label: 'رُفض', detail: 'ملف PDF محمي بكلمة مرور.' });
    const dup = describeResult({ file_name: 'b.pdf', status: 'duplicate', size: 1, duplicate_of: { source_id: 's', version_id: 'v', title: 'Lecture 1' } });
    expect(dup.label).toBe('موجود مسبقًا');
    expect(dup.detail).toContain('Lecture 1');
  });

  it('upload progress is real bytes, not a percentage', () => {
    const v = describeItem(item({ status: 'uploading', sent: 1024 * 1024, total: 3 * 1024 * 1024 }));
    expect(v.detail).toBe('1 MB من 3 MB');
    expect(describeItem(item({ status: 'uploading', sent: 1536 * 1024, total: 3 * 1024 * 1024 })).detail).toBe('1.5 MB من 3 MB');
    expect(v.detail).not.toMatch(/%/);
    expect(describeItem(item({ status: 'checking' })).label).toBe('يفحصه الخادم');
  });

  it('batch summary counts each outcome', () => {
    const res = (status: UploadFileResult['status']): UploadFileResult => ({ file_name: 'f', status, size: 1 });
    expect(
      batchSummary([
        item({ status: 'accepted', result: res('accepted') }),
        item({ status: 'accepted', result: res('accepted') }),
        item({ status: 'rejected', result: res('rejected') }),
        item({ status: 'duplicate', result: res('duplicate') }),
        item({ status: 'waiting' }),
      ]),
    ).toBe('قُبل 2، رُفض 1، موجود مسبقًا 1');
    expect(batchSummary([item({ status: 'waiting' })])).toBeNull();
  });
});

describe('UploadRow rendering', () => {
  const mount = (it: QueueItem, handlers: Partial<Record<'onRemove' | 'onCancel' | 'onRetry' | 'onAddAnyway', () => void>> = {}) =>
    render(
      <MemoryRouter>
        <ToastProvider>
          <ul>
            <UploadRow item={it} busy={false} onRemove={handlers.onRemove ?? vi.fn()} onCancel={handlers.onCancel ?? vi.fn()} onRetry={handlers.onRetry ?? vi.fn()} onAddAnyway={handlers.onAddAnyway ?? vi.fn()} />
          </ul>
        </ToastProvider>
      </MemoryRouter>,
    );

  it('rejected ZIP shows the reason and every skipped entry with its reason', () => {
    mount(
      item({
        file: file('histology.zip'),
        status: 'accepted',
        result: {
          file_name: 'histology.zip',
          status: 'rejected',
          size: 10,
          detected_format: 'zip',
          reason_ar: 'لا يحتوي الأرشيف على صور مدعومة.',
          rejected_entries: [
            { name: 'slides/readme.txt', reason_ar: 'ليس صورة مدعومة.' },
            { name: '__MACOSX/._a.png', reason_ar: 'ملف نظام مخفي — تم تجاهله.' },
          ],
        },
      }),
    );
    expect(screen.getByText('رُفض')).toBeTruthy();
    expect(screen.getByText('لا يحتوي الأرشيف على صور مدعومة.')).toBeTruthy();
    expect(screen.getByText('عناصر استُبعدت من الأرشيف (2)')).toBeTruthy();
    expect(screen.getByText('slides/readme.txt')).toBeTruthy();
  });

  it('duplicate offers a link to the existing source and an explicit «add anyway»', () => {
    const onAddAnyway = vi.fn();
    mount(
      item({
        status: 'duplicate',
        result: { file_name: 'lecture.pdf', status: 'duplicate', size: 10, duplicate_of: { source_id: 'S1', version_id: 'V1', title: 'Lecture 1' }, reason_ar: 'المحتوى نفسه موجود بالفعل.' },
      }),
      { onAddAnyway },
    );
    const link = screen.getByRole('link', { name: /فتح الموجود/ });
    expect(link.getAttribute('href')).toBe('/sources/S1');
    fireEvent.click(screen.getByRole('button', { name: 'أضفه نسخةً مستقلة' }));
    expect(onAddAnyway).toHaveBeenCalledOnce();
  });

  it('accepted file polls processing and shows the stage with real page counts', async () => {
    const status: ProcessingStatusResponse = {
      summary: {
        stage: 'ocr',
        stage_label_ar: 'التعرّف الضوئي على الصفحات الممسوحة',
        pages_total: 10,
        pages_ready: 3,
        pages_failed: 1,
        pages_needs_review: 0,
        pages_ocr: 1,
        failed_pages: [],
        coverage_complete: false,
        job_id: 'J1',
        updated_at: 1,
      },
      job: null,
    };
    setFetchImpl(async () => new Response(JSON.stringify(status), { status: 200, headers: { 'content-type': 'application/json' } }));
    setReader('available');
    const accepted = item({ status: 'accepted', result: { file_name: 'lecture.pdf', status: 'accepted', size: 10, source_id: 'S1', version_id: 'V1', detected_format: 'pdf', suggested_source_type: 'lecture' } });
    const { unmount } = mount(accepted);
    await screen.findByText('التعرّف الضوئي على الصفحات الممسوحة');
    expect(screen.getByText(/جاهز 3 من 10 صفحات/)).toBeTruthy();
    expect(screen.getByText(/تعثّر 1/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /افتح للقراءة/ }).getAttribute('href')).toBe('/study/S1');
    expect(document.body.textContent).not.toMatch(/\d+%/);
    unmount();
    // «open for reading» is only offered when the reader really exists (capability), like the source screen
    setReader('not_implemented');
    mount(accepted);
    await screen.findByText('التعرّف الضوئي على الصفحات الممسوحة');
    expect(screen.queryByRole('link', { name: /افتح للقراءة/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'التفاصيل والصفحات' })).toBeTruthy();
  });

  it('byte sizes are isolated LTR runs (RTL showed «8 B» as «B 8»)', () => {
    const { unmount } = mount(item({ file: file('lecture.pdf', 8) }));
    const waiting = document.querySelector('.ml-upload__detail bdi[dir="ltr"]');
    expect(waiting?.textContent).toBe('8 B');
    unmount();
    mount(item({ status: 'uploading', sent: 1536 * 1024, total: 3 * 1024 * 1024 }));
    const runs = [...document.querySelectorAll('.ml-upload__detail bdi[dir="ltr"]')].map((b) => b.textContent);
    expect(runs).toEqual(['1.5 MB', '3 MB']);
    expect(document.querySelector('.ml-upload__detail')?.textContent).toBe('1.5 MB من 3 MB');
  });

  it('a waiting file can be removed; an error offers retry', () => {
    const onRemove = vi.fn();
    const { unmount } = mount(item({}), { onRemove });
    fireEvent.click(screen.getByRole('button', { name: 'إزالة «lecture.pdf» من القائمة' }));
    expect(onRemove).toHaveBeenCalled();
    unmount();
    const onRetry = vi.fn();
    mount(item({ status: 'error', error: 'تعذّر الوصول إلى الخادم.' }), { onRetry });
    expect(screen.getByText('تعذّر الوصول إلى الخادم.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

class FakeXhr implements XhrLike {
  static last: FakeXhr | null = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  timeout = 0;
  headers: Record<string, string> = {};
  method = '';
  url = '';
  body: FormData | null = null;
  upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(n: string, v: string) {
    this.headers[n] = v;
  }
  send(b: FormData) {
    this.body = b;
  }
  abort() {
    this.onabort?.();
  }
}

describe('postMultipart (XHR with real upload progress)', () => {
  it('sends CSRF + credentials, reports byte progress, parses the JSON answer', async () => {
    setXhrFactory(() => new FakeXhr());
    const progress: Array<[number, number]> = [];
    const form = new FormData();
    const h = postMultipart<{ results: unknown[] }>('/sources/upload', form, (s, t) => progress.push([s, t]));
    const x = FakeXhr.last!;
    expect([x.method, x.url, x.headers['x-medlevo-csrf'], x.withCredentials]).toEqual(['POST', '/api/sources/upload', '1', true]);
    x.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true });
    x.upload.onprogress?.({ loaded: 100, total: 100, lengthComputable: true });
    x.status = 200;
    x.responseText = JSON.stringify({ results: [] });
    x.onload?.();
    await expect(h.promise).resolves.toEqual({ results: [] });
    expect(progress).toEqual([
      [50, 100],
      [100, 100],
    ]);
  });

  it('maps the server error envelope to ApiError with the Arabic message; network failure → offline', async () => {
    setXhrFactory(() => new FakeXhr());
    const h = postMultipart('/sources/upload', new FormData(), () => undefined);
    FakeXhr.last!.status = 409;
    FakeXhr.last!.responseText = JSON.stringify({ error: { code: 'CONFLICT', message: 'المجلد الهدف في سلة المحذوفات.' } });
    FakeXhr.last!.onload?.();
    await expect(h.promise).rejects.toMatchObject({ code: 'CONFLICT', status: 409, message: 'المجلد الهدف في سلة المحذوفات.' });
    const h2 = postMultipart('/sources/upload', new FormData(), () => undefined);
    FakeXhr.last!.onerror?.();
    const err = await h2.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).offline).toBe(true);
  });
});

describe('source screen helpers', () => {
  it('OCR confidence shows the engine score as given (0–1 or 0–100); unknown is a dash', () => {
    expect(confidenceLabel(0.873)).toBe('87%');
    expect(confidenceLabel(91.4)).toBe('91%');
    expect(confidenceLabel(null)).toBe('—');
  });

  it('metadata patch sends only changed fields; emptied fields become null (unknown), never invented', () => {
    const base = {
      title: 'Lecture',
      source_type: 'lecture' as const,
      lecture_kind: '' as const,
      language: '' as const,
      edition: '',
      authors: '',
      publication_date: '',
      original_url: '',
      priority: '0',
      selection_reason: '',
      metadata_status: 'unknown' as const,
    };
    expect(toPatch(base, base)).toEqual({});
    expect(toPatch(base, { ...base, authors: 'Dr. A، Dr. B', edition: ' 3rd ' })).toEqual({ authors: ['Dr. A', 'Dr. B'], edition: '3rd' });
    expect(toPatch({ ...base, edition: '3rd' }, base)).toEqual({ edition: null });
    expect(toPatch(base, { ...base, source_type: 'textbook' })).toEqual({ source_type: 'textbook' });
  });
});
