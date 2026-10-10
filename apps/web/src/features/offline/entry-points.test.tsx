// Integration (I1 #3): the Download Manager is reachable where the owner studies — not only by typing /offline.
//  * library rows show «على هذا الجهاز» for a source downloaded on this device (a REAL download record);
//  * the row menu offers «نزّل للعمل دون اتصال…» (opens the download dialog), disabled offline with the reason, and
//    «على هذا الجهاز — إدارة التنزيلات» (→ /offline) once downloaded;
//  * the source screen mounts OfflineDownloadButton, whose offline reason is visible text (a disabled button cannot
//    be focused, so a tooltip alone would hide it from keyboard users);
//  * the workspace top bar's overflow menu carries the same action;
//  * Settings links to /offline (global nav stays Home / Library / Review / Settings).
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, Route, Routes, RouterProvider } from 'react-router-dom';
import {
  DEFAULT_OWNER_SETTINGS,
  FEATURE_KEYS,
  normalizeOfflinePath,
  type CapabilitiesResponse,
  type FeatureKey,
  type FeatureStatus,
  type OfflineManifestResponse,
  type SourceSummary,
} from '@medlevo/shared';
import { ToastProvider } from '../../design';
import { setFetchImpl } from '../../lib/api';
import { downloadSource, removeDownload } from '../../lib/offline';
import { settingsStore } from '../../lib/settings';
import type { OwnerGateData } from '../../app/routeTypes';
import { SourceRow } from '../library/components/Rows';
import { buildIndex } from '../library/model';
import { SettingsScreen } from '../settings/SettingsScreen';
import { TopBar } from '../workspace/chrome/TopBar';
import { OfflineDownloadButton } from './OfflineDownloadButton';
import { DOWNLOAD_NEEDS_CONNECTION_AR, useOfflineDownloadAction } from './OnDevice';

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const PDF = new TextEncoder().encode('%PDF-1.7 lecture');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function manifest(sourceId: string): OfflineManifestResponse {
  const raw = JSON.stringify({ id: sourceId });
  return {
    format: 'medlevo-offline-1',
    source: { id: sourceId, title: 'Acute Appendicitis', source_type: 'lecture', format: 'pdf' },
    version: { id: `V-${sourceId}`, version_no: 2, is_active: true, page_count: 4, processing_status: 'ready' },
    include_solutions: true,
    generated_at: 1,
    content_hash: 'H',
    entries: [
      { kind: 'file', role: 'display_pdf', file_id: `F-${sourceId}`, url: `/api/files/F-${sourceId}`, mime: 'application/pdf', size: PDF.length, sha256: sha(PDF), page_id: null, page_index: null },
      { kind: 'data', role: 'source_detail', path: normalizeOfflinePath(`/api/sources/${sourceId}`), size: raw.length, contains_solutions: false, sha256: sha(raw) },
    ],
    totals: { bytes: PDF.length + raw.length, file_bytes: PDF.length, data_bytes: raw.length, files: 1, data: 1, solution_bytes: 0 },
    contents: { pages: 4, page_images: 0, has_display_pdf: true, annotations: 0, notes: 0, note_pages: 0, study_book: null, questions: { linked: 0, with_solutions: 0 }, flashcards: 0, review_events: 0 },
    not_included_ar: ['الذكاء الاصطناعي'],
  };
}

const summary = (id: string, title: string): SourceSummary => ({
  id,
  title,
  source_type: 'lecture',
  node_id: 'N1',
  subject_node_id: null,
  course_node_id: null,
  lecture_kind: null,
  lecture_kind_origin: null,
  processing_status: 'ready',
  current_version_id: `V-${id}`,
  frozen_version_id: null,
  active_version_id: `V-${id}`,
  format: 'pdf',
  page_count: 4,
  is_favorite: false,
  last_opened_at: null,
  archived_at: null,
  deleted_at: null,
  created_at: 1,
  updated_at: 1,
  tags: [],
});

function setOnline(on: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on });
  window.dispatchEvent(new Event(on ? 'online' : 'offline'));
}

const index = buildIndex([], [summary('DL', 'Downloaded lecture'), summary('NEW', 'New lecture')]);

function mountRows() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/library']}>
        <Routes>
          <Route
            path="/library"
            element={
              <ul>
                <SourceRow source={summary('DL', 'Downloaded lecture')} index={index} />
                <SourceRow source={summary('NEW', 'New lecture')} index={index} />
              </ul>
            }
          />
          <Route path="/offline" element={<h1>بياناتك</h1>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(async () => {
  setFetchImpl(async (url) => json(url.includes('/manifest') ? manifest('DL') : { format: 'medlevo-offline-1', source_id: 'DL', version_id: 'V-DL', content_hash: 'H', generated_at: 1, entries: [] }));
  await downloadSource('DL', { fetchFile: vi.fn(async () => new Response(PDF as BodyInit, { status: 200 })) });
  setFetchImpl(async (url) => (url.includes('/data/offline/NEW/manifest') ? json(manifest('NEW')) : json({})));
});

afterEach(async () => {
  setOnline(true);
  setFetchImpl(null);
  await removeDownload('DL');
});

describe('library rows', () => {
  it('a downloaded source is marked «على هذا الجهاز» with its version; another source is not', async () => {
    mountRows();
    expect(await screen.findByText('على هذا الجهاز (الإصدار 2)')).toBeTruthy();
    expect(screen.getAllByText(/على هذا الجهاز/)).toHaveLength(1);
  });

  it('the row menu downloads a new source (dialog lists what will be stored) and manages a downloaded one', async () => {
    mountRows();
    await screen.findByText('على هذا الجهاز (الإصدار 2)');
    fireEvent.click(screen.getByRole('button', { name: 'خيارات «New lecture»' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /نزّل للعمل دون اتصال/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('الذكاء الاصطناعي'));

    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'خيارات «Downloaded lecture»' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /على هذا الجهاز — إدارة التنزيلات/ }));
    expect(await screen.findByRole('heading', { name: 'بياناتك' })).toBeTruthy();
  });

  it('offline: downloading is disabled in the menu with the reason; the badge still shows', async () => {
    setOnline(false);
    mountRows();
    expect(await screen.findByText('على هذا الجهاز (الإصدار 2)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'خيارات «New lecture»' }));
    const item = await screen.findByRole('menuitem', { name: /نزّل للعمل دون اتصال/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain(DOWNLOAD_NEEDS_CONNECTION_AR);
  });
});

describe('source screen button', () => {
  it('offline: the button is disabled and the reason is visible text', async () => {
    setOnline(false);
    render(
      <MemoryRouter>
        <OfflineDownloadButton sourceId="NEW" title="New lecture" />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: /نزّل للعمل دون اتصال/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const reason = screen.getByText(DOWNLOAD_NEEDS_CONNECTION_AR);
    expect(btn.getAttribute('aria-describedby')).toBe(reason.id);
  });
});

describe('workspace top bar', () => {
  function Bar({ phone }: { phone: boolean }) {
    const action = useOfflineDownloadAction('NEW', 'New lecture');
    return (
      <>
        <TopBar
          title="New lecture"
          backTo="/library"
          phone={phone}
          pages={[]}
          pageIndex={0}
          onGoToPage={() => {}}
          view="original"
          onView={() => {}}
          splitReason={null}
          studyBookReason={null}
          searchOpen={false}
          onToggleSearch={() => {}}
          zoomLabel="100%"
          fit={false}
          onZoomIn={() => {}}
          onZoomOut={() => {}}
          onZoomTo={() => {}}
          onRotate={() => {}}
          layout="continuous"
          spreadReason={null}
          onLayout={() => {}}
          flipAnimation={false}
          onFlipAnimation={() => {}}
          focusMode={false}
          onFocusMode={() => {}}
          leftOpen={false}
          onToggleLeft={() => {}}
          railOpen={false}
          onToggleRail={() => {}}
          saveState="synced"
          saveDetail=""
          back={null}
          onBack={() => {}}
          inkAvailable={false}
          extraMenuItems={action.item}
        />
        {action.dialog}
      </>
    );
  }

  it.each([false, true])('the overflow menu offers the download (phone=%s)', async (phone) => {
    render(
      <MemoryRouter>
        <Bar phone={phone} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: phone ? 'خيارات القراءة' : 'خيارات العرض' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /نزّل للعمل دون اتصال/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('settings', () => {
  it('links to «بياناتك» (/offline)', async () => {
    const caps: CapabilitiesResponse = {
      features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' } as FeatureStatus])) as Record<FeatureKey, FeatureStatus>,
      ai: { configured: false },
      server_time: 0,
      app_version: 'test',
    };
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/settings')) return json({ settings: DEFAULT_OWNER_SETTINGS });
      if (url.startsWith('/api/auth/sessions')) return json({ sessions: [] });
      if (url.startsWith('/api/capabilities')) return json(caps);
      return json({});
    });
    await act(async () => {
      await settingsStore.load();
    });
    const gate: OwnerGateData = { mode: 'online', username: 'owner', remainingRecoveryCodes: 10, sessionId: 's1', passwordMinLength: 12 };
    const router = createMemoryRouter([{ id: 'owner', path: '/', loader: () => gate, children: [{ path: 'settings', element: <SettingsScreen /> }] }], { initialEntries: ['/settings'] });
    render(
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>,
    );
    const link = await screen.findByRole('link', { name: /بياناتك: التنزيلات والنسخ الاحتياطي والتصدير/ });
    expect(link.getAttribute('href')).toBe('/offline');
  });
});
