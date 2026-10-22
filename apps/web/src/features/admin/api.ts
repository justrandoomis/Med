// «إدارة القنوات» — the moderation queue and actions (/api/moderation) and the scoped security audit (/api/admin/audit),
// P1-T4 step 2's routes. The tree, members, codes and roles use the channels client (features/channels/api.ts).
import type { ModerationActionRequest, ModerationActionView, ReportQueueResponse, ReportStatus, SecurityAuditResponse } from '@medlevo/shared';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };

export const adminApi = {
  queue: (scopeNodeId: string, q: { status?: ReportStatus; cursor?: string | null } = {}) =>
    api.get<ReportQueueResponse>('/moderation/queue', { ...T, query: { scope_node_id: scopeNodeId, status: q.status, cursor: q.cursor ?? undefined } }),
  act: (body: ModerationActionRequest) => api.post<ModerationActionView>('/moderation/actions', body, T),
  audit: (scopeNodeId: string, q: { action?: string; cursor?: string | null } = {}) =>
    api.get<SecurityAuditResponse>('/admin/audit', { ...T, query: { scope_node_id: scopeNodeId, action: q.action || undefined, cursor: q.cursor ?? undefined } }),
};
