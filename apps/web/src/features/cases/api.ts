// Clinical cases / OSCE / viva server calls (/api/cases). Shapes come from @medlevo/shared (cases-api.ts).
// The engine runs on the server (the definition — and so the solution — is never sent to the runner); each event
// carries a client id so a retried request is never applied twice.
import type {
  CaseAttemptListResponse,
  CaseDetailView,
  CaseEventInput,
  CaseEventResponse,
  CaseEvidenceSuggestRequest,
  CaseEvidenceSuggestResponse,
  CaseGenerateRequest,
  CaseListResponse,
  CaseReportView,
  CaseRunView,
  CaseSaveRequest,
  CaseStartRequest,
  CaseSummaryView,
} from '@medlevo/shared';
import { newId } from '@medlevo/shared';
import { api } from '../../lib/api';

const enc = encodeURIComponent;

export const casesApi = {
  list: (kind?: string) => api.get<CaseListResponse>('/cases', { query: { kind } }),
  get: (id: string) => api.get<CaseDetailView>(`/cases/${enc(id)}`),
  create: (body: CaseSaveRequest) => api.post<CaseDetailView>('/cases', body, { timeoutMs: 120_000 }),
  update: (id: string, body: CaseSaveRequest) => api.put<CaseDetailView>(`/cases/${enc(id)}`, body, { timeoutMs: 120_000 }),
  trash: (id: string) => api.del<{ ok: true }>(`/cases/${enc(id)}`),
  restore: (id: string) => api.post<CaseDetailView>(`/cases/${enc(id)}/restore`, {}),
  suggestEvidence: (body: CaseEvidenceSuggestRequest) => api.post<CaseEvidenceSuggestResponse>('/cases/evidence/suggest', body, { timeoutMs: 30_000 }),
  generate: (body: CaseGenerateRequest) => api.post<{ case: CaseSummaryView }>('/cases/generate', body, { timeoutMs: 30_000 }),
  start: (caseId: string, body: CaseStartRequest) => api.post<CaseRunView>(`/cases/${enc(caseId)}/attempts`, body, { timeoutMs: 30_000 }),
  attempts: (caseId?: string) => api.get<CaseAttemptListResponse>('/cases/attempts', { query: { case_id: caseId } }),
  run: (attemptId: string) => api.get<CaseRunView>(`/cases/attempts/${enc(attemptId)}`),
  /** `event_id` is generated here unless the caller retries with the same one */
  event: (attemptId: string, event: DistributiveOmit<CaseEventInput, 'event_id'> & { event_id?: string }) =>
    api.post<CaseEventResponse>(`/cases/attempts/${enc(attemptId)}/events`, { ...event, event_id: event.event_id ?? newId() }, { timeoutMs: 90_000 }),
  report: (attemptId: string) => api.get<CaseReportView>(`/cases/attempts/${enc(attemptId)}/report`),
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
