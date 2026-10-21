// The eyedropper (parity N1 wave 2, G07): pick a colour from the page — a stain on a histology picture (H&E pink /
// purple, a special stain) to label structures in the matching colour.
//
// Two paths, and the capability panel says which one this browser uses:
//  * the browser's own EyeDropper API (Chromium on a computer): it picks any pixel on the screen;
//  * elsewhere (Safari on iPad, Firefox, Android browsers): the owner taps the page and MedLevo reads the colour the
//    app itself drew there — the page picture or PDF canvas, a picture placed on it, and the ink over them — from the
//    rendered canvases. It cannot read colours outside the page, and a picture from another site (none in MedLevo) would
//    be refused by the browser.
// The colour becomes the pen's colour and is kept in the tool's colour slots (G03, synced).

export type EyedropperPath = 'api' | 'canvas';

/** Which path this browser uses (the API only where its feature test passes). */
export function eyedropperPath(): EyedropperPath {
  try {
    return typeof window !== 'undefined' && typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper === 'function' ? 'api' : 'canvas';
  } catch {
    return 'canvas';
  }
}

/** A colour as `#rrggbb` (the API answers `#rrggbb` or `rgb(…)`), or null. */
export function toHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Number(x))).toString(16).padStart(2, '0')).join('')}`;
}

/** The browser's EyeDropper (needs a click: call it from the button's handler). null = cancelled or failed. */
export async function pickWithApi(): Promise<string | null> {
  try {
    const Ctor = (window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
    const r = await new Ctor().open();
    return toHex(r.sRGBHex);
  } catch {
    return null;
  }
}

type RGBA = [number, number, number, number];

/** Source-over (or multiply, for the highlight canvas) of one sample onto the colour below. Pure. */
export function composite(below: RGBA, src: RGBA, mode: 'normal' | 'multiply' = 'normal'): RGBA {
  const a = src[3] / 255;
  if (a <= 0) return below;
  const mix = (b: number, s: number) => {
    const top = mode === 'multiply' ? (b * s) / 255 : s;
    return Math.round(top * a + b * (1 - a));
  };
  return [mix(below[0], src[0]), mix(below[1], src[1]), mix(below[2], src[2]), 255];
}

function pixelOf(el: HTMLCanvasElement | HTMLImageElement, clientX: number, clientY: number): RGBA | null {
  const r = el.getBoundingClientRect();
  if (clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom || r.width <= 0 || r.height <= 0) return null;
  try {
    if (el instanceof HTMLCanvasElement) {
      const ctx = el.getContext('2d');
      if (!ctx || !el.width || !el.height) return null;
      const x = Math.floor(((clientX - r.left) * el.width) / r.width);
      const y = Math.floor(((clientY - r.top) * el.height) / r.height);
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]!];
    }
    if (!el.complete || !el.naturalWidth) return null;
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const sx = ((clientX - r.left) * el.naturalWidth) / r.width;
    const sy = ((clientY - r.top) * el.naturalHeight) / r.height;
    ctx.drawImage(el, sx, sy, 1, 1, 0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]!];
  } catch {
    // a picture the browser will not let the page read (another origin): skipped
    return null;
  }
}

/**
 * The colour MedLevo drew at a point of the page: the canvases and pictures of the page sheet under the ink layer, in
 * paint order, over the paper. null when nothing could be read there.
 */
export function sampleRenderedColor(layerRoot: HTMLElement, clientX: number, clientY: number): string | null {
  const sheet = (layerRoot.closest('.wk-sheet') as HTMLElement | null) ?? layerRoot.parentElement?.parentElement ?? layerRoot.parentElement;
  if (!sheet) return null;
  let color: RGBA = [255, 255, 255, 255];
  try {
    const bg = getComputedStyle(sheet).backgroundColor;
    const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?/.exec(bg);
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) color = [Number(m[1]), Number(m[2]), Number(m[3]), 255];
  } catch {
    // keep white paper
  }
  let read = false;
  for (const el of Array.from(sheet.querySelectorAll<HTMLCanvasElement | HTMLImageElement>('canvas, img'))) {
    if (el.closest('[aria-hidden="true"][data-ink-preview]')) continue;
    const px = pixelOf(el, clientX, clientY);
    if (!px) continue;
    read = true;
    color = composite(color, px, el.classList.contains('ml-ink-layer__canvas--highlight') ? 'multiply' : 'normal');
  }
  return read ? `#${color.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}` : null;
}
