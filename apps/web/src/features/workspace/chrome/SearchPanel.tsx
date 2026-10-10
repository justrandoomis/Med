// Find in document (§26): searches every page's text (pdf.js text content, OCR / paragraph regions) with
// Arabic-aware matching, lists the hits with their page identity, and highlights them on the pages.
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { detectDir, type SourcePageView } from '@medlevo/shared';
import { IconButton, LoadingState, Tooltip, cx } from '../../../design';
import { fetchRegions } from '../data/api';
import type { SourceDocument } from '../data/useSourceDocument';
import { fullPageLabel } from '../model/pages';
import { pdfPageUsesRegionText, regionPageText } from '../model/regionText';
import { searchPages, type SearchResult } from '../model/search';

export interface SearchPanelProps {
  doc: SourceDocument;
  query: string;
  onQuery: (q: string) => void;
  results: SearchResult[];
  onResults: (r: SearchResult[], truncated: boolean) => void;
  current: number;
  onCurrent: (i: number) => void;
  onClose: () => void;
  /** autofocus the field when opened */
  focusKey: number;
}

export async function pageText(doc: Pick<SourceDocument, 'mode' | 'pdf'>, page: SourcePageView): Promise<{ text: string; breaks?: number[] }> {
  // a scanned page inside a PDF has no PDF text: its text is the server's OCR, as on the page's text layer (AC-02)
  if (doc.mode === 'pdf' && doc.pdf && !pdfPageUsesRegionText(page)) return doc.pdf.text(page.page_index);
  const r = await fetchRegions(page.id);
  if (doc.mode !== 'text') return { text: regionPageText(r.regions) }; // same runs and concatenation as the text layer
  const regions = r.regions.filter((x) => x.text && x.kind !== 'footer' && x.kind !== 'header').sort((a, b) => a.reading_order - b.reading_order);
  return { text: regions.map((x) => x.text ?? '').join('\n') };
}

export function SearchPanel({ doc, query, onQuery, results, onResults, current, onCurrent, onClose, focusKey }: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failedPages, setFailedPages] = useState(0);
  const listId = useId();
  const statusId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  // debounced search over all pages (texts are cached per document)
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      onResults([], false);
      setProgress(null);
      setTruncated(false);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const texts: Array<{ pageIndex: number; text: string; breaks?: number[] }> = [];
      let failed = 0;
      setProgress({ done: 0, total: doc.pages.length });
      for (let i = 0; i < doc.pages.length; i++) {
        if (cancelled) return;
        try {
          const t = await pageText(doc, doc.pages[i]!);
          texts.push({ pageIndex: doc.pages[i]!.page_index, ...t });
        } catch {
          failed++;
        }
        if (i % 8 === 7) setProgress({ done: i + 1, total: doc.pages.length });
      }
      if (cancelled) return;
      const r = searchPages(texts, q);
      setProgress(null);
      setTruncated(r.truncated);
      setFailedPages(failed);
      onResults(r.results, r.truncated);
      onCurrent(0);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, doc]);

  const step = (d: 1 | -1) => {
    if (results.length === 0) return;
    onCurrent((current + d + results.length) % results.length);
  };

  const status = !query.trim()
    ? 'اكتب كلمة أو عبارة للبحث في هذا المصدر.'
    : progress
      ? `جارٍ البحث: ${progress.done} من ${progress.total} صفحة`
      : results.length === 0
        ? 'لا توجد نتائج في هذا الإصدار.'
        : `${results.length}${truncated ? '+' : ''} نتيجة — النتيجة ${current + 1}`;

  return (
    <div className="wk-search" role="search" aria-label="البحث في المصدر">
      <div className="wk-search__bar">
        <input
          ref={inputRef}
          className="ml-input wk-search__input"
          type="search"
          dir="auto"
          value={query}
          placeholder="ابحث في هذا المصدر"
          aria-label="ابحث في هذا المصدر"
          aria-describedby={statusId}
          aria-controls={listId}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <Tooltip content="النتيجة السابقة" describe={false}>
          <IconButton label="النتيجة السابقة" icon={<ChevronUp size={18} />} size="sm" disabled={results.length === 0} onClick={() => step(-1)} />
        </Tooltip>
        <Tooltip content="النتيجة التالية" describe={false}>
          <IconButton label="النتيجة التالية" icon={<ChevronDown size={18} />} size="sm" disabled={results.length === 0} onClick={() => step(1)} />
        </Tooltip>
        <Tooltip content="إغلاق البحث" describe={false}>
          <IconButton label="إغلاق البحث" icon={<X size={18} />} size="sm" onClick={onClose} />
        </Tooltip>
      </div>
      <p id={statusId} className="wk-search__status" role="status" aria-live="polite">
        {status}
      </p>
      {progress && <LoadingState inline stage="البحث في الصفحات" done={progress.done} total={progress.total} unit="صفحة" />}
      {failedPages > 0 && !progress && <p className="wk-muted">تعذّر قراءة نص {failedPages} صفحة؛ لم يُبحث فيها.</p>}
      {results.length > 0 && (
        <ol id={listId} className="wk-search__results" role="list">
          {results.map((r, i) => {
            const page = doc.pages[r.pageIndex];
            return (
              <li key={`${r.pageIndex}-${r.start}`}>
                <button type="button" className={cx('wk-search__hit', i === current && 'wk-search__hit--current')} aria-current={i === current ? 'true' : undefined} onClick={() => onCurrent(i)}>
                  <span className="wk-search__page">{page ? fullPageLabel(page) : `الصفحة ${r.pageIndex + 1} في الملف`}</span>
                  <span className="wk-search__snippet" dir={detectDir(r.snippet.before + r.snippet.match + r.snippet.after)}>
                    {r.snippet.before}
                    <mark>{r.snippet.match}</mark>
                    {r.snippet.after}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
