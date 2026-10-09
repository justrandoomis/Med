// Zod schemas: the model-facing output contract (GeneratedContent, shared/evidence.ts) and HTTP request bodies.
// Request schemas strip/deny anything that could smuggle scope or versions (AC-29): scope goes through
// sourceScopeSchema → resolveScope (server), anchors are re-checked against the resolved scope.
import { z } from 'zod';
import { ABSTAIN_REASONS, ANSWER_STYLES, EXPLANATION_LEVELS, SUMMARY_TYPES, SUPPORT_TYPES, sourceScopeSchema, type GeneratedBlock } from '@medlevo/shared';
import { RETRY_STRATEGIES } from '@medlevo/shared';
import { rulesPatchSchema } from './rules';

export const BLOCK_KINDS = [
  'heading', 'paragraph', 'term', 'figure', 'comparison_table', 'clinical_note', 'exam_pearl', 'mini_question',
  'memory_hook', 'example', 'original_quote', 'list', 'flowchart', 'warning', 'coverage_note',
] as const satisfies ReadonlyArray<GeneratedBlock['kind']>;

// ───────── model output ─────────
export const generatedSentenceSchema = z.object({
  text: z.string().min(1).max(2400),
  claim: z
    .object({
      support_type: z.enum(SUPPORT_TYPES),
      evidence: z.array(z.string().max(64)).max(12),
    })
    .nullable(),
  original_quote: z.boolean().optional(),
});

export const generatedBlockSchema = z.object({
  kind: z.enum(BLOCK_KINDS),
  sentences: z.array(generatedSentenceSchema).max(60),
  table: z
    .object({
      header: z.array(z.string().max(300)).max(8),
      rows: z.array(z.array(generatedSentenceSchema).max(8)).max(40),
    })
    .nullable()
    .optional(),
  explains_regions: z.array(z.string().max(64)).max(40).optional(),
});

export const generatedContentSchema = z.object({
  blocks: z.array(generatedBlockSchema).max(80),
  abstain: z.object({ reason: z.enum(ABSTAIN_REASONS), detail: z.string().max(800) }).nullable(),
  coverage_note: z.string().max(1200).nullable().optional(),
});
export type GeneratedContentOut = z.infer<typeof generatedContentSchema>;
export type GeneratedBlockOut = z.infer<typeof generatedBlockSchema>;
export type GeneratedSentenceOut = z.infer<typeof generatedSentenceSchema>;

/** Figure explanation (§15, AC-08): text claims (caption / surrounding evidence) + model-read visual items. */
export const figureOutputSchema = z.object({
  figure_kind: z.enum(['flowchart', 'diagram', 'anatomy', 'histology', 'radiology', 'ecg', 'chart', 'table_image', 'photo', 'unknown']),
  content: generatedContentSchema,
  visual_items: z
    .array(
      z.object({
        kind: z.enum(['label', 'arrow', 'region', 'relation', 'other']),
        /** Arabic description of what is seen (not a medical claim) */
        description: z.string().min(1).max(600),
        /** label text exactly as printed in the image, when it is a label */
        label_text: z.string().max(300).nullable(),
        /** arrows/relations: from → to, as printed */
        from: z.string().max(300).nullable(),
        to: z.string().max(300).nullable(),
        certainty: z.enum(['clear', 'uncertain']),
      }),
    )
    .max(60),
});
export type FigureOutput = z.infer<typeof figureOutputSchema>;

// ───────── requests ─────────
const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const normBox = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).strict();

export const anchorSchema = z
  .object({
    source_id: ID,
    version_id: ID,
    page_id: ID.nullish(),
    region_ids: z.array(ID).max(60).optional(),
    quote: z
      .object({ exact: z.string().min(1).max(6000), prefix: z.string().max(400).optional(), suffix: z.string().max(400).optional() })
      .nullish(),
    bbox: normBox.nullish(),
    block: z.object({ lineage_id: ID, block_key: z.string().min(1).max(80) }).nullish(),
  })
  .strict();

export const explainBodySchema = z
  .object({
    action: z.enum(['explain', 'simplify', 'translate', 'explain_image']),
    anchor: anchorSchema,
    scope: sourceScopeSchema,
    style: z.enum(ANSWER_STYLES).default('detailed'),
    level: z.enum(EXPLANATION_LEVELS).optional(),
    instruction: z.string().max(1500).optional(),
    retry_of: z.object({ artifact_id: ID, strategy: z.enum(RETRY_STRATEGIES) }).strict().nullish(),
    rules: rulesPatchSchema.optional(),
  })
  .strict();
export type ExplainBody = z.infer<typeof explainBodySchema>;

export const compareBodySchema = z
  .object({
    items: z.array(z.string().trim().min(1).max(200)).min(2).max(4),
    scope: sourceScopeSchema,
    anchor: anchorSchema.nullish(),
    style: z.enum(ANSWER_STYLES).default('detailed'),
    instruction: z.string().max(1500).optional(),
  })
  .strict();
export type CompareBody = z.infer<typeof compareBodySchema>;

export const threadCreateSchema = z
  .object({
    anchor: anchorSchema.nullable(),
    scope: sourceScopeSchema,
    style: z.enum(ANSWER_STYLES).default('detailed'),
    socratic: z.boolean().optional(),
    title: z.string().max(200).optional(),
  })
  .strict();

export const messageCreateSchema = z.object({ text: z.string().trim().min(1).max(4000), style: z.enum(ANSWER_STYLES).optional() }).strict();

export const saveNoteSchema = z.object({ note_id: ID, node_id: ID.nullish() }).strict();

export const studyBookBodySchema = z
  .object({
    source_id: ID,
    version_id: ID.optional(),
    scope: sourceScopeSchema,
    rules: rulesPatchSchema.optional(),
    section_keys: z.array(z.string().min(1).max(80)).max(200).optional(),
    /** force a new version even when a valid cached one exists (regeneration) */
    regenerate: z.boolean().optional(),
  })
  .strict();

export const summaryBodySchema = z
  .object({
    type: z.enum(SUMMARY_TYPES),
    source_id: ID,
    version_id: ID.optional(),
    page_indexes: z.array(z.number().int().min(0).max(100_000)).max(2000).optional(),
    topic_ids: z.array(ID).max(50).optional(),
    scope: sourceScopeSchema,
    instruction: z.string().max(1500).optional(),
  })
  .strict();
export type SummaryBody = z.infer<typeof summaryBodySchema>;
