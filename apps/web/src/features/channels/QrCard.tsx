// QrCard (P1-T4 step 3; IA §8.2): the QR of an invite link with the link printed beside it as text, LTR and selectable,
// and a copy button. Its own module: only the screens that show a QR load the encoder.
import { Copy } from 'lucide-react';
import { Button } from '../../design';
import { qrMatrix, qrSvgPath } from './qrEncode';
import { useCopy } from './ui';

/** The QR of an invite link with the link (or code) printed beside it as text, LTR, selectable. */
export function QrCard({ payload, caption }: { payload: string; caption: string }) {
  const copy = useCopy();
  const m = qrMatrix(payload);
  const size = m.length + 8;
  return (
    <figure className="ch-qr">
      <svg className="ch-qr__code" viewBox={`-4 -4 ${size} ${size}`} role="img" aria-label={`رمز QR: ${caption}`} shapeRendering="crispEdges">
        <rect x={-4} y={-4} width={size} height={size} fill="#fff" />
        <path d={qrSvgPath(m)} fill="#000" />
      </svg>
      <figcaption className="ch-qr__caption">
        <span>{caption}</span>
        <code dir="ltr" className="ch-qr__text">
          {payload}
        </code>
        <Button size="sm" icon={<Copy size={16} />} onClick={() => void copy(payload, 'الرابط')}>
          انسخ الرابط
        </Button>
      </figcaption>
    </figure>
  );
}
