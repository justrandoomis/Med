// Image-occlusion mask editor (§43): draw, move and resize masks over the ORIGINAL picture — non-destructively (the
// image is never changed; masks are normalized boxes stored with the card). Pointer: drag on the picture draws a mask,
// drag a mask moves it 1:1 from where it was grabbed, drag a corner resizes. Keyboard alternative: «أضف منطقة» adds a
// centred mask; with a mask focused, arrows move it (Shift = bigger steps), Alt/Option + arrows resize, Delete removes,
// Enter jumps to its label. Every mask is numbered (identity by number + text, never colour alone).
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { newId, type NormBox } from '@medlevo/shared';
import { Button, IconButton, TextField, cx } from '../../../design';
import { applyKey, boxDescriptionAr, boxFromDrag, keyAction, moveBox, newCenteredBox, resizeBox, toImagePoint, type Handle } from '../local/occlusion';

export interface MaskDraft {
  id: string;
  box: NormBox;
  label: string;
}

export interface OcclusionEditorProps {
  imageUrl: string;
  masks: MaskDraft[];
  onChange: (masks: MaskDraft[]) => void;
  /** a single mask is editable (correcting an existing card's own mask); others are shown for context */
  onlyMaskId?: string | null;
  disabled?: boolean;
}

type Drag =
  | { kind: 'draw'; start: { x: number; y: number }; current: { x: number; y: number } }
  | { kind: 'move'; id: string; start: { x: number; y: number }; orig: NormBox }
  | { kind: 'resize'; id: string; handle: Handle; start: { x: number; y: number }; orig: NormBox };

const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];

export function OcclusionEditor({ imageUrl, masks, onChange, onlyMaskId = null, disabled }: OcclusionEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<string | null>(onlyMaskId ?? masks[0]?.id ?? null);
  const labelRefs = useRef(new Map<string, HTMLInputElement>());
  const maskRefs = useRef(new Map<string, HTMLDivElement>());
  const helpId = useId();
  const canDraw = !onlyMaskId && !disabled;
  const editable = (id: string) => !disabled && (!onlyMaskId || onlyMaskId === id);

  useEffect(() => {
    if (selected && !masks.some((m) => m.id === selected)) setSelected(masks[0]?.id ?? null);
  }, [masks, selected]);

  const rect = () => stageRef.current?.getBoundingClientRect() ?? { left: 0, top: 0, width: 1, height: 1 };
  const point = (e: PointerEvent) => toImagePoint(e.clientX, e.clientY, rect());
  const update = (id: string, box: NormBox) => onChange(masks.map((m) => (m.id === id ? { ...m, box } : m)));

  const onStageDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!canDraw || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-mask-id]')) return;
    e.preventDefault();
    stageRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    setDrag({ kind: 'draw', start: p, current: p });
  };
  const onMaskDown = (e: PointerEvent<HTMLDivElement>, m: MaskDraft, handle?: Handle) => {
    if (!editable(m.id) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stageRef.current?.setPointerCapture(e.pointerId);
    setSelected(m.id);
    maskRefs.current.get(m.id)?.focus({ preventScroll: true });
    const p = point(e);
    setDrag(handle ? { kind: 'resize', id: m.id, handle, start: p, orig: m.box } : { kind: 'move', id: m.id, start: p, orig: m.box });
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const p = point(e);
    if (drag.kind === 'draw') setDrag({ ...drag, current: p });
    else if (drag.kind === 'move') update(drag.id, moveBox(drag.orig, p.x - drag.start.x, p.y - drag.start.y));
    else update(drag.id, resizeBox(drag.orig, drag.handle, p.x - drag.start.x, p.y - drag.start.y));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (drag.kind === 'draw') {
      const box = boxFromDrag(drag.start, point(e));
      if (box) {
        const m = { id: newId(), box, label: '' };
        onChange([...masks, m]);
        setSelected(m.id);
        requestAnimationFrame(() => labelRefs.current.get(m.id)?.focus());
      }
    }
    setDrag(null);
  };

  const addMask = () => {
    const m = { id: newId(), box: newCenteredBox(masks.map((x) => x.box)), label: '' };
    onChange([...masks, m]);
    setSelected(m.id);
    requestAnimationFrame(() => maskRefs.current.get(m.id)?.focus());
  };
  const remove = (id: string) => {
    const i = masks.findIndex((m) => m.id === id);
    onChange(masks.filter((m) => m.id !== id));
    const next = masks[i + 1] ?? masks[i - 1];
    setSelected(next?.id ?? null);
  };

  const onMaskKey = (e: KeyboardEvent<HTMLDivElement>, m: MaskDraft) => {
    if (!editable(m.id)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !onlyMaskId) {
      e.preventDefault();
      remove(m.id);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      labelRefs.current.get(m.id)?.focus();
      return;
    }
    const a = keyAction(e.key, { shift: e.shiftKey, alt: e.altKey });
    if (a) {
      e.preventDefault();
      update(m.id, applyKey(m.box, a));
    }
  };

  const preview = drag?.kind === 'draw' ? boxFromDrag(drag.start, drag.current) : null;

  return (
    <div className="lw-occl-editor">
      <p id={helpId} className="lw-muted">
        {canDraw
          ? 'اسحب على الصورة لرسم منطقة تُخفى، واسحب المنطقة لتحريكها أو زاويتها لتغيير حجمها. بلوحة المفاتيح: «أضف منطقة»، ثم الأسهم للتحريك (مع Shift لخطوات أكبر)، وAlt مع الأسهم لتغيير الحجم، وDelete للحذف. الصورة الأصلية لا تتغير.'
          : 'صحّح منطقة هذه البطاقة: اسحبها أو استخدم الأسهم (Alt مع الأسهم لتغيير الحجم). المناطق الأخرى معروضة للسياق فقط.'}
      </p>
      <div
        ref={stageRef}
        className={cx('lw-occl-editor__stage', canDraw && 'lw-occl-editor__stage--draw')}
        onPointerDown={onStageDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      >
        <img src={imageUrl} alt="الصورة الأصلية التي تُرسم فوقها مناطق الإخفاء" draggable={false} className="lw-occl-editor__img" />
        {masks.map((m, i) => (
          <div
            key={m.id}
            ref={(el) => {
              if (el) maskRefs.current.set(m.id, el);
              else maskRefs.current.delete(m.id);
            }}
            data-mask-id={m.id}
            role="button"
            tabIndex={editable(m.id) ? 0 : -1}
            aria-describedby={helpId}
            aria-label={`المنطقة ${i + 1}${m.label ? `: ${m.label}` : ' (بلا اسم بعد)'} — ${boxDescriptionAr(m.box)}`}
            aria-pressed={selected === m.id}
            aria-disabled={!editable(m.id) || undefined}
            className={cx('lw-occl-editor__mask', selected === m.id && 'lw-occl-editor__mask--selected', !editable(m.id) && 'lw-occl-editor__mask--context')}
            style={{ left: `${m.box.x * 100}%`, top: `${m.box.y * 100}%`, width: `${m.box.w * 100}%`, height: `${m.box.h * 100}%` }}
            onPointerDown={(e) => onMaskDown(e, m)}
            onFocus={() => setSelected(m.id)}
            onKeyDown={(e) => onMaskKey(e, m)}
          >
            <span className="lw-occl-editor__num" aria-hidden="true">
              {i + 1}
            </span>
            {selected === m.id &&
              editable(m.id) &&
              HANDLES.map((h) => <span key={h} aria-hidden="true" className={`lw-occl-editor__handle lw-occl-editor__handle--${h}`} onPointerDown={(e) => onMaskDown(e as unknown as PointerEvent<HTMLDivElement>, m, h)} />)}
          </div>
        ))}
        {preview && <div aria-hidden="true" className="lw-occl-editor__mask lw-occl-editor__mask--preview" style={{ left: `${preview.x * 100}%`, top: `${preview.y * 100}%`, width: `${preview.w * 100}%`, height: `${preview.h * 100}%` }} />}
      </div>

      {canDraw && (
        <Button variant="secondary" size="sm" icon={<Plus size={16} />} onClick={addMask}>
          أضف منطقة
        </Button>
      )}

      {masks.length > 0 && (
        <ol className="lw-occl-editor__list" aria-label="المناطق وأسماؤها">
          {masks.map((m, i) =>
            editable(m.id) ? (
              <li key={m.id} className={cx('lw-occl-editor__row', selected === m.id && 'lw-occl-editor__row--selected')}>
                <span className="lw-occl-editor__rownum" aria-hidden="true">
                  {i + 1}
                </span>
                <TextField
                  ref={(el: HTMLInputElement | null) => {
                    if (el) labelRefs.current.set(m.id, el);
                    else labelRefs.current.delete(m.id);
                  }}
                  label={`اسم المنطقة ${i + 1} (الجواب)`}
                  value={m.label}
                  maxLength={300}
                  required
                  onFocus={() => setSelected(m.id)}
                  onChange={(e) => onChange(masks.map((x) => (x.id === m.id ? { ...x, label: e.target.value } : x)))}
                  hint={boxDescriptionAr(m.box)}
                  fieldClassName="lw-occl-editor__label"
                />
                {!onlyMaskId && <IconButton label={`احذف المنطقة ${i + 1}`} icon={<Trash2 size={16} />} onClick={() => remove(m.id)} />}
              </li>
            ) : null,
          )}
        </ol>
      )}
    </div>
  );
}
