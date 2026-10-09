// «قدرات القلم على هذا الجهاز» — an honest, live report (spec §27, AC-28). Rows come from what this
// browser's Pointer Events actually carried; nothing is claimed from the device name.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CircleCheck, CircleDashed, CircleSlash, Construction, Smartphone, Waves } from 'lucide-react';
import { Bidi, Dialog, StatusPill, type StatusTone } from '../../../design';
import { useCapabilities } from '../../../lib/capabilities';
import { describeDevice } from '../../../lib/deviceId';
import { getDb } from '../../../lib/localdb';
import {
  buildCapabilityReport,
  CAPABILITY_STATE_LABELS_AR,
  detectApiSupport,
  penProbe,
  useLastPointerSample,
  usePenObservations,
  type CapabilityState,
} from './capabilities';

const TONE: Record<CapabilityState, StatusTone> = {
  supported: 'success',
  not_observed: 'neutral',
  not_reported: 'warning',
  heuristic: 'info',
  requires_native: 'neutral',
  not_implemented: 'neutral',
};

const ICON: Record<CapabilityState, React.ReactNode> = {
  supported: <CircleCheck size={14} />,
  not_observed: <CircleDashed size={14} />,
  not_reported: <CircleSlash size={14} />,
  heuristic: <Waves size={14} />,
  requires_native: <Smartphone size={14} />,
  not_implemented: <Construction size={14} />,
};

const POINTER_AR: Record<string, string> = { pen: 'قلم', touch: 'لمس', mouse: 'فأرة' };

export function CapabilityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="قدرات القلم على هذا الجهاز" size="lg" description="ما يبلّغ عنه هذا المتصفح فعلًا الآن، وما يحتاج تطبيق iPad أصليًا.">
      {open && <CapabilityPanel />}
    </Dialog>
  );
}

export function CapabilityPanel() {
  const obs = usePenObservations();
  const api = useMemo(() => detectApiSupport(), []);
  const caps = useCapabilities();
  const recognition = caps.feature('workspace.handwriting_recognition');
  // offline writing is claimed only after the local database really opened here
  const [storage, setStorage] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    if (!api.indexedDB) return;
    getDb()
      .open()
      .then(
        () => alive && setStorage('ok'),
        () => alive && setStorage('failed'),
      );
    return () => {
      alive = false;
    };
  }, [api.indexedDB]);
  const rows = buildCapabilityReport(api, obs, { recognitionReason_ar: recognition.available ? undefined : (recognition.reason ?? undefined), storage });
  const device = useMemo(() => describeDevice(), []);
  return (
    <div className="ml-ink-caps" dir="rtl">
      <p className="ml-ink-caps__device">
        هذا الجهاز:{' '}
        {device.split(/( على )/).map((part, i) =>
          /[A-Za-z]/.test(part) ? (
            <Bidi key={i} dir="ltr">
              {part}
            </Bidi>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </p>
      <TestArea />
      <ul className="ml-ink-caps__list" role="list">
        {rows.map((r) => (
          <li key={r.key} className="ml-ink-caps__row">
            <div className="ml-ink-caps__head">
              <span className="ml-ink-caps__label">{r.label_ar}</span>
              <StatusPill tone={TONE[r.state]} icon={ICON[r.state]}>
                {CAPABILITY_STATE_LABELS_AR[r.state]}
              </StatusPill>
            </div>
            <p className="ml-ink-caps__detail">{r.detail_ar}</p>
          </li>
        ))}
      </ul>
      <p className="ml-ink-caps__honesty">
        {obs.mouseSeen && !obs.penSeen ? 'رُصدت فأرة فقط حتى الآن. ' : ''}
        اختبار الفأرة أو اللمس أو المحاكاة لا يثبت جودة الكتابة بـ <Bidi dir="ltr">Apple Pencil</Bidi> ولا رفض راحة اليد؛ يلزم اختبار بقلم فعلي على الجهاز.
      </p>
    </div>
  );
}

/** Write or hover here: every pointer event updates the report and the live readout. */
function TestArea() {
  const sample = useLastPointerSample();
  const ref = useRef<HTMLDivElement>(null);
  const feed = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ne = e.nativeEvent;
    const coalesced = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents().length : 1;
    const predicted = typeof ne.getPredictedEvents === 'function' ? ne.getPredictedEvents().length : 0;
    penProbe.observe(ne, coalesced, predicted);
  };
  return (
    <div className="ml-ink-caps__test">
      <div
        ref={ref}
        className="ml-ink-caps__pad"
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
          feed(e);
        }}
        onPointerMove={feed}
        onPointerUp={feed}
        role="img"
        aria-label="مساحة اختبار القلم: اكتب أو مرّر القلم هنا"
      >
        <span aria-hidden="true">اكتب أو مرّر القلم هنا</span>
      </div>
      <dl className="ml-ink-caps__readout" aria-live="off">
        <div>
          <dt>نوع المؤشر</dt>
          <dd>{sample ? POINTER_AR[sample.pointerType] ?? sample.pointerType : '—'}</dd>
        </div>
        <div>
          <dt>الضغط</dt>
          <dd dir="ltr">{sample ? sample.pressure.toFixed(2) : '—'}</dd>
        </div>
        <div>
          <dt>الميل</dt>
          <dd dir="ltr">{sample ? `${Math.round(sample.tiltX)}°, ${Math.round(sample.tiltY)}°` : '—'}</dd>
        </div>
        <div>
          <dt>الأزرار</dt>
          <dd dir="ltr">{sample ? sample.buttons : '—'}</dd>
        </div>
      </dl>
    </div>
  );
}
