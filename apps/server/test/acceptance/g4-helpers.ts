// Shared setup of the G4 AC-14 / AC-15 acceptance tests: the REAL pipeline (upload → processing → questions hook →
// extraction → lecture matching) with the TEST-ONLY scripted AI provider (never registered in production; there is no
// API key here) standing in for the independent solver (`validate_question`) and the support verifier
// (`verify_support`) of the answer check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnswerCheckResponse, ExamAttemptDTO, ExamSessionView } from '@medlevo/shared';
import { REPO_ROOT } from '../../src/config';
import { MODULES } from '../../src/modules';
import type { ProviderRequest } from '../../src/modules/ai/types';
import { createProcessingModule } from '../../src/modules/processing';
import { aliasWith, ScriptedAi } from '../exams/helpers';
import { createTestApp } from '../helpers/app';
import { api, type QApp } from '../questions/helpers';

export const ACC = join(REPO_ROOT, 'fixtures', 'acceptance');
export const acceptanceFixture = (name: string) => readFileSync(join(ACC, name));

export async function appWith(ai: ScriptedAi | null): Promise<QApp> {
  const t = await createTestApp({
    ai,
    modules: MODULES.map((m) => (m.name === 'processing' ? { ...m, plugin: createProcessingModule({}) } : m)),
    jobs: { backoffBaseMs: 0, backoffMaxMs: 0 },
  });
  const h = await t.login();
  return Object.assign(t, { h });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The neutral letter (A, B, …) the answer check gave an option in the solver's question block. */
export function letterOf(prompt: string, optionText: string): string {
  const m = new RegExp(`^([A-H])\\. ${esc(optionText)}$`, 'm').exec(prompt);
  if (!m) throw new Error(`option «${optionText}» is not in the solver prompt`);
  return m[1]!;
}

/** A scripted INDEPENDENT solver: chooses `optionText`, supported by one sentence citing the excerpt with `needle`. */
export function solveWith(optionText: string, needle: string, sentence: string, over: Record<string, unknown> = {}) {
  return (req: ProviderRequest) => {
    const letter = letterOf(req.prompt, optionText);
    return {
      abstain: null,
      chosen_option: letter,
      defensible_options: [letter],
      answerable_from_evidence: true,
      support: [{ text: sentence, claim: { support_type: 'directly_stated', evidence: [aliasWith(req.prompt, needle)] } }],
      ...over,
    };
  };
}

/** verify_support: one verdict for every claim in the prompt. */
export function verdicts(verdict: 'supported' | 'not_supported' | 'partial') {
  return (req: ProviderRequest) => {
    const idx = [...req.prompt.matchAll(/CLAIM \[(\d+)\]/g)].map((m) => Number(m[1]));
    const aliases = [...new Set([...req.prompt.matchAll(/\b(E\d+)\b/g)].map((m) => m[1]!))];
    return { results: [...new Set(idx)].map((index) => ({ index, verdict, reason: verdict === 'supported' ? 'مدعومة' : 'غير مدعومة', based_on: verdict === 'supported' ? aliases : [] })) };
  };
}

export async function answerCheck(t: QApp, questionId: string, body: Record<string, unknown> = {}) {
  const res = await api(t).post(`/api/questions/${questionId}/answer-check`, body);
  return { status: res.statusCode, body: res.json() as AnswerCheckResponse & { error?: { code: string; message: string } } };
}

export function stateOf(s: ExamSessionView, patch: Partial<ExamAttemptDTO> = {}) {
  const a = { ...s.attempt, ...patch };
  return { status: a.status, elapsed_ms: a.elapsed_ms, current_index: a.current_index, answers: a.answers, flagged: a.flagged, timer: a.timer };
}

export { ScriptedAi };
