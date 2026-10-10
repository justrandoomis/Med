// Study Book module (track C2) — /api/studybook. Owns artifact, content_block, contextual_thread, message and the
// 0450 tables (artifact_section, explanation_rule_override, artifact_reanchor). Uses the evidence module's
// services for Source Lock, retrieval, evidence packs, claim validation, dependencies and cache keys; uses the AI
// orchestrator for every model call. See docs/modules/studybook.md.
//
//   POST /explain                       ExplainRequest (explain | simplify | translate | explain_image) → ExplainResponse
//   POST /compare                       CompareRequest → ExplainResponse (comparison_table, claims per cell)
//   GET  /artifacts?source_id=&kind=    recent generated content of a source (history)
//   GET  /artifacts/:id                 StudyArtifactView · POST /artifacts/:id/freeze {frozen}
//   GET  /books?source_id=              StudyBookStatusResponse · POST /books (generate / regenerate)
//   GET  /books/:id · POST /books/:id/resume · /cancel · /freeze
//   POST /summaries/preview · POST /summaries · GET /summaries/:id
//   POST /threads · GET /threads?source_id=&page_id= · GET /threads/:id · POST /threads/:id/messages · /archive
//   POST /messages/:id/save-note        → note (origin 'ai_answer') through the annotations sync handler
//   GET  /rules?source_id=&node_id= · PUT /rules/owner · PUT|DELETE /rules/nodes/:nodeId
//   GET|POST /terms · PATCH|DELETE /terms/:id   the owner's terminology dictionary (§21) — see below
// Terminology: `medical_term` is owned by the evidence module (ARCHITECTURE §2), which implements its CRUD once at
// /api/evidence/terms (validation, uniqueness, audit; also used by retrieval / search expansion). The Study Book
// contract path /api/studybook/terms FORWARDS to that implementation unchanged (same session, CSRF and origin
// headers), so there is a single write path to the table. This module reads the dictionary to tell the generator
// the owner's preferred renderings (terms.ts). Source text is never edited.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EXPLANATION_TEMPLATES, type ExplanationRules, type ExplanationRulesResponse, type StudyArtifactView } from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { fromJson, toJson } from '../../db/db';
import { AppError } from '../../lib/errors';
import { parseBody, parseParams, parseQuery, RATE_LIMITS } from '../../lib/http';
import { artifactView, requireArtifact, setFrozen } from './artifacts';
import {
  bookForSource,
  bookView,
  cancelSectioned,
  createStudyBook,
  createSummary,
  resumeSectioned,
  SECTION_JOB_VERSION,
  sectionJobHandler,
  STUDY_BOOK_JOB,
  summaryPreview,
  SUMMARY_JOB,
  type SectionJobInput,
  type StudybookHooks,
} from './book';
import { archiveThread, createThread, getThread, listThreads, postMessage, saveAnswerAsNote } from './chat';
import { compareItems, explainSelection } from './explain';
import { registerDiagramRoutes } from './diagrams';
import { nodeChain, nodeChainForSource, readOverride, resolveRules, rulesPatchSchema, templateForNode } from './rules';
import { compareBodySchema, explainBodySchema, messageCreateSchema, saveNoteSchema, studyBookBodySchema, summaryBodySchema, threadCreateSchema } from './schema';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
/** what the rail's history lists (study books / summaries have their own views) */
const ARTIFACT_KINDS_FOR_HISTORY = ['explanation', 'figure_explanation', 'comparison'] as const;
const idParams = z.object({ id: ID });
const nodeParams = z.object({ nodeId: ID });
const freezeBody = z.object({ frozen: z.boolean() }).strict();
const listQuery = z.object({
  source_id: ID.optional(),
  kind: z.enum(['explanation', 'figure_explanation', 'comparison', 'summary', 'study_book', 'chat_answer']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const bookQuery = z.object({ source_id: ID });
const threadsQuery = z.object({ source_id: ID.optional(), page_id: ID.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const rulesQuery = z.object({ source_id: ID.optional(), node_id: ID.optional() });

export interface StudybookModuleOptions {
  hooks?: StudybookHooks;
}

/** Headers carried over when forwarding to the owning module (credentials + CSRF/origin checks run again there). */
const FORWARDED_HEADERS = ['cookie', 'x-medlevo-csrf', 'origin', 'user-agent', 'accept-language'] as const;

/** Forward a terminology request to the evidence module's single implementation; status and body pass through. */
async function forwardToEvidenceTerms(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, suffix: string): Promise<FastifyReply> {
  const headers: Record<string, string> = {};
  for (const h of FORWARDED_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  const hasBody = req.body !== undefined && req.body !== null && req.method !== 'GET' && req.method !== 'DELETE';
  if (hasBody) headers['content-type'] = 'application/json';
  const res = await app.inject({
    method: req.method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: `/api/evidence/terms${suffix}`,
    headers,
    ...(hasBody ? { payload: JSON.stringify(req.body) } : {}),
  });
  const type = res.headers['content-type'];
  reply.code(res.statusCode);
  if (typeof type === 'string') reply.header('content-type', type);
  return reply.send(res.body);
}

const NOT_AI_REASON = 'تتطلب ضبط مزود ذكاء اصطناعي على الخادم (ANTHROPIC_API_KEY).';

function registerCapabilities(ctx: ModuleOptions['ctx']): void {
  const st = ctx.ai.status();
  const set = (key: Parameters<typeof ctx.capabilities.set>[0], task: keyof typeof st.tasks) => {
    if (!st.configured) {
      ctx.capabilities.set(key, 'requires_configuration', NOT_AI_REASON);
      return;
    }
    const t = st.tasks[task];
    // a provider that cannot do the task is a configuration matter, not a working feature
    if (!t.model) ctx.capabilities.set(key, 'requires_configuration', t.reason_ar ?? NOT_AI_REASON);
    else ctx.capabilities.set(key, 'available');
  };
  set('ai.explain', 'explain');
  set('ai.chat', 'chat');
  set('ai.study_book', 'study_book');
  set('ai.summaries', 'summarize');
  // figures: vision when the provider has it; otherwise caption / OCR-label explanations (clearly marked)
  if (st.configured && !st.tasks.vision_figure.model && st.tasks.explain.model) {
    ctx.capabilities.set('ai.figure_explain', 'available', 'يُشرح الشكل من تعليقه ونصوصه المقروءة آليًا فقط: المزود الحالي لا يدعم الرؤية (vision).');
  } else set('ai.figure_explain', 'vision_figure');
}

function rulesResponse(ctx: ModuleOptions['ctx'], q: { source_id?: string; node_id?: string }): ExplanationRulesResponse {
  const rules: ExplanationRules = resolveRules(ctx, { sourceId: q.source_id ?? null, nodeId: q.node_id ?? null });
  const s = ctx.settings.get();
  const chain = q.node_id ? nodeChain(ctx, q.node_id) : nodeChainForSource(ctx, q.source_id);
  const nearest = chain[0] ?? null;
  return {
    rules,
    layers: {
      settings: { level: s.explanation_level, dialect: s.dialect, custom_instruction: s.custom_instruction, socratic: s.socratic_default },
      owner: readOverride(ctx, 'owner', 'owner'),
      node: nearest
        ? { node_id: nearest.id, title: nearest.title, template_key: templateForNode(chain.find((n) => templateForNode(n.template))?.template) ?? null, override: readOverride(ctx, 'node', nearest.id) }
        : null,
    },
    templates: EXPLANATION_TEMPLATES,
  };
}

export function createStudybookModule(opts: StudybookModuleOptions = {}) {
  return async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
    registerCapabilities(ctx);
    const handler = sectionJobHandler(ctx, opts.hooks ?? {});
    const jobDef = {
      version: SECTION_JOB_VERSION,
      maxAttempts: 3,
      timeoutMs: 60 * 60 * 1000,
      concurrency: 1,
      inputSchema: z.object({ artifact_id: ID }).strict() as unknown as z.ZodType<SectionJobInput>,
      handler,
    };
    ctx.jobs.register<SectionJobInput, unknown>(STUDY_BOOK_JOB, jobDef);
    ctx.jobs.register<SectionJobInput, unknown>(SUMMARY_JOB, jobDef);

    const ai = { config: { rateLimit: RATE_LIMITS.ai } };

    // ───────── explanations ─────────
    app.post('/explain', ai, async (req) => explainSelection(ctx, parseBody(explainBodySchema, req)));
    app.post('/compare', ai, async (req) => compareItems(ctx, parseBody(compareBodySchema, req)));

    app.get('/artifacts', async (req): Promise<{ artifacts: Array<Pick<StudyArtifactView, 'id' | 'kind' | 'title' | 'status' | 'version_no' | 'lineage_id' | 'created_at' | 'is_frozen'> & { anchor_page_id: string | null }> }> => {
      const q = parseQuery(listQuery, req);
      const where = ['1 = 1'];
      const params: unknown[] = [];
      if (q.source_id) {
        where.push('primary_source_id = ?');
        params.push(q.source_id);
      }
      if (q.kind) {
        where.push('kind = ?');
        params.push(q.kind);
      } else {
        where.push(`kind IN (${ARTIFACT_KINDS_FOR_HISTORY.map(() => '?').join(',')})`);
        params.push(...ARTIFACT_KINDS_FOR_HISTORY);
      }
      const rows = ctx.db.all<{ id: string; kind: StudyArtifactView['kind']; title: string | null; status: StudyArtifactView['status']; version_no: number; lineage_id: string; created_at: number; is_frozen: number; anchor_json: string | null }>(
        `SELECT id, kind, title, status, version_no, lineage_id, created_at, is_frozen, anchor_json FROM artifact WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...params, q.limit],
      );
      return {
        artifacts: rows.map(({ anchor_json, is_frozen, ...r }) => ({ ...r, is_frozen: is_frozen === 1, anchor_page_id: fromJson<{ page_id?: string | null }>(anchor_json)?.page_id ?? null })),
      };
    });
    app.get('/artifacts/:id', async (req) => ({ artifact: artifactView(ctx, parseParams(idParams, req).id) }));
    app.post('/artifacts/:id/freeze', async (req) => {
      const { id } = parseParams(idParams, req);
      return { artifact: setFrozen(ctx, id, parseBody(freezeBody, req).frozen) };
    });

    // ───────── Study Book ─────────
    app.get('/books', async (req) => bookForSource(ctx, parseQuery(bookQuery, req).source_id));
    app.post('/books', ai, async (req) => createStudyBook(ctx, parseBody(studyBookBodySchema, req)));
    app.get('/books/:id', async (req) => {
      const { id } = parseParams(idParams, req);
      const a = requireArtifact(ctx, id);
      if (a.kind !== 'study_book' && a.kind !== 'summary') throw new AppError('NOT_FOUND', 'كتاب الدراسة المطلوب غير موجود.', 404);
      return bookView(ctx, id);
    });
    app.post('/books/:id/resume', ai, async (req) => resumeSectioned(ctx, parseParams(idParams, req).id));
    app.post('/books/:id/cancel', async (req) => cancelSectioned(ctx, parseParams(idParams, req).id));
    app.post('/books/:id/freeze', async (req) => {
      const { id } = parseParams(idParams, req);
      setFrozen(ctx, id, parseBody(freezeBody, req).frozen);
      return bookView(ctx, id);
    });

    // ───────── summaries ─────────
    app.post('/summaries/preview', async (req) => summaryPreview(ctx, parseBody(summaryBodySchema, req)));
    app.post('/summaries', ai, async (req) => createSummary(ctx, parseBody(summaryBodySchema, req)));
    app.get('/summaries/:id', async (req) => {
      const { id } = parseParams(idParams, req);
      if (requireArtifact(ctx, id).kind !== 'summary') throw new AppError('NOT_FOUND', 'الملخص المطلوب غير موجود.', 404);
      return bookView(ctx, id);
    });

    // ───────── contextual chat ─────────
    app.post('/threads', async (req) => createThread(ctx, parseBody(threadCreateSchema, req)));
    app.get('/threads', async (req) => ({ threads: listThreads(ctx, parseQuery(threadsQuery, req)) }));
    app.get('/threads/:id', async (req) => getThread(ctx, parseParams(idParams, req).id));
    app.post('/threads/:id/messages', ai, async (req) => postMessage(ctx, parseParams(idParams, req).id, parseBody(messageCreateSchema, req)));
    app.post('/threads/:id/archive', async (req) => ({ thread: archiveThread(ctx, parseParams(idParams, req).id) }));
    app.post('/messages/:id/save-note', async (req) => saveAnswerAsNote(ctx, parseParams(idParams, req).id, parseBody(saveNoteSchema, req)));

    // ───────── explanation rules (§19) ─────────
    app.get('/rules', async (req) => rulesResponse(ctx, parseQuery(rulesQuery, req)));
    app.put('/rules/owner', async (req) => {
      const patch = parseBody(rulesPatchSchema, req);
      const before = readOverride(ctx, 'owner', 'owner');
      const merged = { ...(before ?? {}), ...patch, include: { ...(before?.include ?? {}), ...(patch.include ?? {}) } };
      ctx.db.run(
        `INSERT INTO explanation_rule_override (target_type, target_id, rules_json, updated_at) VALUES ('owner', 'owner', ?, ?)
         ON CONFLICT (target_type, target_id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at`,
        [toJson(merged), ctx.clock.now()],
      );
      ctx.audit.record({ entityType: 'explanation_rules', entityId: 'owner', action: 'update', summary: 'تعديل قواعد الشرح العامة', before, after: merged });
      return rulesResponse(ctx, {});
    });
    app.put('/rules/nodes/:nodeId', async (req) => {
      const { nodeId } = parseParams(nodeParams, req);
      const node = ctx.db.get<{ title: string; deleted_at: number | null }>('SELECT title, deleted_at FROM library_node WHERE id = ?', [nodeId]);
      if (!node || node.deleted_at !== null) throw new AppError('NOT_FOUND', 'المجلد غير موجود.', 404);
      const patch = parseBody(rulesPatchSchema, req);
      const before = readOverride(ctx, 'node', nodeId);
      ctx.db.run(
        `INSERT INTO explanation_rule_override (target_type, target_id, rules_json, updated_at) VALUES ('node', ?, ?, ?)
         ON CONFLICT (target_type, target_id) DO UPDATE SET rules_json = excluded.rules_json, updated_at = excluded.updated_at`,
        [nodeId, toJson(patch), ctx.clock.now()],
      );
      ctx.audit.record({ entityType: 'explanation_rules', entityId: nodeId, action: 'update', summary: `قواعد شرح خاصة بـ «${node.title}»`, before, after: patch });
      return rulesResponse(ctx, { node_id: nodeId });
    });
    app.delete('/rules/nodes/:nodeId', async (req) => {
      const { nodeId } = parseParams(nodeParams, req);
      ctx.db.run(`DELETE FROM explanation_rule_override WHERE target_type = 'node' AND target_id = ?`, [nodeId]);
      ctx.audit.record({ entityType: 'explanation_rules', entityId: nodeId, action: 'delete', summary: 'إزالة قواعد الشرح الخاصة بالمجلد' });
      return rulesResponse(ctx, { node_id: nodeId });
    });

    // ───────── interactive timelines & flowcharts (§31, track F3) ─────────
    registerDiagramRoutes(app, ctx);

    // ───────── terminology (§21) — forwarded to the owning evidence module ─────────
    const termParams = z.object({ id: ID });
    app.get('/terms', async (req, reply) => forwardToEvidenceTerms(app, req, reply, ''));
    app.post('/terms', async (req, reply) => forwardToEvidenceTerms(app, req, reply, ''));
    app.patch('/terms/:id', async (req, reply) => forwardToEvidenceTerms(app, req, reply, `/${encodeURIComponent(parseParams(termParams, req).id)}`));
    app.delete('/terms/:id', async (req, reply) => forwardToEvidenceTerms(app, req, reply, `/${encodeURIComponent(parseParams(termParams, req).id)}`));
  };
}

export default createStudybookModule();
