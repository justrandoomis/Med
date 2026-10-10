// Server calls for backups and exports (/api/data/…, shapes in packages/shared/src/data-api.ts).
import type { BackupCreateResponse, BackupsListResponse, ExportFormat, ExportFormatsResponse, LibraryTreeResponse, StudyBookStatusResponse } from '@medlevo/shared';
import { api, ApiError, OFFLINE_MESSAGE_AR } from '../../lib/api';
import { fileNameFrom } from './model';

const enc = encodeURIComponent;

export const dataApi = {
  backups: () => api.get<BackupsListResponse>('/data/backups', { timeoutMs: 30_000 }),
  backup: (id: string) => api.get<BackupCreateResponse>(`/data/backups/${enc(id)}`, { timeoutMs: 30_000 }),
  createBackup: () => api.post<BackupCreateResponse>('/data/backups', {}, { timeoutMs: 30_000 }),
  verifyBackup: (id: string) => api.post<BackupCreateResponse>(`/data/backups/${enc(id)}/verify`, {}, { timeoutMs: 30_000 }),
  deleteBackup: (id: string) => api.del<{ ok: true }>(`/data/backups/${enc(id)}`),
  exportFormats: () => api.get<ExportFormatsResponse>('/data/export/formats', { timeoutMs: 15_000 }),
  libraryTree: () => api.get<LibraryTreeResponse>('/library/tree', { timeoutMs: 30_000 }),
  bookForSource: (sourceId: string) => api.get<StudyBookStatusResponse>('/studybook/books', { query: { source_id: sourceId }, timeoutMs: 30_000 }),
};

export type ExportTarget =
  | { kind: 'source'; sourceId: string }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'notes'; sourceId?: string | null }
  | { kind: 'questions'; sourceId?: string | null; lectureSourceId?: string | null; includeSolutions: boolean }
  | { kind: 'all' };

export function exportUrl(target: ExportTarget, format: ExportFormat): string {
  const q = new URLSearchParams({ format: target.kind === 'all' ? 'json' : format });
  switch (target.kind) {
    case 'source':
      return `/api/data/export/source/${enc(target.sourceId)}?${q}`;
    case 'artifact':
      return `/api/data/export/artifact/${enc(target.artifactId)}?${q}`;
    case 'notes':
      if (target.sourceId) q.set('source_id', target.sourceId);
      return `/api/data/export/notes?${q}`;
    case 'questions':
      if (target.sourceId) q.set('source_id', target.sourceId);
      if (target.lectureSourceId) q.set('lecture_source_id', target.lectureSourceId);
      q.set('include_solutions', target.includeSolutions ? '1' : '0');
      return `/api/data/export/questions?${q}`;
    case 'all':
      return `/api/data/export/all?${q}`;
  }
}

/** Fetches an export as a file (authenticated, same origin). Errors carry the server's Arabic message. */
export async function fetchExport(url: string): Promise<{ blob: Blob; fileName: string; text: () => Promise<string> }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError({ code: 'OFFLINE', status: 0, offline: true, message: OFFLINE_MESSAGE_AR });
  }
  if (!res.ok) {
    let message = `تعذّر التصدير (رمز ${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the generic message
    }
    throw new ApiError({ code: 'HTTP_ERROR', status: res.status, message });
  }
  const blob = await res.blob();
  return { blob, fileName: fileNameFrom(res.headers.get('content-disposition'), 'medlevo-export'), text: () => blob.text() };
}

/** Saves a blob through a temporary <a download> (no navigation, nothing leaves the device). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
