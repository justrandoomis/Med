// Fan-out of official changes to the vaults that hold a copy (P1-T5 step 2; ARCHITECTURE_DELTA §6.3, §12; PRD Q35,
// AOS-2.16, 4.5, 18.10, Scenario 4).
//
// Two job kinds, each in its own database and idempotent by key — there is no transaction across files:
//   * `official_copy_fanout` runs in the SUBJECT'S SPACE after a version is published (once its page map is computed),
//     after a withdrawal or a rights takedown. It reads the system `lecture_copy` index (never a scan of vaults) and, for
//     a lecture's first publication, the subject's «تابع المادة» followers, and queues one `official_stub_sync` job in
//     each vault (keyed by lecture + version + reason), then publishes the notification (P1-T4's service).
//   * `official_stub_sync` runs in ONE USER'S VAULT: it adds the new version to the stub (its pages, fingerprints and the
//     official page map), raises the vault's content alert, and — only when the user chose «انقل ملاحظاتي تلقائيًا» —
//     runs P1-T2's note copy (copy, never move; the same report as the one-tap flow). A takedown nulls the stub's file
//     references and then deletes the vault's file rows (foreign_keys = ON); ink and notes stay over placeholders.
// Nothing here ever deletes, moves or rewrites a personal item.
import type { NotificationContent } from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import { newId } from '../../lib/ids';
import type { Viewer } from '../../system/binding';
import { previewReanchorCopy, runReanchorCopy } from '../annotations/reanchorCopy';
import { removeStoredFileIfUnreferenced } from '../sources/purge';
import { refreshHoldings, vaultUser } from './copies';
import { ensureStub, publishedVersions, recordStubFiles, spaceDb, spaceLecture, stubOf, stubVersions, type SpaceLectureRow } from './stubs';
import { forksSystem } from './system';

export const OFFICIAL_FANOUT_JOB = 'official_copy_fanout';
export const STUB_SYNC_JOB = 'official_stub_sync';
export const HOLDERS_AUDIENCE = 'lecture_copy_holders';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const REASONS = ['published', 'withdrawn', 'takedown'] as const;
const SYNC_REASONS = ['follow', 'version', 'withdrawn', 'takedown'] as const;
type SyncReason = (typeof SYNC_REASONS)[number];

export const fanoutInput = z.object({ lecture_id: id, version_id: id.nullable(), reason: z.enum(REASONS) }).strict();
export type FanoutInput = z.infer<typeof fanoutInput>;
export const stubSyncInput = z.object({ space_id: id, lecture_id: id, version_id: id.nullable(), reason: z.enum(SYNC_REASONS), folder_id: id.nullable().optional() }).strict();
export type StubSyncInput = z.infer<typeof stubSyncInput>;

const PAGE = 500;

/** Queue the fan-out of an official change (call it in the SPACE binding, after the change committed). */
export function enqueueOfficialFanout(ctx: AppContext, input: FanoutInput): string | null {
  if (!ctx.jobs.isRegistered(OFFICIAL_FANOUT_JOB)) return null;
  try {
    return ctx.jobs.enqueue(OFFICIAL_FANOUT_JOB, input, { idempotencyKey: `${OFFICIAL_FANOUT_JOB}:${input.lecture_id}:${input.version_id ?? '-'}:${input.reason}` }).id;
  } catch (e) {
    ctx.log.warn({ err: e }, 'could not queue the copy fan-out of an official lecture');
    return null;
  }
}

/** A viewer object for background checks of someone's membership (no device, never the platform admin's powers). */
function memberViewer(userId: string): Viewer {
  return { userId, deviceId: null, isPlatformAdmin: false };
}

function isMember(ctx: AppContext, userId: string, spaceId: string): boolean {
  const m = ctx.authz.memberships.accessToSpace(memberViewer(userId), spaceId);
  return !!m && !m.pending;
}

/** P1-T4's notification service when it is mounted (a notice is never a reason for a copy job to fail). */
async function notify(ctx: AppContext, build: () => Parameters<NotifyFn>[0]): Promise<void> {
  try {
    const mod = (await import('../notifications/service')) as { notificationsOf?: (c: AppContext) => { publish: NotifyFn } };
    if (!mod.notificationsOf) return;
    mod.notificationsOf(ctx).publish(build());
  } catch (e) {
    ctx.log.warn({ err: e }, 'could not publish a notification of an official lecture');
  }
}
type NotifyFn = (input: {
  content: NotificationContent;
  target?: { db: 'system' | 'vault' | 'space'; space_id?: string | null; type: string; id: string } | null;
  scopeNodeId?: string | null;
  dedupeKey: string;
  audience: { kind: 'users'; user_ids: string[] } | { kind: 'course_followers'; subject_node_id: string } | { kind: 'registered'; name: string; params: Record<string, string> };
  exclude?: readonly string[];
}) => unknown;

/** Register the «holders of a copy of this lecture» audience with P1-T4's notifications (system `lecture_copy`). */
export async function registerHoldersAudience(ctx: AppContext): Promise<void> {
  try {
    const mod = (await import('../notifications/service')) as { notificationsOf?: (c: AppContext) => { registerAudience?: (name: string, pager: (p: Record<string, string>, after: string | null, limit: number) => string[]) => void } };
    const svc = mod.notificationsOf?.(ctx);
    svc?.registerAudience?.(HOLDERS_AUDIENCE, (p, after, limit) => (p.space_id && p.lecture_id ? forksSystem(ctx).holdersPage(p.space_id, p.lecture_id, after, limit) : []));
  } catch (e) {
    ctx.log.warn({ err: e }, 'the notifications module is not available: copy holders are not notified');
  }
}

// ───────────────────────────── the space side ─────────────────────────────

export async function runOfficialFanout(ctx: AppContext, input: FanoutInput): Promise<{ queued: number; followers: number; holders: number }> {
  const b = ctx.binding.current();
  if (!b || b.kind !== 'space') throw new Error('official_copy_fanout runs in a space');
  const spaceId = b.spaceId;
  const lecture = ctx.db.get<SpaceLectureRow>('SELECT * FROM official_lecture WHERE id = ?', [input.lecture_id]);
  if (!lecture) return { queued: 0, followers: 0, holders: 0 };
  const sys = forksSystem(ctx);
  let queued = 0;
  const enqueueIn = (userId: string, job: StubSyncInput): void => {
    const vaultId = sys.vaultOf(userId);
    if (!vaultId) return;
    ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () => {
      ctx.jobs.enqueue(STUB_SYNC_JOB, job, { idempotencyKey: `${STUB_SYNC_JOB}:${job.space_id}:${job.lecture_id}:${job.version_id ?? '-'}:${job.reason}` });
    });
    queued++;
  };
  const subjectTitle = sys.spaceTitleOf(spaceId) ?? '';
  // the holders of a copy (any version) get the new version / the withdrawal
  let holders = 0;
  const holderReason: SyncReason = input.reason === 'published' ? 'version' : input.reason;
  for (let after: string | null = null; ; ) {
    const page = sys.holdersPage(spaceId, lecture.id, after, PAGE);
    if (page.length === 0) break;
    for (const userId of page) {
      if (input.reason === 'published' && !isMember(ctx, userId, spaceId)) continue; // a former member's copy stays as it is
      enqueueIn(userId, { space_id: spaceId, lecture_id: lecture.id, version_id: input.version_id, reason: holderReason });
      holders++;
    }
    after = page[page.length - 1]!;
    if (page.length < PAGE) break;
  }
  // «تابع المادة»: a lecture's FIRST publication lands in every follower's library as a stub (links, not copies)
  let followers = 0;
  const first = input.reason === 'published' && !!input.version_id && !ctx.db.get('SELECT 1 AS x FROM official_version_publish WHERE lecture_id = ? AND version_id <> ? LIMIT 1', [lecture.id, input.version_id]);
  if (first) {
    for (let after: string | null = null; ; ) {
      const page = sys.courseFollowersPage(lecture.subject_node_id, after, PAGE);
      if (page.length === 0) break;
      for (const f of page) {
        if (!isMember(ctx, f.user_id, spaceId)) continue;
        enqueueIn(f.user_id, { space_id: spaceId, lecture_id: lecture.id, version_id: input.version_id, reason: 'follow', folder_id: f.library_folder_id ?? null });
        followers++;
      }
      after = page[page.length - 1]!.user_id;
      if (page.length < PAGE) break;
    }
  }
  // the notice (titles and counts only); P1-T4's fan-out checks each recipient may still open the subject
  if (input.reason === 'published' && input.version_id) {
    const v = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [input.version_id]);
    if (first) {
      await notify(ctx, () => ({
        content: { kind: 'official_lecture_new', payload: { subject_title: subjectTitle || 'المادة', lecture_title: lecture.title, lecture_no: lecture.lecture_no } },
        target: { db: 'space', space_id: spaceId, type: 'official_lecture', id: lecture.id },
        scopeNodeId: lecture.subject_node_id,
        dedupeKey: `official_lecture_new:${lecture.id}`,
        audience: { kind: 'course_followers', subject_node_id: lecture.subject_node_id },
      }));
    } else if (v) {
      await notify(ctx, () => ({
        content: { kind: 'official_version', payload: { subject_title: subjectTitle || 'المادة', lecture_title: lecture.title, version_no: v.version_no } },
        target: { db: 'space', space_id: spaceId, type: 'official_lecture', id: lecture.id },
        scopeNodeId: lecture.subject_node_id,
        dedupeKey: `official_version:${input.version_id}`,
        audience: { kind: 'registered', name: HOLDERS_AUDIENCE, params: { space_id: spaceId, lecture_id: lecture.id } },
      }));
    }
  } else if (input.reason !== 'published') {
    await notify(ctx, () => ({
      content: { kind: 'subject_update', payload: { subject_title: subjectTitle || 'المادة', event_kind: 'lecture_withdrawn', title: lecture.title } },
      target: { db: 'space', space_id: spaceId, type: 'official_lecture', id: lecture.id },
      scopeNodeId: lecture.subject_node_id,
      dedupeKey: `lecture_withdrawn:${lecture.id}:${input.reason}`,
      audience: { kind: 'registered', name: HOLDERS_AUDIENCE, params: { space_id: spaceId, lecture_id: lecture.id } },
    }));
  }
  return { queued, followers, holders };
}

// ───────────────────────────── the vault side ─────────────────────────────

export interface StubSyncResult {
  action: 'added' | 'updated' | 'none' | 'not_member' | 'takedown' | 'withdrawn';
  versions_added: number;
  auto_copy: { copied: number; needs_review: number; kept: number } | null;
}

export async function runStubSync(ctx: AppContext, input: StubSyncInput): Promise<StubSyncResult> {
  const userId = vaultUser(ctx);
  if (!userId) return { action: 'none', versions_added: 0, auto_copy: null };
  if (input.reason === 'takedown') {
    takeDownStub(ctx, input.space_id, input.lecture_id);
    const stub = stubOf(ctx, input.space_id, input.lecture_id);
    if (stub) refreshHoldings(ctx, userId, stub.id);
    return { action: 'takedown', versions_added: 0, auto_copy: null };
  }
  if (input.reason === 'withdrawn') {
    // nothing changes in the vault: the copy reads the withdrawal (and its reason) from the space; notes stay
    return { action: 'withdrawn', versions_added: 0, auto_copy: null };
  }
  if (!isMember(ctx, userId, input.space_id)) return { action: 'not_member', versions_added: 0, auto_copy: null };
  const space = spaceDb(ctx, input.space_id);
  if (!space) return { action: 'none', versions_added: 0, auto_copy: null };
  const lecture = spaceLecture(space, input.lecture_id);
  if (!lecture || lecture.status !== 'published' || !lecture.head_version_id) return { action: 'none', versions_added: 0, auto_copy: null };
  const published = publishedVersions(space, lecture);
  const target = input.version_id && published.some((v) => v.id === input.version_id) ? input.version_id : lecture.head_version_id;
  const stub = stubOf(ctx, input.space_id, input.lecture_id);
  const subjectTitle = forksSystem(ctx).spaceTitleOf(input.space_id) ?? '';
  if (input.reason === 'follow') {
    if (stub) return { action: 'none', versions_added: 0, auto_copy: null }; // already in the library: nothing to add
    const r = ensureStub(ctx, { spaceId: input.space_id, lectureId: lecture.id, versionIds: [target], folderId: input.folder_id ?? null, subjectTitle });
    recordStubFiles(ctx, r);
    refreshHoldings(ctx, userId, r.sourceId);
    return { action: 'added', versions_added: r.addedVersionIds.length, auto_copy: null };
  }
  // a new official version for a holder
  if (!stub) return { action: 'none', versions_added: 0, auto_copy: null };
  const held = stubVersions(ctx, stub.id).map((v) => v.id);
  const r = ensureStub(ctx, { spaceId: input.space_id, lectureId: lecture.id, versionIds: [...new Set([...held.filter((h) => published.some((p) => p.id === h)), target])], folderId: null, subjectTitle });
  recordStubFiles(ctx, r);
  let auto: StubSyncResult['auto_copy'] = null;
  // new to this vault — or added by an earlier attempt of this job (or by «ابدأ الدراسة») that never raised the alert:
  // a retry after a crash must still alert and run the automatic copy (both idempotent; review P1-T5 s2 R-G)
  const targetNo = published.find((p) => p.id === target)?.version_no ?? 0;
  const pendingAlert =
    stubVersions(ctx, stub.id).some((v) => v.version_no < targetNo) &&
    !ctx.db.get('SELECT 1 AS x FROM content_alert WHERE source_id = ? AND source_version_id = ? LIMIT 1', [stub.id, target]);
  if (r.addedVersionIds.includes(target) || pendingAlert) {
    raiseVersionAlert(ctx, stub.id, target, lecture.title);
    const copy = ctx.db.get<{ reanchor_policy: string }>(`SELECT reanchor_policy FROM document_copy WHERE source_id = ? AND deleted_at IS NULL AND reanchor_policy = 'auto' LIMIT 1`, [stub.id]);
    if (copy) auto = autoCopyNotes(ctx, stub.id, target);
    if (auto && auto.copied + auto.needs_review > 0) {
      await notify(ctx, () => ({
        content: { kind: 'reanchor_ready', payload: { lecture_title: lecture.title, copied: auto!.copied, needs_review: auto!.needs_review, kept: auto!.kept } },
        dedupeKey: `reanchor_ready:${userId}:${target}`,
        audience: { kind: 'users', user_ids: [userId] },
      }));
    }
  }
  refreshHoldings(ctx, userId, stub.id);
  return { action: r.addedVersionIds.length ? 'updated' : 'none', versions_added: r.addedVersionIds.length, auto_copy: auto };
}

/** «انقل ملاحظاتي تلقائيًا» (PRD Q35): P1-T2's one-tap copy without the tap — the same plan, the same report. */
function autoCopyNotes(ctx: AppContext, sourceId: string, toVersionId: string): { copied: number; needs_review: number; kept: number } | null {
  try {
    const preview = previewReanchorCopy(ctx, { source_id: sourceId, to_version_id: toVersionId });
    if (preview.state !== 'ready' || !preview.from_version || preview.copy === 0) {
      return { copied: 0, needs_review: preview.needs_review, kept: preview.kept };
    }
    const run = runReanchorCopy(ctx, { source_id: sourceId, from_version_id: preview.from_version.id, to_version_id: toVersionId, map_computed_at: preview.map_computed_at }, { deviceId: null });
    return { copied: run.report.copied, needs_review: run.report.needs_review, kept: run.report.kept };
  } catch (e) {
    ctx.log.warn({ err: e }, 'the automatic note copy to a new official version did not run; the one-tap flow stays available');
    return null;
  }
}

/** One open content alert per new official version of a stub (artifacts that cite older versions need a look). */
function raiseVersionAlert(ctx: AppContext, sourceId: string, versionId: string, title: string): void {
  if (ctx.db.get('SELECT 1 AS x FROM content_alert WHERE source_id = ? AND source_version_id = ? LIMIT 1', [sourceId, versionId])) return;
  const v = ctx.db.get<{ version_no: number }>('SELECT version_no FROM source_version WHERE id = ?', [versionId]);
  const prev = ctx.db.get<{ id: string; version_no: number }>('SELECT id, version_no FROM source_version WHERE source_id = ? AND version_no < ? ORDER BY version_no DESC LIMIT 1', [sourceId, v?.version_no ?? 0]);
  const deps = ctx.db.all<{ dependent_type: string; dependent_id: string; source_version_id: string }>(
    `SELECT DISTINCT dependent_type, dependent_id, source_version_id FROM artifact_dependency WHERE source_version_id IN (SELECT id FROM source_version WHERE source_id = ? AND id <> ?)`,
    [sourceId, versionId],
  );
  const now = ctx.clock.now();
  const alertId = newId(now);
  const changed = ctx.db.all<{ from_page_id: string }>(`SELECT from_page_id FROM version_page_map WHERE to_version_id = ? AND status NOT IN ('safe','confirmed')`, [versionId]).length;
  const summary = `صدر الإصدار ${v?.version_no ?? ''} من «${title.replace(/[\r\n\t]+/g, ' ').trim()}». ملاحظاتك باقية على الإصدار ${prev?.version_no ?? 'السابق'}، وتستطيع نسخها إلى الإصدار الجديد بعد معاينة ما سيُنقل.${
    deps.length ? ` عناصر مشتقة تعتمد على الإصدار السابق: ${deps.length}.` : ''
  }`;
  ctx.db.tx(() => {
    ctx.db.run(
      `INSERT INTO content_alert (id, kind, severity, source_id, source_version_id, from_version_id, summary, affected_json, status, details_json, created_at)
       VALUES (?, 'source_replaced', ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        alertId,
        deps.length ? 'fact_change' : 'info',
        sourceId,
        versionId,
        prev?.id ?? null,
        summary,
        JSON.stringify(deps.map((d) => ({ type: d.dependent_type, id: d.dependent_id, impact: 'needs_review' }))),
        JSON.stringify({ state: 'official_version', pages_not_safe: changed }),
        now,
      ],
    );
    for (const d of deps) {
      ctx.db.run(
        `INSERT OR IGNORE INTO content_alert_item (alert_id, dependent_type, dependent_id, impact, frozen, reason_ar, version_ids_json) VALUES (?, ?, ?, 'needs_review', 0, ?, ?)`,
        [alertId, d.dependent_type, d.dependent_id, 'يعتمد على إصدار سابق من المحاضرة الرسمية؛ راجعه قبل الاعتماد عليه.', JSON.stringify([d.source_version_id])],
      );
    }
  });
}

/**
 * The vault side of a rights takedown (§6.3): in ONE transaction the stub's file references (version files, page
 * renders and thumbnails) are set to NULL — they REFERENCE stored_file and foreign_keys is ON — then each file row of
 * the official blobs goes when nothing else in this vault references it (the bytes wait for the mark-and-sweep GC).
 * Pages, ink, notes, layers and the copy stay; the reader shows placeholders with the reason.
 */
export function takeDownStub(ctx: AppContext, spaceId: string, lectureId: string): { files_released: number } {
  const stub = stubOf(ctx, spaceId, lectureId);
  if (!stub) return { files_released: 0 };
  const files = new Set<string>();
  ctx.db.tx(() => {
    for (const v of ctx.db.all<{ id: string; file_id: string | null; original_file_id: string | null; display_file_id: string | null }>(
      'SELECT id, file_id, original_file_id, display_file_id FROM source_version WHERE source_id = ?',
      [stub.id],
    )) {
      for (const f of [v.file_id, v.original_file_id, v.display_file_id]) if (f) files.add(f);
      for (const p of ctx.db.all<{ render_file_id: string | null; thumbnail_file_id: string | null }>('SELECT render_file_id, thumbnail_file_id FROM source_page WHERE version_id = ?', [v.id])) {
        if (p.render_file_id) files.add(p.render_file_id);
        if (p.thumbnail_file_id) files.add(p.thumbnail_file_id);
      }
      ctx.db.run('UPDATE source_version SET file_id = NULL, original_file_id = NULL, display_file_id = NULL WHERE id = ?', [v.id]);
      ctx.db.run('UPDATE source_page SET render_file_id = NULL, thumbnail_file_id = NULL WHERE version_id = ?', [v.id]);
      // regions pinned from the taken-down lecture lose their text too (the citation stays, saying why)
      ctx.db.run(`UPDATE source_region SET text = NULL, structure_json = NULL WHERE version_id = ? AND id IN (SELECT region_id FROM pinned_region WHERE version_id = ?)`, [v.id, v.id]);
    }
  });
  let released = 0;
  for (const f of files) if (removeStoredFileIfUnreferenced(ctx, f)) released++;
  return { files_released: released };
}

export function registerFanoutJobs(ctx: AppContext): void {
  ctx.jobs.register<FanoutInput, unknown>(OFFICIAL_FANOUT_JOB, {
    version: '1',
    maxAttempts: 5,
    timeoutMs: 30 * 60 * 1000,
    inputSchema: fanoutInput as unknown as z.ZodType<FanoutInput>,
    handler: async (run) => runOfficialFanout(ctx, run.input),
  });
  ctx.jobs.register<StubSyncInput, unknown>(STUB_SYNC_JOB, {
    version: '1',
    maxAttempts: 5,
    timeoutMs: 10 * 60 * 1000,
    inputSchema: stubSyncInput as unknown as z.ZodType<StubSyncInput>,
    handler: async (run) => runStubSync(ctx, run.input),
  });
}
