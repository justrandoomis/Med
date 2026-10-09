// Model-facing contracts of the generated-MCQ pipeline (§37–§38). Model output is untrusted: it is schema-checked
// by the orchestrator, then validated deterministically, by the evidence module (claims) and by an INDEPENDENT
// validator call before anything is published.
import { z } from 'zod';
import { SUPPORT_TYPES } from '@medlevo/shared';

export const GENERATOR_VERSION = 'qgen-v1';

export const sentenceSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  claim: z
    .object({
      support_type: z.enum(SUPPORT_TYPES),
      evidence: z.array(z.string().trim().max(16)).max(8),
    })
    .nullable(),
});
export type ModelSentence = z.infer<typeof sentenceSchema>;

export const generatedQuestionSchema = z.object({
  item_type: z.string().trim().max(40),
  learning_objective: z.string().trim().min(3).max(400),
  concepts: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
  difficulty_est: z.enum(['medium', 'hard', 'very_hard']),
  stem: z.string().trim().min(10).max(3000),
  options: z.array(z.object({ key: z.string().trim().min(1).max(2), text: z.string().trim().min(1).max(500) })).min(2).max(6),
  best_answer: z.string().trim().min(1).max(2),
  explanation: z.array(sentenceSchema).min(1).max(12),
  distractors: z.array(z.object({ option: z.string().trim().min(1).max(2), explanation: z.array(sentenceSchema).min(1).max(6) })).max(6),
});
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export const generationOutputSchema = z.object({
  abstain: z.object({ reason: z.enum(['insufficient_evidence', 'not_found_in_scope']), detail: z.string().max(800) }).nullable().optional(),
  questions: z.array(generatedQuestionSchema).max(5),
});
export type GenerationOutput = z.infer<typeof generationOutputSchema>;

/** The independent validator solves the item WITHOUT the generator's key, from the same evidence only. */
export const validatorOutputSchema = z.object({
  chosen_option: z.string().trim().max(2).nullable(),
  defensible_options: z.array(z.string().trim().max(2)).max(6),
  answerable_from_evidence: z.boolean(),
  clue_issues: z.array(z.string().max(400)).max(10),
  issues: z.array(z.string().max(400)).max(10),
  verdict: z.enum(['valid', 'invalid']),
});
export type ValidatorOutput = z.infer<typeof validatorOutputSchema>;

export const GENERATE_SYSTEM = [
  'You write single-best-answer (SBA) medical study questions in USMLE style for one student, using ONLY the evidence excerpts provided (E1, E2, …).',
  'Rules:',
  '- Difficulty comes from clinical reasoning, applying and integrating the evidence and distinguishing close options — never from ambiguity, trivia outside the evidence, or more than one correct answer.',
  '- Everything needed to choose the best answer must be stated in the evidence. Do not use outside knowledge. If the evidence cannot support the requested difficulty or a safe explanation of every distractor, return {"abstain": {"reason": "insufficient_evidence", "detail": "…"}, "questions": []}.',
  '- A vignette must be complete enough to answer; no misleading irrelevant detail. Do not call the question official or equivalent to a real exam.',
  '- 4 or 5 options with keys A–E, exactly ONE best answer, similar length and grammar, no absolute words that give away distractors, no "all of the above" / "none of the above".',
  '- If the stem is negative, write the negation word in CAPITALS (NOT, EXCEPT) and never use negation as a trick.',
  '- explanation: why the best answer is right, as sentences; every medical sentence carries a claim {support_type, evidence:[aliases]} citing ONLY the aliases given.',
  '- distractors: for EVERY wrong option, why it is plausible but wrong in THIS case, with evidence aliases. Never just "this is incorrect".',
  '- Give learning_objective, concepts, item_type and difficulty_est (an estimate only).',
].join('\n');

export const VALIDATE_SYSTEM = [
  'You are an independent reviewer of a single-best-answer question. You did NOT write it and you are NOT told its intended answer.',
  'Using ONLY the evidence excerpts provided, solve the question and report:',
  '- chosen_option: the single best answer key, or null if the evidence does not determine one;',
  '- defensible_options: every option that could reasonably be defended as correct from the evidence;',
  '- answerable_from_evidence: whether the evidence is sufficient to answer;',
  '- clue_issues: wording clues that reveal the answer (length, grammar, absolute words, repeated stem words);',
  '- issues: contradictions, missing data in the vignette, inconsistency between stem and options;',
  '- verdict: "valid" only if exactly one option is defensible, the evidence determines it, and there are no clues or issues.',
  'Write issues in short Arabic sentences.',
].join('\n');
