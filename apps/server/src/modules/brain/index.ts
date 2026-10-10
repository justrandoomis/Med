// Course Brain module (track F2) — §05 topics, §16 Lecture Compilation & Course Brain, §23 course page, §31 knowledge
// map, §36 Question Coverage Map, §44 Student Knowledge Map. Mounted at /api/brain. Deterministic: no AI anywhere.
//
// Owns: concept_alias, concept_extraction, concept_relation (all rows) and the STATED concept_mention rows (role not
// 'candidate_*'); writes concept rows (new suggestions, owner corrections). Topic links are written only through the
// library module's services. Migration range 0800–0849 (0800_course_brain.sql).
//
// Routes (owner session + CSRF via the global guard; zod on every input):
//   GET    /courses/:nodeId                         extraction status per lecture, objectives, totals
//   POST   /extract {source_id | course_node_id}    (re-)extract — enqueues extract_knowledge jobs
//   GET    /concepts?course_node_id=&source_id=&status=&q=     concepts with their roles (correction view)
//   POST   /concepts                                owner concept
//   GET    /concepts/:id                            concept + every mention (exact quotes, pages) + relations
//   PATCH  /concepts/:id                            accept / reject / rename / kind / note
//   POST   /concepts/:id/merge {into_id}            merge into another concept
//   GET    /relations?course_node_id=&concept_id=&status=
//   POST   /relations · PATCH /relations/:id · DELETE /relations/:id
//   GET    /map?course_node_id=&source_id=          knowledge map graph (lectures ↔ concepts ↔ questions)
//   GET    /coverage?course_node_id= | source_id=   Question Coverage Map
//   GET    /knowledge?course_node_id=               Student Knowledge Map
//   GET    /topics · GET /topics/:id · POST /topics/suggest {topic_id?}
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EXTRACT_KNOWLEDGE_JOB_KIND,
  RELATION_KINDS,
  type BrainConceptListResponse,
  type BrainConceptResponse,
  type BrainExtractResponse,
  type ConceptRelationListResponse,
  type CourseBrainResponse,
  type CoverageResponse,
  type ExtractKnowledgeJobInput,
  type KnowledgeMapResponse,
  type StudentKnowledgeResponse,
  type TopicDetailResponse,
  type TopicSuggestResponse,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { parseBody, parseParams, parseQuery } from '../../lib/http';
import { createConcept, getConcept, listConcepts, mergeConcept, patchConcept } from './concepts';
import { courseBrain, enqueueExtraction } from './course';
import { coverage, versionConcepts } from './coverage';
import { EXTRACTOR_VERSION } from './extract';
import { knowledgeMap } from './map';
import { createRelation, deleteRelation, listRelations, patchRelation } from './relations';
import { runKnowledgeExtraction } from './run';
import { courseSources, versionIdsOf } from './store';
import { studentKnowledge } from './student';
import { suggestTopicLinks, topicDetail, topicList } from './topics';

export { EXTRACTOR_VERSION } from './extract';
export { findConceptByName, resolveConceptId } from './resolve';

const id = z.string().trim().min(1).max(64);
const status = z.enum(['suggested', 'accepted', 'rejected']);
const name = z.string().trim().max(120).nullable().optional();
const idParams = z.object({ id });
const nodeParams = z.object({ nodeId: id });
const jobInput = z.object({ version_id: id }).strict();
const extractBody = z
  .object({ source_id: id.optional(), course_node_id: id.optional() })
  .strict()
  .refine((b) => !!b.source_id !== !!b.course_node_id, 'source_id أو course_node_id (أحدهما فقط)');
const conceptsQuery = z.object({
  course_node_id: id.optional(),
  source_id: id.optional(),
  status: z.enum(['suggested', 'accepted', 'rejected', 'all']).optional(),
  q: z.string().trim().max(120).optional(),
});
const conceptPatch = z
  .object({ status: status.optional(), name_en: name, name_ar: name, kind: z.string().trim().max(60).nullable().optional(), note: z.string().max(2000).nullable().optional() })
  .strict();
const conceptCreate = z.object({ name_en: name, name_ar: name, kind: z.string().trim().max(60).nullable().optional() }).strict();
const mergeBody = z.object({ into_id: id }).strict();
const relationsQuery = z.object({ course_node_id: id.optional(), concept_id: id.optional(), status: status.optional() });
const relationCreate = z.object({ from_concept_id: id, to_concept_id: id, relation: z.enum(RELATION_KINDS), note: z.string().max(1000).nullable().optional() }).strict();
const relationPatch = z.object({ status: status.optional(), relation: z.enum(RELATION_KINDS).optional(), note: z.string().max(1000).nullable().optional() }).strict();
const mapQuery = z.object({ course_node_id: id, source_id: id.optional() });
const coverageQuery = z
  .object({ course_node_id: id.optional(), source_id: id.optional() })
  .refine((q) => !!q.course_node_id !== !!q.source_id, 'course_node_id أو source_id (أحدهما فقط)');
const knowledgeQuery = z.object({ course_node_id: id.optional() });
const suggestBody = z.object({ topic_id: id.optional() }).strict();

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('course_brain', 'available');
  ctx.capabilities.set('knowledge_map', 'available');
  ctx.capabilities.set('coverage_map', 'available');

  ctx.jobs.register<ExtractKnowledgeJobInput, unknown>(EXTRACT_KNOWLEDGE_JOB_KIND, {
    version: EXTRACTOR_VERSION,
    maxAttempts: 2,
    timeoutMs: 5 * 60 * 1000,
    concurrency: 1,
    inputSchema: jobInput as unknown as z.ZodType<ExtractKnowledgeJobInput>,
    handler: async (run) => {
      run.progress({ stage: 'extract' });
      return runKnowledgeExtraction(ctx, run.input.version_id, run.id);
    },
  });

  // ── course page ──
  app.get('/courses/:nodeId', async (req): Promise<CourseBrainResponse> => courseBrain(ctx, parseParams(nodeParams, req).nodeId));
  app.post('/extract', async (req): Promise<BrainExtractResponse> => {
    const b = parseBody(extractBody, req);
    return enqueueExtraction(ctx, { sourceId: b.source_id, courseNodeId: b.course_node_id });
  });

  // ── concepts ──
  app.get('/concepts', async (req): Promise<BrainConceptListResponse> => {
    const q = parseQuery(conceptsQuery, req);
    return listConcepts(ctx, { courseNodeId: q.course_node_id ?? null, sourceId: q.source_id ?? null, status: q.status, q: q.q ?? null });
  });
  app.post('/concepts', async (req): Promise<BrainConceptResponse> => ({ concept: createConcept(ctx, parseBody(conceptCreate, req)) }));
  app.get('/concepts/:id', async (req): Promise<BrainConceptResponse> => {
    const cid = parseParams(idParams, req).id;
    const concept = getConcept(ctx, cid);
    return { concept, relations: listRelations(ctx, { conceptIds: [concept.merged_into?.id ?? concept.id] }) };
  });
  app.patch('/concepts/:id', async (req): Promise<BrainConceptResponse> => ({ concept: patchConcept(ctx, parseParams(idParams, req).id, parseBody(conceptPatch, req)) }));
  app.post('/concepts/:id/merge', async (req): Promise<BrainConceptResponse> => ({ concept: mergeConcept(ctx, parseParams(idParams, req).id, parseBody(mergeBody, req).into_id) }));

  // ── relations ──
  app.get('/relations', async (req): Promise<ConceptRelationListResponse> => {
    const q = parseQuery(relationsQuery, req);
    let conceptIds: string[] | undefined;
    if (q.concept_id) conceptIds = [q.concept_id];
    else if (q.course_node_id) conceptIds = [...new Set(versionIdsOf(courseSources(ctx, q.course_node_id)).flatMap((v) => versionConcepts(ctx, v).map((c) => c.id)))];
    return {
      items: listRelations(ctx, { conceptIds, status: q.status }),
      notes_ar: [
        'العلاقات «المستنتجة» اقتراحات من ترتيب المحاضرات وأقسامها، وليست نصًا من المحاضرة. اقبلها أو ارفضها؛ قرارك يبقى عند إعادة الاستخراج.',
        'فتح موضع متطلب سابق في محاضرة أخرى لا يغيّر نطاق المصدر (Source Lock) في جلسة الدراسة.',
      ],
    };
  });
  app.post('/relations', async (req) => ({ relation: createRelation(ctx, parseBody(relationCreate, req)) }));
  app.patch('/relations/:id', async (req) => ({ relation: patchRelation(ctx, parseParams(idParams, req).id, parseBody(relationPatch, req)) }));
  app.delete('/relations/:id', async (req) => {
    deleteRelation(ctx, parseParams(idParams, req).id);
    return { ok: true };
  });

  // ── maps ──
  app.get('/map', async (req): Promise<KnowledgeMapResponse> => {
    const q = parseQuery(mapQuery, req);
    return knowledgeMap(ctx, q.course_node_id, { sourceId: q.source_id ?? null });
  });
  app.get('/coverage', async (req): Promise<CoverageResponse> => {
    const q = parseQuery(coverageQuery, req);
    return coverage(ctx, { courseNodeId: q.course_node_id ?? null, sourceId: q.source_id ?? null });
  });
  app.get('/knowledge', async (req): Promise<StudentKnowledgeResponse> => studentKnowledge(ctx, { courseNodeId: parseQuery(knowledgeQuery, req).course_node_id ?? null }));

  // ── topics ──
  app.get('/topics', async () => topicList(ctx));
  app.get('/topics/:id', async (req): Promise<TopicDetailResponse> => topicDetail(ctx, parseParams(idParams, req).id));
  app.post('/topics/suggest', async (req): Promise<TopicSuggestResponse> => suggestTopicLinks(ctx, parseBody(suggestBody, req).topic_id));
}
