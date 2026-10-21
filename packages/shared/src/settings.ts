// Owner settings (single owner). Stored as key/value rows in owner_setting; validated here.
import { z } from 'zod';
import { ANSWER_STYLES, EXPLANATION_LEVELS, STUDY_MODES } from './enums';
import { hasBidiControls } from './richtext';
import { SCOPE_MODES } from './scope';

// ───────── (parity N1 — writing comfort and speed) the `ink` settings object ─────────
// Synced with the owner's other settings (GET / PATCH /api/settings) and cached on each device by the web settings store,
// so it works offline. Every part has a default that reproduces the engine's behaviour before N1.

/** Tools that have their own colour slots. */
export const INK_SLOT_TOOLS = ['pen', 'fountain', 'ball', 'highlighter', 'shape', 'text', 'pencil'] as const;
export type InkSlotTool = (typeof INK_SLOT_TOOLS)[number];
/** Most colour slots one tool keeps. */
export const INK_MAX_SLOTS = 12;
/** Longest meaning label of a slot (same limit as `InkStyle.meaning`). */
export const INK_SLOT_MEANING_MAX = 60;

/** A colour token of the ink palette (`ink-blue`, `hl-yellow` …) or a custom `#rrggbb`. */
export const INK_COLOR_RE = /^(#[0-9a-fA-F]{6}|(ink|hl)-[a-z]{2,20})$/;

/** A meaning label: trimmed, one line, 1–60 characters, never a bidi control character (AC-20). */
export const inkMeaningSchema = z
  .string()
  .trim()
  .min(1, 'اكتب معنى اللون أو اتركه فارغًا.')
  .max(INK_SLOT_MEANING_MAX, `معنى اللون أطول من ${INK_SLOT_MEANING_MAX} حرفًا.`)
  .refine((s) => !/[\r\n\t]/.test(s), 'معنى اللون سطر واحد.')
  .refine((s) => !hasBidiControls(s), 'معنى اللون يحتوي رموز اتجاه مخفية؛ احذفها.');

export const inkSlotSchema = z.object({
  color: z.string().regex(INK_COLOR_RE, 'لون غير معروف: اختر من لوحة الألوان أو لونًا بصيغة #rrggbb.'),
  meaning: inkMeaningSchema.optional(),
  /** (parity N1 wave 2, G04) the slot's line pattern (absent = solid): a dashed «to verify» pen, a dotted «deep structure» pen */
  dash: z.enum(['dash', 'dot']).optional(),
});
export type InkSlot = z.infer<typeof inkSlotSchema>;

const inkSlotsSchema = z.array(inkSlotSchema).min(1, 'أبقِ لونًا واحدًا على الأقل.').max(INK_MAX_SLOTS, `${INK_MAX_SLOTS} لونًا على الأكثر لكل أداة.`);

/** Toolbar entries the owner arranges: the built-in tool families and tools registered by other tracks (`x:<id>`). */
export const INK_TOOLBAR_ID_RE = /^([a-z_]{2,20}|x:[a-z0-9_-]{2,40})$/;
const toolbarIdSchema = z.string().regex(INK_TOOLBAR_ID_RE, 'أداة غير معروفة في الشريط.');

export const INK_TOOLBAR_DOCKS = ['top', 'start', 'end'] as const;
export type InkToolbarDock = (typeof INK_TOOLBAR_DOCKS)[number];
export const INK_PALM_LEVELS = ['low', 'medium', 'high'] as const;
export type InkPalmLevel = (typeof INK_PALM_LEVELS)[number];
export const INK_HANDS = ['right', 'left'] as const;
export type InkHand = (typeof INK_HANDS)[number];

const nibFeelSchema = z.object({
  smoothing: z.number().int().min(0).max(6).default(2),
  pressure_floor: z.number().min(0).max(0.9).default(0),
  taper: z.enum(['none', 'round', 'sharp']).default('none'),
  constant: z.boolean().default(false),
});
export type InkNibFeel = z.infer<typeof nibFeelSchema>;

export const inkSettingsSchema = z.object({
  /** colour slots per tool; a tool that is absent uses the built-in palette */
  palettes: z
    .object({
      pen: inkSlotsSchema.optional(),
      fountain: inkSlotsSchema.optional(),
      ball: inkSlotsSchema.optional(),
      highlighter: inkSlotsSchema.optional(),
      shape: inkSlotsSchema.optional(),
      text: inkSlotsSchema.optional(),
      /** (parity N1 wave 2, G06) */
      pencil: inkSlotsSchema.optional(),
    })
    .prefault({}),
  /** pen gestures, recognised after a stroke is committed; each can be turned off (each also has a button / shortcut) */
  gestures: z
    .object({
      scribble_erase: z.boolean().default(true),
      circle_lasso: z.boolean().default(true),
      finger_undo: z.boolean().default(true),
    })
    .prefault({}),
  /** the web palm-rejection heuristic: how strict it is and which hand rests on the screen */
  palm: z.object({ sensitivity: z.enum(INK_PALM_LEVELS).default('medium'), hand: z.enum(INK_HANDS).default('right') }).prefault({}),
  /** «مخصّص» pen feel per nib (the named profiles are fixed in the engine) */
  feel: z
    .object({ pen: nibFeelSchema.prefault({}), fountain: nibFeelSchema.prefault({}), ball: nibFeelSchema.prefault({}), highlighter: nibFeelSchema.prefault({}), pencil: nibFeelSchema.prefault({}) })
    .prefault({}),
  /**
   * (parity N1 wave 2, G22) snapping while moving a selection or drawing a shape: to other items' edges and centres, to
   * the paper's grid pitch and to the lecture's processed regions (lines, paragraphs, figures). Alt held = no snapping.
   */
  snap: z
    .object({ enabled: z.boolean().default(true), items: z.boolean().default(true), grid: z.boolean().default(true), regions: z.boolean().default(true) })
    .prefault({}),
  /**
   * (parity N1 wave 2, G09) the zoom writing window: writing direction (auto = right to left unless the page's text is
   * English), the height of one written line (fraction of the page width), the margins it keeps at the start and end
   * of a line (in the writing direction), the gap to the next line, auto-advance and the size of the docked strip.
   */
  zoom: z
    .object({
      direction: z.enum(['auto', 'rtl', 'ltr']).default('auto'),
      line_height: z.number().min(0.015).max(0.12).default(0.045),
      margin_start: z.number().min(0).max(0.4).default(0.06),
      margin_end: z.number().min(0).max(0.4).default(0.06),
      line_gap: z.number().min(0).max(0.1).default(0.012),
      auto_advance: z.boolean().default(true),
      strip: z.enum(['small', 'medium', 'large']).default('medium'),
    })
    .prefault({}),
  /** the writing toolbar as the owner arranged it */
  toolbar: z
    .object({
      /** tool order (unknown or missing tools keep their built-in place after these) */
      order: z.array(toolbarIdSchema).max(48).default([]),
      hidden: z.array(toolbarIdSchema).max(48).default([]),
      dock: z.enum(INK_TOOLBAR_DOCKS).default('top'),
      /** a slot for the tool used before the current one */
      recent: z.boolean().default(true),
      /** insert tools (text, sticky note, picture, link, shapes) hand back to the lasso after one use */
      insert_returns_to_lasso: z.boolean().default(false),
      /** per study mode: the tools hidden in that mode (absent = the general layout) */
      modes: z.partialRecord(z.enum(STUDY_MODES), z.object({ hidden: z.array(toolbarIdSchema).max(48) })).default({}),
    })
    .prefault({}),
});
export type InkSettings = z.infer<typeof inkSettingsSchema>;

/** The `ink` settings with every default filled in. */
export const DEFAULT_INK_SETTINGS: InkSettings = inkSettingsSchema.parse({});

/**
 * Reads a stored / received `ink` value defensively: each part that does not validate falls back to its default (a bad
 * palette never takes the gestures or the toolbar with it).
 */
export function parseInkSettings(raw: unknown): InkSettings {
  const whole = inkSettingsSchema.safeParse(raw ?? {});
  if (whole.success) return whole.data;
  const out: Record<string, unknown> = {};
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const key of Object.keys(DEFAULT_INK_SETTINGS) as Array<keyof InkSettings>) {
    const part = inkSettingsSchema.shape[key].safeParse(src[key]);
    out[key] = part.success ? part.data : DEFAULT_INK_SETTINGS[key];
  }
  return out as InkSettings;
}

export const ownerSettingsSchema = z.object({
  timezone: z.string().default('Asia/Baghdad'),
  ui_language: z.enum(['ar', 'en']).default('ar'),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  paper_texture: z.boolean().default(true),
  reduce_motion: z.enum(['system', 'on', 'off']).default('system'),
  text_scale: z.number().min(0.8).max(1.6).default(1),
  // explanation rules (§19)
  explanation_level: z.enum(EXPLANATION_LEVELS).default('medium'),
  dialect: z.enum(['fusha_simple', 'iraqi_teaching']).default('fusha_simple'),
  custom_instruction: z.string().max(1000).default(''),
  answer_style: z.enum(ANSWER_STYLES).default('detailed'),
  socratic_default: z.boolean().default(false),
  check_question_density: z.enum(['off', 'low', 'medium']).default('low'),
  margin_density: z.enum(['minimal', 'normal', 'rich']).default('normal'),
  // source lock defaults (§8, §9)
  default_scope_mode: z.enum(SCOPE_MODES).default('lecture_only'),
  source_priority: z
    .object({
      lecture_explanation: z.array(z.string()).default(['lecture', 'course_reference', 'textbook']),
      source_question_practice: z.array(z.string()).default(['question_source', 'lecture', 'course_reference']),
      clinical_expansion: z.array(z.string()).default(['course_reference', 'guideline', 'textbook', 'lecture']),
    })
    .default({
      lecture_explanation: ['lecture', 'course_reference', 'textbook'],
      source_question_practice: ['question_source', 'lecture', 'course_reference'],
      clinical_expansion: ['course_reference', 'guideline', 'textbook', 'lecture'],
    }),
  // practice
  practice_hints: z.enum(['off', 'progressive']).default('progressive'),
  anti_shortcut_mode: z.boolean().default(false),
  // learning
  daily_new_cards: z.number().int().min(0).max(500).default(20),
  desired_retention: z.number().min(0.7).max(0.99).default(0.9),
  self_level: z.string().max(200).default(''),
  // workspace layout
  rail_width: z.number().int().min(280).max(640).default(380),
  rail_open: z.boolean().default(true),
  page_layout: z.enum(['single', 'double', 'continuous']).default('continuous'),
  page_flip_animation: z.boolean().default(false),
  // (parity N1) the writing engine: colour slots and their meanings, gestures, palm rejection, pen feel, toolbar layout.
  // One nested object (NESTED_SETTING_KEYS): a PATCH that names `ink` changes only the parts it names.
  ink: inkSettingsSchema.prefault({}),
});
export type OwnerSettings = z.infer<typeof ownerSettingsSchema>;

export const DEFAULT_OWNER_SETTINGS: OwnerSettings = ownerSettingsSchema.parse({});

/**
 * Settings whose value is a set of independent parts (one ordering per purpose). A PATCH replaces only the parts it
 * names; the others keep their current value (they are never reset to the defaults).
 */
export const NESTED_SETTING_KEYS = ['source_priority', 'ink'] as const;

/** `{ ...base, ...patch }` with a per-part merge for NESTED_SETTING_KEYS (server PATCH and the web store use it). */
export function mergeSettingsPatch<T extends object>(base: T, patch: object): T {
  const b = base as unknown as Record<string, unknown>;
  const p = patch as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b, ...p };
  for (const k of NESTED_SETTING_KEYS) {
    const pv = p[k];
    const bv = b[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) out[k] = { ...bv, ...pv };
  }
  return out as unknown as T;
}
