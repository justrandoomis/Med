// Multipart upload with REAL byte progress (XMLHttpRequest upload events; fetch cannot report it).
// Same conventions as lib/api.ts: same-origin cookie, CSRF header, ApiErrorBody → ApiError (Arabic).
import { isApiErrorBody } from '@medlevo/shared';
import { ApiError, OFFLINE_MESSAGE_AR, UNREACHABLE_MESSAGE_AR } from '../../lib/api';

export interface UploadHandle<T> {
  promise: Promise<T>;
  abort: () => void;
}

export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
  abort(): void;
  status: number;
  responseText: string;
  withCredentials: boolean;
  timeout: number;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
}

let xhrFactory: () => XhrLike = () => new XMLHttpRequest() as unknown as XhrLike;
/** test hook */
export function setXhrFactory(f: (() => XhrLike) | null): void {
  xhrFactory = f ?? (() => new XMLHttpRequest() as unknown as XhrLike);
}

export function postMultipart<T>(path: string, form: FormData, onProgress: (sent: number, total: number) => void): UploadHandle<T> {
  const xhr = xhrFactory();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path.startsWith('/api') ? path : `/api${path}`);
    xhr.setRequestHeader('x-medlevo-csrf', '1');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.withCredentials = true;
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data !== undefined) {
        resolve(data as T);
        return;
      }
      if (isApiErrorBody(data)) {
        reject(new ApiError({ code: data.error.code, status: xhr.status, message: data.error.message, details: data.error.details }));
        return;
      }
      reject(
        new ApiError({
          code: xhr.status === 413 ? 'PAYLOAD_TOO_LARGE' : xhr.status >= 500 ? 'INTERNAL' : 'HTTP_ERROR',
          status: xhr.status,
          message: xhr.status === 413 ? 'الملف أكبر من الحد المسموح على الخادم.' : `تعذّر رفع الملف (رمز ${xhr.status}).`,
        }),
      );
    };
    const offline = () =>
      reject(
        new ApiError({
          code: typeof navigator !== 'undefined' && navigator.onLine === false ? 'OFFLINE' : 'NETWORK_ERROR',
          status: 0,
          offline: true,
          message: typeof navigator !== 'undefined' && navigator.onLine === false ? OFFLINE_MESSAGE_AR : UNREACHABLE_MESSAGE_AR,
        }),
      );
    xhr.onerror = offline;
    xhr.ontimeout = offline;
    xhr.onabort = () => reject(new ApiError({ code: 'HTTP_ERROR', status: 0, message: 'أُلغي الرفع.' }));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
