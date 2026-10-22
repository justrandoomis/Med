// What a page of a published explanation looks like, drawn as marks over the official page's thumbnail (P1-T5 step 3).
// Pure: the publication page asks the server for the version's items (members of the subject only) and turns them into
// SVG paths and boxes in the page's normalized space (0…1). The page picture comes from the official version's
// thumbnail; nothing of the author's vault is read here.
import type { AnnotationDTO, NormBox } from '@medlevo/shared';

export interface PagePreview {
  pageId: string;
  pageIndex: number;
  /** ink strokes as SVG path data (normalized coordinates) */
  paths: string[];
  /** frames of everything else (text boxes, shapes, sticky notes, highlights) */
  boxes: NormBox[];
  items: number;
}

const r = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function pathOf(points: unknown): string | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  const out: string[] = [];
  for (const p of points) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
    out.push(`${out.length === 0 ? 'M' : 'L'}${r(clamp(p[0]))} ${r(clamp(p[1]))}`);
  }
  return out.length ? out.join(' ') : null;
}

function boxOf(data: Record<string, unknown>): NormBox[] {
  const b = (v: unknown): NormBox | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.x !== 'number' || typeof o.y !== 'number' || typeof o.w !== 'number' || typeof o.h !== 'number') return null;
    return { x: clamp(o.x), y: clamp(o.y), w: Math.max(0.004, Math.min(1, o.w)), h: Math.max(0.004, Math.min(1, o.h)) };
  };
  if (Array.isArray(data.rects)) return data.rects.map(b).filter((x): x is NormBox => x !== null);
  const one = b(data.box) ?? b(data.bbox);
  if (one) return [one];
  // a shape: its two corners; a sticky note: a small square at its point
  const pt = (v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? ([clamp(v[0]), clamp(v[1])] as const) : null);
  const from = pt(data.from);
  const to = pt(data.to);
  if (from && to) return [{ x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), w: Math.max(0.004, Math.abs(to[0] - from[0])), h: Math.max(0.004, Math.abs(to[1] - from[1])) }];
  const at = pt(data.at);
  if (at) return [{ x: at[0], y: at[1], w: 0.03, h: 0.03 }];
  return [];
}

/** The frame of one item on its page (ink: its bbox, or the extent of its points). */
export function itemBox(it: Pick<AnnotationDTO, 'kind' | 'data'>): NormBox | null {
  const data = (it.data ?? {}) as Record<string, unknown>;
  const boxes = boxOf(data);
  if (boxes.length) {
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
  }
  if (it.kind === 'ink' && Array.isArray(data.points)) {
    const pts = (data.points as unknown[]).filter((p): p is number[] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number');
    if (!pts.length) return null;
    const xs = pts.map((p) => clamp(p[0]!));
    const ys = pts.map((p) => clamp(p[1]!));
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(0.004, Math.max(...xs) - Math.min(...xs)), h: Math.max(0.004, Math.max(...ys) - Math.min(...ys)) };
  }
  return null;
}

export type ChangeKind = 'added' | 'changed' | 'removed';
export interface ChangeMark {
  kind: ChangeKind;
  box: NormBox;
}

const PAD = 0.01;
const padded = (b: NormBox): NormBox => ({ x: Math.max(0, b.x - PAD), y: Math.max(0, b.y - PAD), w: Math.min(1, b.w + 2 * PAD), h: Math.min(1, b.h + 2 * PAD) });

/**
 * What changed on one page between two versions of an explanation, for the update preview: items whose (stable) id is
 * new are «added», an id whose content differs is «changed», an id that is gone is «removed» (drawn where it was).
 */
export function changeMarks(from: readonly AnnotationDTO[], to: readonly AnnotationDTO[]): ChangeMark[] {
  const before = new Map(from.filter((i) => i.deleted_at == null).map((i) => [i.id, i]));
  const after = new Map(to.filter((i) => i.deleted_at == null).map((i) => [i.id, i]));
  const out: ChangeMark[] = [];
  const add = (kind: ChangeKind, it: AnnotationDTO) => {
    const b = itemBox(it);
    if (b) out.push({ kind, box: padded(b) });
  };
  for (const [id, it] of after) {
    const old = before.get(id);
    if (!old) add('added', it);
    else if (JSON.stringify(old.data) !== JSON.stringify(it.data) || JSON.stringify(old.anchor) !== JSON.stringify(it.anchor)) add('changed', it);
  }
  for (const [id, it] of before) if (!after.has(id)) add('removed', it);
  return out;
}

/** Groups the items of a version by official page (items on inserted note pages are not part of a Phase 1 snapshot). */
export function pagePreviews(items: readonly AnnotationDTO[], limit = 12): PagePreview[] {
  const pages = new Map<string, PagePreview>();
  for (const it of items) {
    if (it.deleted_at != null || it.anchor.type !== 'page') continue;
    const a = it.anchor;
    let p = pages.get(a.page_id);
    if (!p) {
      p = { pageId: a.page_id, pageIndex: a.page_index, paths: [], boxes: [], items: 0 };
      pages.set(a.page_id, p);
    }
    p.items++;
    const data = (it.data ?? {}) as Record<string, unknown>;
    const path = it.kind === 'ink' ? pathOf(data.points) : null;
    if (path) p.paths.push(path);
    else p.boxes.push(...boxOf(data));
  }
  return [...pages.values()].sort((a, b) => a.pageIndex - b.pageIndex).slice(0, limit);
}

/**
 * (C2, AOS-19I.5) Machine-generated content inside a published explanation, said in words with its count: saved AI
 * answers and text read from handwriting are never presented as the author's own writing, nor as a source. Null when
 * the version holds none.
 */
export function machineContentAr(notes: ReadonlyArray<{ origin: string }>): string | null {
  const ai = notes.filter((n) => n.origin === 'ai_answer').length;
  const hw = notes.filter((n) => n.origin === 'handwriting_recognition').length;
  if (ai === 0 && hw === 0) return null;
  const aiAr = ai === 1 ? 'إجابة مولَّدة محفوظة كملاحظة' : ai === 2 ? 'إجابتان مولَّدتان محفوظتان كملاحظات' : ai <= 10 ? `${ai} إجابات مولَّدة محفوظة كملاحظات` : `${ai} إجابة مولَّدة محفوظة كملاحظات`;
  const hwAr = hw === 1 ? 'نص واحد مقروء آليًا من خط اليد' : hw === 2 ? 'نصان مقروءان آليًا من خط اليد' : hw <= 10 ? `${hw} نصوص مقروءة آليًا من خط اليد` : `${hw} نصًا مقروءًا آليًا من خط اليد`;
  const parts = [ai ? aiAr : null, hw ? hwAr : null].filter((x): x is string => !!x);
  return `فيه محتوى مولَّد آليًا: ${parts.join('، ')} — ليست مصدرًا، وتحقّق منها قبل الاعتماد عليها.`;
}
