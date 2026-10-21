// Pen feel (parity N1, G01): smoothing, pressure floor, taper and constant width per nib, in named profiles.
//
// The feel a stroke was written with is saved IN its style (InkStyle.smoothing / pressure_floor / taper / constant), so
// every device draws it the same way and changing the profile later never changes what was written. Only values that
// differ from the classic drawing are stored (a classic stroke is byte for byte what the engine wrote before N1).
// The profile in use is remembered per notebook / document on this device.
import type { InkNibFeel, InkPenTool, InkSettings, InkStyle } from '@medlevo/shared';
import { localGet, localSet } from './prefs';

export type FeelProfileId = 'classic' | 'writing' | 'fine' | 'anatomy' | 'custom';

export interface FeelProfile {
  id: FeelProfileId;
  label_ar: string;
  hint_ar: string;
  /** null: the owner's own values (settings `ink.feel`) */
  feel: InkNibFeel | null;
  /** thinnest line this profile allows to be thicker than (page-width fraction); null = the tool's own width */
  widthCap: number | null;
}

/** The classic drawing (everything before N1): radius-2 smoothing, no floor, no taper, width follows pressure. */
export const CLASSIC_FEEL: InkNibFeel = { smoothing: 2, pressure_floor: 0, taper: 'none', constant: false };

export const FEEL_PROFILES: readonly FeelProfile[] = [
  { id: 'classic', label_ar: 'كلاسيكي', hint_ar: 'الرسم كما كان: تنعيم خفيف، والسماكة تتبع الضغط إن أبلغ عنه القلم.', feel: CLASSIC_FEEL, widthCap: null },
  { id: 'writing', label_ar: 'كتابة', hint_ar: 'تنعيم قليل ليبقى الخط سريع الاستجابة، وطرف ناعم للحروف.', feel: { smoothing: 1, pressure_floor: 0.15, taper: 'round', constant: false }, widthCap: null },
  { id: 'fine', label_ar: 'رسم دقيق', hint_ar: 'تنعيم عالٍ يثبّت اليد في الرسوم والمنحنيات.', feel: { smoothing: 5, pressure_floor: 0.1, taper: 'none', constant: false }, widthCap: null },
  { id: 'anatomy', label_ar: 'تشريح', hint_ar: 'تثبيت قوي وخط رفيع ثابت السماكة لتتبّع حدود البنى في الأطالس.', feel: { smoothing: 6, pressure_floor: 0, taper: 'none', constant: true }, widthCap: 0.0016 },
  { id: 'custom', label_ar: 'مخصّص', hint_ar: 'قيمك أنت لكل نوع قلم (تُحفظ في إعداداتك وتتبعك إلى أجهزتك).', feel: null, widthCap: null },
];

export function feelProfile(id: FeelProfileId): FeelProfile {
  return FEEL_PROFILES.find((p) => p.id === id) ?? FEEL_PROFILES[0]!;
}

/** The feel a new stroke of `tool` gets under `profile`. */
export function feelFor(profile: FeelProfileId, tool: InkPenTool, settings: InkSettings): InkNibFeel {
  const p = feelProfile(profile);
  if (p.feel) return tool === 'highlighter' ? { ...CLASSIC_FEEL, smoothing: p.feel.smoothing } : p.feel;
  return settings.feel[tool] ?? CLASSIC_FEEL;
}

/** The style fields to store for a feel (only what differs from the classic drawing). */
export function styleFeel(f: InkNibFeel): Partial<InkStyle> {
  const out: Partial<InkStyle> = {};
  if (f.smoothing !== CLASSIC_FEEL.smoothing) out.smoothing = clampInt(f.smoothing, 0, 6);
  if (f.pressure_floor > 0) out.pressure_floor = Math.min(0.9, Math.round(f.pressure_floor * 100) / 100);
  if (f.taper !== 'none') out.taper = f.taper;
  if (f.constant) out.constant = true;
  return out;
}

/** The width a stroke is written with under a profile (the anatomy profile keeps lines thin). */
export function cappedWidth(profile: FeelProfileId, width: number): number {
  const cap = feelProfile(profile).widthCap;
  return cap != null ? Math.min(width, cap) : width;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

// ── the profile per notebook / document (this device) ──
const KEY = 'medlevo.ink.feel.v1:';
const IDS: readonly FeelProfileId[] = ['classic', 'writing', 'fine', 'anatomy', 'custom'];

export function loadFeelProfile(documentKey: string): FeelProfileId {
  const v = localGet(KEY + documentKey);
  return v && (IDS as readonly string[]).includes(v) ? (v as FeelProfileId) : 'classic';
}

export function saveFeelProfile(documentKey: string, id: FeelProfileId): void {
  localSet(KEY + documentKey, id);
}
