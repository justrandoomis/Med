// «انقل ملاحظاتي إلى الإصدار الجديد» on the web (Academic OS P1-T2 step 3; ARCHITECTURE_DELTA §6.3; PRD AOS-3.13, Q35).
// COPY, NEVER MOVE — the server does the copy in one transaction (apps/server/src/modules/annotations/reanchorCopy.ts);
// this file holds the calls, the pure grouping of the review list, and a tiny change signal so the reader's banner and
// the «إعادة ربط» review list refresh each other after a tap, an undo or a review decision.
import { useSyncExternalStore } from 'react';
import type {
  ReanchorCopyActionRequest,
  ReanchorCopyActionResponse,
  ReanchorCopyPreview,
  ReanchorCopyRunRequest,
  ReanchorCopyRunResponse,
  ReanchorPageRef,
  ReanchorReviewItem,
  SourceVersionView,
} from '@medlevo/shared';
import { api } from '../../../lib/api';
import { getSyncEngine } from '../../../lib/sync';
import type { ReanchorGroup } from './ReanchorSection';

export const MIGRATION_OFFLINE_AR = 'نقل الملاحظات إلى إصدار أحدث يُنفَّذ على الخادم ويُسجَّل في سجل التغييرات؛ يحتاج اتصالًا. لا يتغير شيء حتى تتصل.';

export function fetchMigrationPreview(sourceId: string, opts: { toVersionId?: string | null; fromVersionId?: string | null } = {}): Promise<ReanchorCopyPreview> {
  return api.get<ReanchorCopyPreview>('/annotations/reanchor-copy', {
    query: { source_id: sourceId, ...(opts.toVersionId ? { to_version_id: opts.toVersionId } : {}), ...(opts.fromVersionId ? { from_version_id: opts.fromVersionId } : {}) },
    timeoutMs: 30_000,
    skipAuthRedirect: true,
  });
}

/** The tap. The copies reach this device through the sync feed (pulled right away). */
export async function runMigration(req: ReanchorCopyRunRequest): Promise<ReanchorCopyRunResponse> {
  const res = await api.post<ReanchorCopyRunResponse>('/annotations/reanchor-copy', req, { timeoutMs: 120_000 });
  await getSyncEngine()
    .syncNow({ pull: true })
    .catch(() => undefined);
  bumpMigration(req.source_id);
  return res;
}

/** One-step undo: the run's copies are tombstoned (only those; a copy you changed since is kept). */
export async function undoMigration(sourceId: string, runId: string): Promise<ReanchorCopyRunResponse> {
  const res = await api.post<ReanchorCopyRunResponse>('/annotations/reanchor-copy/undo', { run_id: runId }, { timeoutMs: 60_000 });
  await getSyncEngine()
    .syncNow({ pull: true })
    .catch(() => undefined);
  bumpMigration(sourceId);
  return res;
}

/** A review decision through Round 7's re-anchoring route, as a COPY (or keep / review again). */
export async function postVersionDecision(sourceId: string, req: ReanchorCopyActionRequest): Promise<ReanchorCopyActionResponse> {
  // this device's own unsent edits of these items go first (the server checks the revision the list saw)
  await getSyncEngine()
    .syncNow()
    .catch(() => undefined);
  const res = await api.post<ReanchorCopyActionResponse>('/annotations/reanchor', req, { timeoutMs: 30_000 });
  bumpMigration(sourceId);
  return res;
}

/** The newest version of the lecture (the target of «انقل ملاحظاتي»), null when there is only one. */
export function newestVersion(versions: readonly Pick<SourceVersionView, 'id' | 'version_no'>[]): Pick<SourceVersionView, 'id' | 'version_no'> | null {
  if (versions.length < 2) return null;
  return [...versions].sort((a, b) => b.version_no - a.version_no)[0] ?? null;
}

/** Should the reader offer the migration? Only when something is waiting: items to copy or to review. */
export function hasPendingMigration(p: ReanchorCopyPreview | null): boolean {
  if (!p || p.state === 'none' || !p.from_version) return false;
  if (p.state === 'ready') return p.copy > 0 || p.needs_review > 0;
  return p.total - p.already_moved - p.kept > 0;
}

export interface VersionReviewGroup extends ReanchorGroup {
  reason_ar: string;
  from: ReanchorPageRef;
  suggested: ReanchorPageRef | null;
  item_kind: string;
}

const groupKind = (itemKind: string): ReanchorGroup['kind'] => (itemKind === 'note' ? 'note' : itemKind === 'text_highlight' ? 'highlight' : itemKind === 'bookmark' ? 'bookmark' : 'ink');

function itemsAr(n: number): string {
  return n === 1 ? 'عنصر واحد' : n === 2 ? 'عنصران' : n <= 10 ? `${n} عناصر` : `${n} عنصرًا`;
}

/** Review rows: pen items of one old page with one reason are copied together (their shapes and places kept). */
export function versionReviewGroups(review: readonly ReanchorReviewItem[], fromVersionNo: number): VersionReviewGroup[] {
  const out = new Map<string, VersionReviewGroup>();
  for (const r of review) {
    let g = out.get(r.group_key);
    if (!g) {
      g = {
        key: `v:${r.group_key}`,
        kind: groupKind(r.item_kind),
        label: r.label_ar,
        preview: r.preview,
        where: `${r.from.label_ar} — الإصدار ${fromVersionNo}`,
        pageIndex: null,
        items: [],
        detached: false,
        reason_ar: r.reason_ar,
        from: r.from,
        suggested: r.suggested,
        item_kind: r.item_kind,
      };
      out.set(r.group_key, g);
    }
    g.items.push({ kind: r.kind, id: r.id, rev: r.rev });
    if (g.kind === 'ink' && g.items.length > 1) g.label = `كتابة بالقلم (${itemsAr(g.items.length)})`;
  }
  return [...out.values()];
}

/** «ص 12 ← ص 14» rows of the preview, bounded; the rest is counted. */
export function willCopyRows(p: Pick<ReanchorCopyPreview, 'will_copy'>, limit = 12): { rows: Array<{ key: string; from: string; to: string; items: string }>; more: number } {
  const rows = p.will_copy.slice(0, limit).map((w) => ({ key: w.page.page_id, from: w.from?.label_ar ?? `الصفحة ${w.from_page_index + 1} في الملف`, to: w.page.label_ar, items: itemsAr(w.items) }));
  return { rows, more: Math.max(0, p.will_copy.length - limit) };
}

// ───────── change signal (banner ↔ review list) ─────────
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
export function bumpMigration(sourceId: string): void {
  versions.set(sourceId, (versions.get(sourceId) ?? 0) + 1);
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** Changes whenever a tap, an undo or a review decision for this lecture finished on this device. */
export function useMigrationVersion(sourceId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => versions.get(sourceId) ?? 0,
    () => 0,
  );
}
