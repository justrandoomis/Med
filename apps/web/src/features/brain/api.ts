// Course Brain web — API paths and mutations (/api/brain, topics via /api/library). GETs go through the library's
// useQuery (opt-in device cache → readable offline); writes always need the server and refresh the affected queries.
import type {
  BrainConceptCreateRequest,
  BrainConceptPatchRequest,
  BrainConceptResponse,
  BrainExtractResponse,
  ConceptRelationCreateRequest,
  ConceptRelationPatchRequest,
  ConceptRelationView,
  TopicLinkView,
  TopicSuggestResponse,
  TopicView,
} from '@medlevo/shared';
import { api } from '../../lib/api';
import { mutate } from '../library/data';

const e = encodeURIComponent;
const q = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const t = s.toString();
  return t ? `?${t}` : '';
};

export const BRAIN_PATHS = {
  course: (nodeId: string) => `/brain/courses/${e(nodeId)}`,
  map: (nodeId: string, sourceId?: string | null) => `/brain/map${q({ course_node_id: nodeId, source_id: sourceId })}`,
  coverage: (opts: { courseNodeId?: string | null; sourceId?: string | null }) => `/brain/coverage${q({ course_node_id: opts.courseNodeId, source_id: opts.sourceId })}`,
  knowledge: (courseNodeId?: string | null) => `/brain/knowledge${q({ course_node_id: courseNodeId })}`,
  concepts: (opts: { courseNodeId?: string | null; sourceId?: string | null; status?: string | null; q?: string | null }) =>
    `/brain/concepts${q({ course_node_id: opts.courseNodeId, source_id: opts.sourceId, status: opts.status, q: opts.q })}`,
  concept: (id: string) => `/brain/concepts/${e(id)}`,
  relations: (opts: { courseNodeId?: string | null; conceptId?: string | null }) => `/brain/relations${q({ course_node_id: opts.courseNodeId, concept_id: opts.conceptId })}`,
  topics: '/brain/topics',
  topic: (id: string) => `/brain/topics/${e(id)}`,
  progress: (courseNodeId: string) => `/learning/progress${q({ course_node_id: courseNodeId })}`,
};

const BRAIN = ['/brain', '/learning/progress'];

export const brainApi = {
  extract: (body: { source_id?: string; course_node_id?: string }) => mutate(() => api.post<BrainExtractResponse>('/brain/extract', body), BRAIN),
  patchConcept: (id: string, body: BrainConceptPatchRequest) => mutate(() => api.patch<BrainConceptResponse>(`/brain/concepts/${e(id)}`, body), BRAIN),
  createConcept: (body: BrainConceptCreateRequest) => mutate(() => api.post<BrainConceptResponse>('/brain/concepts', body), BRAIN),
  mergeConcept: (id: string, intoId: string) => mutate(() => api.post<BrainConceptResponse>(`/brain/concepts/${e(id)}/merge`, { into_id: intoId }), BRAIN),
  createRelation: (body: ConceptRelationCreateRequest) => mutate(() => api.post<{ relation: ConceptRelationView }>('/brain/relations', body), BRAIN),
  patchRelation: (id: string, body: ConceptRelationPatchRequest) => mutate(() => api.patch<{ relation: ConceptRelationView }>(`/brain/relations/${e(id)}`, body), BRAIN),
  deleteRelation: (id: string) => mutate(() => api.del<{ ok: true }>(`/brain/relations/${e(id)}`), BRAIN),
  // topics live in the library module
  createTopic: (body: { title: string; title_ar?: string | null; parent_topic_id?: string | null }) => mutate(() => api.post<{ topic: TopicView }>('/library/topics', body), ['/brain', '/library']),
  patchTopic: (id: string, body: { title?: string; title_ar?: string | null; parent_topic_id?: string | null }) =>
    mutate(() => api.patch<{ topic: TopicView }>(`/library/topics/${e(id)}`, body), ['/brain', '/library']),
  deleteTopic: (id: string) => mutate(() => api.del<{ ok: true }>(`/library/topics/${e(id)}`), ['/brain', '/library']),
  linkTopic: (topicId: string, entityType: string, entityId: string) =>
    mutate(() => api.post<{ link: TopicLinkView }>(`/library/topics/${e(topicId)}/links`, { entity_type: entityType, entity_id: entityId }), ['/brain', '/library']),
  decideTopicLink: (linkId: string, status: 'accepted' | 'rejected' | 'suggested') => mutate(() => api.patch<{ link: TopicLinkView }>(`/library/topic-links/${e(linkId)}`, { status }), ['/brain', '/library']),
  unlinkTopic: (linkId: string) => mutate(() => api.del<{ ok: true }>(`/library/topic-links/${e(linkId)}`), ['/brain', '/library']),
  suggestTopics: (topicId?: string) => mutate(() => api.post<TopicSuggestResponse>('/brain/topics/suggest', topicId ? { topic_id: topicId } : {}), ['/brain', '/library']),
};

export const conceptUrl = (id: string) => `/concepts/${e(id)}`;
export const conceptsUrl = (opts: { courseNodeId?: string | null; sourceId?: string | null } = {}) => `/concepts${q({ course: opts.courseNodeId, source: opts.sourceId })}`;
export const knowledgeUrl = (courseNodeId?: string | null) => `/knowledge${q({ course: courseNodeId })}`;
export const topicUrl = (id: string) => `/library/topics/${e(id)}`;
export const courseTabUrl = (nodeId: string, tab: 'sources' | 'map' | 'progress' | 'coverage') => `/library/${e(nodeId)}${tab === 'sources' ? '' : `?tab=${tab}`}`;
