// Helpers for the G1 acceptance specs (AC-01..AC-04). The derived acceptance fixtures live in fixtures/acceptance
// (synthetic TEST FIXTURE documents built from the Golden Set by make_g1_fixtures.py; never medical content).
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SourcePagesResponse, SourcePageView, SourceType, UploadResponse } from '@medlevo/shared';
import { CSRF_HEADERS, type E2eApi, type UploadedFixture } from './support';
import { REPO_ROOT } from './support/paths';

export const ACCEPTANCE_DIR = join(REPO_ROOT, 'fixtures', 'acceptance');

/** Upload any local file (e.g. a derived acceptance fixture) the way `api.uploadFixture` uploads Golden Set files. */
export async function uploadFile(api: E2eApi, nodeId: string, path: string, opts: { sourceType?: SourceType; title?: string } = {}): Promise<UploadedFixture> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = { node_id: nodeId, on_duplicate: 'create' };
  if (opts.sourceType) multipart.source_type = opts.sourceType;
  if (opts.title) multipart.title = opts.title;
  multipart.files = { name: basename(path), mimeType: 'application/octet-stream', buffer: readFileSync(path) };
  const res = await api.request.post('/api/sources/upload', { headers: { ...CSRF_HEADERS }, multipart });
  const text = await res.text();
  if (!res.ok()) throw new Error(`upload of ${basename(path)} → ${res.status()}: ${text.slice(0, 400)}`);
  const result = (JSON.parse(text) as UploadResponse).results[0];
  if (!result || result.status !== 'accepted' || !result.source_id || !result.version_id) throw new Error(`upload of ${basename(path)} was not accepted: ${JSON.stringify(result)}`);
  return result as UploadedFixture;
}

export async function versionPages(api: E2eApi, sourceId: string, versionId: string): Promise<SourcePageView[]> {
  return (await api.get<SourcePagesResponse>(`/api/sources/${sourceId}/versions/${versionId}/pages`)).pages;
}

export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
