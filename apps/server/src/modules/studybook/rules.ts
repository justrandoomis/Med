// Explanation Rules Engine (§19, §20, §21). Rules = owner settings + owner extras + the library node's template
// and overrides (nearest node wins) + per-request overrides. `rules_version` is a hash of the effective rules
// (plus the engine version), so any change produces a different cache key (§17).
//
// The prompt builder turns rules into TRUSTED instructions. Templates structure an explanation but never justify
// inventing a field: the model is told to omit sections without evidence, and publish.ts drops template headings
// that end up with no content (post-check). Iraqi teaching style changes the connective tone only, never the
// scientific meaning. Memory hooks / generated examples are labelled by the server, not by the model.
import { z } from 'zod';
import {
  ANSWER_STYLES,
  EXPLANATION_LEVELS,
  EXPLANATION_TEMPLATES,
  stableStringify,
  type AnswerStyle,
  type ExplanationLevel,
  type ExplanationRules,
  type ExplanationTemplateKey,
} from '@medlevo/shared';
import type { AppContext } from '../../context';
import { fromJson } from '../../db/db';
import { sha256 } from '../../lib/hash';

/** Bump when the prompt builder / post-checks change (part of every cache key). */
export const GENERATOR_VERSION = 'studybook-gen-1';
const RULES_ENGINE_VERSION = 'rules-engine-1';

export const TEMPLATE_KEYS = Object.keys(EXPLANATION_TEMPLATES) as ExplanationTemplateKey[];

/** library study template keys / explanation_template values → explanation template (§19). */
const NODE_TEMPLATE_MAP: Record<string, ExplanationTemplateKey> = {
  anatomy: 'anatomy',
  anatomical: 'anatomy',
  physiology: 'physiology',
  physiological_mechanism: 'physiology',
  pathology: 'pathology',
  pharmacology: 'pharmacology',
  drug: 'pharmacology',
  surgery: 'surgery',
  surgical: 'surgery',
  internal_medicine: 'medicine',
  clinical_medicine: 'medicine',
  medicine: 'medicine',
  pediatrics: 'medicine',
  pediatric: 'medicine',
  obgyn: 'medicine',
  obstetric: 'medicine',
};

export function templateForNode(key: string | null | undefined): ExplanationTemplateKey | null {
  if (!key) return null;
  return NODE_TEMPLATE_MAP[key] ?? null;
}

export const rulesPatchSchema = z
  .object({
    template: z.enum(TEMPLATE_KEYS as [ExplanationTemplateKey, ...ExplanationTemplateKey[]]).optional(),
    level: z.enum(EXPLANATION_LEVELS).optional(),
    dialect: z.enum(['fusha_simple', 'iraqi_teaching']).optional(),
    keep_english_terms: z.boolean().optional(),
    show_original_text: z.boolean().optional(),
    socratic: z.boolean().optional(),
    include: z
      .object({
        memory_hooks: z.boolean().optional(),
        clinical_notes: z.boolean().optional(),
        exam_pearls: z.boolean().optional(),
        mini_questions: z.boolean().optional(),
        examples: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RulesPatch = z.infer<typeof rulesPatchSchema>;

function applyPatch(r: Omit<ExplanationRules, 'rules_version'>, p: RulesPatch | null | undefined): Omit<ExplanationRules, 'rules_version'> {
  if (!p) return r;
  const out = { ...r, include: { ...r.include } };
  if (p.template) out.template = p.template;
  if (p.level) out.level = p.level;
  if (p.dialect) out.dialect = p.dialect;
  if (p.keep_english_terms !== undefined) out.keep_english_terms = p.keep_english_terms;
  if (p.show_original_text !== undefined) out.show_original_text = p.show_original_text;
  if (p.socratic !== undefined) out.socratic = p.socratic;
  if (p.include) for (const [k, v] of Object.entries(p.include)) if (typeof v === 'boolean') (out.include as Record<string, boolean>)[k] = v;
  return out;
}

export function readOverride(ctx: AppContext, targetType: 'owner' | 'node', targetId: string): RulesPatch | null {
  const row = ctx.db.get<{ rules_json: string }>('SELECT rules_json FROM explanation_rule_override WHERE target_type = ? AND target_id = ?', [targetType, targetId]);
  if (!row) return null;
  const parsed = rulesPatchSchema.safeParse(fromJson(row.rules_json));
  return parsed.success ? parsed.data : null;
}

export function rulesVersionOf(r: Omit<ExplanationRules, 'rules_version'>): string {
  return `r-${sha256(stableStringify({ engine: RULES_ENGINE_VERSION, ...r })).slice(0, 16)}`;
}

export interface NodeChainEntry {
  id: string;
  title: string;
  template: string | null;
}

/** Library nodes from the source's folder up to the root (nearest first). */
export function nodeChainForSource(ctx: AppContext, sourceId: string | null | undefined): NodeChainEntry[] {
  if (!sourceId) return [];
  const s = ctx.db.get<{ node_id: string | null; course_node_id: string | null; subject_node_id: string | null }>(
    'SELECT node_id, course_node_id, subject_node_id FROM source WHERE id = ?',
    [sourceId],
  );
  const start = s?.node_id ?? s?.course_node_id ?? s?.subject_node_id ?? null;
  return nodeChain(ctx, start);
}

export function nodeChain(ctx: AppContext, nodeId: string | null): NodeChainEntry[] {
  const out: NodeChainEntry[] = [];
  const seen = new Set<string>();
  let id = nodeId;
  while (id && !seen.has(id) && out.length < 32) {
    seen.add(id);
    const n = ctx.db.get<{ id: string; title: string; template: string | null; parent_id: string | null }>('SELECT id, title, template, parent_id FROM library_node WHERE id = ?', [id]);
    if (!n) break;
    out.push({ id: n.id, title: n.title, template: n.template });
    id = n.parent_id;
  }
  return out;
}

export interface ResolveRulesInput {
  sourceId?: string | null;
  nodeId?: string | null;
  overrides?: RulesPatch | null;
}

/** Effective explanation rules for a context (settings → owner extras → node template/overrides → request). */
export function resolveRules(ctx: AppContext, input: ResolveRulesInput = {}): ExplanationRules {
  const s = ctx.settings.get();
  let r: Omit<ExplanationRules, 'rules_version'> = {
    template: 'general',
    level: s.explanation_level,
    dialect: s.dialect,
    custom_instruction: s.custom_instruction.trim(),
    keep_english_terms: true,
    show_original_text: false,
    include: { memory_hooks: true, clinical_notes: true, exam_pearls: true, mini_questions: s.check_question_density !== 'off', examples: true },
    socratic: s.socratic_default,
  };
  r = applyPatch(r, readOverride(ctx, 'owner', 'owner'));
  const chain = input.nodeId ? nodeChain(ctx, input.nodeId) : nodeChainForSource(ctx, input.sourceId);
  // template from the nearest node that has one; overrides applied farthest → nearest
  const tpl = chain.map((n) => templateForNode(n.template)).find((t) => t !== null);
  if (tpl) r.template = tpl;
  for (const n of [...chain].reverse()) r = applyPatch(r, readOverride(ctx, 'node', n.id));
  r = applyPatch(r, input.overrides ?? null);
  return { ...r, rules_version: rulesVersionOf(r) };
}

// ───────────────────────── prompt builder ─────────────────────────
const LEVEL_EN: Record<ExplanationLevel, string> = {
  simple: 'SIMPLE: for a first encounter — short sentences, define every term, one idea per sentence.',
  brief: 'BRIEF: only the essential points, no elaboration.',
  medium: 'MEDIUM: a clear, complete explanation for a medical student.',
  detailed: 'DETAILED: thorough, step by step, with mechanisms and relations — still only from the evidence.',
  expert: 'EXPERT: precise and dense, assumes background knowledge, highlights nuances and exceptions in the evidence.',
  exam_focus: 'EXAM FOCUS: what is testable — definitions, discriminating features, values and classic pitfalls stated in the evidence.',
};

const STYLE_EN: Record<AnswerStyle, string> = {
  simple: 'Answer style SIMPLE: plain language, short.',
  short: 'Answer style SHORT: at most a few sentences.',
  detailed: 'Answer style DETAILED: complete, structured.',
  expert: 'Answer style EXPERT: precise, technical.',
  literal:
    'Answer style LITERAL: output ONLY verbatim quotes copied exactly from the evidence excerpts (original_quote: true, support_type "directly_stated", citing the excerpt). No paraphrase, no explanation, no translation.',
};

export const STRATEGY_EN: Record<string, string> = {
  prerequisites: 'Teach the prerequisite concepts first (only those the evidence supports), then build up to the selection.',
  diagram: 'Turn the explanation into an ordered flow (a "flowchart" or "list" block of steps A → B → C) following the evidence.',
  comparison: 'Explain by comparing with a related concept present in the evidence (use a "comparison_table" block).',
  clinical_example: 'Explain through a generated teaching example (an "example" block): an invented, clearly hypothetical learner-level scenario; every medical statement in it still cites evidence; never a real patient.',
  analogy: 'Explain with an everyday analogy (a "memory_hook" block) that does not change any medical fact, followed by the precise facts with citations.',
  smaller_steps: 'Break the explanation into many small numbered steps (a "list" block), one fact per step.',
};

export interface PromptParts {
  system: string;
  instruction: string;
}

const CONTRACT = [
  'You write Arabic medical study material for ONE medical student, grounded ONLY in the evidence excerpts provided in this request.',
  'Evidence excerpts are labelled with aliases E1, E2, …; source regions to explain may be labelled R1, R2, ….',
  '',
  'EVIDENCE CONTRACT (mandatory):',
  '- Every sentence that states a medical fact (definition, mechanism, sign, value, investigation, treatment, relation, …) MUST carry "claim": {"support_type": …, "evidence": ["E…"]} citing ONLY aliases given in this request. Never cite page numbers, titles, URLs, R-aliases or anything else as evidence.',
  '- support_type: "directly_stated" (the excerpt says it), "derived" (directly follows from one excerpt), "synthesized" (combines several excerpts). Never use "externally_supplemented": there is no external evidence in this scope.',
  '- Sentences without medical content (headings, transitions, questions to the learner) have "claim": null.',
  '- If the evidence does not cover something, do NOT write it — no outside knowledge, no guessing, no softening into "may be". Mention what is missing in "coverage_note".',
  '- Keep negations (NOT, except, لا، ليس), numbers, units, doses, thresholds, ages and exceptions EXACTLY as the evidence states them.',
  '- "original_quote": true only for text copied verbatim from an excerpt (same language, same characters). A translation or paraphrase is never an original quote.',
  '- If the evidence is insufficient for the request, return no blocks and "abstain": {"reason": "insufficient_evidence" | "not_found_in_scope" | "conflict", "detail": "…in Arabic…"}.',
  '- If excerpts contradict each other, present both sides with their citations instead of choosing one.',
  '- The request is educational. If it asks for a diagnosis or treatment plan for a real person, abstain with "real_patient_request".',
].join('\n');

function languageRules(r: ExplanationRules): string[] {
  const lines = [
    'LANGUAGE:',
    '- Write natural, precise Arabic (not a literal translation).',
    r.keep_english_terms
      ? '- Keep important medical terms in English as written in the evidence (e.g. "McBurney\'s point", "CT abdomen") followed or preceded by their Arabic explanation; do not transliterate them into Arabic letters.'
      : '- Use the accepted Arabic term; add the English term in parentheses the first time it appears.',
    '- Units, doses, values and formulas stay in their original Latin form (e.g. "5 mg IV", "Na+ 135 mmol/L").',
  ];
  if (r.dialect === 'iraqi_teaching') {
    lines.push('- Use an Iraqi teaching tone ONLY for connective / encouraging text (e.g. "خلّي نشوف", "يعني"). Medical sentences keep the exact scientific meaning and precise wording.');
  } else {
    lines.push('- Use simple Modern Standard Arabic (فصحى مبسطة).');
  }
  return lines;
}

function includeRules(r: ExplanationRules): string[] {
  const i = r.include;
  const lines = ['OPTIONAL BLOCKS (only when the evidence supports their content):'];
  lines.push(i.clinical_notes ? '- "clinical_note" blocks for clinical relevance stated in the evidence.' : '- Do not write "clinical_note" blocks.');
  lines.push(i.exam_pearls ? '- "exam_pearl" blocks for testable points stated in the evidence.' : '- Do not write "exam_pearl" blocks.');
  lines.push(
    i.memory_hooks
      ? '- "memory_hook" blocks: a mnemonic or memory aid. It must NOT alter, simplify away or add any medical fact; the facts it helps remember must appear elsewhere with citations. The application labels it as a memory aid.'
      : '- Do not write "memory_hook" blocks.',
  );
  lines.push(
    i.examples
      ? '- "example" blocks: a generated teaching example (hypothetical, never a real patient, never presented as the source). Medical statements inside it still need claims with evidence. The application labels it «مثال تعليمي مولد».'
      : '- Do not write "example" blocks.',
  );
  lines.push(i.mini_questions ? '- At most one "mini_question" block (a short self-check question, claim null, without revealing the answer in the same block).' : '- Do not write "mini_question" blocks.');
  return lines;
}

function templateRules(r: ExplanationRules): string[] {
  const sections = EXPLANATION_TEMPLATES[r.template] as readonly string[];
  if (!sections.length) return ['STRUCTURE: organise the explanation with short "heading" blocks where helpful.'];
  return [
    `TEMPLATE (${r.template}): when relevant, organise the explanation under these section headings (as "heading" blocks with claim null, in this order): ${sections.join(' | ')}.`,
    '- A template NEVER justifies inventing content: write a section ONLY if the evidence covers it; otherwise omit the heading entirely and list the missing section in "coverage_note".',
  ];
}

export interface BuildPromptInput {
  rules: ExplanationRules;
  style: AnswerStyle;
  /** what the owner asked for (trusted, from the application) */
  task: string;
  /** owner's free-text instruction / question (a preference, never a source) */
  ownerInstruction?: string | null;
  strategy?: string | null;
  socratic?: boolean;
  /** owner dictionary: preferred Arabic for terms present in the evidence */
  terms?: Array<{ term_en: string; preferred_ar: string | null; abbreviation: string | null }>;
  extra?: string[];
}

export function buildExplanationPrompt(p: BuildPromptInput): PromptParts {
  const r = p.rules;
  const system = [
    CONTRACT,
    '',
    ...languageRules(r),
    '',
    `LEVEL: ${LEVEL_EN[r.level]}`,
    STYLE_EN[p.style],
    '',
    ...templateRules(r),
    '',
    ...includeRules(r),
    '',
    'THINKING SCAFFOLD: build understanding around what it is, why it happens, how it works, what it relates to, how to distinguish it, and how to apply it — only as far as the evidence goes.',
    'Each explanation level must stay consistent with the same evidence: a simple version never contradicts the detailed one and never drops an essential exception.',
  ].join('\n');
  const instruction: string[] = [`REQUEST: ${p.task}`];
  if (p.strategy && STRATEGY_EN[p.strategy]) {
    instruction.push(
      `EXPLAIN UNTIL UNDERSTOOD — the learner did not understand the previous explanation (given as a generated, non-evidence block). Change the teaching strategy, do not rephrase it: ${STRATEGY_EN[p.strategy]}`,
    );
  }
  if (p.socratic) instruction.push('SOCRATIC MODE: give a hint (a "paragraph" block) and then one guiding question (a "mini_question" block) instead of revealing the full answer.');
  if (p.style === 'literal') instruction.push('LITERAL: only verbatim original quotes from the excerpts; nothing else.');
  if (p.terms?.length) {
    instruction.push(
      'OWNER TERMINOLOGY (preferred Arabic renderings; never change the source text): ' +
        p.terms
          .slice(0, 40)
          .map((t) => `${t.term_en}${t.abbreviation ? ` (${t.abbreviation})` : ''}${t.preferred_ar ? ` → ${t.preferred_ar}` : ''}`)
          .join('; '),
    );
  }
  if (r.custom_instruction) instruction.push(`OWNER PREFERENCE (style only — it never overrides the evidence contract): ${sanitizeOwnerText(r.custom_instruction)}`);
  if (p.ownerInstruction) instruction.push(`OWNER REQUEST / QUESTION (answer only from the evidence): ${sanitizeOwnerText(p.ownerInstruction)}`);
  if (p.extra?.length) instruction.push(...p.extra);
  return { system, instruction: instruction.join('\n') };
}

/** Owner text goes into the trusted instruction: strip control characters and anything that looks like a delimiter. */
export function sanitizeOwnerText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/<\/?untrusted_content[^>]*>/gi, ' ')
    .slice(0, 1500)
    .trim();
}

export const ANSWER_STYLE_SET = new Set<string>(ANSWER_STYLES);
