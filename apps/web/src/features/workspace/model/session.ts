// Study Session restore precedence (§46).
//   1. an explicit place in the URL (?page / ?v — e.g. a citation) is opened as asked;
//   2. otherwise this device's own last position (local IndexedDB, works offline);
//   3. otherwise the server's latest position (another device), adopted as this session;
//   4. otherwise the first page.
// A newer position saved by ANOTHER device is never applied silently over the local one: the decision
// carries it as `conflict` and the UI asks the owner (§46: resuming must not silently overwrite).
import type { StudyLocation, StudySessionDTO } from '@medlevo/shared';

/** Reader location as the workspace stores it (StudyLocation + the fit mode). */
export interface ReaderLocation extends StudyLocation {
  fit?: 'width' | null;
}

export interface LocalSession {
  id: string;
  sourceId: string | null | undefined;
  versionId: string | null | undefined;
  location: ReaderLocation;
  /** server revision the local row is based on */
  rev?: number | null;
  /** epoch ms of the last local change */
  updatedAt: number;
}

export interface StartInput {
  url: { versionId?: string | null; pageIndex?: number | null };
  local: LocalSession | null;
  server: StudySessionDTO | null;
  deviceId: string;
  /** versions of this source, and the one study tools use by default */
  versionIds: readonly string[];
  activeVersionId: string;
}

export interface StartDecision {
  /** session to continue (null → create a new one) */
  sessionId: string | null;
  rev: number | null;
  versionId: string;
  location: ReaderLocation;
  from: 'url' | 'local' | 'server' | 'default';
  /** keep the saved zoom only when it was chosen on this device (a desktop zoom is wrong on a phone) */
  keepZoom: boolean;
  /** a newer position from another device that the owner must be asked about */
  conflict: StudySessionDTO | null;
}

/** Did the owner end up somewhere else (page or version)? Zoom/panel differences are not worth a prompt. */
export function locationsDiffer(a: { versionId: string | null | undefined; location: StudyLocation }, b: { versionId: string | null | undefined; location: StudyLocation }): boolean {
  if ((a.versionId ?? null) !== (b.versionId ?? null)) return true;
  return (a.location.page_index ?? 0) !== (b.location.page_index ?? 0);
}

/** Is the server copy newer than the local one AND written by another device? */
export function newerElsewhere(server: StudySessionDTO, local: LocalSession, deviceId: string): boolean {
  if (server.device_id === deviceId) return false;
  if (server.id === local.id) return server.rev > (local.rev ?? 0);
  return server.updated_at > local.updatedAt;
}

export function decideStart(i: StartInput): StartDecision {
  const validVersion = (v: string | null | undefined): v is string => !!v && i.versionIds.includes(v);
  const local = i.local && (!i.local.versionId || validVersion(i.local.versionId)) ? i.local : null;
  const server = i.server && (!i.server.version_id || validVersion(i.server.version_id)) ? i.server : null;

  // 1. explicit URL place
  if (i.url.pageIndex != null || validVersion(i.url.versionId)) {
    const base = local ?? (server ? fromServer(server) : null);
    const versionId = validVersion(i.url.versionId) ? i.url.versionId : (base?.versionId && validVersion(base.versionId) ? base.versionId : i.activeVersionId);
    const sameVersion = base && base.versionId === versionId;
    const location: ReaderLocation =
      i.url.pageIndex != null
        ? { ...(sameVersion ? base.location : {}), page_index: Math.max(0, i.url.pageIndex), page_offset: 0, page_id: undefined }
        : sameVersion
          ? base.location
          : { page_index: 0 };
    return {
      sessionId: base?.id ?? null,
      rev: base?.rev ?? null,
      versionId,
      location,
      from: 'url',
      keepZoom: !!local && sameVersion === true && base === local,
      conflict: null,
    };
  }

  // 2. this device's own position
  if (local) {
    if (server && newerElsewhere(server, local, i.deviceId)) {
      const serverLoc = fromServer(server);
      if (locationsDiffer(local, serverLoc)) {
        return { sessionId: local.id, rev: local.rev ?? null, versionId: local.versionId ?? i.activeVersionId, location: local.location, from: 'local', keepZoom: true, conflict: server };
      }
    }
    if (server && server.id === local.id && server.rev > (local.rev ?? 0) && server.device_id === i.deviceId) {
      // written by this device in another tab: newer, ours → just take it
      return { sessionId: server.id, rev: server.rev, versionId: server.version_id ?? i.activeVersionId, location: fromServer(server).location, from: 'server', keepZoom: true, conflict: null };
    }
    return { sessionId: local.id, rev: local.rev ?? null, versionId: local.versionId ?? i.activeVersionId, location: local.location, from: 'local', keepZoom: true, conflict: null };
  }

  // 3. the server's latest position (nothing local to protect)
  if (server) {
    return {
      sessionId: server.id,
      rev: server.rev,
      versionId: server.version_id ?? i.activeVersionId,
      location: fromServer(server).location,
      from: 'server',
      keepZoom: server.device_id === i.deviceId,
      conflict: null,
    };
  }

  // 4. first page
  return { sessionId: null, rev: null, versionId: i.activeVersionId, location: { page_index: 0 }, from: 'default', keepZoom: false, conflict: null };
}

function fromServer(s: StudySessionDTO): LocalSession {
  return { id: s.id, sourceId: s.source_id, versionId: s.version_id, location: (s.location ?? {}) as ReaderLocation, rev: s.rev, updatedAt: s.updated_at };
}
