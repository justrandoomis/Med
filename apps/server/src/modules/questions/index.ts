// Questions module (track C3): My Question Vault (§33–§36, §16 minimal, §48 review items; AC-10…AC-17, AC-26).
// Registers the extract_questions / match_questions jobs, the honest state of the questions.* capabilities and
// the /api/questions routes. The processing pipeline enqueues the jobs when a version finishes processing
// (question_source / previous_exam → extract; lecture → match). Other tracks use ./service.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EXTRACT_QUESTIONS_JOB_KIND,
  MATCH_QUESTIONS_JOB_KIND,
  type ExtractQuestionsJobInput,
  type MatchQuestionsJobInput,
} from '@medlevo/shared';
import type { ModuleOptions } from '../../context';
import { detectNearDuplicates } from './duplicates';
import { runExtraction } from './extract';
import { matchQuestions, matchSourceVersion, MATCHER_VERSION } from './match';
import { PARSER_VERSION } from './parser';
import { registerRoutes } from './routes';

export { PARSER_VERSION } from './parser';
export { MATCHER_VERSION } from './match';

const extractInput = z.object({ version_id: z.string().min(1).max(64) }).strict();
const matchInput = z
  .object({ version_id: z.string().min(1).max(64).optional(), question_ids: z.array(z.string().min(1).max(64)).min(1).max(5000).optional() })
  .strict()
  .refine((i) => !!i.version_id !== !!i.question_ids, 'version_id أو question_ids (أحدهما فقط)');

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('questions.vault', 'available');
  ctx.capabilities.set('questions.extraction', 'available');
  ctx.capabilities.set('questions.matching', 'available');
  // G4 / AC-14, AC-15: the answer check needs the AI provider (reported requires_configuration without one)
  ctx.capabilities.set('ai.answer_check', 'available');

  ctx.jobs.register<ExtractQuestionsJobInput, unknown>(EXTRACT_QUESTIONS_JOB_KIND, {
    version: PARSER_VERSION,
    maxAttempts: 2,
    timeoutMs: 10 * 60 * 1000,
    concurrency: 1,
    inputSchema: extractInput as unknown as z.ZodType<ExtractQuestionsJobInput>,
    handler: async (run) => {
      const out = await run.checkpoint('extract', async () => {
        run.progress({ stage: 'extract' });
        const r = runExtraction(ctx, run.input.version_id, run.id);
        return { summary: r.summary, created: r.createdQuestionIds };
      });
      // G7 / AC-25: after a power loss between the extraction's commit and its checkpoint, the resumed attempt finds the
      // questions already in the vault (created = []), so the questions THIS job created are also looked up by job id —
      // otherwise their near-duplicate suggestions would never be made
      const created = [
        ...new Set([
          ...out.created,
          ...ctx.db
            .all<{ question_id: string }>(`SELECT DISTINCT question_id FROM question_version WHERE job_id = ? AND version_no = 1 AND created_by = 'extraction'`, [run.id])
            .map((r) => r.question_id),
        ]),
      ];
      run.progress({ stage: 'duplicates', done: 0, total: created.length, unit: 'items' });
      let suggestions = 0;
      created.forEach((qid, i) => {
        suggestions += ctx.db.tx(() => detectNearDuplicates(ctx, qid));
        run.progress({ stage: 'duplicates', done: i + 1, total: created.length, unit: 'items' });
      });
      // incremental matching of this question source against the lectures of its course
      if (out.summary.questions > 0 && ctx.jobs.isRegistered(MATCH_QUESTIONS_JOB_KIND)) {
        ctx.jobs.enqueue(MATCH_QUESTIONS_JOB_KIND, { version_id: run.input.version_id }, { idempotencyKey: `${MATCH_QUESTIONS_JOB_KIND}:${run.input.version_id}:${run.id}`, parentJobId: run.id });
      }
      return { ...out.summary, duplicate_suggestions: suggestions };
    },
  });

  ctx.jobs.register<MatchQuestionsJobInput, unknown>(MATCH_QUESTIONS_JOB_KIND, {
    version: MATCHER_VERSION,
    maxAttempts: 2,
    timeoutMs: 10 * 60 * 1000,
    concurrency: 1,
    inputSchema: matchInput as unknown as z.ZodType<MatchQuestionsJobInput>,
    handler: async (run) => {
      run.progress({ stage: 'match' });
      if (run.input.question_ids) return matchQuestions(ctx, run.input.question_ids);
      return matchSourceVersion(ctx, run.input.version_id!);
    },
  });

  registerRoutes(app, ctx);
}
