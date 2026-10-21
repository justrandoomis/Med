// (P1-T2 review) text highlights / underlines are drawn by the reader (reader/overlays.tsx), not by the ink engine — they
// must follow the same layer visibility (PRD AOS-4.10: render respects visibility). A layer copy («انسخ الطبقة») copies
// text highlights too, so hiding that layer must hide its highlights; a highlight of another document in the same
// reader (the split pane) is left alone.
import { afterEach, describe, expect, it } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { annotationTargetKey, defaultPersonalLayerId, newId, type AnnotationAnchor } from '@medlevo/shared';
import { getDb, type AnnotationRow } from '../../src/lib/localdb';
import { TextHighlightsLayer } from '../../src/features/workspace/reader/overlays';
import { LayerViewContext, type LayerViewContextValue } from '../../src/features/workspace/ink/layers/LayerViewProvider';
import { defaultLayerInfo, hiddenLayerIds, type LayerInfo } from '../../src/features/workspace/ink/layers/model';

const DOC = 'source:S1';
const anchor = (source = 'S1'): AnnotationAnchor => ({ type: 'page', source_id: source, version_id: 'V1', page_id: 'P0', page_index: 0, space: 'page_norm' });
const KEY = annotationTargetKey(anchor());

function hl(layerId: string | null | undefined, source = 'S1'): AnnotationRow {
  return {
    id: newId(),
    targetKey: KEY,
    kind: 'text_highlight',
    tool: null,
    anchor: anchor(source),
    data: { v: 1, style: 'highlight', color: 'hl-yellow', rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }] },
    layer: 'highlight',
    z: 0,
    locked: false,
    anchorStatus: 'ok',
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    syncState: 'synced',
    ...(layerId !== undefined ? { layerId } : {}),
  } as AnnotationRow;
}

const copyLayer: LayerInfo = { ...defaultLayerInfo(DOC), id: 'L_COPY', title: 'نسخة', isDefault: false, sortOrder: 1 };
function view(hidden: string[]): LayerViewContextValue {
  const layers = [defaultLayerInfo(DOC), copyLayer];
  const session = { hidden };
  return { layers, hidden: hiddenLayerIds(layers, session), activeId: layers[0]!.id, setVisible: () => undefined, setActive: () => undefined, documentKey: DOC, session };
}

afterEach(async () => {
  await getDb().annotations.clear();
});

describe('text highlights follow the layer view', () => {
  it('a hidden layer’s highlights are not drawn; «ملاحظاتي» hidden hides the legacy (no layer id) ones; another document’s stay', async () => {
    await getDb().annotations.bulkPut([hl(undefined), hl('L_COPY'), hl(undefined, 'OTHER_SOURCE')]);
    const r = render(
      <LayerViewContext.Provider value={view(['L_COPY'])}>
        <TextHighlightsLayer targetKey={KEY} />
      </LayerViewContext.Provider>,
    );
    await waitFor(() => expect(document.querySelectorAll('.wk-mark')).toHaveLength(2));
    r.rerender(
      <LayerViewContext.Provider value={view([defaultPersonalLayerId(DOC)])}>
        <TextHighlightsLayer targetKey={KEY} />
      </LayerViewContext.Provider>,
    );
    // the copy's highlight and the split pane's highlight of another source remain
    await waitFor(() => expect(document.querySelectorAll('.wk-mark')).toHaveLength(2));
    r.rerender(
      <LayerViewContext.Provider value={view([defaultPersonalLayerId(DOC), 'L_COPY'])}>
        <TextHighlightsLayer targetKey={KEY} />
      </LayerViewContext.Provider>,
    );
    await waitFor(() => expect(document.querySelectorAll('.wk-mark')).toHaveLength(1));
    r.unmount();
    // outside a layer view (e.g. a screen without layers) every highlight is drawn as before
    render(<TextHighlightsLayer targetKey={KEY} />);
    await waitFor(() => expect(document.querySelectorAll('.wk-mark')).toHaveLength(3));
  });
});
