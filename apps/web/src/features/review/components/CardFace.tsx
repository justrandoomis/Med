// One side of a card as the owner studies it (rendered on the device, works offline): basic / mistake text, cloze with
// only the asked index hidden, image occlusion with the masks. Mixed Arabic/English goes through RichTextView.
import { CircleAlert, ImageOff } from 'lucide-react';
import { RichTextView, Skeleton } from '../../../design';
import { facesOf } from '../local/render';
import type { LocalCardRow } from '../local/store';
import { OcclusionView, useCardImage } from './CardBits';

export function CardFace({ card, side }: { card: LocalCardRow; side: 'front' | 'back' }) {
  const faces = facesOf(card);
  const img = useCardImage(card.kind === 'image_occlusion' ? card : null);
  const text = side === 'front' ? faces.front : faces.back;
  return (
    <div className="lw-face" data-side={side} data-kind={card.kind}>
      {card.kind === 'image_occlusion' && (
        <div className="lw-face__image">
          {img.url ? (
            <OcclusionView url={img.url} masks={card.image?.masks ?? []} activeId={card.image?.active_mask_id ?? (card.image?.masks.length === 1 ? card.image.masks[0]!.id : null)} side={side} />
          ) : img.loading ? (
            <Skeleton height="12rem" radius="var(--ml-radius-md)" />
          ) : (
            <p className="lw-note lw-note--warn" role="note">
              <ImageOff size={16} aria-hidden="true" />
              <span>{img.reason_ar}</span>
            </p>
          )}
        </div>
      )}
      {text.paragraphs.length > 0 ? (
        <RichTextView value={text} className={side === 'front' ? 'lw-face__text lw-face__text--front' : 'lw-face__text'} />
      ) : side === 'back' && card.kind === 'cloze' ? null : (
        <p className="lw-muted">{side === 'front' ? 'الوجه فارغ.' : 'لا يوجد نص على ظهر البطاقة.'}</p>
      )}
      {faces.clozeProblem && side === 'front' && (
        <p className="lw-note lw-note--warn" role="note">
          <CircleAlert size={16} aria-hidden="true" />
          <span>
            لم يُعرف أي فراغ تسأل عنه هذه البطاقة؛ عدّلها وحدّد الفراغ بالصيغة <bdi dir="ltr">{'{{c1::الجواب}}'}</bdi>.
          </span>
        </p>
      )}
    </div>
  );
}
