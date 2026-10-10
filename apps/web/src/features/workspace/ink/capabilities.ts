// What the CURRENT browser/device actually reports for pen input (spec §27, AC-28).
// Nothing here is assumed from the user agent string: an API counts as "supported" only when its
// feature test passes, and a hardware capability (pressure, tilt, hover) only once real pointer
// events carried it. Mouse or simulated input never validates Apple Pencil quality or palm rejection.
import { useSyncExternalStore } from 'react';

export type CapabilityState =
  | 'supported' // observed on this device (or the API feature test passed, for pure APIs)
  | 'not_observed' // API exists, but no event has carried it yet — try writing with the pen
  | 'not_reported' // the device/browser did not report it
  | 'heuristic' // approximated on the web (e.g. palm rejection)
  | 'requires_native' // only a native iPad layer can provide it
  | 'requires_configuration' // built, but needs something set up on the server (e.g. a vision provider)
  | 'not_implemented'; // MedLevo has not built it yet

export const CAPABILITY_STATE_LABELS_AR: Record<CapabilityState, string> = {
  supported: 'مدعوم ورُصد هنا',
  not_observed: 'لم يُرصد بعد',
  not_reported: 'لا يبلّغ عنه هذا الجهاز',
  heuristic: 'تقريبي على الويب',
  requires_native: 'يتطلب تطبيق iPad أصليًا',
  requires_configuration: 'يحتاج إعدادًا على الخادم',
  not_implemented: 'غير منفّذ بعد',
};

export interface ApiSupport {
  pointerEvents: boolean;
  coalesced: boolean;
  predicted: boolean;
  /** PointerEvent.altitudeAngle (tilt as angles) */
  altitude: boolean;
  /** iPadOS Safari exposes Touch.touchType ('stylus' | 'direct') */
  touchType: boolean;
  indexedDB: boolean;
  anyFinePointer: boolean;
  anyHover: boolean;
}

export interface PenObservations {
  penSeen: boolean;
  touchSeen: boolean;
  mouseSeen: boolean;
  /** pressure values varied while a pen/touch was in contact */
  pressureVaried: boolean;
  pressureFrom: 'pen' | 'touch' | null;
  tiltSeen: boolean;
  /** pen pointermove with buttons = 0 (hovering above the screen) */
  hoverSeen: boolean;
  /** most coalesced samples delivered in one pointermove */
  maxCoalesced: number;
  predictedSeen: boolean;
  /** the live canvas asked for { desynchronized: true } and the browser honoured it (null = not asked yet) */
  desynchronized: boolean | null;
}

export interface CapabilityRow {
  key: string;
  label_ar: string;
  state: CapabilityState;
  detail_ar: string;
}

export function detectApiSupport(): ApiSupport {
  const hasWindow = typeof window !== 'undefined';
  const PE = hasWindow ? (window as unknown as { PointerEvent?: { prototype: object } }).PointerEvent : undefined;
  const mq = (q: string) => {
    try {
      return hasWindow && window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  const TouchCtor = hasWindow ? (window as unknown as { Touch?: { prototype: object } }).Touch : undefined;
  return {
    pointerEvents: !!PE,
    coalesced: !!PE && typeof (PE.prototype as { getCoalescedEvents?: unknown }).getCoalescedEvents === 'function',
    predicted: !!PE && typeof (PE.prototype as { getPredictedEvents?: unknown }).getPredictedEvents === 'function',
    altitude: !!PE && 'altitudeAngle' in PE.prototype,
    touchType: !!TouchCtor && 'touchType' in TouchCtor.prototype,
    indexedDB: hasWindow && typeof indexedDB !== 'undefined',
    anyFinePointer: mq('(any-pointer: fine)'),
    anyHover: mq('(any-hover: hover)'),
  };
}

export const EMPTY_OBSERVATIONS: PenObservations = {
  penSeen: false,
  touchSeen: false,
  mouseSeen: false,
  pressureVaried: false,
  pressureFrom: null,
  tiltSeen: false,
  hoverSeen: false,
  maxCoalesced: 0,
  predictedSeen: false,
  desynchronized: null,
};

/** Builds the honest capability rows (pure; unit-tested). */
/**
 * `storage`: whether this page could actually open its local database (null = not checked yet).
 * The `indexedDB` global alone proves nothing — private modes expose it and then refuse to open.
 */
export function buildCapabilityReport(
  api: ApiSupport,
  o: PenObservations,
  opts: { recognitionReason_ar?: string; recognitionAvailable?: boolean; storage?: 'ok' | 'failed' | null } = {},
): CapabilityRow[] {
  const noPen = 'لم يُستخدم قلم هنا بعد. اكتب أو مرّر القلم في مساحة الاختبار.';
  const rows: CapabilityRow[] = [];

  rows.push(
    !api.pointerEvents
      ? { key: 'pressure', label_ar: 'الضغط', state: 'not_reported', detail_ar: 'هذا المتصفح لا يدعم Pointer Events؛ الخطوط بسماكة ثابتة.' }
      : o.pressureVaried
        ? { key: 'pressure', label_ar: 'الضغط', state: 'supported', detail_ar: o.pressureFrom === 'touch' ? 'رصدنا تغيّر الضغط من اللمس. تتغيّر سماكة الخط مع الضغط.' : 'رصدنا تغيّر الضغط من القلم. تتغيّر سماكة الخط مع الضغط.' }
        : o.penSeen
          ? { key: 'pressure', label_ar: 'الضغط', state: 'not_reported', detail_ar: 'القلم المستخدم لم يُبلّغ عن تغيّر في الضغط، فتُرسم الخطوط بسماكة ثابتة ويُسجَّل ذلك مع كل خط.' }
          : { key: 'pressure', label_ar: 'الضغط', state: 'not_observed', detail_ar: noPen },
  );

  rows.push(
    o.tiltSeen
      ? { key: 'tilt', label_ar: 'الميل', state: 'supported', detail_ar: 'رصدنا زاوية ميل القلم، وتُحفظ مع نقاط الخط.' }
      : o.penSeen
        ? { key: 'tilt', label_ar: 'الميل', state: 'not_reported', detail_ar: 'القلم المستخدم لم يُبلّغ عن الميل.' }
        : { key: 'tilt', label_ar: 'الميل', state: 'not_observed', detail_ar: noPen },
  );

  rows.push(
    o.hoverSeen
      ? { key: 'hover', label_ar: 'تمرير القلم فوق الشاشة', state: 'supported', detail_ar: 'وصلت أحداث حركة للقلم دون لمس الشاشة.' }
      : o.penSeen
        ? { key: 'hover', label_ar: 'تمرير القلم فوق الشاشة', state: 'not_reported', detail_ar: 'لم تصل أحداث تمرير للقلم دون لمس؛ يحتاج ذلك جهازًا وقلمًا يدعمانه.' }
        : { key: 'hover', label_ar: 'تمرير القلم فوق الشاشة', state: 'not_observed', detail_ar: noPen },
  );

  rows.push({
    key: 'palm',
    label_ar: 'رفض راحة اليد',
    state: 'heuristic',
    detail_ar: 'تقريبي: في وضع «القلم فقط» يُتجاهل اللمس للكتابة ويبقى للتمرير، وتُرفض مساحات اللمس الكبيرة واللمس بعد رفع القلم مباشرة. رفض راحة اليد الأصلي من النظام يحتاج تطبيقًا أصليًا.',
  });

  rows.push(
    !api.coalesced
      ? { key: 'coalesced', label_ar: 'النقاط الإضافية بين الإطارات (coalesced events)', state: 'not_reported', detail_ar: 'غير متاحة في هذا المتصفح؛ تُلتقط نقطة واحدة لكل حدث حركة.' }
      : o.maxCoalesced > 1
        ? { key: 'coalesced', label_ar: 'النقاط الإضافية بين الإطارات (coalesced events)', state: 'supported', detail_ar: `تُستخدم: وصل حتى ${o.maxCoalesced} نقاط في حدث حركة واحد.` }
        : { key: 'coalesced', label_ar: 'النقاط الإضافية بين الإطارات (coalesced events)', state: 'not_observed', detail_ar: 'الواجهة متاحة وتُستخدم، لكن لم يصل بعد حدث يحمل أكثر من نقطة.' },
  );

  rows.push(
    !api.predicted
      ? { key: 'predicted', label_ar: 'توقّع حركة القلم (predicted events)', state: 'not_reported', detail_ar: 'غير متاحة في هذا المتصفح.' }
      : o.predictedSeen
        ? { key: 'predicted', label_ar: 'توقّع حركة القلم (predicted events)', state: 'supported', detail_ar: 'تُرسم النقاط المتوقعة مؤقتًا أمام الخط فقط ولا تُحفظ.' }
        : { key: 'predicted', label_ar: 'توقّع حركة القلم (predicted events)', state: 'not_observed', detail_ar: 'الواجهة متاحة، لكن المتصفح لم يُرسل نقاطًا متوقعة بعد.' },
  );

  rows.push(
    o.desynchronized === true
      ? { key: 'desync', label_ar: 'لوحة رسم منخفضة التأخير (desynchronized)', state: 'supported', detail_ar: 'قبل المتصفح هذا التلميح للطبقة الحية. لم نقِس زمن التأخير الفعلي.' }
      : o.desynchronized === false
        ? { key: 'desync', label_ar: 'لوحة رسم منخفضة التأخير (desynchronized)', state: 'not_reported', detail_ar: 'تجاهل المتصفح هذا التلميح؛ يُرسم الخط بالمسار العادي.' }
        : { key: 'desync', label_ar: 'لوحة رسم منخفضة التأخير (desynchronized)', state: 'not_observed', detail_ar: 'يُطلب عند فتح صفحة للكتابة.' },
  );

  rows.push({ key: 'pencilkit', label_ar: 'حبر PencilKit بأقل تأخير', state: 'requires_native', detail_ar: 'غير متاح للويب؛ يحتاج طبقة iPad أصلية.' });
  rows.push({ key: 'double_tap', label_ar: 'النقر المزدوج على القلم', state: 'requires_native', detail_ar: 'لا يصل هذا الحدث إلى صفحات الويب (UIPencilInteraction في UIKit فقط).' });
  rows.push({ key: 'squeeze', label_ar: 'الضغط على جسم القلم (Squeeze)', state: 'requires_native', detail_ar: 'لا يصل إلى صفحات الويب (Apple Pencil Pro وUIKit فقط).' });
  rows.push({
    key: 'scribble',
    label_ar: 'Scribble',
    state: 'requires_native',
    detail_ar: 'تحويل الحبر على الصفحة إلى نص غير متاح للويب. داخل حقول النص العادية (مربع النص والملاحظة اللاصقة) قد يعمل Scribble من النظام على Safari في iPad — لم نختبر ذلك على جهاز.',
  });
  // (track F4) recognition is built: a vision provider on the server reads what the owner selects
  rows.push(
    opts.recognitionAvailable
      ? {
          key: 'recognition',
          label_ar: 'التعرف على الخط اليدوي',
          state: 'supported',
          detail_ar: 'حدّد كتابتك بأداة التحديد الحر ثم «تحويل إلى نص»: يقرؤها مزود الرؤية على الخادم. النتيجة مشتقة تعرض الكلمات غير المؤكدة وتقبل التصحيح، ولا تمحو الحبر. دقتها على خطك لم تُختبر هنا.',
        }
      : {
          key: 'recognition',
          label_ar: 'التعرف على الخط اليدوي',
          state: 'requires_configuration',
          detail_ar: opts.recognitionReason_ar ?? 'يحتاج مزود ذكاء اصطناعي يقرأ الصور (vision) على الخادم. الحبر الأصلي يُحفظ دائمًا، والتعرف نتيجة مشتقة قابلة للتصحيح.',
        },
  );
  const offline = 'الكتابة دون اتصال';
  rows.push(
    !api.indexedDB || opts.storage === 'failed'
      ? { key: 'offline', label_ar: offline, state: 'not_reported', detail_ar: 'التخزين المحلي محجوب أو لا يفتح في هذا المتصفح (ربما وضع التصفح الخاص): ما تكتبه يبقى ظاهرًا في هذه الجلسة فقط ولن يُحفظ على هذا الجهاز.' }
      : opts.storage === 'ok'
        ? { key: 'offline', label_ar: offline, state: 'supported', detail_ar: 'فُتح التخزين المحلي (IndexedDB) هنا: كل خط يُحفظ على هذا الجهاز أولًا ثم يُزامَن عند توفر الاتصال.' }
        : { key: 'offline', label_ar: offline, state: 'not_observed', detail_ar: 'جارٍ التحقق من أن التخزين المحلي يفتح فعلًا في هذا المتصفح…' },
  );
  return rows;
}

// ─── runtime observer ──────────────────────────────────────────────────────────────────────────
export interface PointerSample {
  pointerType: string;
  pressure: number;
  tiltX: number;
  tiltY: number;
  buttons: number;
  type: string;
}

/** Tilt in degrees from tiltX/tiltY, or derived from altitude/azimuth (W3C Pointer Events §4.1.5). */
export function tiltOf(e: { tiltX?: number; tiltY?: number; altitudeAngle?: number; azimuthAngle?: number }): [number, number] {
  const tx = e.tiltX ?? 0;
  const ty = e.tiltY ?? 0;
  if (tx !== 0 || ty !== 0) return [tx, ty];
  const alt = e.altitudeAngle;
  const az = e.azimuthAngle;
  if (typeof alt === 'number' && typeof az === 'number' && alt > 0 && alt < Math.PI / 2 - 1e-3) {
    const tanAlt = Math.tan(alt);
    const r2d = 180 / Math.PI;
    return [Math.atan(Math.cos(az) / tanAlt) * r2d, Math.atan(Math.sin(az) / tanAlt) * r2d];
  }
  return [0, 0];
}

class PenProbe {
  private obs: PenObservations = { ...EMPTY_OBSERVATIONS };
  private pressureMin: Record<'pen' | 'touch', number> = { pen: Infinity, touch: Infinity };
  private pressureMax: Record<'pen' | 'touch', number> = { pen: -Infinity, touch: -Infinity };
  private listeners = new Set<() => void>();
  private last: PointerSample | null = null;
  private lastListeners = new Set<() => void>();

  get = (): PenObservations => this.obs;
  getLast = (): PointerSample | null => this.last;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  subscribeLast = (l: () => void) => {
    this.lastListeners.add(l);
    return () => this.lastListeners.delete(l);
  };

  private patch(p: Partial<PenObservations>) {
    let changed = false;
    for (const [k, v] of Object.entries(p) as Array<[keyof PenObservations, unknown]>) {
      if (this.obs[k] !== v) changed = true;
    }
    if (!changed) return;
    this.obs = { ...this.obs, ...p };
    this.listeners.forEach((l) => l());
  }

  /** Called for real pointer events (ink layer + the capability test area). Cheap: no allocation in the common case. */
  observe(e: PointerEvent, coalescedCount = 1, predictedCount = 0): void {
    const t = e.pointerType;
    const p: Partial<PenObservations> = {};
    if (t === 'pen' && !this.obs.penSeen) p.penSeen = true;
    else if (t === 'touch' && !this.obs.touchSeen) p.touchSeen = true;
    else if (t === 'mouse' && !this.obs.mouseSeen) p.mouseSeen = true;
    if ((t === 'pen' || t === 'touch') && e.buttons !== 0 && e.pressure > 0) {
      if (e.pressure < this.pressureMin[t]) this.pressureMin[t] = e.pressure;
      if (e.pressure > this.pressureMax[t]) this.pressureMax[t] = e.pressure;
      if (!this.obs.pressureVaried && this.pressureMax[t] - this.pressureMin[t] > 0.01) {
        p.pressureVaried = true;
        p.pressureFrom = t;
      }
    }
    if (t === 'pen') {
      const [tx, ty] = tiltOf(e);
      if (!this.obs.tiltSeen && (Math.abs(tx) > 0.5 || Math.abs(ty) > 0.5)) p.tiltSeen = true;
      if (!this.obs.hoverSeen && e.type === 'pointermove' && e.buttons === 0) p.hoverSeen = true;
    }
    if (coalescedCount > this.obs.maxCoalesced) p.maxCoalesced = coalescedCount;
    if (predictedCount > 0 && !this.obs.predictedSeen) p.predictedSeen = true;
    if (Object.keys(p).length) this.patch(p);
    if (this.lastListeners.size) {
      const [tx, ty] = tiltOf(e);
      this.last = { pointerType: t, pressure: e.pressure, tiltX: tx, tiltY: ty, buttons: e.buttons, type: e.type };
      this.lastListeners.forEach((l) => l());
    }
  }

  noteDesynchronized(honoured: boolean): void {
    if (this.obs.desynchronized !== true) this.patch({ desynchronized: honoured });
  }
}

export const penProbe = new PenProbe();

export function usePenObservations(): PenObservations {
  return useSyncExternalStore(penProbe.subscribe, penProbe.get, penProbe.get);
}

export function useLastPointerSample(): PointerSample | null {
  return useSyncExternalStore(penProbe.subscribeLast, penProbe.getLast, penProbe.getLast);
}
