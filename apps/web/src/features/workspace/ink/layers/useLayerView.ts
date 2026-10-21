// Wires a document's layers and the study session's layer choices into the ink store (Academic OS P1-T2 step 1):
// the visibility / editability predicates (render, hit-test, eraser, lasso) and the layer new writing goes to.
// Writing that lands on a layer hidden in this session shows that layer again (the owner always sees what they write).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { InkDocumentStore } from '../store';
import { hiddenLayerIds, layerPredicates, type LayerInfo, type LayerSession } from './model';
import { useDocumentLayers } from './repo';

export interface LayerViewApi {
  layers: LayerInfo[];
  hidden: ReadonlySet<string>;
  /** the layer new writing goes to (its id; «ملاحظاتي»'s derived id when none is chosen) */
  activeId: string;
  setVisible(layerId: string, visible: boolean): void;
  setActive(layerId: string): void;
}

export function useLayerView(opts: { store: InkDocumentStore; documentKey: string; session: LayerSession; onSession: (s: LayerSession) => void }): LayerViewApi {
  const { store, documentKey, session, onSession } = opts;
  const layers = useDocumentLayers(documentKey);
  const predicates = useMemo(() => layerPredicates(layers, session), [layers, session]);
  const hidden = useMemo(() => hiddenLayerIds(layers, session), [layers, session]);
  const latest = useRef({ session, layers, onSession });
  useEffect(() => {
    latest.current = { session, layers, onSession };
  });

  useEffect(() => {
    store.setVisibility(predicates.visible, `${documentKey}|${[...hidden].sort().join(',')}`);
    store.setEditability(predicates.editable);
    store.setActiveLayer(predicates.active, predicates.inDocument);
  }, [store, predicates, hidden, documentKey]);
  // leaving the document: the store (kept for the app's lifetime) goes back to «everything visible»
  useEffect(
    () => () => {
      store.setVisibility(null);
      store.setEditability(null);
      store.setActiveLayer(null);
      store.setWriteToHiddenLayerHandler(null);
    },
    [store],
  );
  useEffect(() => {
    store.setWriteToHiddenLayerHandler((layerId) => {
      const { session: s, layers: ls, onSession: set } = latest.current;
      const id = layerId ?? ls.find((l) => l.isDefault)?.id;
      if (!id) return;
      const next = [...hiddenLayerIds(ls, s)].filter((x) => x !== id);
      set({ ...s, hidden: next });
    });
  }, [store]);

  const setVisible = useCallback(
    (layerId: string, visible: boolean) => {
      const { session: s, layers: ls, onSession: set } = latest.current;
      const cur = hiddenLayerIds(ls, s);
      if (visible) cur.delete(layerId);
      else cur.add(layerId);
      set({ ...s, hidden: [...cur] });
    },
    [],
  );
  const setActive = useCallback((layerId: string) => {
    const { session: s, layers: ls, onSession: set } = latest.current;
    const layer = ls.find((l) => l.id === layerId);
    // writing on a layer shows it
    const cur = hiddenLayerIds(ls, s);
    cur.delete(layerId);
    set({ ...s, hidden: [...cur], active: layer?.isDefault ? null : layerId });
  }, []);

  const defaultId = layers.find((l) => l.isDefault)?.id ?? '';
  const activeId = predicates.active ?? defaultId;
  return useMemo(() => ({ layers, hidden, activeId, setVisible, setActive }), [layers, hidden, activeId, setVisible, setActive]);
}
