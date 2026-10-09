// Ink colour tokens (spec §26 «ألوانًا وسماكات محفوظة»).
//
// Strokes store a TOKEN ('ink-blue', 'hl-yellow') or a custom '#rrggbb'. Tokens resolve per paper
// tone, so black ink stays readable on dark note paper. The same values are declared as CSS custom
// properties in ink.css (`--ml-ink-c-<token>`); a reader can scope `data-ink-paper="light"` on an
// ancestor of the InkLayer when it renders pages white inside the dark theme (e.g. original PDF
// pages), and every token then resolves to its light value. test/ink/palette.test.ts keeps the two
// declarations identical.
import type { InkPenTool } from '@medlevo/shared';

export type PaperTone = 'light' | 'dark';

export interface InkColorToken {
  token: string;
  label_ar: string;
  light: string;
  dark: string;
}

export const PEN_COLORS: readonly InkColorToken[] = [
  { token: 'ink-black', label_ar: 'أسود', light: '#1c2230', dark: '#eceae4' },
  { token: 'ink-blue', label_ar: 'أزرق', light: '#2346c8', dark: '#8fb0ff' },
  { token: 'ink-red', label_ar: 'أحمر', light: '#c62828', dark: '#ff8a80' },
  { token: 'ink-green', label_ar: 'أخضر', light: '#1e7a46', dark: '#7fd6a0' },
  { token: 'ink-purple', label_ar: 'بنفسجي', light: '#6a3fb5', dark: '#c3a6ff' },
  { token: 'ink-orange', label_ar: 'برتقالي', light: '#b85300', dark: '#ffb36b' },
];

export const HIGHLIGHTER_COLORS: readonly InkColorToken[] = [
  { token: 'hl-yellow', label_ar: 'أصفر', light: '#ffe14d', dark: '#7a6500' },
  { token: 'hl-green', label_ar: 'أخضر فاتح', light: '#9be38d', dark: '#2f6b2a' },
  { token: 'hl-pink', label_ar: 'وردي', light: '#ff9ccf', dark: '#7a2f58' },
  { token: 'hl-blue', label_ar: 'سماوي', light: '#8fd3ff', dark: '#1f5675' },
  { token: 'hl-orange', label_ar: 'برتقالي فاتح', light: '#ffc074', dark: '#7a4a10' },
];

/** Laser pointer trail (never saved). */
export const LASER_COLOR: InkColorToken = { token: 'laser', label_ar: 'مؤشر الليزر', light: '#e5281b', dark: '#ff5a4d' };

export const ALL_COLOR_TOKENS: readonly InkColorToken[] = [...PEN_COLORS, ...HIGHLIGHTER_COLORS, LASER_COLOR];
const BY_TOKEN = new Map(ALL_COLOR_TOKENS.map((c) => [c.token, c]));

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: string): boolean {
  return HEX_RE.test(v);
}

export function isKnownColor(v: string): boolean {
  return BY_TOKEN.has(v) || isHexColor(v);
}

export function colorsForTool(tool: InkPenTool | 'shape' | 'text'): readonly InkColorToken[] {
  return tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
}

export function colorLabel(v: string): string {
  return BY_TOKEN.get(v)?.label_ar ?? 'لون مخصّص';
}

/** CSS custom property that carries a token's value (declared in ink.css). */
export function tokenVar(token: string): string {
  return `--ml-ink-c-${token}`;
}

/**
 * Resolve a stored colour to a concrete CSS colour. Tokens use the computed custom property of
 * `el` when the stylesheet is present (so a reader can override per paper tone), else the
 * defaults above. Unknown values fall back to the black token (never an invisible stroke).
 */
export function resolveInkColor(v: string, tone: PaperTone, style?: CSSStyleDeclaration | null): string {
  if (isHexColor(v)) return v;
  const tok = BY_TOKEN.get(v) ?? PEN_COLORS[0]!;
  const fromCss = style?.getPropertyValue(tokenVar(tok.token)).trim();
  if (fromCss) return fromCss;
  return tone === 'dark' ? tok.dark : tok.light;
}
