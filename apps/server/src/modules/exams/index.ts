// Exams module (track C4): practice & exams, generated hard MCQs, written answers, attempts and results
// (§37–§39, §41, §44 signals; AC-14, AC-17, AC-18, AC-19, AC-26, AC-27). See docs/modules/exams.md.
//  * sync entities 'question_attempt' (append-only) and 'exam_attempt' (resumable state)
//  * job 'exams.generate_questions' (generated MCQ pipeline)
//  * capabilities: `exams` (deterministic — available), `ai.generate_questions`, `ai.grade_written` (reported
//    `requires_configuration` by the registry while no AI provider is configured)
import type { FastifyInstance } from 'fastify';
import type { ModuleOptions } from '../../context';
import { registerAttemptSync } from './attempts';
import { registerGenerationJob } from './generation/pipeline';
import { registerRoutes } from './routes';

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('exams', 'available');
  ctx.capabilities.set('ai.generate_questions', 'available');
  ctx.capabilities.set('ai.grade_written', 'available');
  registerAttemptSync(ctx);
  registerGenerationJob(ctx);
  registerRoutes(app, ctx);
}
