// The web client of /api/channels/* (P1-T4; channels-api.ts) and of the signed-in account (/api/accounts/me). Every
// answer is already filtered by the server for the viewer: the client shows it and the server's Arabic reasons, and
// never decides who may see or do something.
import type {
  AssignRoleRequest,
  ChannelArchiveResponse,
  ChannelNodeDetail,
  ChannelNodeView,
  ChannelRolesResponse,
  ChannelRoleView,
  ChannelTreeResponse,
  CourseFollowView,
  CourseUnfollowResponse,
  CreateChannelNodeRequest,
  CreateJoinCodeRequest,
  CreateJoinCodeResponse,
  InvitationDecisionResponse,
  InvitationsResponse,
  InvitationStatus,
  InvitationView,
  InviteeSearchResponse,
  JoinCodesResponse,
  JoinPreviewResponse,
  JoinResponse,
  MeResponse,
  MemberDecisionRequest,
  MembersResponse,
  MembershipStatus,
  PatchChannelNodeRequest,
} from '@medlevo/shared';
import { CHANNEL_KINDS } from '@medlevo/shared';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };
const enc = encodeURIComponent;

export const channelsApi = {
  /** the whole tree the viewer may name (titles only for nodes they cannot enter), up to the server's size limit */
  tree: (root?: string, depth: number = CHANNEL_KINDS.length) => api.get<ChannelTreeResponse>('/channels/tree', { ...T, query: { depth, root } }),
  node: (id: string) => api.get<ChannelNodeDetail>(`/channels/nodes/${enc(id)}`, T),
  createNode: (body: CreateChannelNodeRequest) => api.post<ChannelNodeView>('/channels/nodes', body, T),
  patchNode: (id: string, body: PatchChannelNodeRequest) => api.patch<ChannelNodeView>(`/channels/nodes/${enc(id)}`, body, T),
  archive: (id: string, preview: boolean) => api.post<ChannelArchiveResponse>(`/channels/nodes/${enc(id)}/archive`, { preview }, T),

  joinWithCode: (code: string) => api.post<JoinResponse>('/channels/join', { code }, T),
  joinWithLink: (token: string) => api.post<JoinResponse>('/channels/join/link', { token }, T),
  /** PUBLIC: the channel's title for a valid invite token, the body of a missing route otherwise */
  preview: (token: string) => api.get<JoinPreviewResponse>('/channels/join/preview', { ...T, query: { token }, skipAuthRedirect: true }),

  invitations: () => api.get<InvitationsResponse>('/channels/invitations', T),
  decideInvitation: (id: string, accept: boolean) => api.post<InvitationDecisionResponse>(`/channels/invitations/${enc(id)}/decision`, { accept }, T),
  // (C2, AOS-18.5) inviting named people from the screen: the picker, sending, the list sent into a node, revoking
  searchInvitees: (nodeId: string, q: string) => api.get<InviteeSearchResponse>(`/channels/nodes/${enc(nodeId)}/invitees`, { ...T, query: { q } }),
  invite: (nodeId: string, userIds: string[]) => api.post<InvitationsResponse>(`/channels/nodes/${enc(nodeId)}/invitations`, { user_ids: userIds }, T),
  nodeInvitations: (nodeId: string, status?: InvitationStatus) => api.get<InvitationsResponse>(`/channels/nodes/${enc(nodeId)}/invitations`, { ...T, query: { status } }),
  revokeInvitation: (id: string) => api.del<InvitationView>(`/channels/invitations/${enc(id)}`, T),

  follow: (subjectId: string) => api.put<CourseFollowView>(`/channels/subjects/${enc(subjectId)}/follow`, { add_new_lectures: true }, T),
  unfollow: (subjectId: string) => api.del<CourseUnfollowResponse>(`/channels/subjects/${enc(subjectId)}/follow`, T),

  members: (nodeId: string, q: { status?: MembershipStatus; cursor?: string | null } = {}) =>
    api.get<MembersResponse>(`/channels/nodes/${enc(nodeId)}/members`, { ...T, query: { status: q.status, cursor: q.cursor ?? undefined, limit: 50 } }),
  decide: (nodeId: string, userId: string, body: MemberDecisionRequest) => api.post<unknown>(`/channels/nodes/${enc(nodeId)}/members/${enc(userId)}/decision`, body, T),

  codes: (nodeId: string) => api.get<JoinCodesResponse>(`/channels/nodes/${enc(nodeId)}/codes`, T),
  createCode: (nodeId: string, body: CreateJoinCodeRequest) => api.post<CreateJoinCodeResponse>(`/channels/nodes/${enc(nodeId)}/codes`, body, T),
  revokeCode: (codeId: string) => api.del<unknown>(`/channels/codes/${enc(codeId)}`, T),

  roles: (nodeId: string) => api.get<ChannelRolesResponse>(`/channels/nodes/${enc(nodeId)}/roles`, T),
  assignRole: (nodeId: string, body: AssignRoleRequest) => api.post<ChannelRoleView>(`/channels/nodes/${enc(nodeId)}/roles`, body, T),
  revokeRole: (roleId: string) => api.del<unknown>(`/channels/roles/${enc(roleId)}`, T),
};

export const accountApi = {
  me: () => api.get<MeResponse>('/accounts/me', T),
};
