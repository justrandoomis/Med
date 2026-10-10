// Study Session (§46): restore where the owner was (local first, then the server), autosave the place
// (page, offset, zoom, rotation, layout, panels) through the outbox, and ask — never overwrite silently —
// when another device saved a newer position.
import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { newId, type StudyMode, type StudySessionDTO } from '@medlevo/shared';
import { getDeviceId } from '../../../lib/deviceId';
import { getDb, kvGet } from '../../../lib/localdb';
import { getSyncEngine } from '../../../lib/sync';
import { fetchLatestSession } from '../data/api';
import { latestLocalSession, rebasePendingSessionOps, saveSession, SESSION_CONFLICT_KEY, sessionRowFromDTO, type WorkspaceSessionRow } from '../data/local';
import { decideStart, type ReaderLocation, type StartDecision } from '../model/session';
import { isStudyMode } from '../modes/arrangement';

export const AUTOSAVE_MS = 1200;

export interface SessionConflict {
  server: StudySessionDTO;
  /** where it came from: opening the reader, or a save the server refused */
  origin: 'open' | 'save';
}

export interface StudySessionApi {
  decision: StartDecision | null;
  sessionId: string | null;
  conflict: SessionConflict | null;
  /** a newer position arrived from another device while reading (not applied) */
  remote: WorkspaceSessionRow['remoteChange'];
  /** queue an autosave of the current place */
  save(location: ReaderLocation, versionId: string, view?: 'original' | 'split'): void;
  /** write immediately (page hide, leaving the reader) */
  flush(): Promise<void>;
  /** 'theirs': adopt the other device's position (returned for navigation); 'mine': keep the current one */
  resolveConflict(choice: 'theirs' | 'mine', current: { location: ReaderLocation; versionId: string }): Promise<StudySessionDTO | null>;
  dismissRemote(): void;
  /** (track F3) the study mode of this session (§39) — restored with the session, synced like the place */
  mode: StudyMode;
  /** switch the mode: saved at once (IndexedDB + outbox), never waiting for the network */
  setMode(mode: StudyMode, current?: { location: ReaderLocation; versionId: string; view?: 'original' | 'split' }): void;
}

export function useStudySession(opts: {
  sourceId: string;
  versionIds: readonly string[] | null;
  activeVersionId: string | null;
  url: { versionId?: string | null; pageIndex?: number | null };
  online: boolean;
}): StudySessionApi {
  const { sourceId, versionIds, activeVersionId } = opts;
  const [decision, setDecision] = useState<StartDecision | null>(null);
  const [conflict, setConflict] = useState<SessionConflict | null>(null);
  const [remote, setRemote] = useState<WorkspaceSessionRow['remoteChange']>(null);
  const sessionId = useRef<string | null>(null);
  const deviceId = useRef<string>('');
  const pending = useRef<{ location: ReaderLocation; versionId: string; view: 'original' | 'split' } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const conflictRef = useRef<SessionConflict | null>(null);
  conflictRef.current = conflict;
  const [mode, setModeState] = useState<StudyMode>('learn');
  const modeRef = useRef<StudyMode>('learn');
  const urlRef = useRef(opts.url);
  const onlineRef = useRef(opts.online);
  onlineRef.current = opts.online;

  // ── decide where to start (once per source) ──
  useEffect(() => {
    if (!versionIds || !activeVersionId) return;
    let cancelled = false;
    (async () => {
      const db = getDb();
      deviceId.current = await getDeviceId(db).catch(() => 'unknown-device');
      const local = await latestLocalSession(db, sourceId).catch(() => null);
      let server: StudySessionDTO | null = null;
      if (onlineRef.current) {
        try {
          server = (await fetchLatestSession(sourceId)).session;
        } catch {
          server = null; // offline / slow server: the local position is enough to continue
        }
      }
      if (cancelled) return;
      const d = decideStart({
        url: urlRef.current,
        local: local ? { id: local.id, sourceId: local.sourceId, versionId: local.versionId, location: local.location ?? {}, rev: local.rev, updatedAt: local.updatedAt } : null,
        server,
        deviceId: deviceId.current,
        versionIds,
        activeVersionId,
      });
      // adopt a server session we did not have locally (nothing local to protect)
      if (d.from === 'server' && server && (!local || local.id !== server.id || (local.rev ?? 0) < server.rev)) {
        await db.studySessions.put(sessionRowFromDTO(server)).catch(() => undefined);
      }
      if (d.from === 'url' && !d.sessionId && server) {
        await db.studySessions.put(sessionRowFromDTO(server)).catch(() => undefined);
        d.sessionId = server.id;
        d.rev = server.rev;
      }
      sessionId.current = d.sessionId ?? newId();
      // the mode of the session being continued (this device's row, or the adopted server copy)
      const row = (await db.studySessions.get(sessionId.current).catch(() => undefined)) as WorkspaceSessionRow | undefined;
      const restored = row?.mode ?? (server && server.id === sessionId.current ? server.mode : null);
      if (cancelled) return;
      if (isStudyMode(restored)) {
        modeRef.current = restored;
        setModeState(restored);
      }
      setDecision({ ...d, sessionId: sessionId.current });
      if (d.conflict) setConflict({ server: d.conflict, origin: 'open' });
    })();
    return () => {
      cancelled = true;
    };
    // decided once per source; version list identity changes on refetch only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, activeVersionId, versionIds?.join(',')]);

  // ── refused saves (another device was newer) and remote moves, from the sync appliers ──
  useEffect(() => {
    const id = decision?.sessionId;
    if (!id) return;
    const db = getDb();
    const sub = liveQuery(async () => ({ conflict: await kvGet<StudySessionDTO>(db, SESSION_CONFLICT_KEY(id)), row: (await db.studySessions.get(id)) as WorkspaceSessionRow | undefined })).subscribe({
      next: ({ conflict: c, row }) => {
        if (c && !conflictRef.current) setConflict({ server: c, origin: 'save' });
        setRemote(row?.remoteChange ?? null);
      },
      error: () => undefined,
    });
    return () => sub.unsubscribe();
  }, [decision?.sessionId]);

  const writeNow = useCallback(async () => {
    const p = pending.current;
    const id = sessionId.current;
    pending.current = null;
    if (!p || !id || conflictRef.current) return;
    const db = getDb();
    const cur = (await db.studySessions.get(id)) as WorkspaceSessionRow | undefined;
    const now = Date.now();
    const row: WorkspaceSessionRow = {
      ...(cur ?? { createdAt: now, rev: null, mode: 'learn' as const }),
      id,
      sourceId,
      versionId: p.versionId,
      mode: modeRef.current,
      view: p.view,
      location: p.location,
      deviceId: deviceId.current || null,
      updatedAt: now,
      syncState: 'pending_sync',
      remoteChange: null,
    };
    await saveSession(db, row).catch(() => undefined);
  }, [sourceId]);

  const save = useCallback(
    (location: ReaderLocation, versionId: string, view: 'original' | 'split' = 'original') => {
      pending.current = { location, versionId, view };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void writeNow(), AUTOSAVE_MS);
    },
    [writeNow],
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    await writeNow();
  }, [writeNow]);

  // write the last place when the page is hidden or the reader closes
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      void flush();
    };
  }, [flush]);

  const resolveConflict = useCallback<StudySessionApi['resolveConflict']>(
    async (choice, current) => {
      const c = conflictRef.current;
      const id = sessionId.current;
      if (!c || !id) return null;
      const db = getDb();
      const engine = getSyncEngine();
      const ops = await db.outbox.where('[entity_type+entity_id]').equals(['study_session', id]).filter((o) => o.status === 'conflict' && !o.acknowledgedAt).toArray();
      for (const o of ops) await engine.acknowledge(o.op_id);
      await db.kv.delete(SESSION_CONFLICT_KEY(id)).catch(() => undefined);
      const server = c.server;
      // queued saves of this session were built on the refused revision: move them onto the server's
      // (carrying the other device's place when the owner chose it) so the owner is not asked twice
      if (server.id === id) await rebasePendingSessionOps(db, server, choice === 'theirs').catch(() => 0);
      setConflict(null);
      conflictRef.current = null;
      if (choice === 'theirs') {
        if (server.id === id) {
          await db.studySessions.put(sessionRowFromDTO(server));
        } else {
          // the newer position lives in another session row: continue in that one
          await db.studySessions.put(sessionRowFromDTO(server));
          sessionId.current = server.id;
        }
        return server;
      }
      // keep mine: base the next save on the server's revision so it is applied, not refused again
      if (server.id === id) {
        const cur = (await db.studySessions.get(id)) as WorkspaceSessionRow | undefined;
        if (cur) await db.studySessions.update(id, { rev: server.rev });
      }
      pending.current = { location: current.location, versionId: current.versionId, view: 'original' };
      await writeNow();
      return null;
    },
    [writeNow],
  );

  const dismissRemote = useCallback(() => {
    const id = sessionId.current;
    setRemote(null);
    if (id) void getDb().studySessions.update(id, { remoteChange: null } as Partial<WorkspaceSessionRow>).catch(() => undefined);
  }, []);

  const setMode = useCallback<StudySessionApi['setMode']>(
    (next, current) => {
      if (!isStudyMode(next)) return;
      modeRef.current = next;
      setModeState(next);
      // the switch is written at once with the current place (local first; the outbox syncs it)
      const place = pending.current ?? (current ? { location: current.location, versionId: current.versionId, view: current.view ?? ('original' as const) } : null);
      if (place) {
        pending.current = place;
        window.clearTimeout(timer.current);
        void writeNow();
        return;
      }
      const id = sessionId.current;
      if (!id) return;
      void (async () => {
        const db = getDb();
        const cur = (await db.studySessions.get(id)) as WorkspaceSessionRow | undefined;
        if (cur && !conflictRef.current) await saveSession(db, { ...cur, mode: next }).catch(() => undefined);
      })();
    },
    [writeNow],
  );

  return { decision, sessionId: decision?.sessionId ?? null, conflict, remote, save, flush, resolveConflict, dismissRemote, mode, setMode };
}
