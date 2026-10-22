// The in-app QR scanner of the join sheet (P1-T4 step 3; PRD AOS-2.12; IA §8.2 QrScannerSheet). It asks for the camera
// only when the person taps «امسح رمز QR», says plainly when the camera cannot be used (no camera API, permission
// refused, no camera), and hands control back to the code field — typing the code always works. Frames are decoded
// on the device (jsQR); nothing is uploaded. The stream stops as soon as a code is read or the sheet closes.
import { useEffect, useRef, useState } from 'react';
import { CameraOff } from 'lucide-react';
import { Button } from '../../design';
import { decodeQrPixels } from './qr';

/** Why the camera cannot be used, in Arabic (from the real error, never from the device name). */
export function cameraProblemAr(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'لم يُسمح باستخدام الكاميرا. اكتب الرمز، أو اختر صورة رمز QR من جهازك.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'لا توجد كاميرا متاحة على هذا الجهاز. اكتب الرمز، أو اختر صورة رمز QR.';
  if (name === 'NotReadableError') return 'الكاميرا مشغولة بتطبيق آخر. أغلقه أو اكتب الرمز.';
  return 'الكاميرا غير متاحة هنا. اكتب الرمز، أو اختر صورة رمز QR.';
}

export function QrScanner({ onResult, onUnavailable, onStop }: { onResult: (text: string) => void; onUnavailable: (reasonAr: string) => void; onStop: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    const stop = () => {
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const tick = async () => {
      const v = videoRef.current;
      if (cancelled || done.current || !v) return;
      if (v.readyState >= 2 && v.videoWidth > 0) {
        const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (g) {
          g.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = g.getImageData(0, 0, canvas.width, canvas.height);
          const text = await decodeQrPixels(img.data, canvas.width, canvas.height);
          if (text && !cancelled && !done.current) {
            done.current = true;
            stop();
            onResult(text);
            return;
          }
        }
      }
      timer = setTimeout(() => void tick(), 300);
    };
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      onUnavailable('الكاميرا غير متاحة في هذا المتصفح أو على هذا الاتصال. اكتب الرمز، أو اختر صورة رمز QR من جهازك.');
      return;
    }
    media
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setLive(true);
        void tick();
      })
      .catch((e) => !cancelled && onUnavailable(cameraProblemAr(e)));
    return () => {
      cancelled = true;
      stop();
    };
    // the scanner runs once per mount; the parent remounts it for another scan
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ch-scan">
      <video ref={videoRef} className="ch-scan__video" muted playsInline aria-label="معاينة الكاميرا لقراءة رمز QR" />
      <p className="ml-group-footer" role="status">
        {live ? 'وجّه الكاميرا إلى رمز QR. يُقرأ على جهازك ولا يُرفع.' : 'جارٍ تشغيل الكاميرا…'}
      </p>
      <Button size="sm" icon={<CameraOff size={16} />} onClick={onStop}>
        أوقف الكاميرا
      </Button>
    </div>
  );
}
