// zod schemas for the annotation / note / note_page / study_session sync payloads (shapes from
// @medlevo/shared/annotations — AnnotationDTO, NoteDTO, NotePageDTO, StudySessionDTO).
// Server-managed fields (rev, created_at/updated_at, deleted_at, conflict ids) sent by a client are ignored.
// `data` objects are validated for the fields the contract defines and keep any extra keys (forward
// compatible ink formats); free-form records are size-limited.
import {
  ANNOTATION_IMAGE_MAX_BYTES,
  ANNOTATION_IMAGE_MAX_SIDE,
  ANNOTATION_IMAGE_MIMES,
  CONNECTOR_RELATIONS,
  CONNECTOR_ROUTES,
  COVER_COLORS,
  decodeInkPoints,
  hasBidiControls,
  INK_DASHES,
  INK_MEANING_MAX,
  INK_SMOOTHING_MAX,
  INK_TAPERS,
  INK_TEXTURES,
  NOTE_PAGE_KINDS,
  PATHWAY_HEADS,
  richTextSchema,
  richTextToPlain,
  SHAPE_CORNER_MAX,
  SHAPE_KINDS,
  SHAPE_LABEL_MAX,
  SHAPE_POLYGON_MAX,
  SHAPE_SIDES,
} from '@medlevo/shared';
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
/**
 * (parity N1, G03) the meaning of a colour slot copied onto a stroke: one trimmed line, 1–60 characters, no bidi control
 * characters (AC-20). Validated without transforming (the stored `data` is the payload as sent).
 */
export const inkMeaningSchema = z
  .string()
  .min(1, 'معنى اللون فارغ.')
  .max(INK_MEANING_MAX, `معنى اللون أطول من ${INK_MEANING_MAX} حرفًا.`)
  .refine((s) => s === s.trim() && !/[\r\n\t]/.test(s), 'معنى اللون سطر واحد دون مسافات في طرفيه.')
  .refine((s) => !hasBidiControls(s), 'معنى اللون يحتوي رموز اتجاه مخفية.');
/** (parity N1, G19) a rotation in radians about the item's centre (page space); one turn either way at most */
const rotationSchema = finite.refine((n) => Math.abs(n) <= 2 * Math.PI + 1e-9, 'زاوية دوران غير صالحة.');
const inkStyleSchema = z.looseObject({
  tool: z.enum(['pen', 'fountain', 'ball', 'highlighter']),
  color: z.string().min(1).max(40),
  width: finite.refine((n) => n > 0 && n <= 0.2, 'سماكة غير صالحة.'),
  opacity: unit.optional(),
  // (parity N1) colour meaning (G03) and pen feel (G01), saved with the stroke so every device draws it the same way
  meaning: inkMeaningSchema.optional(),
  smoothing: z.number().int('التنعيم عدد صحيح.').min(0).max(INK_SMOOTHING_MAX, 'التنعيم خارج المدى.').optional(),
  pressure_floor: finite.refine((n) => n >= 0 && n <= 0.9, 'حد الضغط الأدنى خارج المدى.').optional(),
  taper: z.enum(INK_TAPERS, 'نوع طرف الخط غير معروف.').optional(),
  constant: z.boolean().optional(),
  // (parity N1 wave 2) dashes / dots (G04) and the pencil's graphite grain (G06)
  dash: z.enum(INK_DASHES, 'نمط الخط غير معروف.').optional(),
  texture: z.enum(INK_TEXTURES, 'ملمس القلم غير معروف.').optional(),
});
/** (track F4) time link of a stroke to an in-app recording (shared InkAudioLink) */
export const audioLinkSchema = z.object({
  recording_id: ID,
  offset_ms: z.number().int().min(0).max(24 * 3600 * 1000, 'وقت التسجيل خارج المدى.'),
  origin: z.enum(['auto', 'manual']),
});
export const inkDataSchema = z.looseObject({
  v: z.literal(1),
  points: z.array(inkPoint).min(1).max(20_000).refine((pts) => pts.every((p) => p[0]! >= -1 && p[0]! <= 2 && p[1]! >= -1 && p[1]! <= 2), 'نقطة خارج نطاق الصفحة.'),
  style: inkStyleSchema,
  bbox: normBoxSchema,
  pressure_available: z.boolean(),
  tilt_available: z.boolean(),
  audio_link: audioLinkSchema.optional(),
});
/**
 * (P1-T2, ADR-0004 §2.5) ink data v2 from a client that sends `accept-ink: 2`: the same stroke with packed points. The
 * points are decoded and held to exactly the v1 rules (count, range); the server stores the decoded v1 (one stored
 * format, so re-anchoring, export and recognition keep reading `points`).
 */
export const MAX_PACKED_CHARS = 1_200_000;
export const inkDataV2Schema = z
  .looseObject({
    v: z.literal(2),
    points_packed: z.string().min(4).max(MAX_PACKED_CHARS),
    style: inkStyleSchema,
    bbox: normBoxSchema,
    pressure_available: z.boolean(),
    tilt_available: z.boolean(),
    audio_link: audioLinkSchema.optional(),
  })
  .superRefine((d, ctx) => {
    let pts: unknown;
    try {
      pts = decodeInkPoints(d.points_packed);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['points_packed'], message: 'النقاط المضغوطة تالفة؛ لم تُقرأ الكتابة.' });
      return;
    }
    const r = z.array(inkPoint).min(1).max(20_000).safeParse(pts);
    if (!r.success || !r.data.every((p) => p[0]! >= -1 && p[0]! <= 2 && p[1]! >= -1 && p[1]! <= 2)) {
      ctx.addIssue({ code: 'custom', path: ['points_packed'], message: 'نقطة خارج نطاق الصفحة.' });
    }
  });
/** (parity N1 wave 2, G20) a fill colour: a palette token or #rrggbb */
const fillColorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|(ink|hl)-[a-z]{2,20})$/, 'لون التعبئة غير معروف.');
/** (G21) the edge point of a shape a connector is attached to */
const shapeAttachSchema = z.object({ id: ID, side: z.enum(SHAPE_SIDES, 'جهة الاتصال غير معروفة.') });
export const shapeDataSchema = z
  .looseObject({
    v: z.literal(1),
    shape: z.enum(SHAPE_KINDS, 'نوع الشكل غير معروف.'),
    from: z.tuple([coord, coord]),
    to: z.tuple([coord, coord]),
    rotation: finite.optional(),
    style: inkStyleSchema,
    recognized_from: inkDataSchema.optional(),
    audio_link: audioLinkSchema.optional(),
    // ── (parity N1 wave 2 — G20 shapes, G21 connectors) ──
    fill: fillColorSchema.optional(),
    corner: finite.refine((n) => n > 0 && n <= SHAPE_CORNER_MAX, 'نصف قطر الزاوية خارج المدى.').optional(),
    label: richTextSchema
      .refine((t) => richTextToPlain(t).length <= SHAPE_LABEL_MAX, `النص داخل الشكل أطول من ${SHAPE_LABEL_MAX} حرف.`)
      .refine((t) => !hasBidiControls(richTextToPlain(t)), 'النص داخل الشكل يحتوي رموز اتجاه مخفية.')
      .optional(),
    label_scale: finite.refine((n) => n >= 0.004 && n <= 0.1, 'حجم خط النص داخل الشكل خارج المدى.').optional(),
    points: z.array(z.tuple([coord, coord])).min(3, 'المضلّع يحتاج ثلاث زوايا على الأقل.').max(SHAPE_POLYGON_MAX, `المضلّع ${SHAPE_POLYGON_MAX} زاوية على الأكثر.`).optional(),
    control: z.tuple([coord, coord]).optional(),
    head: z.enum(PATHWAY_HEADS, 'رأس السهم غير معروف.').optional(),
    route: z.enum(CONNECTOR_ROUTES, 'مسار الموصِّل غير معروف.').optional(),
    attach: z.object({ from: shapeAttachSchema.optional(), to: shapeAttachSchema.optional() }).optional(),
    relation: z.enum(CONNECTOR_RELATIONS, 'نوع العلاقة غير معروف.').optional(),
    concept_id: ID.optional(),
    concept_name: z
      .string()
      .min(1)
      .max(300)
      .refine((s) => !hasBidiControls(s) && !/[\r\n]/.test(s), 'اسم المفهوم سطر واحد دون رموز اتجاه مخفية.')
      .optional(),
  })
  .refine((d) => d.shape !== 'polygon' || (Array.isArray(d.points) && d.points.length >= 3), { message: 'المضلّع يحتاج زواياه.', path: ['points'] });
const textBoxDataSchema = z.looseObject({ v: z.literal(1), box: normBoxSchema, text: richTextSchema, color: z.string().max(40), font_scale: finite, rotation: rotationSchema.optional() });
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

/** a box placed on the page: inside the stored range, with a real size */
const placedBoxSchema = normBoxSchema.refine((b) => b.w > 0 && b.h > 0, 'المساحة على الصفحة يجب أن يكون لها عرض وارتفاع.');
/** a region on the target page of a link (normalized to that page) */
const targetBoxSchema = z.object({ x: unit, y: unit, w: unit, h: unit });

/** Link target (shared LinkTarget): a page of a source version (optionally a region on it) or a note page. */
export const linkTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('source_page'),
    source_id: ID,
    version_id: ID.nullable(),
    page_id: ID.nullable(),
    page_index: z.number().int().min(0).max(100_000),
    bbox: targetBoxSchema.nullish(),
    region_id: ID.nullish(),
  }),
  z.object({ type: z.literal('note_page'), note_page_id: ID, bbox: targetBoxSchema.nullish() }),
]);
export const linkDataSchema = z.looseObject({
  v: z.literal(1),
  box: placedBoxSchema,
  target: linkTargetSchema,
  label: z.string().max(200).nullish(),
  target_label: z.string().max(300).nullish(),
});

/** Image annotation data (shared ImageAnnotationData): the picture itself travels separately by image_key. */
export const imageDataSchema = z.looseObject({
  v: z.literal(1),
  image_key: ID,
  box: placedBoxSchema,
  mime: z.enum(ANNOTATION_IMAGE_MIMES, 'نوع الصورة غير مدعوم (PNG أو JPEG أو WebP أو GIF).'),
  natural_w: z.number().int().min(1).max(ANNOTATION_IMAGE_MAX_SIDE),
  natural_h: z.number().int().min(1).max(ANNOTATION_IMAGE_MAX_SIDE),
  bytes: z.number().int().min(1).max(ANNOTATION_IMAGE_MAX_BYTES, 'الصورة أكبر من الحد المسموح (10 ميغابايت).'),
  alt: z.string().max(500).nullish(),
  name: z.string().max(255).nullish(),
  /** (parity N1, G19) rotation about the picture's centre */
  rotation: rotationSchema.optional(),
});
/** any other kind: a JSON object, size-limited by the caller */
const freeDataSchema = z.record(z.string(), z.unknown());

export const ANNOTATION_KINDS = ['ink', 'highlight', 'underline', 'shape', 'text', 'sticky', 'image', 'bookmark', 'link', 'text_highlight'] as const;

const DATA_BY_KIND: Record<(typeof ANNOTATION_KINDS)[number], z.ZodType> = {
  ink: z.union([inkDataSchema, inkDataV2Schema]),
  // not fixed by the shared contract (the ink engine decides): any JSON object, size-limited
  highlight: freeDataSchema,
  underline: freeDataSchema,
  shape: shapeDataSchema,
  text: textBoxDataSchema,
  sticky: stickyDataSchema,
  image: imageDataSchema,
  bookmark: bookmarkDataSchema,
  link: linkDataSchema,
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
    /** (P1-T2) the authorship layer; absent / null = the document's default personal layer («ملاحظاتي») */
    layer_id: ID.nullish(),
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
  /** (P1-T2) the authorship layer; absent / null = the document's default personal layer */
  layer_id: ID.nullish(),
});
export type NotePayload = z.infer<typeof notePayloadSchema>;

export const notePagePayloadSchema = z
  .object({
    id: ID.optional(),
    node_id: ID.nullish(),
    source_id: ID.nullish(),
    after_page_index: z.number().int().min(-1).max(100_000).nullish(),
    /** the source page it was inserted after (placement survives a re-numbered version) */
    after_page_id: ID.nullish(),
    title: z.string().max(500).nullish(),
    template: z.enum(['blank', 'ruled', 'dotted', 'grid']).default('blank'),
    /** 'divider' starts a section (tab) of a notebook */
    kind: z.enum(NOTE_PAGE_KINDS).default('page'),
    /** a divider's tab colour: a cover colour token */
    color: z.enum(COVER_COLORS, 'لون القسم غير معروف.').nullish(),
    width: finite.refine((n) => n >= 100 && n <= 20_000, 'مقاس الصفحة غير صالح.').default(595),
    height: finite.refine((n) => n >= 100 && n <= 20_000, 'مقاس الصفحة غير صالح.').default(842),
    sort_order: finite.refine((n) => Math.abs(n) <= 1e12, 'ترتيب الصفحة غير صالح.').default(0),
    created_at: z.number().int().nonnegative().optional(),
  })
  .refine((p) => !!p.node_id || !!p.source_id, {
    message: 'صفحة الملاحظات يجب أن تكون داخل دفتر أو مجلد، أو بعد صفحة من مصدر.',
    path: ['node_id'],
  })
  .refine((p) => p.after_page_index == null || !!p.source_id, {
    message: 'موضع الصفحة بعد صفحة من مصدر يحتاج المصدر نفسه.',
    path: ['after_page_index'],
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
  left_panel: z.object({ open: z.boolean(), tab: z.enum(['thumbnails', 'outline', 'bookmarks', 'layers']) }).optional(),
  /** (P1-T2) layers hidden in this study session and the layer new writing goes to */
  layers: z.object({ hidden: z.array(ID).max(200).optional(), active: ID.nullish() }).optional(),
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
