// Channels (/api/channels; ARCHITECTURE_DELTA §7.3; P1-T4 step 1). System routes: the university tree, joining,
// members, codes and links, invitations and roles. Every route asks the one policy (rules/channels.ts) through the
// service; the plugin also registers those rules, gate 2's membership provider and the account-deletion participant.
//
//   GET    /tree?root=&depth=                       → ChannelTreeResponse        (signed in: titles only)
//   GET    /nodes/:id                               → ChannelNodeDetail
//   POST   /nodes                                   CreateChannelNodeRequest → ChannelNodeView   (platform admin: a
//                                                    university; Admin of the parent: below it; a subject gets its space)
//   PATCH  /nodes/:id                               PatchChannelNodeRequest → ChannelNodeView
//   POST   /nodes/:id/archive                       {preview} → ChannelArchiveResponse
//   GET    /nodes/:id/members?status=&cursor=&limit= → MembersResponse          (Admin / Assistant)
//   POST   /nodes/:id/members/:userId/decision      {decision, reason?} → MemberView
//   GET    /nodes/:id/codes                         → JoinCodesResponse
//   POST   /nodes/:id/codes                         CreateJoinCodeRequest → CreateJoinCodeResponse (secret shown once)
//   DELETE /codes/:id                               → JoinCodeView               (404 to anyone who may not manage it)
//   POST   /nodes/:id/invitations                   {user_ids} → InvitationsResponse
//   GET    /invitations                             → InvitationsResponse        (the viewer's own pending ones)
//   POST   /invitations/:id/decision                {accept} → InvitationDecisionResponse (the invitee only)
//   GET    /nodes/:id/roles                         → ChannelRolesResponse       (with inherited roles)
//   POST   /nodes/:id/roles                         {user_id, role} → ChannelRoleView
//   DELETE /roles/:id                               → ChannelRoleView            (404 to anyone who may not manage it)
//   POST   /join                                    {code} → JoinResponse        (wrong codes limited per account)
//   POST   /join/link                               {token} → JoinResponse       (the QR encodes the link)
//   GET    /join/preview?token=                     → JoinPreviewResponse        PUBLIC: the title only, else the 404
//                                                    of a missing route (ADR-0003 §3.10)
//   PUT    /subjects/:id/follow                     CourseFollowRequest → CourseFollowView  «تابع المادة» (members of
//                                                    the subject; step 2)
//   DELETE /subjects/:id/follow                     → CourseUnfollowResponse     (the viewer's own follow; idempotent)
// Registration (POST /api/auth/register) lives in modules/auth behind P1-T1's JoinTokenVerifier, which ./verifier.ts
// implements on this module's service.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  archiveChannelNodeSchema,
  assignRoleSchema,
  channelTreeQuerySchema,
  courseFollowSchema,
  createChannelNodeSchema,
  createInvitationsSchema,
  createJoinCodeSchema,
  entityIdSchema,
  invitationDecisionSchema,
  joinWithCodeSchema,
  joinWithLinkSchema,
  memberDecisionSchema,
  membersQuerySchema,
  patchChannelNodeSchema,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import type { Viewer } from '../../system/binding';
import { registerAccountDeletionParticipant } from '../accounts/deletion';
import { channelsOf } from './service';

const idParams = z.object({ id: entityIdSchema });
const memberParams = z.object({ id: entityIdSchema, userId: entityIdSchema });

function viewerOf(req: FastifyRequest): Viewer {
  if (!req.viewer) throw new AppError('UNAUTHENTICATED', 'يلزم تسجيل الدخول للمتابعة.', 401);
  return req.viewer;
}

const ipOf = (req: FastifyRequest) => req.ip ?? null;

export default async function channelsModule(app: FastifyInstance, opts: ModuleOptions): Promise<void> {
  const { ctx } = opts;
  const channels = channelsOf(ctx);
  channels.install();
  registerAccountDeletionParticipant(ctx, { name: 'channels', run: (_ctx, who) => channels.forgetUser(who.userId) });

  app.get('/tree', async (req) => channels.tree(viewerOf(req), parseQuery(channelTreeQuerySchema, req)));

  app.get('/nodes/:id', async (req) => channels.nodeDetail(viewerOf(req), parseParams(idParams, req).id));

  app.post('/nodes', async (req) => channels.createNode(viewerOf(req), parseBody(createChannelNodeSchema, req), ipOf(req)));

  app.patch('/nodes/:id', async (req) => channels.patchNode(viewerOf(req), parseParams(idParams, req).id, parseBody(patchChannelNodeSchema, req), ipOf(req)));

  app.post('/nodes/:id/archive', async (req) => channels.archive(viewerOf(req), parseParams(idParams, req).id, parseBody(archiveChannelNodeSchema, req).preview, ipOf(req)));

  app.get('/nodes/:id/members', async (req) => channels.members(viewerOf(req), parseParams(idParams, req).id, parseQuery(membersQuerySchema, req)));

  app.post('/nodes/:id/members/:userId/decision', async (req) => {
    const p = parseParams(memberParams, req);
    return channels.decideMember(viewerOf(req), p.id, p.userId, parseBody(memberDecisionSchema, req), ipOf(req));
  });

  app.get('/nodes/:id/codes', async (req) => channels.listCodes(viewerOf(req), parseParams(idParams, req).id));

  app.post('/nodes/:id/codes', async (req) => channels.createCode(viewerOf(req), parseParams(idParams, req).id, parseBody(createJoinCodeSchema, req), ipOf(req)));

  app.delete('/codes/:id', async (req) => channels.revokeCode(viewerOf(req), parseParams(idParams, req).id, ipOf(req)));

  app.post('/nodes/:id/invitations', async (req) => channels.invite(viewerOf(req), parseParams(idParams, req).id, parseBody(createInvitationsSchema, req).user_ids, ipOf(req)));

  app.get('/invitations', async (req) => channels.myInvitations(viewerOf(req)));

  app.post('/invitations/:id/decision', async (req) => channels.decideInvitation(viewerOf(req), parseParams(idParams, req).id, parseBody(invitationDecisionSchema, req).accept, ipOf(req)));

  app.get('/nodes/:id/roles', async (req) => channels.roles(viewerOf(req), parseParams(idParams, req).id));

  app.post('/nodes/:id/roles', async (req) => channels.assignRole(viewerOf(req), parseParams(idParams, req).id, parseBody(assignRoleSchema, req), ipOf(req)));

  app.delete('/roles/:id', async (req) => channels.revokeRole(viewerOf(req), parseParams(idParams, req).id, ipOf(req)));

  app.put('/subjects/:id/follow', async (req) => channels.follow(viewerOf(req), parseParams(idParams, req).id, parseBody(courseFollowSchema, req)));

  app.delete('/subjects/:id/follow', async (req) => channels.unfollow(viewerOf(req), parseParams(idParams, req).id));

  app.post('/join', async (req) => channels.joinWithCode(viewerOf(req), parseBody(joinWithCodeSchema, req).code, ipOf(req)));

  app.post('/join/link', async (req) => channels.joinWithLink(viewerOf(req), parseBody(joinWithLinkSchema, req).token, ipOf(req)));

  // PUBLIC (modules/auth/guard.ts PUBLIC_ROUTES): no session needed; a malformed, wrong or expired token gets exactly
  // the body of a missing route — never a validation message that would describe what a token looks like
  // a coarse per-address ceiling (a lecture hall scanning one QR stays far below it); wrong tokens are counted per IP
  app.get('/join/preview', { config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (req) => channels.preview((req.query as Record<string, unknown> | undefined)?.token, ipOf(req)));
}
