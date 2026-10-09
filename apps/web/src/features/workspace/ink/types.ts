// CONTRACT between the workspace reader (features/workspace/*) and the ink engine (features/workspace/ink/*).
// The reader mounts <InkProvider> once per open document, <InkToolbar> in its top bar, and one
// <InkLayer> per rendered page (or note page). The ink engine owns everything inside ink/.
// Do not change these exported shapes without updating both sides.
import type { AnnotationAnchor, QuarterTurn } from '@medlevo/shared';

export type InkToolId =
  | 'hand' // pan/scroll/read; no writing (fingers always scroll in pen-only mode)
  | 'select_text' // native text selection on the text layer (no ink capture)
  | 'pen'
  | 'fountain'
  | 'ball'
  | 'highlighter'
  | 'eraser_stroke'
  | 'eraser_point'
  | 'lasso'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'text'
  | 'sticky'
  | 'laser'; // presentation pointer — never saved

export interface InkToolState {
  tool: InkToolId;
  color: string;
  /** base width as a fraction of page width */
  width: number;
  /** true → only a stylus writes; touch/finger scrolls (palm/finger rejection heuristic in the web) */
  penOnly: boolean;
  shapeRecognition: boolean;
}

/** View transform of a rendered page; same semantics as PageViewTransform in @medlevo/shared/geometry. */
export interface InkPageView {
  /** unrotated page size in page units */
  pageWidth: number;
  pageHeight: number;
  /** css px per page unit */
  scale: number;
  /** total clockwise rotation in the view */
  rotation: QuarterTurn;
}

export interface InkLayerProps {
  /** 'source_page:<page_id>' | 'note_page:<note_page_id>' (annotationTargetKey of the anchor) */
  targetKey: string;
  /** stamped on every new annotation created on this page */
  anchor: AnnotationAnchor;
  view: InkPageView;
  /** when false the layer only renders (no input capture), e.g. during text selection or hand tool */
  interactive: boolean;
  /** the reader must stop scrolling/page-flip while a stroke is in progress (§24: no flip during a stroke) */
  onStrokeActiveChange?: (active: boolean) => void;
}

export interface InkProviderProps {
  /** document identity for undo history scope and persisted tool presets */
  documentKey: string;
  children: React.ReactNode;
}

export interface InkController {
  toolState: InkToolState;
  setTool(tool: InkToolId): void;
  setColor(color: string): void;
  setWidth(width: number): void;
  setPenOnly(v: boolean): void;
  setShapeRecognition(v: boolean): void;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** true when the current tool captures pointer input for writing (not hand/select_text) */
  isWritingTool: boolean;
}
