// Page geometry (§07, §25, AC-21). ONE coordinate system for regions, evidence boxes and ink:
//   normalized page space: x,y ∈ [0,1] relative to the UNROTATED page box, origin top-left.
// Views apply scale (css px per page unit) and a view rotation (0/90/180/270, clockwise) on top of the
// page's intrinsic /Rotate. Converting view ↔ normalized is exact and DPI/zoom independent, so ink
// written at any zoom/rotation/device returns to the same spot.

export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface PageViewTransform {
  /** unrotated page size in page units (PDF pt / image px) */
  pageWidth: number;
  pageHeight: number;
  /** css px per page unit */
  scale: number;
  /** total clockwise rotation applied to the page in the view (intrinsic + user), multiple of 90 */
  rotation: QuarterTurn;
}

export function normalizeRotation(deg: number): QuarterTurn {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as QuarterTurn;
}

/** Size of the rendered page box in css px. */
export function viewSize(t: PageViewTransform): { width: number; height: number } {
  const w = t.pageWidth * t.scale;
  const h = t.pageHeight * t.scale;
  return t.rotation === 90 || t.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** normalized page point → view px (relative to the rendered page box's top-left). */
export function normToView(nx: number, ny: number, t: PageViewTransform): [number, number] {
  const w = t.pageWidth * t.scale;
  const h = t.pageHeight * t.scale;
  const px = nx * w;
  const py = ny * h;
  switch (t.rotation) {
    case 0:
      return [px, py];
    case 90:
      return [h - py, px];
    case 180:
      return [w - px, h - py];
    case 270:
      return [py, w - px];
  }
}

/** view px → normalized page point. Exact inverse of normToView. */
export function viewToNorm(vx: number, vy: number, t: PageViewTransform): [number, number] {
  const w = t.pageWidth * t.scale;
  const h = t.pageHeight * t.scale;
  let px: number;
  let py: number;
  switch (t.rotation) {
    case 0:
      px = vx;
      py = vy;
      break;
    case 90:
      px = vy;
      py = h - vx;
      break;
    case 180:
      px = w - vx;
      py = h - vy;
      break;
    case 270:
      px = w - vy;
      py = vx;
      break;
  }
  return [px / w, py / h];
}

/** normalized box → view rect {left, top, width, height} in px. */
export function normBoxToView(b: NormBox, t: PageViewTransform): { left: number; top: number; width: number; height: number } {
  const [x1, y1] = normToView(b.x, b.y, t);
  const [x2, y2] = normToView(b.x + b.w, b.y + b.h, t);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** Bounding box of normalized points. */
export function boundsOf(points: ReadonlyArray<readonly [number, number, ...number[]]>): NormBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boxesIntersect(a: NormBox, b: NormBox): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function clampBox(b: NormBox): NormBox {
  const x = Math.min(1, Math.max(0, b.x));
  const y = Math.min(1, Math.max(0, b.y));
  return { x, y, w: Math.min(1 - x, Math.max(0, b.w)), h: Math.min(1 - y, Math.max(0, b.h)) };
}

/**
 * Convert a PDF-space rectangle (origin bottom-left, in pt, within the page's unrotated mediabox
 * [x0,y0,x1,y1]) to a normalized box.
 */
export function pdfRectToNorm(
  rect: { x: number; y: number; width: number; height: number },
  mediaBox: [number, number, number, number],
): NormBox {
  const [mx0, my0, mx1, my1] = mediaBox;
  const pw = mx1 - mx0;
  const ph = my1 - my0;
  return clampBox({
    x: (rect.x - mx0) / pw,
    y: (my1 - (rect.y + rect.height)) / ph,
    w: rect.width / pw,
    h: rect.height / ph,
  });
}
