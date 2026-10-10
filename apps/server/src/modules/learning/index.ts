// Learning module (track L1): flashcards & spaced repetition (FSRS via ts-fsrs, schedules derived from the review log),
// weakness center, mistake genome, reasoning replay, forgetting forecast, learning profile, study planner, one-tap
// revision, home, Exam DNA and progress separation (§40, §43–§45, §47; AC-23 server side, AC-24, AC-26, AC-27).
// See docs/modules/learning.md.
//  * sync entities 'flashcard' (rev-based upsert, keep-both on stale edits, tombstones) and 'review_event'
//    (append-only, idempotent; events for unknown / deleted cards are rejected with the reason)
//  * capabilities: flashcards, weakness, planner, exam_dna, export.anki_tsv → available (deterministic, no AI needed)
import type { FastifyInstance } from 'fastify';
import type { ModuleOptions } from '../../context';
import { registerRoutes } from './routes';
import { registerLearningSync } from './sync';

export default async function register(app: FastifyInstance, { ctx }: ModuleOptions): Promise<void> {
  ctx.capabilities.set('flashcards', 'available');
  ctx.capabilities.set('weakness', 'available');
  ctx.capabilities.set('planner', 'available');
  ctx.capabilities.set('exam_dna', 'available');
  ctx.capabilities.set('export.anki_tsv', 'available');
  registerLearningSync(ctx);
  registerRoutes(app, ctx);
}
