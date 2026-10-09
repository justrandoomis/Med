// STUB — replaced by the ink engine track. Keeps the reader compiling against the contract in types.ts.
import { createContext, useContext, useMemo, useState } from 'react';
import type { InkController, InkProviderProps, InkToolId, InkToolState } from './types';

const DEFAULT_STATE: InkToolState = { tool: 'hand', color: 'ink-blue', width: 0.0025, penOnly: true, shapeRecognition: false };
const InkContext = createContext<InkController | null>(null);

export function InkProvider({ children }: InkProviderProps) {
  const [toolState, setToolState] = useState<InkToolState>(DEFAULT_STATE);
  const value = useMemo<InkController>(
    () => ({
      toolState,
      setTool: (tool: InkToolId) => setToolState((s) => ({ ...s, tool })),
      setColor: (color) => setToolState((s) => ({ ...s, color })),
      setWidth: (width) => setToolState((s) => ({ ...s, width })),
      setPenOnly: (penOnly) => setToolState((s) => ({ ...s, penOnly })),
      setShapeRecognition: (shapeRecognition) => setToolState((s) => ({ ...s, shapeRecognition })),
      undo: () => {},
      redo: () => {},
      canUndo: false,
      canRedo: false,
      isWritingTool: toolState.tool !== 'hand' && toolState.tool !== 'select_text',
    }),
    [toolState],
  );
  return <InkContext.Provider value={value}>{children}</InkContext.Provider>;
}

export function useInk(): InkController {
  const ctx = useContext(InkContext);
  if (!ctx) throw new Error('useInk must be used inside <InkProvider>');
  return ctx;
}
