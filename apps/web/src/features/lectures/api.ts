// Official lectures in subject spaces — the web client of /api/spaces/:spaceId/… (P1-T5 step 1; lectures-api.ts).
// Every call names the subject's space; the server binds it only for a viewer with access there (anything else is
// «not found»), so the client never decides access — it shows what the server answers and the server's reasons.
import type {
  ChannelTreeResponse,
  CreateReportRequest,
  CursorPage,
  DecideSubjectReviewResponse,
  LecturePublicationsResponse,
  LayersResponse,
  MeResponse,
  OfficialCorrectionsResponse,
  OfficialCorrectionStatus,
  OfficialCorrectionView,
  OfficialLectureDetail,
  OfficialLecturesResponse,
  OfficialLectureView,
  PatchPublicationRequest,
  PublicationItemsResponse,
  PublicationView,
  PublishOfficialVersionPreview,
  PublishRequest,
  ReportView,
  RepublishRequest,
  PublishOfficialVersionResponse,
  SubjectDuplicatesResponse,
  SubjectEventView,
  SubjectReviewResponse,
  UpstreamPreview,
  UploadOfficialVersionResponse,
  VersionCompareResponse,
  WithdrawOfficialLectureRequest,
} from '@medlevo/shared';
import { api } from '../../lib/api';

const T = { timeoutMs: 20_000 };
const S = (spaceId: string, rest: string) => `/spaces/${encodeURIComponent(spaceId)}${rest}`;

export const lecturesApi = {
  list: (spaceId: string, q: { status?: OfficialLectureView['status']; cursor?: string | null } = {}) =>
    api.get<OfficialLecturesResponse>(S(spaceId, '/lectures'), { ...T, query: { status: q.status, cursor: q.cursor ?? undefined, limit: 100 } }),
  detail: (spaceId: string, id: string) => api.get<OfficialLectureDetail>(S(spaceId, `/lectures/${encodeURIComponent(id)}`), T),
  create: (spaceId: string, body: { title: string; lecture_no?: number | null; held_on?: string | null }) => api.post<OfficialLectureView>(S(spaceId, '/lectures'), body, T),
  upload: (spaceId: string, id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return api.post<UploadOfficialVersionResponse>(S(spaceId, `/lectures/${encodeURIComponent(id)}/upload`), fd, { timeoutMs: 10 * 60_000 });
  },
  approve: (spaceId: string, id: string) => api.post<OfficialLectureView>(S(spaceId, `/lectures/${encodeURIComponent(id)}/approve`), {}, T),
  previewPublish: (spaceId: string, id: string, versionId: string) =>
    api.post<PublishOfficialVersionPreview>(S(spaceId, `/lectures/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/publish`), { preview: true }, T),
  publish: (spaceId: string, id: string, versionId: string, changeNote: string | null) =>
    api.post<PublishOfficialVersionResponse>(S(spaceId, `/lectures/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/publish`), { change_note: changeNote }, T),
  compare: (spaceId: string, id: string, from: string, to: string) =>
    api.get<VersionCompareResponse>(S(spaceId, `/lectures/${encodeURIComponent(id)}/versions/${encodeURIComponent(from)}/compare/${encodeURIComponent(to)}`), T),
  withdraw: (spaceId: string, id: string, body: WithdrawOfficialLectureRequest) => api.post<OfficialLectureDetail>(S(spaceId, `/lectures/${encodeURIComponent(id)}/withdraw`), body, T),
  corrections: (spaceId: string, q: { status?: OfficialCorrectionStatus } = {}) =>
    api.get<OfficialCorrectionsResponse>(S(spaceId, '/subject/corrections'), { ...T, query: { status: q.status } }),
  decideCorrection: (spaceId: string, lectureId: string, correctionId: string, decision: 'accept' | 'reject', note?: string) =>
    api.post<OfficialCorrectionView>(S(spaceId, `/lectures/${encodeURIComponent(lectureId)}/corrections/${encodeURIComponent(correctionId)}/decide`), { decision, ...(note ? { note_ar: note } : {}) }, T),
  duplicates: (spaceId: string) => api.get<SubjectDuplicatesResponse>(S(spaceId, '/subject/duplicates'), T),
  // (C2, AOS-3.18 / 3.11) the subject's review queue — Subject Moderators only (403 for anyone else)
  review: (spaceId: string) => api.get<SubjectReviewResponse>(S(spaceId, '/subject/review'), T),
  decideReview: (spaceId: string, itemId: string, action: 'accept' | 'reject') =>
    api.post<DecideSubjectReviewResponse>(S(spaceId, `/subject/review/${encodeURIComponent(itemId)}/decide`), { action }, T),
  events: (spaceId: string, cursor?: string | null) => api.get<CursorPage<SubjectEventView>>(S(spaceId, '/subject/events'), { ...T, query: { cursor: cursor ?? undefined } }),
  /** the original (or converted) file of a version, as a same-origin link */
  fileUrl: (spaceId: string, fileId: string) => `/api${S(spaceId, `/files/${encodeURIComponent(fileId)}`)}`,
};

/**
 * Course-only explanations of a lecture (P1-T5 step 3; publications-api.ts). The space's routes answer only members
 * of the subject; the server decides who may publish, edit, withdraw, follow or fork (every refusal says why).
 */
export const publicationsApi = {
  list: (spaceId: string, lectureId: string, cursor?: string | null) =>
    api.get<LecturePublicationsResponse>(S(spaceId, `/lectures/${encodeURIComponent(lectureId)}/publications`), { ...T, query: { cursor: cursor ?? undefined, limit: 50 } }),
  get: (spaceId: string, id: string) => api.get<PublicationView>(S(spaceId, `/publications/${encodeURIComponent(id)}`), T),
  /** `key`: the dialog's idempotency key (a retry after a lost answer returns the same publication) */
  publish: (spaceId: string, body: PublishRequest, key: string) =>
    api.post<PublicationView>(S(spaceId, '/publications'), body, { timeoutMs: 120_000, headers: { 'idempotency-key': key } }),
  republish: (spaceId: string, id: string, body: RepublishRequest) => api.post<PublicationView>(S(spaceId, `/publications/${encodeURIComponent(id)}/versions`), body, { timeoutMs: 120_000 }),
  patch: (spaceId: string, id: string, body: PatchPublicationRequest) => api.patch<PublicationView>(S(spaceId, `/publications/${encodeURIComponent(id)}`), body, T),
  withdraw: (spaceId: string, id: string) => api.post<PublicationView>(S(spaceId, `/publications/${encodeURIComponent(id)}/withdraw`), {}, T),
  items: (spaceId: string, id: string, versionNo: number, pageId?: string) =>
    api.get<PublicationItemsResponse>(S(spaceId, `/publications/${encodeURIComponent(id)}/versions/${versionNo}/items`), { ...T, query: { page_id: pageId } }),
  diff: (spaceId: string, id: string, from: number, to: number) => api.get<UpstreamPreview>(S(spaceId, `/publications/${encodeURIComponent(id)}/diff`), { ...T, query: { from, to } }),
  /** a page image of the official version (members only) */
  thumbnailUrl: (spaceId: string, pageId: string) => `/api${S(spaceId, `/versions/pages/${encodeURIComponent(pageId)}/thumbnail`)}`,
  /** «أبلغ» — P1-T4's moderation (one open report per person per explanation) */
  report: (body: CreateReportRequest) => api.post<ReportView>('/moderation/reports', body, T),
  /** the viewer's own layers on their copy of a lecture (the publish dialog chooses among them) */
  myLayers: (sourceId: string) => api.get<LayersResponse>('/annotations/layers', { ...T, query: { document_key: `source:${sourceId}` } }),
};

/** The publication page of a subject (features/lectures). */
export function publicationUrl(spaceId: string, publicationId: string): string {
  return `/subjects/${encodeURIComponent(spaceId)}/publications/${encodeURIComponent(publicationId)}`;
}

/** A subject the viewer may administer official content in (from P1-T4's channel tree). */
export interface AdminSubject {
  id: string;
  title: string;
  spaceId: string;
  /** a Subject Moderator / Admin here (or the platform admin): approve, publish, withdraw */
  moderator: boolean;
}

const OFFICIAL_ROLES = new Set(['subject_moderator', 'admin']);

/**
 * The subjects whose official content the viewer manages: every subject whose space the viewer may bind and where
 * they hold an official role (Subject Moderator, Admin, Contributor — inherited down the tree), or every bindable
 * subject for the platform admin. Read from P1-T4's tree; the server still decides every action.
 */
export async function loadAdminSubjects(roles: readonly string[]): Promise<AdminSubject[]> {
  const [tree, me] = await Promise.all([api.get<ChannelTreeResponse>('/channels/tree', { ...T, query: { depth: 7 } }), api.get<MeResponse>('/accounts/me', T)]);
  const out: AdminSubject[] = [];
  for (const n of tree.nodes) {
    if (n.kind !== 'subject' || !n.space_id || n.status !== 'active') continue;
    const held = n.viewer.roles;
    const moderator = me.is_platform_admin || held.some((r) => OFFICIAL_ROLES.has(r));
    if (moderator || held.some((r) => roles.includes(r))) out.push({ id: n.id, title: n.title, spaceId: n.space_id, moderator });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'ar'));
}
