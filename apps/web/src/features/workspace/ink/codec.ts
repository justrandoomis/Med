// Ink data on the wire (Academic OS P1-T2 step 2; ADR-0004 §2.5, ARCHITECTURE_DELTA §8.2).
//
//  * In memory and in IndexedDB the engine keeps v1 (`points` arrays) — every engine path reads them.
//  * The sync transport asks for `accept-ink: 2`, so pulled / pushed entities of a v2-aware server carry packed points;
//    `inkFromWire` decodes them back to v1 before anything stores them. A v1 entity passes through unchanged.
//  * This device pushes v2 only once the server has shown it speaks v2 (an entity with packed points arrived in this
//    page's lifetime). An older server never sends v2, so it never receives v2 either — old servers keep working.
//    Points that do not sit exactly on the engine's rounding grid stay v1 (the codec refuses them).
import { isInkDataV2, packInkData, toInkV1, type InkData } from '@medlevo/shared';

let serverSpeaksV2 = false;

/** Decodes packed points of an entity coming from the server (anything else is returned as is). */
export function inkFromWire<D>(kind: string, data: D): D {
  if (kind !== 'ink' || !isInkDataV2(data)) return data;
  serverSpeaksV2 = true;
  return toInkV1(data) as unknown as D;
}

/** The `data` to put into an outbox payload: packed when the server speaks v2 and the points pack losslessly. */
export function inkToWire<D>(kind: string, data: D): D {
  if (!serverSpeaksV2 || kind !== 'ink' || !data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1) return data;
  return (packInkData(data as unknown as InkData) ?? data) as D;
}

/** Tests only. */
export function __setServerSpeaksInkV2(v: boolean): void {
  serverSpeaksV2 = v;
}
export function serverSpeaksInkV2(): boolean {
  return serverSpeaksV2;
}
