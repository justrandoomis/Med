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
  | 'image' // place a picture on the page (tap → choose / paste; track F1)
  | 'link' // drag a box → choose the page it opens (track F1)
  | 'laser' // presentation pointer — never saved
  // ── (parity N1 wave 2) ──
  | 'pencil' // G06: graphite grain, pressure → width and opacity (stored as a pen stroke)
  | 'triangle' // G20
  | 'polygon' // G20: tap the corners, tap the first one (or Enter) to close
  | 'curved_arrow' // G20
  | 'double_arrow' // G20
  | 'connector' // G21: from a shape's edge to another shape; follows them when they move
  | 'insert_space' // G10: drag down (or sideways) from a line: everything after it moves by that much
  | 'measure' // G08: educational measurement (lengths, angles) after setting the scale from a scale bar — never ink
  | 'zoom_window' // G09: tap the page to place the target box of the docked writing window
  | `x:${string}`; // (parity N1 Wave 0) a tool registered by another track (ink/tools.ts)

export interface InkToolState {
  tool: InkToolId;
  color: string;
  /** base width as a fraction of page width */
  width: number;
  /** true → only a stylus writes; touch/finger scrolls (palm/finger rejection heuristic in the web) */
  penOnly: boolean;
  shapeRecognition: boolean;
  // ── (parity N1, all optional: a host that does not know them gets the engine's behaviour before N1) ──
  /** G03: the meaning of the colour slot in use, saved on each new stroke */
  meaning?: string;
  /** G01: pen feel saved on each new stroke (only fields that differ from the classic drawing) */
  feel?: { smoothing?: number; pressure_floor?: number; taper?: 'none' | 'round' | 'sharp'; constant?: boolean };
  /** G14: which gestures are on */
  gestures?: { scribble_erase: boolean; circle_lasso: boolean; finger_undo: boolean };
  /** G02: palm-rejection sensitivity and the writing hand */
  palm?: { sensitivity: 'low' | 'medium' | 'high'; hand: 'right' | 'left' };
  /** G15: what the eraser may remove */
  eraserTypes?: { pen: boolean; highlighter: boolean; shape: boolean; text_highlight: boolean };
  /** G17: the lasso's shape and type filter */
  lasso?: { mode: 'free' | 'rect'; types: { ink: boolean; shape: boolean; text: boolean; image: boolean; link: boolean } };
  // ── (parity N1 wave 2) ──
  /** G04: the line pattern of new strokes and shapes (absent = solid) */
  dash?: 'dash' | 'dot';
  /** G20 / G21: options of new shapes and connectors */
  shapeOptions?: { head: 'activation' | 'inhibition' | 'conversion' | null; fill: string | null; corner: boolean; route: 'straight' | 'elbow' | 'curve' };
  /** G22: snapping while drawing shapes and moving a selection */
  snap?: { enabled: boolean; items: boolean; grid: boolean; regions: boolean };
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
  /**
   * (parity N1 Wave 0) the editor used for text boxes; default: a plain-text area. N3 mounts its rich-text editor here
   * without touching InkLayer.tsx.
   */
  textEditor?: React.ComponentType<InkTextEditorProps>;
}

/** (parity N1 Wave 0) The contract of a text-box editor mounted in the text-editor slot of <InkProvider>. */
export interface InkTextEditorProps {
  /** the text when the editor opened (empty for a new text box) */
  initial: import('@medlevo/shared').RichText;
  /** placement, size, font size and rotation of the box on the page (css px) */
  style: React.CSSProperties;
  ariaLabel: string;
  placeholder: string;
  /** every change (the engine saves when the editor finishes or goes away — typed text is never lost) */
  onChange(text: import('@medlevo/shared').RichText, heightPx: number): void;
  /** Escape, Ctrl/⌘+Enter or leaving the editor: save and close */
  onFinish(heightPx: number): void;
}

export interface InkController {
  toolState: InkToolState;
  setTool(tool: InkToolId): void;
  /** `slot` (N1, G03): the index of the colour slot picked (its meaning goes with each stroke); absent = a custom colour */
  setColor(color: string, slot?: number | null): void;
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
