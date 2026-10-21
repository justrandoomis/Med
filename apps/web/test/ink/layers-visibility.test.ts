// P1-T2 step 1 — the layer visibility / editability predicate in render, hit-test, eraser and lasso (ADR-0004 R5; PRD
// AOS-1.4, 1.6, 1.9, 4.10). Hidden layers are not drawn, hit, erased or lassoed; items of read-only layers can be selected
// and copied, never moved, recoloured or deleted; new writing goes to the active layer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPersonalLayerId, newId, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { MedLevoDB, type LayerRow } from '../../src/lib/localdb';
import { PageInkController } from '../../src/features/workspace/ink/layerController';
import { makeInkItem, makeTextItem, type InkItem } from '../../src/features/workspace/ink/model';
import { InkDocumentStore } from '../../src/features/workspace/ink/store';
import { documentLayers, hiddenLayerIds, layerPredicates, type LayerSession } from '../../src/features/workspace/ink/layers/model';
import type { InkToolState } from '../../src/features/workspace/ink/types';

const DOC = 'source:SRC';
const DEF = defaultPersonalLayerId(DOC);
const anchor: AnnotationAnchor = { type: 'page', source_id: 'SRC', version_id: 'VER', page_id: 'P1', page_index: 0, space: 'page_norm' };
const KEY = 'source_page:P1';
const T = 1_800_000_000_000;

function layerRow(id: string, over: Partial<LayerRow> = {}): LayerRow {
  return { id, documentKey: DOC, kind: 'answers', title: 'إجابات', writable: true, frozen: false, visible: true, locked: false, sortOrder: 1, updatedAt: T, syncState: 'synced', rev: 1, ...over };
}
const followed = layerRow('FOL', { kind: 'followed', title: 'شرح سارة', writable: false, origin: { author_display: 'سارة', version_no: 3 } });
const answers = layerRow('ANS');

function line(id: string, y: number, layerId: string | null, extra: Partial<InkItem> = {}, tool: 'pen' | 'highlighter' = 'pen'): InkItem {
  const points: InkPoint[] = Array.from({ length: 20 }, (_, i) => [0.1 + (0.6 * i) / 19, y, i * 8]);
  return { ...makeInkItem({ id, anchor, now: T, z: 1, style: { tool, color: 'ink-blue', width: 0.004 }, points, pressureAvailable: false, tiltAvailable: false, pointerType: 'pen' }), layer_id: layerId, ...extra };
}

describe('layer model (pure)', () => {
  const layers = documentLayers([followed, answers, layerRow('DEL', { deletedAt: T })], DOC);

  it('lists «ملاحظاتي» first (virtual until renamed), then the live layers; a followed layer is read-only with its origin', () => {
    expect(layers.map((l) => [l.id, l.access, l.isDefault])).toEqual([
      [DEF, 'write', true],
      ['ANS', 'write', false],
      ['FOL', 'read_only', false],
    ]);
    expect(layers[2]!.originLabel).toBe('من شرح سارة — الإصدار 3');
  });

  it('hidden layers: the session list once it has one, else each layer’s default', () => {
    const hiddenByDefault = documentLayers([{ ...answers, visible: false }], DOC);
    expect([...hiddenLayerIds(hiddenByDefault, {})]).toEqual(['ANS']);
    expect([...hiddenLayerIds(hiddenByDefault, { hidden: [] })]).toEqual([]);
    expect([...hiddenLayerIds(hiddenByDefault, { hidden: [DEF] })]).toEqual([DEF]);
  });

  it('editable: own writable unlocked layers only; never a followed item, another author’s item or a locked layer; unknown layers are left to the server', () => {
    const p = layerPredicates(documentLayers([followed, answers, layerRow('LCK', { locked: true })], DOC), {});
    expect(p.editable({ layer_id: null })).toBe(true);
    expect(p.editable({ layer_id: 'ANS' })).toBe(true);
    expect(p.editable({ layer_id: 'FOL' })).toBe(false);
    expect(p.editable({ layer_id: 'LCK' })).toBe(false);
    expect(p.editable({ layer_id: null, author_user_id: 'U2' })).toBe(false);
    expect(p.editable({ layer_id: 'NOT_SYNCED_YET' })).toBe(true);
  });

  it('the active layer must be writable and unlocked; «ملاحظاتي» and unusable choices are null', () => {
    const ls = documentLayers([followed, answers], DOC);
    expect(layerPredicates(ls, { active: 'ANS' }).active).toBe('ANS');
    expect(layerPredicates(ls, { active: 'FOL' }).active).toBeNull();
    expect(layerPredicates(ls, { active: DEF }).active).toBeNull();
    expect(layerPredicates(ls, { active: 'GONE' }).active).toBeNull();
  });
});

describe('the store applies the predicates', () => {
  let db: MedLevoDB;
  let store: InkDocumentStore;
  const apply = (session: LayerSession) => {
    const p = layerPredicates(documentLayers([followed, answers], DOC), session);
    store.setVisibility(p.visible);
    store.setEditability(p.editable);
    store.setActiveLayer(p.active, p.inDocument);
  };

  beforeEach(async () => {
    db = new MedLevoDB(`medlevo-layers-${newId()}`);
    await db.open();
    store = new InkDocumentStore(`doc-${newId()}`, db, () => T, { persistHistory: false });
    store.attachPage(KEY, anchor, 1.25);
    await store.whenLoaded(KEY);
    store.commit('fixture', [
      { id: 'MINE', targetKey: KEY, before: null, after: line('MINE', 0.2, null) },
      { id: 'ANSW', targetKey: KEY, before: null, after: line('ANSW', 0.4, 'ANS') },
      { id: 'SARA', targetKey: KEY, before: null, after: line('SARA', 0.6, 'FOL', { author_user_id: 'U2' }) },
    ]);
  });
  afterEach(() => store.dispose());

  it('new writing goes to the active layer; an item that names its layer keeps it', () => {
    apply({ active: 'ANS' });
    const a = line('NEW1', 0.8, null);
    delete (a as { layer_id?: unknown }).layer_id;
    store.commit('كتابة', [{ id: a.id, targetKey: KEY, before: null, after: a }]);
    expect(store.item(KEY, 'NEW1')!.layer_id).toBe('ANS');
    apply({});
    const b = line('NEW2', 0.85, null);
    delete (b as { layer_id?: unknown }).layer_id;
    store.commit('كتابة', [{ id: b.id, targetKey: KEY, before: null, after: b }]);
    // «ملاحظاتي» active: nothing is stamped (the item is exactly as written; no layer id = the default layer)
    expect(store.item(KEY, 'NEW2')!.layer_id).toBeUndefined();
    expect(store.item(KEY, 'NEW2')).toBe(b);
  });

  it('another document in the same store (the split pane): this document’s layer choices never apply to it', () => {
    const OTHER_KEY = 'source_page:Q1';
    const other: AnnotationAnchor = { ...anchor, source_id: 'OTHER', page_id: 'Q1' };
    store.attachPage(OTHER_KEY, other, 1.25);
    apply({ active: 'ANS', hidden: [defaultPersonalLayerId(DOC)] });
    const c = { ...line('NEW3', 0.3, null), anchor: other };
    delete (c as { layer_id?: unknown }).layer_id;
    store.commit('كتابة', [{ id: c.id, targetKey: OTHER_KEY, before: null, after: c }]);
    // not stamped with this document's active layer, and not hidden with this document's «ملاحظاتي»
    expect(store.item(OTHER_KEY, 'NEW3')!.layer_id).toBeUndefined();
    expect(store.isVisible(store.item(OTHER_KEY, 'NEW3')!)).toBe(true);
    expect(store.isVisible(store.item(KEY, 'MINE')!)).toBe(false);
  });

  it('delete / recolour / move of a selection skip the read-only items; the owner’s own items change', () => {
    apply({});
    store.setSelection({ targetKey: KEY, ids: ['MINE', 'SARA'] });
    expect(store.selectionHasReadOnly()).toBe(true);
    store.recolorSelection('ink-red');
    expect((store.item(KEY, 'MINE')!.data as { style: { color: string } }).style.color).toBe('ink-red');
    expect((store.item(KEY, 'SARA')!.data as { style: { color: string } }).style.color).toBe('ink-blue');
    store.transformSelection([1, 0, 0, 1, 0.05, 0]);
    expect(store.item(KEY, 'SARA')!.data).toEqual(line('SARA', 0.6, 'FOL').data);
    store.setSelection({ targetKey: KEY, ids: ['SARA'] });
    store.deleteSelection();
    expect(store.item(KEY, 'SARA')).toBeDefined();
  });

  it('«انسخ إلى طبقتي» copies a followed item in place onto the active layer, as the owner’s own writing; the original stays', () => {
    apply({ active: 'ANS' });
    store.setSelection({ targetKey: KEY, ids: ['SARA'] });
    expect(store.copySelectionToActiveLayer()).toBe(1);
    const copies = store.items(KEY).filter((i) => i.id !== 'SARA' && i.id !== 'MINE' && i.id !== 'ANSW');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.layer_id).toBe('ANS');
    expect(copies[0]!.author_user_id).toBeUndefined();
    expect((copies[0]!.data as { points: unknown }).points).toEqual((store.item(KEY, 'SARA')!.data as { points: unknown }).points);
    expect(store.item(KEY, 'SARA')!.layer_id).toBe('FOL');
  });

  it('hiding a layer drops its items from the selection and asks the host to show a hidden layer it writes on', () => {
    const asked: Array<string | null> = [];
    store.setWriteToHiddenLayerHandler((l) => asked.push(l));
    store.setSelection({ targetKey: KEY, ids: ['MINE', 'ANSW'] });
    apply({ hidden: ['ANS'], active: 'ANS' });
    expect(store.getSelection()!.ids).toEqual(['MINE']);
    const a = line('NEW3', 0.9, null);
    delete (a as { layer_id?: unknown }).layer_id;
    store.commit('كتابة', [{ id: a.id, targetKey: KEY, before: null, after: a }]);
    expect(asked).toEqual(['ANS']);
  });
});

describe('render, hit-test, eraser and lasso respect the predicate (page controller)', () => {
  // jsdom has no Path2D: a recording-free stand-in (the fake context below only counts stroke() calls)
  if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
    (globalThis as { Path2D?: unknown }).Path2D = class {
      moveTo() {}
      lineTo() {}
      quadraticCurveTo() {}
      bezierCurveTo() {}
      closePath() {}
      arc() {}
      rect() {}
      ellipse() {}
      addPath() {}
    };
  }
  let db: MedLevoDB;
  let store: InkDocumentStore;
  let ctrl: PageInkController;
  let strokes: { hl: number; ink: number };

  /** a 2D context that only counts stroke() calls per canvas */
  function fakeContext(which: 'hl' | 'ink') {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'stroke') return () => void strokes[which]++;
          if (prop === 'getContextAttributes') return () => ({});
          if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
          return () => undefined;
        },
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
  }

  beforeEach(async () => {
    db = new MedLevoDB(`medlevo-layers-ctrl-${newId()}`);
    await db.open();
    store = new InkDocumentStore(`doc-${newId()}`, db, () => T, { persistHistory: false });
    store.attachPage(KEY, anchor, 1.25);
    await store.whenLoaded(KEY);
    store.commit('fixture', [
      { id: 'MINE', targetKey: KEY, before: null, after: line('MINE', 0.2, null) },
      { id: 'SARA', targetKey: KEY, before: null, after: line('SARA', 0.6, 'FOL', { author_user_id: 'U2' }) },
      { id: 'SARA_HL', targetKey: KEY, before: null, after: line('SARA_HL', 0.65, 'FOL', { author_user_id: 'U2' }, 'highlighter') },
      { id: 'TXT', targetKey: KEY, before: null, after: { ...makeTextItem({ id: 'TXT', anchor, now: T, z: 2, box: { x: 0.1, y: 0.75, w: 0.3, h: 0.05 }, text: { v: 1, paragraphs: [] }, color: 'ink-black', fontScale: 0.02 }), layer_id: 'FOL', author_user_id: 'U2' } },
    ]);
    strokes = { hl: 0, ink: 0 };
    const hl = document.createElement('canvas');
    const ink = document.createElement('canvas');
    const live = document.createElement('canvas');
    vi.spyOn(hl, 'getContext').mockReturnValue(fakeContext('hl') as never);
    vi.spyOn(ink, 'getContext').mockReturnValue(fakeContext('ink') as never);
    vi.spyOn(live, 'getContext').mockReturnValue(null);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const tool: InkToolState = { tool: 'eraser_stroke', color: 'ink-blue', width: 0.003, penOnly: false, shapeRecognition: false };
    ctrl = new PageInkController({
      store,
      targetKey: KEY,
      root,
      highlightCanvas: hl,
      inkCanvas: ink,
      liveCanvas: live,
      getAnchor: () => anchor,
      getView: () => ({ pageWidth: 600, pageHeight: 750, scale: 1, rotation: 0 }),
      getTool: () => tool,
      getInteractive: () => true,
      onStrokeActive: () => undefined,
      onTextRequest: () => undefined,
    });
  });
  afterEach(() => {
    ctrl.destroy();
    store.dispose();
  });

  const paint = () => {
    strokes = { hl: 0, ink: 0 };
    ctrl.invalidate('all');
    ctrl.paintCommitted();
    return { ...strokes };
  };
  const show = (session: LayerSession) => {
    const p = layerPredicates(documentLayers([followed], DOC), session);
    store.setVisibility(p.visible);
    store.setEditability(p.editable);
  };

  it('render: a hidden layer’s strokes and highlights are not drawn; showing it draws them again (its highlight stays on the highlight canvas)', () => {
    show({});
    const all = paint();
    expect(all.ink).toBeGreaterThan(0);
    expect(all.hl).toBeGreaterThan(0);
    show({ hidden: ['FOL'] });
    const mineOnly = paint();
    expect(mineOnly.hl).toBe(0);
    expect(mineOnly.ink).toBeGreaterThan(0);
    expect(mineOnly.ink).toBeLessThan(all.ink);
    show({ hidden: ['FOL', DEF] });
    expect(paint()).toEqual({ hl: 0, ink: 0 });
  });

  it('hit-test: a tap never selects an item of a hidden layer', () => {
    show({});
    expect(ctrl.hitTest([0.4, 0.6])?.id).toBe('SARA');
    show({ hidden: ['FOL'] });
    expect(ctrl.hitTest([0.4, 0.6])).toBeNull();
    expect(ctrl.hitTest([0.4, 0.2])?.id).toBe('MINE');
  });

  it('eraser: candidates exclude read-only and hidden items (the followed stroke is never erased)', () => {
    show({});
    const cands = (ctrl as unknown as { candidatesAlong(p: Array<[number, number]>, r: number): InkItem[] }).candidatesAlong(
      [
        [0.05, 0.1],
        [0.9, 1.0],
      ],
      0.05,
    );
    expect(cands.map((c) => c.id).sort()).toEqual(['MINE']);
  });
});

describe('layers created on this device', () => {
  it('get a small ordinal sort order after the document’s layers (the server refuses timestamp-sized ones) and an outbox op', async () => {
    const { createLayer } = await import('../../src/features/workspace/ink/layers/repo');
    const db = new MedLevoDB(`medlevo-layers-create-${newId()}`);
    await db.open();
    const a = await createLayer(db, { documentKey: DOC, title: 'أ', kind: 'answers' });
    const b = await createLayer(db, { documentKey: DOC, title: 'ب', kind: 'personal' });
    expect(a.sortOrder).toBe(1);
    expect(b.sortOrder).toBe(2);
    const ops = await db.outbox.where('entity_type').equals('annotation_layer').toArray();
    expect(ops.map((o) => (o.payload as { sort_order: number }).sort_order)).toEqual([1, 2]);
    expect(Math.max(...ops.map((o) => Math.abs((o.payload as { sort_order: number }).sort_order)))).toBeLessThanOrEqual(1e12);
  });
});
