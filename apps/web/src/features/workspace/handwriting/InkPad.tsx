// A small writing pad (track F4, §41 handwritten answers): pen, finger or mouse strokes in pad-width units
// ([x, y, t]), drawn locally (no network), undoable, and handed to the caller on every change so it can keep a draft
// on the device. It is an alternative input: the keyboard answer field always stays available.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser, Undo2 } from 'lucide-react';
import { Button } from '../../../design';

export type PadStroke = number[][];

export interface InkPadProps {
  strokes: PadStroke[];
  onChange: (strokes: PadStroke[]) => void;
  label?: string;
  disabled?: boolean;
}

/** pad height / pad width */
const AR = 1 / 3;

export function InkPad({ strokes, onChange, label = 'لوحة الكتابة بخط اليد', disabled }: InkPadProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<{ id: number; pts: number[][]; t0: number } | null>(null);
  const history = useRef<PadStroke[][]>([]);
  const [canUndo, setCanUndo] = useState(false);

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const ink = getComputedStyle(c).color || '#1c1c1e';
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, w * 0.004);
    const all = live.current ? [...strokes, live.current.pts] : strokes;
    for (const s of all) {
      if (s.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(s[0]![0]! * w, s[0]![1]! * w);
      if (s.length === 1) ctx.lineTo(s[0]![0]! * w + 0.5, s[0]![1]! * w + 0.5);
      for (let i = 1; i < s.length; i++) ctx.lineTo(s[i]![0]! * w, s[i]![1]! * w);
      ctx.stroke();
    }
  }, [strokes]);

  useEffect(() => {
    paint();
    if (typeof ResizeObserver === 'undefined' || !canvas.current) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(canvas.current);
    return () => ro.disconnect();
  }, [paint]);

  const point = (e: ReactPointerEvent<HTMLCanvasElement>, t0: number): number[] => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = r.width || 1;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / w));
    const y = Math.min(AR, Math.max(0, (e.clientY - r.top) / w));
    return [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, Math.round(performance.now() - t0)];
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best effort
    }
    const t0 = performance.now();
    live.current = { id: e.pointerId, pts: [point(e, t0)], t0 };
    paint();
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    const p = point(e, l.t0);
    const last = l.pts[l.pts.length - 1]!;
    if (Math.hypot(p[0]! - last[0]!, p[1]! - last[1]!) < 0.002) return;
    l.pts.push(p);
    paint();
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    live.current = null;
    history.current.push(strokes);
    setCanUndo(true);
    // a stroke that ends (or is cancelled) is still the owner's writing: it is kept
    onChange([...strokes, l.pts]);
  };

  const undo = () => {
    const prev = history.current.pop();
    setCanUndo(history.current.length > 0);
    if (prev) onChange(prev);
  };
  const clear = () => {
    if (strokes.length === 0) return;
    history.current.push(strokes);
    setCanUndo(true);
    onChange([]);
  };

  return (
    <div className="hw-pad">
      <div className="hw-pad__surface">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`${label}. اكتب بالقلم أو بإصبعك أو بالفأرة؛ ${strokes.length} ${strokes.length === 1 ? 'خط' : 'خطوط'} مكتوبة. يمكنك الكتابة بلوحة المفاتيح بدلًا منها.`}
          tabIndex={0}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          data-testid="ink-pad"
        />
      </div>
      <div className="hw-actions">
        <Button variant="plain" size="sm" icon={<Undo2 size={16} />} disabled={!canUndo || disabled} onClick={undo}>
          تراجع
        </Button>
        <Button variant="plain" size="sm" icon={<Eraser size={16} />} disabled={strokes.length === 0 || disabled} onClick={clear}>
          امسح اللوحة
        </Button>
      </div>
    </div>
  );
}
