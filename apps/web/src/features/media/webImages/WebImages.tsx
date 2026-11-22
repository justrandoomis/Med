// Web reference images («صور من الويب») — the shared pieces:
//   <WebImageGrid>      results with their attribution (source · author · licence · link to the original page)
//   <WebImageLightbox>  tap to enlarge: the larger preview, the full credit, «أضف إلى ملاحظاتي»
//   <WebImageStrip query=… />  a small embeddable strip (searches by itself) for other screens, e.g. the AI chat
// Every picture is labelled «صورة من الويب — ليست من محاضرتك» and loaded through the server's proxy (same origin, no
// referrer): the user's address never reaches the image hosts. Links to originals open without a referrer.
import { useEffect, useState, type ReactNode } from 'react';
import { BookmarkPlus, ExternalLink, Globe } from 'lucide-react';
import { WEB_IMAGE_LABEL_AR, WEB_IMAGE_USAGE_LABELS_AR, type WebImageRefView, type WebImageResult } from '@medlevo/shared';
import { Button, Dialog, ErrorState, Skeleton, StatusPill } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { useOnline } from '../../../lib/useOnline';
import { searchWebImages, webImagesApi } from './api';
import './webImages.css';

export type WebPicture = WebImageResult | WebImageRefView;

function ExternalLinkTo({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
    </a>
  );
}

/** source · author · licence (linked) · original page — always shown with the picture */
export function WebImageAttribution({ item, compact }: { item: WebPicture; compact?: boolean }) {
  return (
    <dl className={compact ? 'wi-credit wi-credit--compact' : 'wi-credit'} aria-label="مصدر الصورة وترخيصها">
      <div>
        <dt>المصدر</dt>
        <dd>{item.provider_label_ar}</dd>
      </div>
      {item.author && (
        <div>
          <dt>المؤلف</dt>
          <dd>
            <bdi>{item.author}</bdi>
          </dd>
        </div>
      )}
      <div>
        <dt>الترخيص</dt>
        <dd>{item.license_url ? <ExternalLinkTo href={item.license_url}>{item.license ?? 'الترخيص'}</ExternalLinkTo> : <bdi>{item.license ?? 'غير معروف'}</bdi>}</dd>
      </div>
      <div>
        <dt className="wi-sr">الصفحة الأصلية</dt>
        <dd>
          <ExternalLinkTo href={item.page_url}>
            <ExternalLink size={12} aria-hidden="true" /> الصفحة الأصلية
          </ExternalLinkTo>
        </dd>
      </div>
    </dl>
  );
}

export function WebImageGrid({ items, onOpen, pinnedIds }: { items: WebImageResult[]; onOpen: (item: WebImageResult) => void; pinnedIds?: ReadonlySet<string> }) {
  return (
    <ul className="wi-grid" aria-label="نتائج صور من الويب">
      {items.map((it) => (
        <li key={it.id} className="wi-card">
          <button type="button" className="wi-card__img" onClick={() => onOpen(it)} aria-label={`كبّر الصورة: ${it.title}`}>
            <img src={it.thumb} alt={it.title} loading="lazy" referrerPolicy="no-referrer" />
          </button>
          <p className="wi-card__title" dir="auto">
            {it.title}
          </p>
          {pinnedIds?.has(it.id) && <StatusPill tone="success">في ملاحظاتك</StatusPill>}
          <WebImageAttribution item={it} compact />
        </li>
      ))}
    </ul>
  );
}

export function WebImageLightbox({ item, onClose, onPin, pinned, pinBusy }: { item: WebPicture | null; onClose: () => void; onPin?: (item: WebImageResult) => void; pinned?: boolean; pinBusy?: boolean }) {
  if (!item) return null;
  const isResult = 'token' in item;
  return (
    <Dialog open onClose={onClose} size="lg" title={<bdi>{item.title}</bdi>} description={WEB_IMAGE_LABEL_AR}>
      <figure className="wi-lightbox">
        <img src={item.large} alt={item.title} referrerPolicy="no-referrer" />
        <figcaption>
          <p className="wi-label" role="note">
            <Globe size={14} aria-hidden="true" /> {WEB_IMAGE_LABEL_AR}
          </p>
          {item.caption && (
            <p dir="auto" className="wi-lightbox__caption">
              {item.caption}
            </p>
          )}
          <WebImageAttribution item={item} />
          <p className="wi-muted">{WEB_IMAGE_USAGE_LABELS_AR[item.usage]}</p>
        </figcaption>
      </figure>
      {isResult && onPin && (
        <div className="wi-actions">
          <Button size="sm" variant="secondary" icon={<BookmarkPlus size={16} />} loading={pinBusy} disabled={pinned || pinBusy} onClick={() => onPin(item)}>
            {pinned ? 'في ملاحظاتك' : 'أضف إلى ملاحظاتي'}
          </Button>
          <span className="wi-muted">تُحفظ بطاقة مرجعية بمصدرها وترخيصها، لا جزءًا من المحاضرة.</span>
        </div>
      )}
    </Dialog>
  );
}

/**
 * A small strip of web reference images for `query`, searched on mount (online only). For other screens (the AI chat,
 * explanations): `<WebImageStrip query="granuloma histology" sourceId={…} />`. Shows nothing when the feature is off
 * or nothing was found, unless `showEmpty`.
 */
export function WebImageStrip({ query, sourceId, pageId, max = 6, showEmpty = false }: { query: string; sourceId?: string; pageId?: string; max?: number; showEmpty?: boolean }) {
  const online = useOnline();
  const [items, setItems] = useState<WebImageResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<WebImageResult | null>(null);
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(query);
  if (key !== query) {
    setKey(query);
    setItems(null);
    setError(null);
  }
  useEffect(() => {
    if (!online || query.trim().length < 2) return;
    const ctrl = new AbortController();
    searchWebImages(query, { limit: max, signal: ctrl.signal })
      .then((r) => setItems(r.items.slice(0, max)))
      .catch((e: unknown) => !ctrl.signal.aborted && setError(errorMessage(e, 'تعذّر جلب صور من الويب.')));
    return () => ctrl.abort();
  }, [online, query, max]);

  const pin = async (it: WebImageResult) => {
    setBusy(true);
    try {
      await webImagesApi.pin(it, { query, ...(sourceId ? { source_id: sourceId } : {}), ...(pageId ? { page_id: pageId } : {}) });
      setPinned((s) => new Set(s).add(it.id));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ الصورة في ملاحظاتك.'));
    } finally {
      setBusy(false);
    }
  };

  if (!online) return null;
  if (error) return showEmpty ? <ErrorState inline message={error} /> : null;
  if (items === null) return <Skeleton lines={2} />;
  if (items.length === 0) return showEmpty ? <p className="wi-muted">لم تُعثر على صور من الويب لهذا الموضوع.</p> : null;
  return (
    <section className="wi-strip" aria-label="صور من الويب">
      <p className="wi-label" role="note">
        <Globe size={14} aria-hidden="true" /> {WEB_IMAGE_LABEL_AR}
      </p>
      <ul className="wi-strip__list">
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" className="wi-card__img" onClick={() => setOpen(it)} aria-label={`كبّر الصورة: ${it.title}`}>
              <img src={it.thumb} alt={it.title} loading="lazy" referrerPolicy="no-referrer" />
            </button>
            <span className="wi-strip__credit">
              <bdi>{it.provider_label_ar}</bdi>
              {it.license ? ` · ${it.license}` : ''}
            </span>
          </li>
        ))}
      </ul>
      <WebImageLightbox item={open} onClose={() => setOpen(null)} onPin={(it) => void pin(it)} pinned={open ? pinned.has(open.id) : false} pinBusy={busy} />
    </section>
  );
}
