// React hooks over the local learning store: the cached SRS configuration (+ parity verdict) and live card / event
// rows from IndexedDB (Dexie liveQuery — updates when a pull, a push answer or another tab writes).
import { liveQuery } from 'dexie';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SrsConfigView } from '@medlevo/shared';
import { getDb } from '../../../lib/localdb';
import { getSyncEngine } from '../../../lib/sync';
import { useOnline } from '../../../lib/useOnline';
import { learningApi } from '../api';
import { checkParity, type ParityResult } from './srs';
import { cachedSrsConfig, registerLearningAppliers, storeSrsConfig, type LocalCardRow, type LocalEventRow } from './store';

export interface SrsConfigState {
  config: SrsConfigView | null;
  /** where the config came from: the server just now, or this device's saved copy */
  origin: 'server' | 'device' | null;
  fetchedAt: number | null;
  parity: ParityResult | null;
  loading: boolean;
  error: string | null;
}

/** Ensures the learning appliers are registered (pulled cards / events land in IndexedDB). */
export function useLearningSync(): void {
  useEffect(() => {
    registerLearningAppliers(getSyncEngine());
  }, []);
}

/** The SRS configuration: the saved copy first (works offline), refreshed from the server when online. */
export function useSrsConfig(): SrsConfigState & { refresh: () => Promise<void> } {
  const online = useOnline();
  const [st, setSt] = useState<SrsConfigState>({ config: null, origin: null, fetchedAt: null, parity: null, loading: true, error: null });

  const refresh = useCallback(async () => {
    const db = getDb();
    const cached = await cachedSrsConfig(db).catch(() => null);
    if (cached) setSt((s) => ({ ...s, config: cached.config, origin: 'device', fetchedAt: cached.fetchedAt, parity: checkParity(cached.config) }));
    try {
      const cfg = await learningApi.srsConfig();
      await storeSrsConfig(db, cfg).catch(() => undefined);
      setSt({ config: cfg, origin: 'server', fetchedAt: Date.now(), parity: checkParity(cfg), loading: false, error: null });
    } catch (e) {
      setSt((s) => ({ ...s, loading: false, error: cached ? null : e instanceof Error ? e.message : 'تعذّر تحميل إعدادات الجدولة.' }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, online]);

  return { ...st, refresh };
}

export interface LocalCardsState {
  cards: LocalCardRow[];
  events: Map<string, LocalEventRow[]>;
  ready: boolean;
}

/** Live rows from IndexedDB. */
export function useLocalCards(): LocalCardsState {
  const [cards, setCards] = useState<LocalCardRow[] | null>(null);
  const [events, setEvents] = useState<LocalEventRow[] | null>(null);
  useEffect(() => {
    const db = getDb();
    const a = liveQuery(() => db.flashcards.toArray()).subscribe({ next: (rows) => setCards(rows as LocalCardRow[]), error: () => setCards([]) });
    const b = liveQuery(() => db.reviewEvents.toArray()).subscribe({ next: (rows) => setEvents(rows as LocalEventRow[]), error: () => setEvents([]) });
    return () => {
      a.unsubscribe();
      b.unsubscribe();
    };
  }, []);
  const byCard = useMemo(() => {
    const m = new Map<string, LocalEventRow[]>();
    for (const e of events ?? []) {
      const list = m.get(e.cardId) ?? [];
      list.push(e);
      m.set(e.cardId, list);
    }
    return m;
  }, [events]);
  return { cards: cards ?? [], events: byCard, ready: cards !== null && events !== null };
}

/** A ticking clock (ms) for due times (re-renders every `everyMs`). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
