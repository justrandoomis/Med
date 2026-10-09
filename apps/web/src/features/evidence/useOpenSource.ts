// «افتح المصدر» (§11): inside the study workspace → Source Jump & Back (openSourceLocation: scrolls,
// highlights the region, records the way back); anywhere else → navigate to the reader URL of the cited
// version/page/region. The cited version is kept (never swapped for another one).
import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EvidenceView } from '@medlevo/shared';
import { getDb } from '../../lib/localdb';
import { useOnline } from '../../lib/useOnline';
import { SourceNavigationContext, studyUrl } from '../workspace/nav/SourceNavigation';
import { chipText } from './model';

export type OpenResult = { ok: true } | { ok: false; reason_ar: string };

export function useOpenSource(): (e: EvidenceView) => Promise<OpenResult> {
  const nav = useContext(SourceNavigationContext);
  const navigate = useNavigate();
  return useCallback(
    async (e: EvidenceView): Promise<OpenResult> => {
      if (e.availability === 'source_deleted') return { ok: false, reason_ar: 'حُذف هذا المصدر؛ لا يمكن فتح موضع الدليل.' };
      const req = {
        sourceId: e.source_id,
        versionId: e.version_id,
        pageId: e.page_id,
        pageIndex: e.page_index,
        bbox: e.bbox,
        regionId: e.region_id,
        label: `${chipText(e)} — ${e.source_title}`,
      };
      if (nav) return nav.openSourceLocation(req);
      navigate(studyUrl(req));
      return { ok: true };
    },
    [nav, navigate],
  );
}

/**
 * While offline a page can only be opened if this device downloaded that version (Download Manager writes
 * `offlineSources`). Returns the effective availability.
 */
export function useEffectiveAvailability(e: EvidenceView | null): EvidenceView['availability'] | null {
  const online = useOnline();
  const [offlineOk, setOfflineOk] = useState<boolean | null>(null);
  useEffect(() => {
    if (online || !e) {
      setOfflineOk(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const row = await getDb().offlineSources.get(e.source_id);
        if (alive) setOfflineOk(!!row && (row as { versionId?: string }).versionId === e.version_id);
      } catch {
        if (alive) setOfflineOk(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [online, e]);
  if (!e) return null;
  if (e.availability !== 'available' && e.availability !== 'version_replaced') return e.availability;
  if (!online && offlineOk !== true) return 'not_downloaded_offline';
  return e.availability;
}
