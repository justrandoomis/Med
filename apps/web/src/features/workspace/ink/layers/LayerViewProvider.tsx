// The study session's layer view for one document (Academic OS P1-T2 step 1). Mounted by the reader inside its
// <InkProvider>, it keeps the ink store's visibility / editability predicates and the active layer in step with the
// session's choices (so hidden layers stay hidden while the layers panel is closed) and gives the panel its data.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useInkInternal } from '../InkProvider';
import type { LayerSession } from './model';
import { useLayerView, type LayerViewApi } from './useLayerView';

export interface LayerViewContextValue extends LayerViewApi {
  documentKey: string;
  session: LayerSession;
}

/** (exported for the reader's own layers — text highlights, reader/overlays.tsx — and for tests) */
export const LayerViewContext = createContext<LayerViewContextValue | null>(null);

/** The layer view of the document around (null outside a <LayerViewProvider>: the panel then offers no layers tab). */
export function useLayerViewContext(): LayerViewContextValue | null {
  return useContext(LayerViewContext);
}

export function LayerViewProvider({ documentKey, session, onSession, children }: { documentKey: string; session: LayerSession; onSession: (s: LayerSession) => void; children: ReactNode }) {
  const { store } = useInkInternal();
  const view = useLayerView({ store, documentKey, session, onSession });
  const value = useMemo<LayerViewContextValue>(() => ({ ...view, documentKey, session }), [view, documentKey, session]);
  return <LayerViewContext.Provider value={value}>{children}</LayerViewContext.Provider>;
}
