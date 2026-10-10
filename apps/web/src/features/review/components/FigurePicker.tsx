// Picks a picture for an image-occlusion card from the owner's processed sources: source → page → a figure that
// processing extracted as an image (it has an `image_asset`). The picture shown for drawing masks is the figure's
// region of the page (the same crop processing stored), so masks drawn here line up with the image the card shows.
// Pages without a stored rendering are rendered from the reader's PDF with pdf.js. Nothing is guessed: a figure
// without a usable rendering says so.
import { useEffect, useMemo, useState } from 'react';
import type { NormBox, SourcePageView, SourceRegionView, SourceSummary, SourceVersionView } from '@medlevo/shared';
import { pageDisplayLabel } from '@medlevo/shared';
import { ErrorState, LoadingState, Select } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { openPdf } from '../../../lib/pdf';
import { useLibrary } from '../../library/useLibrary';
import { fetchPages, fetchRegions, fetchSource } from '../../workspace/data/api';

export interface PickedFigure {
  imageAssetId: string;
  sourceId: string;
  versionId: string;
  pageId: string;
  imageUrl: string;
  caption: string | null;
}

const fileUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;

async function cropBlob(img: CanvasImageSource, w: number, h: number, box: NormBox): Promise<string> {
  const cw = Math.max(1, Math.round(box.w * w));
  const ch = Math.max(1, Math.round(box.h * h));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.drawImage(img, box.x * w, box.y * h, box.w * w, box.h * h, 0, 0, cw, ch);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('blob');
  return URL.createObjectURL(blob);
}

/** The figure's area of the page as an object URL (from the stored page rendering, else from the reader's PDF). */
export async function figureImageUrl(version: SourceVersionView, page: SourcePageView, region: SourceRegionView): Promise<string> {
  const box = region.bbox ?? { x: 0, y: 0, w: 1, h: 1 };
  if (page.render_file_id || (version.format === 'image' && version.file_id)) {
    const res = await fetch(fileUrl(page.render_file_id ?? version.file_id!), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('file');
    const bmp = await createImageBitmap(await res.blob());
    return cropBlob(bmp, bmp.width, bmp.height, box);
  }
  if (version.display_file_id && region.bbox) {
    const doc = await openPdf({ url: fileUrl(version.display_file_id) });
    const p = await doc.getPage(page.page_index + 1);
    const base = p.getViewport({ scale: 1, rotation: 0 });
    const scale = Math.min(4, 1800 / Math.max(1, base.width * box.w));
    const vp = p.getViewport({ scale, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp } as never).promise;
    return cropBlob(canvas, canvas.width, canvas.height, box);
  }
  throw new Error('no rendering');
}

export function FigurePicker({ onPick, initialSourceId }: { onPick: (f: PickedFigure | null) => void; initialSourceId?: string | null }) {
  const lib = useLibrary();
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [version, setVersion] = useState<SourceVersionView | null>(null);
  const [pages, setPages] = useState<SourcePageView[] | null>(null);
  const [pageId, setPageId] = useState('');
  const [figures, setFigures] = useState<SourceRegionView[] | null>(null);
  const [figureId, setFigureId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const sources: SourceSummary[] = useMemo(
    () => (lib.data?.sources ?? []).filter((s) => !s.deleted_at && s.active_version_id && s.processing_status !== 'pending').sort((a, b) => a.title.localeCompare(b.title, 'ar')),
    [lib.data],
  );

  useEffect(() => {
    setVersion(null);
    setPages(null);
    setPageId('');
    setFigures(null);
    setFigureId('');
    onPick(null);
    if (!sourceId) return;
    let cancelled = false;
    setLoading('جارٍ تحميل صفحات المصدر…');
    setError(null);
    void (async () => {
      try {
        const detail = await fetchSource(sourceId);
        const vid = detail.frozen_version_id ?? detail.current_version_id;
        const v = detail.versions.find((x) => x.id === vid) ?? detail.versions[0];
        if (!v) throw new Error('لا توجد نسخة لهذا المصدر.');
        const r = await fetchPages(sourceId, v.id);
        if (cancelled) return;
        setVersion(r.version);
        setPages(r.pages);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, 'تعذّر تحميل صفحات المصدر.'));
      } finally {
        if (!cancelled) setLoading(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  useEffect(() => {
    setFigures(null);
    setFigureId('');
    onPick(null);
    if (!pageId) return;
    let cancelled = false;
    setLoading('جارٍ البحث عن الصور في الصفحة…');
    void fetchRegions(pageId)
      .then((r) => {
        if (cancelled) return;
        setFigures(r.regions.filter((g) => g.structure?.type === 'figure' && !!g.structure.image_asset_id));
      })
      .catch((e) => !cancelled && setError(errorMessage(e, 'تعذّر تحميل مناطق الصفحة.')))
      .finally(() => !cancelled && setLoading(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  useEffect(() => {
    onPick(null);
    const fig = figures?.find((f) => f.id === figureId);
    const page = pages?.find((p) => p.id === pageId);
    if (!fig || !page || !version || fig.structure?.type !== 'figure' || !fig.structure.image_asset_id) return;
    const assetId = fig.structure.image_asset_id;
    let cancelled = false;
    let url: string | null = null;
    setLoading('جارٍ تجهيز الصورة…');
    setError(null);
    void figureImageUrl(version, page, fig)
      .then((u) => {
        url = u;
        if (cancelled) return URL.revokeObjectURL(u);
        onPick({ imageAssetId: assetId, sourceId, versionId: version.id, pageId: page.id, imageUrl: u, caption: null });
      })
      .catch(() => !cancelled && setError('تعذّر عرض هذه الصورة هنا (لا توجد صورة للصفحة ولا ملف PDF للعرض). اختر صورة أخرى.'))
      .finally(() => !cancelled && setLoading(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figureId]);

  const withImages = (pages ?? []).filter((p) => p.has_images);
  return (
    <div className="lw-figpick">
      <Select
        label="المصدر"
        options={[{ value: '', label: lib.loading && !lib.data ? 'جارٍ التحميل…' : 'اختر مصدرًا' }, ...sources.map((s) => ({ value: s.id, label: s.title }))]}
        value={sourceId}
        onValueChange={setSourceId}
      />
      {pages && (
        <Select
          label="الصفحة"
          hint={withImages.length ? `${withImages.length} صفحة فيها صور مستخرجة.` : 'لم يُعثر على صور مستخرجة في صفحات هذا المصدر.'}
          options={[{ value: '', label: 'اختر صفحة' }, ...withImages.map((p) => ({ value: p.id, label: pageDisplayLabel(p) }))]}
          value={pageId}
          onValueChange={setPageId}
        />
      )}
      {figures && figures.length === 0 && <p className="lw-muted">لا توجد صورة مستخرجة في هذه الصفحة.</p>}
      {figures && figures.length > 0 && (
        <Select
          label="الصورة"
          options={[{ value: '', label: 'اختر صورة' }, ...figures.map((f, i) => ({ value: f.id, label: f.text?.trim() ? `صورة ${i + 1}: ${f.text.trim().slice(0, 60)}` : `صورة ${i + 1}` }))]}
          value={figureId}
          onValueChange={setFigureId}
        />
      )}
      {loading && <LoadingState inline stage={loading} />}
      {error && <ErrorState inline message={error} />}
    </div>
  );
}
