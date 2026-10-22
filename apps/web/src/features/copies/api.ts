// Study copies — the web client of /api/copies (P1-T5 step 2; copies-api.ts). A copy lives in the viewer's OWN vault:
// every call answers the viewer's copies only; whether the viewer may study a lecture is the server's decision (a
// lecture the viewer may not see answers «not found», exactly like a missing one).
import type {
  ApplyUpstreamRequest,
  ApplyUpstreamResponse,
  DocumentCopiesResponse,
  DocumentCopyView,
  LinkToOfficialRequest,
  LinkToOfficialResponse,
  OfficialLinkCandidatesResponse,
  PatchDocumentCopyRequest,
  StartStudyingRequest,
  StartStudyingResponse,
  UpstreamPreview,
} from '@medlevo/shared';
import { api } from '../../lib/api';
import { getSyncEngine } from '../../lib/sync';

const T = { timeoutMs: 20_000 };
const enc = encodeURIComponent;

export const copiesApi = {
  /** «ابدأ الدراسة»: idempotent by the client id (same id + same body → the copy that exists) */
  start: (body: StartStudyingRequest) => api.post<StartStudyingResponse>('/copies', body, T),
  list: (q: { source_id?: string; space_id?: string; lecture_id?: string }) => api.get<DocumentCopiesResponse>('/copies', { ...T, query: q, skipAuthRedirect: true }),
  get: (id: string) => api.get<DocumentCopyView>(`/copies/${enc(id)}`, T),
  patch: (id: string, body: PatchDocumentCopyRequest) => api.patch<DocumentCopyView>(`/copies/${enc(id)}`, body, T),
  /** official lectures of the viewer's subjects that match a PRIVATE source (same file, or most pages) */
  linkCandidates: (sourceId: string) => api.get<OfficialLinkCandidatesResponse>('/copies/link-candidates', { ...T, query: { source_id: sourceId }, skipAuthRedirect: true }),
  /** «اربط بالمحاضرة الرسمية»: copies the private source's items onto the official version (the private one unchanged) */
  link: (body: LinkToOfficialRequest) => api.post<LinkToOfficialResponse>('/copies/link', body, { timeoutMs: 120_000 }),
  /** (P1-T5 step 3) what «طبّق التحديث» would change in a followed copy — nothing changes before the tap */
  upstream: (id: string) => api.get<UpstreamPreview>(`/copies/${enc(id)}/upstream`, T),
  /** «طبّق التحديث» (or `skip: true`: «تخطَّ هذا الإصدار»); a replay changes nothing */
  applyUpstream: (id: string, body: ApplyUpstreamRequest) => api.post<ApplyUpstreamResponse>(`/copies/${enc(id)}/upstream/apply`, body, { timeoutMs: 120_000 }),
};

/**
 * A fork / follow / applied update writes rows in the viewer's vault on the server: pull them now so the reader shows
 * them (best effort — the regular sync brings them anyway).
 */
export function pullCopyChanges(): void {
  try {
    void getSyncEngine()
      .syncNow({ pull: true })
      .catch(() => undefined);
  } catch {
    // no sync engine (signed out in the meantime): the next sign-in pulls everything
  }
}

/** The reader of a copy: `copy` tells the copy bar which copy the viewer came for (its own notes go to that copy). */
export function copyStudyUrl(copy: Pick<DocumentCopyView, 'id' | 'source_id'>, pageIndex?: number | null): string {
  const q = new URLSearchParams();
  if (pageIndex != null) q.set('page', String(pageIndex));
  q.set('copy', copy.id);
  return `/study/${enc(copy.source_id)}?${q.toString()}`;
}

/** The official lecture page of a subject (features/lectures). `page` (0-based) is carried to the reader. */
export function lectureUrl(spaceId: string, lectureId: string, page?: number | null): string {
  const base = `/subjects/${enc(spaceId)}/lectures/${enc(lectureId)}`;
  return page != null && page > 0 ? `${base}?page=${page}` : base;
}
