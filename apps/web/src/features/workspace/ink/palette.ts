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
  /** (P1-T2) the e-ink grey (`<html data-eink="on">`; declared in ink.css too — themeDisplay.test.tsx keeps them equal) */
  eink: string;
}

export const PEN_COLORS: readonly InkColorToken[] = [
  { token: 'ink-black', label_ar: 'أسود', light: '#1c2230', dark: '#eceae4', eink: '#000000' },
  { token: 'ink-blue', label_ar: 'أزرق', light: '#2346c8', dark: '#8fb0ff', eink: '#141414' },
  { token: 'ink-red', label_ar: 'أحمر', light: '#c62828', dark: '#ff8a80', eink: '#2e2e2e' },
  { token: 'ink-green', label_ar: 'أخضر', light: '#1e7a46', dark: '#7fd6a0', eink: '#3d3d3d' },
  { token: 'ink-purple', label_ar: 'بنفسجي', light: '#6a3fb5', dark: '#c3a6ff', eink: '#222222' },
  { token: 'ink-orange', label_ar: 'برتقالي', light: '#b85300', dark: '#ffb36b', eink: '#4a4a4a' },
];

export const HIGHLIGHTER_COLORS: readonly InkColorToken[] = [
  { token: 'hl-yellow', label_ar: 'أصفر', light: '#ffe14d', dark: '#7a6500', eink: '#d6d6d6' },
  { token: 'hl-green', label_ar: 'أخضر فاتح', light: '#9be38d', dark: '#2f6b2a', eink: '#c4c4c4' },
  { token: 'hl-pink', label_ar: 'وردي', light: '#ff9ccf', dark: '#7a2f58', eink: '#bababa' },
  { token: 'hl-blue', label_ar: 'سماوي', light: '#8fd3ff', dark: '#1f5675', eink: '#cccccc' },
  { token: 'hl-orange', label_ar: 'برتقالي فاتح', light: '#ffc074', dark: '#7a4a10', eink: '#b0b0b0' },
];

/** Laser pointer trail (never saved). */
export const LASER_COLOR: InkColorToken = { token: 'laser', label_ar: 'مؤشر الليزر', light: '#e5281b', dark: '#ff5a4d', eink: '#000000' };

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
 * (P1-T2 review) A signature of the ink palette as it resolves on `style` right now: the computed value of every colour
 * token. Two renders with the same signature draw every token stroke in the same colours (the tile cache keys by it).
 */
export function paletteSignature(style: CSSStyleDeclaration | null | undefined): string {
  if (!style) return einkActive(null) ? 'eink' : '';
  return [...ALL_COLOR_TOKENS.map((c) => style.getPropertyValue(tokenVar(c.token)).trim()), einkActive(style) ? 'eink' : ''].join(',');
}

/**
 * (P1-T2 review) Is the e-ink display mode on? From the ink layer's CSS (`--ml-ink-mono: 1`, ink.css) when a computed
 * style is given, else from `<html data-eink="on">` (DOM objects such as text boxes resolve without the layer's CSS).
 */
function einkActive(style: CSSStyleDeclaration | null | undefined): boolean {
  if (style && style.getPropertyValue('--ml-ink-mono').trim() === '1') return true;
  try {
    return typeof document !== 'undefined' && document.documentElement.getAttribute('data-eink') === 'on';
  } catch {
    return false;
  }
}

/**
 * A custom colour on an e-ink screen: a grey of the same lightness, kept in the e-ink token ranges — pens and text dark
 * (#000…#4a4a4a, so a pale custom pen never fades away on a white page), highlighters light (#b0b0b0…#d6d6d6, so the
 * text under them stays readable). The order of lightness between colours is kept.
 */
export function einkGreyOf(hex: string, role: 'pen' | 'highlighter' = 'pen'): string {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const g = role === 'highlighter' ? 0xb0 + Math.round(l * (0xd6 - 0xb0)) : Math.round(l * 0x4a);
  const h = g.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/**
 * Resolve a stored colour to a concrete CSS colour. Tokens use the computed custom property of
 * `el` when the stylesheet is present (so a reader can override per paper tone), else the
 * defaults above. Unknown values fall back to the black token (never an invisible stroke).
 */
export function resolveInkColor(v: string, tone: PaperTone, style?: CSSStyleDeclaration | null, role: 'pen' | 'highlighter' = 'pen'): string {
  // (P1-T2 review) e-ink: black / grey only — a custom colour too, and tokens resolved without the ink layer's CSS
  const eink = einkActive(style);
  if (isHexColor(v)) return eink ? einkGreyOf(v, role) : v;
  const tok = BY_TOKEN.get(v) ?? PEN_COLORS[0]!;
  const fromCss = style?.getPropertyValue(tokenVar(tok.token)).trim();
  if (fromCss) return fromCss;
  if (eink) return tok.eink;
  return tone === 'dark' ? tok.dark : tok.light;
}
