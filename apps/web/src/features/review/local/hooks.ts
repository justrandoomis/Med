// React hooks over the local learning store: the cached SRS configuration (+ parity verdict) and live card / event
// rows from IndexedDB (updates when a pull, a push answer, a local write or another tab writes — Dexie storagemutated).
import Dexie, { type ObservabilitySet } from 'dexie';
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

/**
 * Re-read window during bursts of writes. Consumers re-fold EVERY card (FSRS replay) on each new set of rows: with two
 * whole-table live queries, a first sync of 3 000 cards + 12 000 events re-read both tables and re-folded all cards
 * after almost every pulled change — over half of the main thread in Chromium (I2, docs/PERFORMANCE.md).
 */
export const LOCAL_CARDS_RELOAD_MS = 400;

/**
 * Live rows from IndexedDB. The first write after a quiet period is reflected at once (a rating, an edit); a burst of
 * writes (a sync pull) is coalesced into at most one re-read per LOCAL_CARDS_RELOAD_MS, plus one after the burst.
 */
export function useLocalCards(): LocalCardsState {
  const [cards, setCards] = useState<LocalCardRow[] | null>(null);
  const [events, setEvents] = useState<LocalEventRow[] | null>(null);
  useEffect(() => {
    const db = getDb();
    let cancelled = false;
    let running = false;
    let again = false;
    let lastStart = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      lastStart = Date.now();
      try {
        const [c, e] = await Promise.all([db.flashcards.toArray(), db.reviewEvents.toArray()]);
        if (!cancelled) {
          setCards(c as LocalCardRow[]);
          setEvents(e as LocalEventRow[]);
        }
      } catch {
        if (!cancelled) {
          setCards((x) => x ?? []);
          setEvents((x) => x ?? []);
        }
      } finally {
        running = false;
        if (again && !cancelled) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (cancelled || timer !== undefined) return;
      const wait = Math.max(0, lastStart + LOCAL_CARDS_RELOAD_MS - Date.now());
      if (wait === 0 && !running) {
        void load();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void load();
      }, wait);
    };
    const tables = [`idb://${db.name}/flashcards/`, `idb://${db.name}/reviewEvents/`];
    const onMutated = (parts: ObservabilitySet) => {
      if (Object.keys(parts).some((k) => tables.some((t) => k.startsWith(t)))) schedule();
    };
    Dexie.on.storagemutated.subscribe(onMutated);
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      Dexie.on.storagemutated.unsubscribe(onMutated);
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
