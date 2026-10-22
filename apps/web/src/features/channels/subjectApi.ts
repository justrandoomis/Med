// What the subject page reads from P1-T5's API (official lectures, attachments, the updates feed of a subject's space)
// and the viewer's own copies (/api/copies, their vault). Every space route binds the subject's space only for a viewer
// with access there; anything else answers «not found» — the page never decides access itself.
import type { CursorPage, DocumentCopiesResponse, OfficialLecturesResponse, SubjectAttachmentsResponse, SubjectEventView } from '@medlevo/shared';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };
const S = (spaceId: string, rest: string) => `/spaces/${encodeURIComponent(spaceId)}${rest}`;

export const subjectApi = {
  lectures: (spaceId: string, cursor?: string | null) => api.get<OfficialLecturesResponse>(S(spaceId, '/lectures'), { ...T, query: { cursor: cursor ?? undefined, limit: 100 } }),
  attachments: (spaceId: string) => api.get<SubjectAttachmentsResponse>(S(spaceId, '/subject/attachments'), T),
  events: (spaceId: string, cursor?: string | null) => api.get<CursorPage<SubjectEventView>>(S(spaceId, '/subject/events'), { ...T, query: { cursor: cursor ?? undefined } }),
  /** the viewer's own copies of this subject's lectures (vault rows) */
  copies: (spaceId: string) => api.get<DocumentCopiesResponse>('/copies', { ...T, query: { space_id: spaceId }, skipAuthRedirect: true }),
  /** a subject file as a same-origin link (the space route re-checks access) */
  fileUrl: (spaceId: string, fileId: string) => `/api${S(spaceId, `/files/${encodeURIComponent(fileId)}`)}`,
};
