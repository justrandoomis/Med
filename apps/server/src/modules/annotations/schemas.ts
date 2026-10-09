// zod schemas for the annotation / note / note_page / study_session sync payloads (shapes from
// @medlevo/shared/annotations — AnnotationDTO, NoteDTO, NotePageDTO, StudySessionDTO).
// Server-managed fields (rev, created_at/updated_at, deleted_at, conflict ids) sent by a client are ignored.
// `data` objects are validated for the fields the contract defines and keep any extra keys (forward
// compatible ink formats); free-form records are size-limited.
import { richTextSchema } from '@medlevo/shared';
import { z } from 'zod';

const ID = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف غير صالح.');
const finite = z.number().refine((n) => Number.isFinite(n), 'قيمة رقمية غير صالحة.');
/** normalized page coordinates; strokes may run slightly past the page edge */
const coord = finite.refine((n) => n >= -1 && n <= 2, 'إحداثي خارج نطاق الصفحة.');
const unit = finite.refine((n) => n >= 0 && n <= 1, 'القيمة يجب أن تكون بين 0 و1.');

export const normBoxSchema = z.object({ x: coord, y: coord, w: finite.refine((n) => n >= 0 && n <= 3), h: finite.refine((n) => n >= 0 && n <= 3) });

/** a highlight may cover a whole dense page (≈ 5–8k characters); far below the payload limit */
export const MAX_QUOTE_CHARS = 20_000;

export const textQuoteSchema = z.object({
  exact: z.string().min(1).max(MAX_QUOTE_CHARS),
  prefix: z.string().max(400).optional(),
  suffix: z.string().max(400).optional(),
});

export const anchorSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('page'),
    source_id: ID,
    version_id: ID,
    page_id: ID,
    page_index: z.number().int().min(0).max(100_000),
    space: z.literal('page_norm'),
  }),
  z.object({ type: z.literal('note_page'), note_page_id: ID, space: z.literal('page_norm') }),
  z.object({
    type: z.literal('block'),
    lineage_id: ID,
    artifact_version: z.number().int().min(0),
    block_key: z.string().min(1).max(200),
    quote: textQuoteSchema.optional(),
    start: z.number().int().min(0).optional(),
    end: z.number().int().min(0).optional(),
  }),
]);
export type AnchorInput = z.infer<typeof anchorSchema>;

const inkPoint = z.array(finite).min(3).max(6);
const inkStyleSchema = z.looseObject({
  tool: z.enum(['pen', 'fountain', 'ball', 'highlighter']),
  color: z.string().min(1).max(40),
  width: finite.refine((n) => n > 0 && n <= 0.2, 'سماكة غير صالحة.'),
  opacity: unit.optional(),
});
export const inkDataSchema = z.looseObject({
  v: z.literal(1),
  points: z.array(inkPoint).min(1).max(20_000).refine((pts) => pts.every((p) => p[0]! >= -1 && p[0]! <= 2 && p[1]! >= -1 && p[1]! <= 2), 'نقطة خارج نطاق الصفحة.'),
  style: inkStyleSchema,
  bbox: normBoxSchema,
  pressure_available: z.boolean(),
  tilt_available: z.boolean(),
});
const shapeDataSchema = z.looseObject({
  v: z.literal(1),
  shape: z.enum(['line', 'arrow', 'rect', 'ellipse']),
  from: z.tuple([coord, coord]),
  to: z.tuple([coord, coord]),
  rotation: finite.optional(),
  style: inkStyleSchema,
  recognized_from: inkDataSchema.optional(),
});
const textBoxDataSchema = z.looseObject({ v: z.literal(1), box: normBoxSchema, text: richTextSchema, color: z.string().max(40), font_scale: finite });
const stickyDataSchema = z.looseObject({ v: z.literal(1), at: z.tuple([coord, coord]), text: z.string().max(20_000), color: z.string().max(40), collapsed: z.boolean().optional() });
export const textHighlightDataSchema = z.looseObject({
  v: z.literal(1),
  style: z.enum(['highlight', 'underline']),
  color: z.string().min(1).max(40),
  rects: z.array(normBoxSchema).min(1).max(500),
  quote: textQuoteSchema,
  region_ids: z.array(ID).max(200).optional(),
});
const bookmarkDataSchema = z.looseObject({ v: z.literal(1), label: z.string().max(300).optional() });
/** any other kind: a JSON object, size-limited by the caller */
const freeDataSchema = z.record(z.string(), z.unknown());

export const ANNOTATION_KINDS = ['ink', 'highlight', 'underline', 'shape', 'text', 'sticky', 'image', 'bookmark', 'link', 'text_highlight'] as const;

const DATA_BY_KIND: Record<(typeof ANNOTATION_KINDS)[number], z.ZodType> = {
  ink: inkDataSchema,
  // not fixed by the shared contract (the ink engine decides): any JSON object, size-limited
  highlight: freeDataSchema,
  underline: freeDataSchema,
  shape: shapeDataSchema,
  text: textBoxDataSchema,
  sticky: stickyDataSchema,
  image: freeDataSchema,
  bookmark: bookmarkDataSchema,
  link: freeDataSchema,
  text_highlight: textHighlightDataSchema,
};

export const annotationPayloadSchema = z
  .object({
    id: ID.optional(),
    kind: z.enum(ANNOTATION_KINDS),
    tool: z.string().max(40).nullish(),
    anchor: anchorSchema,
    data: z.record(z.string(), z.unknown()),
    layer: z.enum(['ink', 'highlight', 'text', 'media']).optional(),
    z: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    locked: z.boolean().optional(),
    anchor_status: z.enum(['ok', 'needs_reanchor', 'reanchored']).optional(),
    previous_anchor: anchorSchema.nullish(),
    input: z
      .object({ pointer_type: z.string().max(20).optional(), pressure: z.boolean().optional(), tilt: z.boolean().optional() })
      .nullish(),
    created_at: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    const r = DATA_BY_KIND[v.kind].safeParse(v.data);
    if (!r.success) {
      for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', path: ['data', ...issue.path.map((p) => String(p))], message: issue.message });
    }
  });
export type AnnotationPayload = z.infer<typeof annotationPayloadSchema>;

export const notePayloadSchema = z.object({
  id: ID.optional(),
  node_id: ID.nullish(),
  title: z.string().max(500).nullish(),
  body: richTextSchema,
  anchor: anchorSchema.nullish(),
  origin: z.enum(['owner', 'ai_answer', 'handwriting_recognition']).optional(),
  ai_record: z.record(z.string(), z.unknown()).nullish(),
  created_at: z.number().int().nonnegative().optional(),
});
export type NotePayload = z.infer<typeof notePayloadSchema>;

export const notePagePayloadSchema = z.object({
  id: ID.optional(),
  node_id: ID.nullish(),
  source_id: ID.nullish(),
  after_page_index: z.number().int().min(-1).max(100_000).nullish(),
  title: z.string().max(500).nullish(),
  template: z.enum(['blank', 'ruled', 'dotted', 'grid']).default('blank'),
  width: finite.refine((n) => n > 0 && n <= 20_000).default(595),
  height: finite.refine((n) => n > 0 && n <= 20_000).default(842),
  sort_order: finite.default(0),
  created_at: z.number().int().nonnegative().optional(),
});
export type NotePagePayload = z.infer<typeof notePagePayloadSchema>;

export const studyLocationSchema = z.looseObject({
  page_index: z.number().int().min(0).max(100_000).optional(),
  page_id: ID.optional(),
  block_key: z.string().max(200).optional(),
  zoom: finite.refine((n) => n >= 0.1 && n <= 10, 'قيمة التكبير غير صالحة.').optional(),
  page_offset: unit.optional(),
  rotation: z.number().int().refine((n) => n % 90 === 0, 'الدوران يجب أن يكون من مضاعفات 90.').optional(),
  layout: z.enum(['single', 'double', 'continuous']).optional(),
  rail: z.object({ open: z.boolean(), width: finite, tab: z.string().max(40) }).optional(),
  left_panel: z.object({ open: z.boolean(), tab: z.enum(['thumbnails', 'outline', 'bookmarks']) }).optional(),
  split: z
    .looseObject({ mode: z.string().max(40), secondary_source_id: ID.optional(), secondary_page_index: z.number().int().min(0).optional() })
    .nullish(),
});

export const studySessionPayloadSchema = z.object({
  id: ID.optional(),
  source_id: ID.nullish(),
  version_id: ID.nullish(),
  mode: z.enum(['learn', 'understand', 'practice', 'review', 'exam']).default('learn'),
  view: z.enum(['original', 'study_book', 'split']).default('original'),
  location: studyLocationSchema,
  scope: z.unknown().optional(),
  created_at: z.number().int().nonnegative().optional(),
});
export type StudySessionPayload = z.infer<typeof studySessionPayloadSchema>;

/** Max serialized payload size per op (a long stroke with 20k points is ≈ 1 MB). */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
