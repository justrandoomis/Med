// Chunked, resumable upload of an official file INTO a subject space (AOS-2.3 / 18.3; the server's
// /api/spaces/:spaceId/uploads…, P1-T1's upload sessions bound to the space). A large lecture on a weak connection:
//   1. the whole file's sha256 is computed a slice at a time (lib/sha256.ts — never the whole file in memory);
//   2. the session is announced (size + sha256, target: this subject); bytes the subject already holds complete at once;
//   3. only the chunks the server does not hold yet are sent, each with its own sha256;
//   4. when the connection cuts, the same bytes are announced again: the server answers the SAME session and the
//      chunks it already verified, and only the rest is sent (a few tries, then the reason is shown);
//   5. «complete» verifies the whole file; the caller then turns the upload into the lecture's version.
// Small files keep the one-shot multipart upload (one request, nothing to resume).
import type { UploadCompleteResponse, UploadOfficialVersionResponse, UploadSessionView } from '@medlevo/shared';
import { UPLOAD_CHUNK_SHA_HEADER } from '@medlevo/shared';
import { api, ApiError } from '../../lib/api';
import { blobBytes, sha256Hex, sha256OfBlob } from '../../lib/sha256';

/** From this size a file goes in chunks (the server's default chunk is 8 MB: below that one request is as good). */
export const CHUNKED_UPLOAD_FROM_BYTES = 8 * 1024 * 1024;

export interface ChunkedProgress {
  /** 'hashing' while the file's fingerprint is computed, 'sending' while chunks go */
  stage: 'hashing' | 'sending' | 'checking';
  sent: number;
  total: number;
}

export interface ChunkedOptions {
  onProgress?: (p: ChunkedProgress) => void;
  /** how many times a cut connection is resumed before the reason is shown (default 3) */
  retries?: number;
  /** wait before a resume, ms (tests pass 0) */
  retryDelayMs?: number;
}

const S = (spaceId: string, rest: string) => `/spaces/${encodeURIComponent(spaceId)}${rest}`;
/** a cut connection or a timeout — worth resuming; anything the server answered is its decision */
const isCut = (e: unknown) => e instanceof ApiError && e.status === 0;
const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Send `file` into the subject space in chunks; resolves to the completed upload id. */
export async function chunkedUploadToSpace(spaceId: string, file: File, opts: ChunkedOptions = {}): Promise<string> {
  const retries = opts.retries ?? 3;
  const delay = opts.retryDelayMs ?? 2000;
  const report = (p: ChunkedProgress) => opts.onProgress?.(p);
  report({ stage: 'hashing', sent: 0, total: file.size });
  const sha256 = await sha256OfBlob(file);
  const announce = { size: file.size, sha256, ...(file.type ? { mime: file.type } : {}), name: file.name, target: { space_id: spaceId } };

  for (let attempt = 0; ; attempt++) {
    try {
      // announcing again after a cut returns the SAME session with what it already holds
      const s = await api.post<UploadSessionView>(S(spaceId, '/uploads'), announce, { timeoutMs: 30_000 });
      if (s.status !== 'completed') {
        const done = new Set(s.received);
        let sent = Math.min(file.size, done.size * s.chunk_size);
        report({ stage: 'sending', sent, total: file.size });
        for (let n = 0; n < s.chunks; n++) {
          if (done.has(n)) continue;
          const part = file.slice(n * s.chunk_size, Math.min((n + 1) * s.chunk_size, file.size));
          const hex = sha256Hex(await blobBytes(part));
          await api.put<UploadSessionView>(S(spaceId, `/uploads/${encodeURIComponent(s.upload_id)}/chunks/${n}`), part, {
            timeoutMs: 120_000,
            headers: { 'Content-Type': 'application/octet-stream', [UPLOAD_CHUNK_SHA_HEADER]: hex },
          });
          sent = Math.min(file.size, sent + part.size);
          report({ stage: 'sending', sent, total: file.size });
        }
        report({ stage: 'checking', sent: file.size, total: file.size });
        await api.post<UploadCompleteResponse>(S(spaceId, `/uploads/${encodeURIComponent(s.upload_id)}/complete`), {}, { timeoutMs: 10 * 60_000 });
      }
      return s.upload_id;
    } catch (e) {
      if (!isCut(e) || attempt >= retries) throw e;
      await wait(delay * (attempt + 1));
    }
  }
}

/**
 * The official file of a lecture: one request for a small file; for a large one a chunked, resumable upload into the
 * space, then the lecture takes it (`{upload_id}`) — the server inspects and processes it the same way.
 */
export async function uploadLectureFile(
  spaceId: string,
  lectureId: string,
  file: File,
  opts: ChunkedOptions & { chunkedFrom?: number; oneShot: (spaceId: string, lectureId: string, file: File) => Promise<UploadOfficialVersionResponse> },
): Promise<UploadOfficialVersionResponse> {
  if (file.size < (opts.chunkedFrom ?? CHUNKED_UPLOAD_FROM_BYTES)) return opts.oneShot(spaceId, lectureId, file);
  const uploadId = await chunkedUploadToSpace(spaceId, file, opts);
  return api.post<UploadOfficialVersionResponse>(S(spaceId, `/lectures/${encodeURIComponent(lectureId)}/upload`), { upload_id: uploadId }, { timeoutMs: 10 * 60_000 });
}
