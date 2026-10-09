// Source Inspector (§11): a larger panel showing the cited region highlighted on the rendered page — PDF pages
// through pdf.js (an explicitly downloaded copy when present), image pages from their render file, and for
// sources without fixed pages (DOCX, slide text) the page's regions with the cited one marked. The cited
// version is the one shown (never a substitute). Offline without a downloaded copy → said so.
import { useEffect, useRef, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { normBoxToView, type EvidenceView, type NormBox, type PageRegionsResponse, type QuarterTurn, type SourceDetail, type SourcePagesResponse } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, Sheet } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { loadPdfHandle } from '../workspace/reader/pdfDoc';
import { BidiText } from './BidiText';
import { EvidencePeek, type CitationContext } from './CitationChip';
import { availabilityReason } from './model';
import { useEffectiveAvailability } from './useOpenSource';

export interface SourceInspectorProps {
  evidence: EvidenceView | null;
  context?: CitationContext;
  open: boolean;
  onClose: () => void;
}

type Render =
  | { kind: 'pdf'; fileId: string; pageIndex: number }
  | { kind: 'image'; fileId: string }
  | { kind: 'regions'; regions: PageRegionsResponse['regions'] }
  | { kind: 'none'; reason: string };

interface Loaded {
  render: Render;
  page: SourcePagesResponse['pages'][number] | null;
}

async function loadRender(e: EvidenceView, signal: AbortSignal): Promise<Loaded> {
  const detail = await api.get<SourceDetail>(`/sources/${encodeURIComponent(e.source_id)}`, { signal, timeoutMs: 20_000 });
  const version = detail.versions.find((v) => v.id === e.version_id);
  if (!version) return { render: { kind: 'none', reason: 'نسخة الدليل لم تعد موجودة في هذا المصدر.' }, page: null };
  const pages = await api.get<SourcePagesResponse>(`/sources/${encodeURIComponent(e.source_id)}/versions/${encodeURIComponent(e.version_id)}/pages`, { signal, timeoutMs: 20_000 });
  const page = pages.pages.find((p) => p.id === e.page_id) ?? null;
  if (!page) return { render: { kind: 'none', reason: 'الدليل غير مرتبط بصفحة محددة.' }, page: null };
  const pdfFile = version.display_file_id ?? (version.format === 'pdf' ? version.file_id : null);
  if (pdfFile && page.kind !== 'image' && page.kind !== 'docx_section') return { render: { kind: 'pdf', fileId: pdfFile, pageIndex: page.page_index }, page };
  if (page.render_file_id) return { render: { kind: 'image', fileId: page.render_file_id }, page };
  const regions = await api.get<PageRegionsResponse>(`/sources/pages/${encodeURIComponent(page.id)}/regions`, { signal, timeoutMs: 20_000 });
  return { render: { kind: 'regions', regions: regions.regions }, page };
}

function Highlight({ box, label }: { box: { left: number; top: number; width: number; height: number }; label: string }) {
  return <div className="ev-inspect__box" role="img" aria-label={label} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />;
}

function PdfPage({ fileId, pageIndex, bbox, label }: { fileId: string; pageIndex: number; bbox: NormBox | null; label: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | null = null;
    void (async () => {
      try {
        const handle = await loadPdfHandle(fileId);
        destroy = () => handle.destroy();
        const page = await handle.page(pageIndex);
        if (cancelled) return;
        const [x1, y1, x2, y2] = page.view as [number, number, number, number];
        const unrot = { w: x2 - x1, h: y2 - y1 };
        const rotation = (((page.rotate % 360) + 360) % 360) as QuarterTurn;
        const width = Math.max(240, (wrapRef.current?.clientWidth ?? 480) - 2);
        const rotatedW = rotation === 90 || rotation === 270 ? unrot.h : unrot.w;
        const scale = width / rotatedW;
        const viewport = page.getViewport({ scale, rotation });
        const canvas = canvasRef.current!;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        await page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
        if (cancelled) return;
        setSize({ w: viewport.width, h: viewport.height });
        if (bbox) setBox(normBoxToView(bbox, { pageWidth: unrot.w, pageHeight: unrot.h, scale, rotation }));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, 'تعذّر عرض الصفحة.'));
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [fileId, pageIndex, bbox]);
  useEffect(() => {
    if (box && wrapRef.current) wrapRef.current.scrollTo?.({ top: Math.max(0, box.top - 80), behavior: 'auto' });
  }, [box]);
  if (error) return <ErrorState inline message={error} />;
  return (
    <div ref={wrapRef} className="ev-inspect__page">
      <div className="ev-inspect__stage" style={size ? { width: size.w, height: size.h } : undefined}>
        <canvas ref={canvasRef} aria-hidden="true" />
        {box && <Highlight box={box} label={label} />}
      </div>
      {!size && <LoadingState inline stage="جارٍ عرض الصفحة…" />}
    </div>
  );
}

function ImagePage({ fileId, bbox, label }: { fileId: string; bbox: NormBox | null; label: string }) {
  return (
    <div className="ev-inspect__page">
      <div className="ev-inspect__stage ev-inspect__stage--image">
        <img src={`/api/files/${encodeURIComponent(fileId)}`} alt="صورة الصفحة الأصلية" />
        {bbox && (
          <div
            className="ev-inspect__box"
            role="img"
            aria-label={label}
            style={{ left: `${bbox.x * 100}%`, top: `${bbox.y * 100}%`, width: `${bbox.w * 100}%`, height: `${bbox.h * 100}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function SourceInspector({ evidence, context, open, onClose }: SourceInspectorProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const availability = useEffectiveAvailability(evidence);
  const blocked = availability === 'source_deleted' || availability === 'not_downloaded_offline';

  useEffect(() => {
    if (!open || !evidence || blocked) return;
    const ctrl = new AbortController();
    setLoaded(null);
    setError(null);
    loadRender(evidence, ctrl.signal)
      .then(setLoaded)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(errorMessage(e, 'تعذّر تحميل الصفحة.'));
      });
    return () => ctrl.abort();
  }, [open, evidence, blocked, attempt]);

  const label = evidence ? `موضع الدليل في ${evidence.locator_label_ar}` : '';
  return (
    <Sheet open={open} onClose={onClose} title="فحص المصدر" width="40rem" className="ev-inspect">
      {evidence && (
        <div className="ev-inspect__body">
          <EvidencePeek evidence={evidence} context={context} onOpened={onClose} />
          <section className="ev-inspect__view" aria-label={`الصفحة ${evidence.locator_label_ar}`}>
            {blocked ? (
              <p className="ev-note ev-note--warning" role="note">
                {availabilityReason(availability!, evidence.version_no)}
              </p>
            ) : error ? (
              <ErrorState inline message={error} onRetry={() => setAttempt((n) => n + 1)} />
            ) : !loaded ? (
              <LoadingState inline stage="جارٍ تحميل الصفحة…" />
            ) : loaded.render.kind === 'pdf' ? (
              <PdfPage fileId={loaded.render.fileId} pageIndex={loaded.render.pageIndex} bbox={evidence.bbox} label={label} />
            ) : loaded.render.kind === 'image' ? (
              <ImagePage fileId={loaded.render.fileId} bbox={evidence.bbox} label={label} />
            ) : loaded.render.kind === 'regions' ? (
              <div className="ev-inspect__regions">
                <p className="ev-note" role="note">
                  هذا المصدر بلا صفحات ثابتة؛ يُعرض نص المقطع وموضع الدليل فيه.
                </p>
                {loaded.render.regions
                  .filter((r) => r.text && r.kind !== 'table_cell')
                  .map((r) => (
                    <BidiText key={r.id} text={r.text!} className={r.id === evidence.region_id ? 'ev-inspect__region ev-inspect__region--cited' : 'ev-inspect__region'} />
                  ))}
              </div>
            ) : (
              <p className="ev-note" role="note">
                {loaded.render.reason}
              </p>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

/** Small helper button that opens the inspector (for lists). */
export function InspectButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="plain" size="sm" icon={<FileSearch size={16} />} onClick={onClick}>
      فحص الموضع
    </Button>
  );
}
