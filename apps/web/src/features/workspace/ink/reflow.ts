// Word reflow (parity N1, G10 phase 2): only with handwriting recognition. The selection's strokes are read by the
// server's vision provider (the same recognition as «تحويل إلى نص», a DERIVED reading — the ink stays), and the words it
// read decide where the word gaps are; handwritingLayout.reflowPlan then moves whole words (translation only).
//
// The reader is a seam: the app reads through /api/annotations/recognitions; the tests install a fake reader (the shape
// the server's fake provider returns), so phase 2 is tested without a provider.
import { newId, type AnnotationAnchor, type NormBox, type RecognizedLine } from '@medlevo/shared';
import { recognitionApi, waitForRecognition } from '../handwriting/api';
import { renderSelectionPicture } from '../handwriting/raster';
import type { InkItem } from './model';

export interface ReflowReadRequest {
  items: InkItem[];
  anchor: AnnotationAnchor | null;
  bbox: NormBox;
  ar: number;
  signal?: AbortSignal;
}
export interface ReflowReading {
  lines: RecognizedLine[];
  /** the language the reader found ('ar' → right to left) */
  lang: 'ar' | 'en' | 'mixed' | null;
}
export type ReflowReader = (req: ReflowReadRequest) => Promise<ReflowReading>;

const appReader: ReflowReader = async ({ items, anchor, bbox, ar, signal }) => {
  const picture = renderSelectionPicture(items, ar);
  const a = anchor;
  const rec = await recognitionApi.create({
    id: newId(),
    purpose: 'page_ink',
    lang: 'mixed',
    annotation_ids: items.map((i) => i.id),
    anchor: a?.type === 'page' ? { type: 'page', source_id: a.source_id, version_id: a.version_id, page_id: a.page_id, page_index: a.page_index } : a?.type === 'note_page' ? { type: 'note_page', note_page_id: a.note_page_id } : null,
    bbox,
    image_png_base64: picture.base64,
  });
  const done = await waitForRecognition(rec.id, { signal });
  if (done.status !== 'recognized') throw new Error(done.error_ar ?? 'لم تُقرأ الكتابة؛ لم يُعَد ترتيب شيء.');
  return { lines: done.lines, lang: done.lang_detected };
};

let reader: ReflowReader = appReader;

/** Tests only: install a reader (null = the app's). */
export function setReflowReader(r: ReflowReader | null): void {
  reader = r ?? appReader;
}

export function readForReflow(req: ReflowReadRequest): Promise<ReflowReading> {
  return reader(req);
}
