// Owner settings (single owner). Stored as key/value rows in owner_setting; validated here.
import { z } from 'zod';
import { ANSWER_STYLES, EXPLANATION_LEVELS } from './enums';
import { SCOPE_MODES } from './scope';

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
});
export type OwnerSettings = z.infer<typeof ownerSettingsSchema>;

export const DEFAULT_OWNER_SETTINGS: OwnerSettings = ownerSettingsSchema.parse({});

/**
 * Settings whose value is a set of independent parts (one ordering per purpose). A PATCH replaces only the parts it
 * names; the others keep their current value (they are never reset to the defaults).
 */
export const NESTED_SETTING_KEYS = ['source_priority'] as const;

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
