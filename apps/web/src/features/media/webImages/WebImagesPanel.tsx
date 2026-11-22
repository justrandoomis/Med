// «صور من الويب» in the lecture workspace (rail «المصادر», under the figure descriptions): reference pictures from
// Wikimedia Commons, NLM Open-i and — when the owner set its key — Google, searched ONLY when the owner asks (a typed
// query or one of the suggestions made from the page's figure descriptions). Grid with attribution, tap to enlarge,
// «أضف إلى ملاحظاتي» keeps a reference card; the cards of this lecture are listed below. Never lecture content.
import { useCallback, useEffect, useState } from 'react';
import { Globe, Search, Trash2 } from 'lucide-react';
import { WEB_IMAGE_LABEL_AR, type WebImageRefView, type WebImageResult, type WebImageSearchResponse, type WebImageStatusResponse } from '@medlevo/shared';
import { Button, ErrorState, Skeleton, TextField } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { webImagesApi } from './api';
import { WebImageAttribution, WebImageGrid, WebImageLightbox, type WebPicture } from './WebImages';
import './webImages.css';

export interface WebImagesPanelProps {
  online: boolean;
  /** queries proposed from the page (figure descriptions); the owner picks one — nothing is searched by itself */
  suggestions?: string[];
  sourceId?: string;
  versionId?: string;
  pageId?: string;
}

export function WebImagesPanel({ online, suggestions = [], sourceId, versionId, pageId }: WebImagesPanelProps) {
  const [status, setStatus] = useState<WebImageStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<WebImageSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<WebPicture | null>(null);
  const [refs, setRefs] = useState<WebImageRefView[]>([]);
  const [pinBusy, setPinBusy] = useState(false);

  const loadRefs = useCallback(() => {
    webImagesApi
      .refs(sourceId)
      .then((r) => setRefs(r.items))
      .catch(() => undefined);
  }, [sourceId]);

  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    webImagesApi
      .status()
      .then((s) => !cancelled && setStatus(s))
      .catch((e: unknown) => !cancelled && setStatusError(errorMessage(e, 'تعذّر معرفة حالة صور الويب.')));
    loadRefs();
    return () => {
      cancelled = true;
    };
  }, [online, loadRefs]);

  const run = async (q: string) => {
    const text = q.trim();
    if (text.length < 2) return;
    setQuery(text);
    setSearching(true);
    setError(null);
    try {
      setResult(await webImagesApi.search(text));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر البحث عن صور من الويب.'));
    } finally {
      setSearching(false);
    }
  };

  const pinnedIds = new Set(result?.items.filter((i) => refs.some((r) => r.image_url === i.image_url)).map((i) => i.id) ?? []);
  const pin = async (item: WebImageResult) => {
    setPinBusy(true);
    try {
      const r = await webImagesApi.pin(item, { ...(query ? { query } : {}), ...(sourceId ? { source_id: sourceId } : {}), ...(versionId ? { version_id: versionId } : {}), ...(pageId ? { page_id: pageId } : {}) });
      setRefs((x) => [r.item, ...x.filter((y) => y.id !== r.item.id)]);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر حفظ الصورة في ملاحظاتك.'));
    } finally {
      setPinBusy(false);
    }
  };
  const unpin = async (id: string) => {
    try {
      await webImagesApi.unpin(id);
      setRefs((x) => x.filter((r) => r.id !== id));
    } catch (e) {
      setError(errorMessage(e, 'تعذّر إزالة المرجع.'));
    }
  };

  if (!online) return <p className="wi-muted">صور الويب تحتاج اتصالًا بالإنترنت.</p>;
  if (statusError) return <p className="wi-muted">{statusError}</p>;
  if (!status) return <Skeleton lines={2} />;
  const available = status.state === 'available';
  const uniqueSuggestions = [...new Set(suggestions.map((s) => s.trim()).filter((s) => s.length > 1))].slice(0, 4);

  return (
    <section className="wi-panel" aria-labelledby="wi-panel-h">
      <h3 id="wi-panel-h" className="wk-rail-h">
        <Globe size={16} aria-hidden="true" /> صور من الويب
      </h3>
      <p className="wi-label" role="note">
        {WEB_IMAGE_LABEL_AR}. صور مرجعية من خدمات عامة للمقارنة فقط، بمصدرها وترخيصها.
      </p>
      {!available ? (
        <div className="wi-off" role="note">
          <p>{status.reason_ar}</p>
          <ul>
            {status.how_to_enable_ar.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <form
            className="wi-search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              void run(query);
            }}
          >
            <TextField label="ابحث عن صورة مرجعية" hint="بالإنجليزية أو بالعربية (مثل: ورم حبيبي نسيجي، adenocarcinoma colon)" dir="auto" value={query} maxLength={300} onChange={(e) => setQuery(e.target.value)} />
            <Button type="submit" size="sm" variant="secondary" icon={<Search size={16} />} loading={searching} disabled={searching || query.trim().length < 2}>
              ابحث
            </Button>
          </form>
          {uniqueSuggestions.length > 0 && (
            <div className="wi-suggest" role="group" aria-label="اقتراحات من وصف صور هذه الصفحة">
              {uniqueSuggestions.map((s) => (
                <Button key={s} size="sm" variant="plain" disabled={searching} onClick={() => void run(s)}>
                  <bdi>{`ابحث: ${s}`}</bdi>
                </Button>
              ))}
            </div>
          )}
          {status.providers
            .filter((p) => p.state !== 'available')
            .map((p) => (
              <p key={p.provider} className="wi-muted">{`${p.label_ar}: ${p.reason_ar ?? ''}`}</p>
            ))}
        </>
      )}
      {error && <ErrorState inline message={error} />}
      {searching && <Skeleton lines={3} />}
      {result && !searching && (
        <>
          {result.query_en && result.query_en !== result.query.toLowerCase() && (
            <p className="wi-muted">
              بحثتُ عن: <bdi dir="ltr">{result.query_en}</bdi>
            </p>
          )}
          {result.providers
            .filter((p) => p.error_ar)
            .map((p) => (
              <p key={p.provider} className="wi-muted" role="status">
                {p.error_ar}
              </p>
            ))}
          {result.items.length === 0 ? <p className="wi-muted">لم تُعثر على صور. جرّب مصطلحًا إنجليزيًا أدق.</p> : <WebImageGrid items={result.items} onOpen={setOpen} pinnedIds={pinnedIds} />}
          {result.notes_ar.map((n) => (
            <p key={n} className="wi-muted">
              {n}
            </p>
          ))}
        </>
      )}
      {refs.length > 0 && (
        <>
          <h4 className="wi-subh">مراجعي من الويب{sourceId ? ' لهذه المحاضرة' : ''}</h4>
          <ul className="wi-refs" aria-label="صور الويب في ملاحظاتي">
            {refs.map((r) => (
              <li key={r.id} className="wi-ref">
                <button type="button" className="wi-card__img wi-ref__img" onClick={() => setOpen(r)} aria-label={`كبّر الصورة: ${r.title}`}>
                  <img src={r.thumb} alt={r.title} loading="lazy" referrerPolicy="no-referrer" />
                </button>
                <div>
                  <p className="wi-card__title" dir="auto">
                    {r.title}
                  </p>
                  <WebImageAttribution item={r} compact />
                  <Button size="sm" variant="plain" icon={<Trash2 size={14} />} onClick={() => void unpin(r.id)}>
                    أزل من ملاحظاتي
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <WebImageLightbox item={open} onClose={() => setOpen(null)} onPin={(it) => void pin(it)} pinned={open ? pinnedIds.has(open.id) || refs.some((r) => r.image_url === open.image_url) : false} pinBusy={pinBusy} />
    </section>
  );
}
