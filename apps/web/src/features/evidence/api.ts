// Client for /api/evidence (contracts: @medlevo/shared evidence.ts + evidence-api.ts).
import type {
  ClaimView,
  ContentAlertsResponse,
  ContentAlertView,
  EvidenceBatchResponse,
  EvidenceRibbonResponse,
  EvidenceView,
  ScopeResolveResponse,
  SourceScope,
} from '@medlevo/shared';
import { api } from '../../lib/api';

export function fetchEvidence(id: string, pinnedVersionIds: string[] = []): Promise<{ evidence: EvidenceView }> {
  return api.get(`/evidence/${encodeURIComponent(id)}`, { query: pinnedVersionIds.length ? { pinned_version_ids: pinnedVersionIds.join(',') } : undefined, timeoutMs: 15_000 });
}

export function fetchEvidenceBatch(ids: string[], pinnedVersionIds: string[] = []): Promise<EvidenceBatchResponse> {
  return api.post('/evidence/batch', { ids, pinned_version_ids: pinnedVersionIds }, { timeoutMs: 20_000 });
}

export function fetchClaim(id: string): Promise<{ claim: ClaimView }> {
  return api.get(`/evidence/claims/${encodeURIComponent(id)}`, { timeoutMs: 15_000 });
}

export function fetchRibbon(ownerType: string, ownerId: string): Promise<EvidenceRibbonResponse> {
  return api.get('/evidence/ribbon', { query: { owner_type: ownerType, owner_id: ownerId }, timeoutMs: 15_000 });
}

export function resolveScopePreview(scope: SourceScope): Promise<ScopeResolveResponse> {
  return api.post('/evidence/scope/resolve', scope, { timeoutMs: 15_000 });
}

export function fetchAlerts(status: 'active' | 'all' | 'open' | 'acknowledged' | 'resolved' = 'active', sourceId?: string): Promise<ContentAlertsResponse> {
  return api.get('/evidence/alerts', { query: { status, source_id: sourceId }, timeoutMs: 20_000 });
}

export function acknowledgeAlert(id: string): Promise<{ alert: ContentAlertView }> {
  return api.post(`/evidence/alerts/${encodeURIComponent(id)}/ack`);
}

export function resolveAlert(id: string): Promise<{ alert: ContentAlertView }> {
  return api.post(`/evidence/alerts/${encodeURIComponent(id)}/resolve`);
}
