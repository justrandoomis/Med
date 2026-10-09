// TEST-ONLY harness for the ink engine (Vite dev server: /test/ink/harness.html). Not part of the
// production build (vite builds index.html only). Mounts InkProvider + InkToolbar + one InkLayer
// over a blank sheet so Playwright can draw with the mouse at different zooms / rotations and
// verify AC-21 (web part). The sample lines are typesetting filler, not medical content.
//
// URL params: zoom (css px per page unit, default 1), rot (0|90|180|270), tool (InkToolId),
// doc (document key), page (page id), pw/ph (page size in page units).
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '../../src/design/tokens.css';
import '../../src/design/base.css';
import '../../src/design/components.css';
import { annotationTargetKey, newId, normalizeRotation, type AnnotationAnchor, type InkPoint } from '@medlevo/shared';
import { makeInkItem } from '../../src/features/workspace/ink/model';
import { InkLayer, InkProvider, InkToolbar, useInk } from '../../src/features/workspace/ink';
import { getDocumentStore } from '../../src/features/workspace/ink/store';
import { getDb } from '../../src/lib/localdb';
import type { InkPageView, InkToolId } from '../../src/features/workspace/ink/types';

const q = new URLSearchParams(location.search);
const view: InkPageView = {
  pageWidth: Number(q.get('pw') ?? 600),
  pageHeight: Number(q.get('ph') ?? 800),
  scale: Number(q.get('zoom') ?? 1),
  rotation: normalizeRotation(Number(q.get('rot') ?? 0)),
};
const documentKey = q.get('doc') ?? 'harness-doc';
const anchor: AnnotationAnchor = { type: 'note_page', note_page_id: q.get('page') ?? 'HARNESSPAGE', space: 'page_norm' };
const targetKey = annotationTargetKey(anchor);
const initialTool = (q.get('tool') ?? 'pen') as InkToolId;

declare global {
  interface Window {
    __ink?: {
      view: InkPageView;
      targetKey: string;
      ready: boolean;
      items: () => unknown[];
      flush: () => Promise<void>;
      rows: () => Promise<unknown[]>;
      outbox: () => Promise<unknown[]>;
      strokeEvents: boolean[];
      /** test-only: commit `n` synthetic strokes in one command (performance measurement) */
      seed: (n: number) => void;
    };
  }
}

const strokeEvents: boolean[] = [];
window.__ink = {
  view,
  targetKey,
  ready: false,
  items: () => getDocumentStore(documentKey).items(targetKey),
  flush: () => getDocumentStore(documentKey).flush(),
  rows: () => getDb().annotations.where('targetKey').equals(targetKey).toArray(),
  outbox: () => getDb().outbox.toArray(),
  strokeEvents,
  seed: (n: number) => {
    const store = getDocumentStore(documentKey);
    const changes = [];
    for (let i = 0; i < n; i++) {
      const x0 = (i % 40) / 40;
      const y0 = Math.floor(i / 40) / (n / 40 + 1);
      const points: InkPoint[] = Array.from({ length: 24 }, (_, k) => [x0 + k * 0.001, y0 + Math.sin(k / 3) * 0.004, k * 8, 0.4 + (k % 5) * 0.05]);
      const item = makeInkItem({ id: newId(), anchor, now: Date.now(), z: i + 1, style: { tool: i % 7 === 0 ? 'highlighter' : 'pen', color: i % 7 === 0 ? 'hl-yellow' : 'ink-blue', width: i % 7 === 0 ? 0.012 : 0.0025 }, points, pressureAvailable: i % 2 === 0, tiltAvailable: false, pointerType: 'pen' });
      changes.push({ id: item.id, targetKey, before: null, after: item });
    }
    store.commit('seed', changes);
  },
};

function SetTool() {
  const ink = useInk();
  useEffect(() => {
    ink.setTool(initialTool);
    void getDocumentStore(documentKey)
      .whenLoaded(targetKey)
      .then(() => {
        if (window.__ink) window.__ink.ready = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function Harness() {
  const rotated = view.rotation === 90 || view.rotation === 270;
  const w = (rotated ? view.pageHeight : view.pageWidth) * view.scale;
  const h = (rotated ? view.pageWidth : view.pageHeight) * view.scale;
  return (
    <InkProvider documentKey={documentKey}>
      <SetTool />
      <header style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--ml-color-paper)', padding: 'var(--ml-space-2)', boxShadow: 'var(--ml-shadow-paper)' }}>
        <InkToolbar />
      </header>
      <main style={{ padding: 'var(--ml-space-5)', background: 'var(--ml-color-canvas)', minHeight: '100vh' }}>
        <div id="sheet" data-testid="sheet" style={{ position: 'relative', width: w, height: h, background: '#ffffff', boxShadow: 'var(--ml-shadow-paper)' }}>
          <div aria-hidden="true" style={{ position: 'absolute', top: 40 * view.scale, insetInlineStart: 40 * view.scale, color: '#1c2230', fontSize: 18 * view.scale, lineHeight: 1.8 }}>
            <p style={{ margin: 0 }}>سطر تجريبي لاختبار الحبر فوق النص</p>
            <p style={{ margin: 0 }}>Second line: highlight must not hide text</p>
          </div>
          <InkLayer targetKey={targetKey} anchor={anchor} view={view} interactive onStrokeActiveChange={(a) => strokeEvents.push(a)} />
        </div>
      </main>
    </InkProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
