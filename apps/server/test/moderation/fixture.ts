// A stand-in for P1-T5's publications in the moderation tests (P1-T4 step 2). Course-only publications arrive with
// P1-T5 step 3, which registers the real `publication` / `publication_version` handlers from its own plugin through
// the same seam (`moderationTargetsOf(ctx).register`). This fixture keeps a few «publications» in memory with exactly
// what the seam asks for: the subject they belong to, a title, the author, the moderation state — and who may see them
// (members of the subject while visible; the author and the subject's moderators while hidden).
import type { ModerationTarget } from '@medlevo/shared';
import type { AppContext } from '../../src/context';
import { ChannelAccess } from '../../src/modules/channels/access';
import { channelsOf } from '../../src/modules/channels/service';
import { moderationTargetsOf } from '../../src/modules/moderation/targets';
import type { Viewer } from '../../src/system/binding';

export interface FixturePublication {
  id: string;
  subjectNodeId: string;
  title: string;
  authorUserId: string;
  state: 'visible' | 'hidden';
  /** every hide / restore the seam was asked to apply, in order */
  history: Array<{ state: 'visible' | 'hidden'; by: string; reasonAr: string }>;
}

export function installFixturePublications(ctx: AppContext): Map<string, FixturePublication> {
  const pubs = new Map<string, FixturePublication>();
  const access = channelsOf(ctx).access;
  const isModerator = (viewer: Viewer, nodeId: string) => ctx.authz.can(viewer, 'moderate', { type: 'channel_node', id: nodeId }).allowed;
  moderationTargetsOf(ctx).register(
    {
      type: 'publication',
      resolve(target: ModerationTarget) {
        const p = pubs.get(target.id);
        if (!p || target.db !== 'system') return null;
        return { scopeNodeId: p.subjectNodeId, title: p.title, authorUserId: p.authorUserId, state: p.state, link: `/p/${p.id}` };
      },
      visibleTo(viewer, target, info) {
        if (info.authorUserId === viewer.userId) return true;
        if (info.state === 'hidden') return isModerator(viewer, info.scopeNodeId);
        const e = access.effective(viewer, info.scopeNodeId);
        return !!e && ChannelAccess.mayEnter(e) && target.type === 'publication';
      },
      setState(target, state, by) {
        const p = pubs.get(target.id)!;
        p.state = state;
        p.history.push({ state, by: by.userId, reasonAr: by.reasonAr });
      },
    },
    { override: true },
  );
  return pubs;
}

export function addPublication(pubs: Map<string, FixturePublication>, id: string, subjectNodeId: string, authorUserId: string, title = `شرح ${id}`): FixturePublication {
  const p: FixturePublication = { id, subjectNodeId, title, authorUserId, state: 'visible', history: [] };
  pubs.set(id, p);
  return p;
}
