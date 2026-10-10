// Occlusion pictures kept on this device for offline review: which are missing, and saving them explicitly (the
// owner's action, online) — never implied by the HTTP cache.
import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState } from 'react';
import { getDb } from '../../../lib/localdb';
import { learningApi } from '../api';
import { cardImageBlobId, storeCardImage, type LocalCardRow } from '../local/store';

/** One card per occlusion picture that is not saved on this device yet. */
export function useMissingCardImages(cards: readonly LocalCardRow[]): LocalCardRow[] {
  const [stored, setStored] = useState<Set<string> | null>(null);
  useEffect(() => {
    const db = getDb();
    const sub = liveQuery(() => db.blobs.where('kind').equals('flashcard_image').primaryKeys()).subscribe({
      next: (keys) => setStored(new Set(keys as string[])),
      error: () => setStored(new Set()),
    });
    return () => sub.unsubscribe();
  }, []);
  return useMemo(() => {
    if (!stored) return [];
    const seen = new Set<string>();
    const out: LocalCardRow[] = [];
    for (const c of cards) {
      const asset = c.kind === 'image_occlusion' && !c.deletedAt ? c.image?.image_asset_id : null;
      if (!asset || seen.has(asset) || stored.has(cardImageBlobId(asset))) continue;
      seen.add(asset);
      out.push(c);
    }
    return out;
  }, [cards, stored]);
}

/** Saves the pictures through each card's short-lived media link (served without a file name). */
export async function prefetchCardImages(cards: readonly LocalCardRow[], onProgress?: (done: number) => void): Promise<{ saved: number; failed: number }> {
  const db = getDb();
  let saved = 0;
  let failed = 0;
  for (const c of cards) {
    const asset = c.image?.image_asset_id;
    try {
      const payload = await learningApi.reviewPayload(c.id);
      if (!asset || !payload.image) throw new Error('no image');
      const res = await fetch(payload.image.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      await storeCardImage(db, asset, await res.blob(), c.sourceId ?? null);
      saved++;
    } catch {
      failed++;
    }
    onProgress?.(saved + failed);
  }
  return { saved, failed };
}
