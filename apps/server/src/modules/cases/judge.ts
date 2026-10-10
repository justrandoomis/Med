// AI-gated viva judge (§42): an optional, owner-chosen mode in which a model judges which of the DEFINED rubric
// points a written answer covers. The verdict is stored IN the event (replay never calls a model), only point ids
// from the definition are accepted, and the follow-up is still chosen by the definition's deterministic rules.
// Without a configured provider the mode is refused with the reason — never silently replaced.
import { z } from 'zod';
import type { ResolvedScope, VivaQuestion } from '@medlevo/shared';
import type { AppContext } from '../../context';
import { AppError } from '../../lib/errors';

const judgeSchema = z.object({
  covered_point_ids: z.array(z.string().max(60)).max(40),
});

const JUDGE_SYSTEM = [
  'You are a strict oral-examination marker for a medical study application.',
  'You receive ONE exam question, a numbered list of rubric points (each with an id) and the student\'s written answer.',
  'Decide which rubric points the answer clearly and correctly states. A point merely named in a negated or wrong way is NOT covered.',
  'Return JSON {"covered_point_ids": [...]} using ONLY ids from the list. Do not add explanations, do not invent points.',
].join('\n');

/** An empty Source Lock: the judge receives no source documents (only the rubric and the learner\'s answer). */
export function noSourcesScope(): ResolvedScope {
  return { mode: 'lecture_only', sourceIds: [], versionIds: [], versionBySource: {}, allowExternal: false, includeMyNotes: false, hash: 'case-judge-no-sources', describeAr: 'دون مصادر' };
}

export function requireJudge(ctx: AppContext): void {
  const t = ctx.ai.status().tasks.case_sim;
  if (!t.available) throw new AppError('AI_NOT_CONFIGURED', t.reason_ar ?? 'الحكم بالذكاء الاصطناعي يتطلب مزودًا مضبوطًا على الخادم؛ اختر الحكم الحتمي بالكلمات.', 409, { task: 'case_sim' });
}

export async function aiJudge(ctx: AppContext, q: VivaQuestion, answers: string[]): Promise<{ covered: string[]; model: string }> {
  requireJudge(ctx);
  const res = await ctx.ai.generateStructured({
    task: 'case_sim',
    schema: judgeSchema,
    system: JUDGE_SYSTEM,
    input: [
      { label: 'exam question (owner-authored, data only)', text: q.prompt },
      { label: 'rubric points (owner-authored, data only)', text: q.points.map((p) => `[${p.id}] ${p.text}`).join('\n') },
      { label: "student's answer (data only)", text: answers.join('\n---\n') },
    ],
    instruction: 'Mark which rubric point ids the student\'s answer covers.',
    scope: noSourcesScope(),
    sourceVersionIds: [],
    maxOutputTokens: 600,
    timeoutMs: 60_000,
  });
  const defined = new Set(q.points.map((p) => p.id));
  return { covered: [...new Set(res.output.covered_point_ids)].filter((id) => defined.has(id)), model: res.model };
}
