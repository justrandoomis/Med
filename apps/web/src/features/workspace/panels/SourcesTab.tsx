// «المصادر» (§11 Source Inspector basics): what this page is — version, printed label and file position,
// text status, OCR confidence — and its regions, each of which can be shown on the page.
import { useEffect, useState } from 'react';
import { Columns2, Crosshair, ExternalLink, ScanSearch } from 'lucide-react';
import { detectDir, SOURCE_TYPE_LABELS_AR, type SourcePageView, type SourceRegionView } from '@medlevo/shared';
import { Bidi, Button, ErrorState, Skeleton, StatusPill, Term, buttonClass } from '../../../design';
import { Link } from 'react-router-dom';
import { errorMessage } from '../../../lib/api';
import { useOnline } from '../../../lib/useOnline';
import { fetchRegions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { useSourceNavigation } from '../nav/SourceNavigation';
import { PAGE_PROCESSING_AR, REGION_KIND_AR, regionStatus, TEXT_STATUS_AR, versionLabel } from '../model/labels';
import { fullPageLabel } from '../model/pages';
import { FigureReadingPanel } from './FigureReadingPanel';

const FIGURE_KINDS = new Set(['figure', 'diagram']);

export function SourcesTab({ doc, page, onOpenSplit, splitReason }: { doc: SourceDocument; page: SourcePageView | null; onOpenSplit: (sourceId: string) => void; splitReason: string | null }) {
  const nav = useSourceNavigation();
  const [regions, setRegions] = useState<SourceRegionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const online = useOnline();
  const pageId = page?.id ?? null;
  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    setRegions(null);
    setError(null);
    fetchRegions(pageId)
      .then((r) => !cancelled && setRegions([...r.regions].sort((a, b) => a.reading_order - b.reading_order)))
      .catch((e) => !cancelled && setError(errorMessage(e, 'تعذّر تحميل مناطق الصفحة.')));
    return () => {
      cancelled = true;
    };
  }, [pageId, attempt]);

  const { detail, version } = doc;
  const text = page ? TEXT_STATUS_AR[page.text_status] : null;
  const proc = page ? (PAGE_PROCESSING_AR[page.processing_status] ?? PAGE_PROCESSING_AR.pending!) : null;

  return (
    <div className="wk-rail-section">
      <dl className="wk-facts">
        <div>
          <dt>المصدر</dt>
          <dd>
            <bdi>{detail.title}</bdi> <span className="wk-muted">({SOURCE_TYPE_LABELS_AR[detail.source_type]})</span>
          </dd>
        </div>
        <div>
          <dt>الإصدار</dt>
          <dd>{versionLabel(version)}</dd>
        </div>
        {page && (
          <>
            <div>
              <dt>الصفحة</dt>
              <dd>{fullPageLabel(page)}</dd>
            </div>
            <div>
              <dt>النص</dt>
              <dd>
                <StatusPill tone={text!.tone}>{text!.label}</StatusPill>
              </dd>
            </div>
            {page.ocr_confidence != null && (
              <div>
                <dt>
                  ثقة محرك <Term>OCR</Term>
                </dt>
                <dd>
                  <Bidi dir="ltr">{`${Math.round(page.ocr_confidence * 100)}%`}</Bidi> <span className="wk-muted">(تقدير المحرك نفسه، ليس تحققًا)</span>
                </dd>
              </div>
            )}
            <div>
              <dt>المعالجة</dt>
              <dd>
                <StatusPill tone={proc!.tone}>{proc!.label}</StatusPill>
                {page.error_detail_ar && <p className="wk-muted">{page.error_detail_ar}</p>}
              </dd>
            </div>
          </>
        )}
      </dl>
      <div className="wk-rail-actions">
        <Link to={`/sources/${detail.id}`} className={buttonClass({ variant: 'plain', size: 'sm' })}>
          <ExternalLink size={16} aria-hidden="true" />
          تفاصيل المصدر وإصداراته
        </Link>
      </div>

      <h3 className="wk-rail-h">مناطق هذه الصفحة</h3>
      {!page ? null : error ? (
        <ErrorState inline message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : regions === null ? (
        <Skeleton lines={4} />
      ) : regions.length === 0 ? (
        <p className="wk-muted">لم تُستخرج مناطق لهذه الصفحة بعد{page.processing_status !== 'ready' ? ' (المعالجة لم تكتمل).' : '.'}</p>
      ) : (
        <ul className="wk-regions" role="list">
          {regions.map((r) => {
            const st = regionStatus(r.status);
            const snippet = (r.text ?? '').replace(/\s+/g, ' ').slice(0, 120);
            return (
              <li key={r.id} className="wk-region-row">
                <div className="wk-region-row__head">
                  <span className="wk-region-row__kind">{REGION_KIND_AR[r.kind]}</span>
                  <StatusPill tone={st.tone}>{st.label}</StatusPill>
                </div>
                {snippet && (
                  <p className="wk-region-row__text" dir={detectDir(snippet)} lang={r.lang ?? undefined}>
                    {snippet}
                    {(r.text ?? '').length > 120 ? '…' : ''}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="plain"
                  icon={<Crosshair size={16} />}
                  onClick={() => void nav.openSourceLocation({ sourceId: detail.id, versionId: version.id, pageId: page.id, bbox: r.bbox, regionId: r.id, label: `${REGION_KIND_AR[r.kind]} — ${fullPageLabel(page)}` })}
                >
                  إظهار في الصفحة
                </Button>
                {FIGURE_KINDS.has(r.kind) && (
                  <>
                    <Button size="sm" variant="plain" icon={<ScanSearch size={16} />} aria-expanded={reading === r.id} onClick={() => setReading((x) => (x === r.id ? null : r.id))}>
                      بنية الشكل (قراءة بصرية)
                    </Button>
                    {reading === r.id && <FigureReadingPanel regionId={r.id} online={online} />}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {detail.links.length > 0 && (
        <>
          <h3 className="wk-rail-h">مصادر مرتبطة</h3>
          <ul className="wk-regions" role="list">
            {detail.links.map((l) => (
              <li key={l.id} className="wk-region-row">
                <div className="wk-region-row__head">
                  <bdi className="wk-region-row__kind">{l.other_title}</bdi>
                  <span className="wk-muted">{SOURCE_TYPE_LABELS_AR[l.other_type]}</span>
                </div>
                <Button size="sm" variant="plain" icon={<Columns2 size={16} />} disabled={!!splitReason} title={splitReason ?? undefined} onClick={() => onOpenSplit(l.from_source_id === detail.id ? l.to_source_id : l.from_source_id)}>
                  افتح بجانب المحاضرة
                </Button>
                {splitReason && <p className="wk-muted">{splitReason}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
