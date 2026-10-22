// What happens around a publication outside its own routes (P1-T5 step 3; ARCHITECTURE_DELTA §6.4, §12, §13; PRD
// AOS-4.14, 5.18, 18.7, 18.8, 21.44, Q14, Q25):
//   * fan-out of a new version: `publication_update_fanout` runs in the SUBJECT'S SPACE, pages the followers (system
//     `publication_copy`, never a scan of vaults), queues one `publication_follow_sync` job in each follower's VAULT
//     (keyed by publication + version) and publishes «تحديث شرح أتابعه» through P1-T4's notifications (titles and
//     counts only). The vault job marks the version pending — or applies it for «طبّق التحديثات تلقائيًا»;
//   * the «followers of a publication» notification audience;
//   * the moderation targets `publication` (system index) and `publication_version` (the space) — P1-T4's moderation
//     hides / restores through them; followers and forks keep what they had (copy, never move);
//   * the account-deletion participant (Q14): the deleted author's publications leave every listing («طالب سابق» is
//     rendered at read time), forks others made are not erased, followed copies freeze at their last version.
import type { ModerationTarget } from '@medlevo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context';
import type { Viewer } from '../../system/binding';
import { registerAccountDeletionParticipant } from '../accounts/deletion';
import type { PublicationResource } from '../authz/rules/publications';
import { eraseAuthorNameInVault, syncFollowedCopy } from './following';
import { diffVersions } from './pubItems';
import { spaceDb } from './stubs';
import { forksSystem, publicationIndex, type PublicationRow } from './system';

export const PUBLICATION_FANOUT_JOB = 'publication_update_fanout';
export const FOLLOW_SYNC_JOB = 'publication_follow_sync';
export const FOLLOWERS_AUDIENCE = 'publication_followers';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const fanoutInput = z.object({ publication_id: id, version_no: z.number().int().min(1) }).strict();
type FanoutInput = z.infer<typeof fanoutInput>;
const syncInput = z.object({ space_id: id, publication_id: id, version_no: z.number().int().min(1) }).strict();
type SyncInput = z.infer<typeof syncInput>;

const PAGE = 500;

/** Review P1-T5 s3 R3-F: after an author's account deletion, the holders of copies lose his name (space job). */
export const AUTHOR_ERASED_JOB = 'publication_author_erased';
const erasedInput = z.object({ publication_id: id, author_user_id: id }).strict();
type ErasedInput = z.infer<typeof erasedInput>;

/** Page the holders of copies of one publication and rename what their vaults stored of the deleted author (Q14). */
async function runAuthorErased(ctx: AppContext, input: ErasedInput): Promise<{ vaults: number; skipped: number }> {
  const sys = forksSystem(ctx);
  let vaults = 0;
  let skipped = 0;
  for (let after: string | null = null; ; ) {
    const page = publicationIndex(ctx).holdersPage(input.publication_id, input.author_user_id, after, PAGE);
    if (page.length === 0) break;
    for (const userId of page) {
      const v = sys.vaultStateOf(userId);
      if (!v) continue; // no vault any more: nothing of his name is left there
      if (!v.readable) {
        skipped++; // locked for a restore, or suspended: the job retries
        continue;
      }
      ctx.binding.run({ kind: 'vault', vaultId: v.id, viewer: null }, () => eraseAuthorNameInVault(ctx, input.publication_id, input.author_user_id));
      vaults++;
    }
    after = page[page.length - 1]!;
    if (page.length < PAGE) break;
  }
  if (skipped > 0) throw new Error(`${skipped} vault(s) could not be read yet; the author's name is removed from them on a retry`);
  return { vaults, skipped };
}

/**
 * Queue the fan-out of a new publication version (call it in the SPACE binding, after the version committed). `rerun`
 * names a later pass over the same version (a restore by a moderator, review P1-T5 s3 R3-C): the fan-out's own key is
 * then new, while each follower's sync job keeps its key per publication + version — so a follower who was already
 * offered that version (and applied or skipped it) is not asked again.
 */
export function enqueuePublicationFanout(ctx: AppContext, input: FanoutInput, rerun?: string): string | null {
  if (!ctx.jobs.isRegistered(PUBLICATION_FANOUT_JOB)) return null;
  try {
    const key = `${PUBLICATION_FANOUT_JOB}:${input.publication_id}:${input.version_no}${rerun ? `:${rerun}` : ''}`;
    return ctx.jobs.enqueue(PUBLICATION_FANOUT_JOB, input, { idempotencyKey: key }).id;
  } catch (e) {
    ctx.log.warn({ err: e }, 'could not queue the fan-out of a publication version');
    return null;
  }
}

/**
 * After a moderator's restore (review P1-T5 s3 R3-C): the fan-out of a version published while the explanation was
 * hidden ran and stopped (nothing reaches followers of a hidden explanation), so the head is fanned out again. Runs
 * after P1-T4's moderation transaction has committed (a microtask: the transaction is synchronous), re-reads the state
 * and does nothing unless the explanation is active again.
 */
function fanOutAfterRestore(ctx: AppContext, publicationId: string, hiddenAt: number | null): void {
  queueMicrotask(() => {
    try {
      const pub = publicationIndex(ctx).get(publicationId);
      if (!pub || pub.status !== 'active' || pub.head_version_no < 2) return;
      ctx.binding.run({ kind: 'space', spaceId: pub.space_id, subjectNodeId: pub.subject_node_id, viewer: null, access: 'moderator', route: null }, () => {
        enqueuePublicationFanout(ctx, { publication_id: pub.id, version_no: pub.head_version_no }, `restored:${hiddenAt ?? 0}`);
      });
    } catch (e) {
      ctx.log.warn({ err: e }, 'could not queue the fan-out of a restored publication');
    }
  });
}

async function runFanout(ctx: AppContext, input: FanoutInput): Promise<{ queued: number }> {
  const b = ctx.binding.current();
  if (!b || b.kind !== 'space') throw new Error('publication_update_fanout runs in a space');
  const pub = publicationIndex(ctx).get(input.publication_id);
  if (!pub || pub.space_id !== b.spaceId || pub.status !== 'active') return { queued: 0 };
  const sys = forksSystem(ctx);
  let queued = 0;
  for (let after: string | null = null; ; ) {
    const page = publicationIndex(ctx).followersPage(pub.id, after, PAGE);
    if (page.length === 0) break;
    for (const userId of page) {
      if (userId === pub.author_user_id) continue;
      const vaultId = sys.vaultOf(userId);
      if (!vaultId) continue;
      ctx.binding.run({ kind: 'vault', vaultId, viewer: null }, () => {
        ctx.jobs.enqueue(FOLLOW_SYNC_JOB, { space_id: pub.space_id, publication_id: pub.id, version_no: input.version_no } satisfies SyncInput, {
          idempotencyKey: `${FOLLOW_SYNC_JOB}:${pub.id}:${input.version_no}`,
        });
      });
      queued++;
    }
    after = page[page.length - 1]!;
    if (page.length < PAGE) break;
  }
  // the inbox entry «حدّث حسن شرحه … (الإصدار 2)»: titles and counts only; P1-T4's fan-out re-checks each follower may
  // still enter the subject
  const d = input.version_no > 1 ? diffVersions(ctx.db, pub.id, input.version_no - 1, input.version_no) : null;
  if (d) {
    try {
      const mod = await import('../notifications/service');
      mod.notificationsOf(ctx).publish({
        content: { kind: 'publication_updated', payload: { publication_title: pub.title, version_no: input.version_no, added: d.added.length, removed: d.removed.length, changed: d.changed.length } },
        actorUserId: pub.author_user_id,
        target: { db: 'system', type: 'publication', id: pub.id },
        link: `/subjects/${pub.space_id}/publications/${pub.id}`,
        scopeNodeId: pub.subject_node_id,
        dedupeKey: `publication_updated:${pub.id}:${input.version_no}`,
        audience: { kind: 'registered', name: FOLLOWERS_AUDIENCE, params: { publication_id: pub.id } },
        exclude: [pub.author_user_id],
      });
    } catch (e) {
      ctx.log.warn({ err: e }, 'could not publish the notification of a publication update');
    }
  }
  return { queued };
}

function vaultUserOf(ctx: AppContext): string | null {
  const b = ctx.binding.current();
  if (!b || b.kind !== 'vault') return null;
  return b.viewer?.userId ?? forksSystem(ctx).userOfVault(b.vaultId);
}

// ───────────────────────── moderation targets (P1-T4's registry) ─────────────────────────

function publicationResource(ctx: AppContext, viewer: Viewer, pub: PublicationRow): PublicationResource {
  return { type: 'publication', id: pub.id, spaceId: pub.space_id, authorUserId: pub.author_user_id, status: pub.status, viewerHoldsCopy: publicationIndex(ctx).holds(viewer.userId, pub.id) };
}

function pubOfTarget(ctx: AppContext, target: ModerationTarget): PublicationRow | null {
  if (target.type === 'publication') return target.db === 'system' ? publicationIndex(ctx).get(target.id) : null;
  if (target.type === 'publication_version') {
    const space = spaceDb(ctx, target.db);
    const v = space?.get<{ publication_id: string }>('SELECT publication_id FROM publication_version WHERE id = ?', [target.id]);
    const pub = v ? publicationIndex(ctx).get(v.publication_id) : null;
    return pub && pub.space_id === target.db ? pub : null;
  }
  return null;
}

async function registerModerationTargets(ctx: AppContext): Promise<void> {
  try {
    const { moderationTargetsOf } = await import('../moderation/targets');
    const reg = moderationTargetsOf(ctx);
    for (const type of ['publication', 'publication_version'] as const) {
      if (reg.handler(type)) continue;
      reg.register({
        type,
        resolve(target) {
          const pub = pubOfTarget(ctx, target);
          // a withdrawn publication (or a deleted author's) is nobody's to moderate any more: it is gone from listings
          if (!pub || pub.status === 'withdrawn' || pub.status === 'author_deleted') return null;
          return {
            scopeNodeId: pub.subject_node_id,
            title: pub.title,
            authorUserId: pub.author_user_id,
            state: pub.status === 'hidden_by_moderator' ? 'hidden' : 'visible',
            link: `/subjects/${pub.space_id}/publications/${pub.id}`,
          };
        },
        visibleTo(viewer, target) {
          const pub = pubOfTarget(ctx, target);
          return !!pub && ctx.authz.can(viewer, 'view', publicationResource(ctx, viewer, pub)).allowed;
        },
        setState(target, state, by) {
          const pub = pubOfTarget(ctx, target);
          if (!pub) return;
          publicationIndex(ctx).setModerationState(pub.id, state, by);
          if (state === 'visible' && pub.status === 'hidden_by_moderator') fanOutAfterRestore(ctx, pub.id, pub.hidden_at);
        },
      });
    }
  } catch (e) {
    ctx.log.warn({ err: e }, 'the moderation module is not available: publications cannot be reported');
  }
}

// ───────────────────────── registration (from the forks plugin) ─────────────────────────

export async function registerPublicationHooks(ctx: AppContext): Promise<void> {
  ctx.jobs.register<FanoutInput, unknown>(PUBLICATION_FANOUT_JOB, {
    version: '1',
    maxAttempts: 5,
    timeoutMs: 30 * 60 * 1000,
    inputSchema: fanoutInput as unknown as z.ZodType<FanoutInput>,
    handler: async (run) => runFanout(ctx, run.input),
  });
  ctx.jobs.register<SyncInput, unknown>(FOLLOW_SYNC_JOB, {
    version: '1',
    maxAttempts: 5,
    timeoutMs: 10 * 60 * 1000,
    inputSchema: syncInput as unknown as z.ZodType<SyncInput>,
    handler: async (run) => {
      const userId = vaultUserOf(ctx);
      return userId ? syncFollowedCopy(ctx, userId, run.input) : { action: 'none' };
    },
  });
  try {
    const mod = await import('../notifications/service');
    mod.notificationsOf(ctx).registerAudience(FOLLOWERS_AUDIENCE, (p, after, limit) => (p.publication_id ? publicationIndex(ctx).followersPage(p.publication_id, after, limit) : []));
  } catch (e) {
    ctx.log.warn({ err: e }, 'the notifications module is not available: followers are not notified of updates');
  }
  await registerModerationTargets(ctx);
  ctx.jobs.register<ErasedInput, unknown>(AUTHOR_ERASED_JOB, {
    version: '1',
    maxAttempts: 8,
    timeoutMs: 30 * 60 * 1000,
    inputSchema: erasedInput as unknown as z.ZodType<ErasedInput>,
    handler: async (run) => runAuthorErased(ctx, run.input),
  });
  registerAccountDeletionParticipant(ctx, {
    name: 'publications',
    run: (c, who) => {
      const pubs = publicationIndex(c).ofAuthor(who.userId);
      publicationIndex(c).authorDeleted(who.userId);
      // review P1-T5 s3 R3-F: «طالب سابق» in the copies others keep — one job per publication, in its subject's space
      for (const p of pubs) {
        c.binding.run({ kind: 'space', spaceId: p.space_id, subjectNodeId: p.subject_node_id, viewer: null, access: 'moderator', route: null }, () => {
          c.jobs.enqueue(AUTHOR_ERASED_JOB, { publication_id: p.id, author_user_id: who.userId } satisfies ErasedInput, { idempotencyKey: `${AUTHOR_ERASED_JOB}:${p.id}` });
        });
      }
    },
    preview: (c, userId) => publicationIndex(c).countsOfAuthor(userId),
  });
}
