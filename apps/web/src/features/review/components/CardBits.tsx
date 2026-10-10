// Small card pieces shared by the review session, the card library and the editor: the schedule state in words
// (Arabic + the English term, never colour alone), the card's citations (online: the evidence chip with its peek;
// offline / vanished: the quote saved with the card, said as such), and the occlusion picture.
import { useEffect, useState } from 'react';
import { CloudOff, FileWarning, Quote } from 'lucide-react';
import { CARD_STATE_LABELS_AR, type CardEvidenceSnapshot, type CardState, type EvidenceView, type NormBox } from '@medlevo/shared';
import { StatusPill, Term, cx } from '../../../design';
import { getDb } from '../../../lib/localdb';
import { useOnline } from '../../../lib/useOnline';
import { BidiText, CitationChip, evidenceApi } from '../../evidence';
import { learningApi } from '../api';
import { storeCardImage, storedCardImage, type LocalCardRow } from '../local/store';

const STATE_TERMS: Record<CardState, string> = { new: 'New', learning: 'Learning', review: 'Review', relearning: 'Relearning' };

export function StateLabel({ state, mastered }: { state: CardState; mastered?: boolean }) {
  return (
    <span className="lw-state" data-state={state}>
      <StatusPill tone={state === 'relearning' ? 'warning' : state === 'new' ? 'info' : 'neutral'} icon={false}>
        {CARD_STATE_LABELS_AR[state]} <Term>{STATE_TERMS[state]}</Term>
      </StatusPill>
      {mastered && (
        <span className="lw-state__mastered" title="تقدير من سجل مراجعاتك: الاستقرار 21 يومًا أو أكثر. تعود البطاقة للمراجعة دائمًا.">
          متقنة تقديريًا — تعود للمراجعة
        </span>
      )}
    </span>
  );
}

// ───────── citations ─────────
const evidenceCache = new Map<string, EvidenceView | null>();

/** Full evidence views for chips (online), cached for the app session; missing ids map to null. */
function useEvidenceViews(ids: string[]): Map<string, EvidenceView | null> {
  const online = useOnline();
  const key = ids.join(',');
  const [, force] = useState(0);
  useEffect(() => {
    const want = ids.filter((id) => !evidenceCache.has(id));
    if (!online || want.length === 0) return;
    let cancelled = false;
    void evidenceApi
      .fetchEvidenceBatch(want)
      .then((r) => {
        for (const ev of r.evidence) evidenceCache.set(ev.id, ev);
        for (const m of r.missing) evidenceCache.set(m, null);
        if (!cancelled) force((n) => n + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online]);
  return new Map(ids.filter((id) => evidenceCache.has(id)).map((id) => [id, evidenceCache.get(id) ?? null]));
}

/** The card's citations: a real chip when the evidence can be shown now, else the saved quote with the reason. */
export function CardEvidenceList({ snapshots, compact, hasSource }: { snapshots: CardEvidenceSnapshot[]; compact?: boolean; hasSource?: boolean }) {
  const online = useOnline();
  const views = useEvidenceViews(snapshots.map((s) => s.evidence_id));
  if (snapshots.length === 0)
    return compact ? null : <p className="lw-muted">{hasSource ? 'مرتبطة بمصدرها دون اقتباس نصي محدد.' : 'لا دليل مرتبطًا بهذه البطاقة: كتبتها بنفسك دون ربطها بموضع في مصدر.'}</p>;
  return (
    <ul className={cx('lw-evidence', compact && 'lw-evidence--compact')} aria-label="مصادر البطاقة">
      {snapshots.map((s) => {
        const ev = views.get(s.evidence_id);
        if (ev) {
          return (
            <li key={s.evidence_id} className="lw-evidence__item">
              <CitationChip evidence={ev} />
              {!compact && <BidiText as="span" className="lw-evidence__title" text={s.source_title} />}
            </li>
          );
        }
        const reason = !s.available || ev === null ? 'هذا الدليل لم يعد متاحًا في المصدر؛ يظهر النص كما حُفظ عند إنشاء البطاقة.' : online ? 'جارٍ تحميل الدليل…' : 'فتح المصدر يحتاج اتصالًا أو تنزيل المحاضرة على هذا الجهاز؛ هذا النص محفوظ مع البطاقة.';
        return (
          <li key={s.evidence_id} className="lw-evidence__item lw-evidence__item--saved">
            <span className="lw-evidence__saved">
              {!s.available || ev === null ? <FileWarning size={14} aria-hidden="true" /> : online ? <Quote size={14} aria-hidden="true" /> : <CloudOff size={14} aria-hidden="true" />}
              <BidiText as="span" text={`${s.source_title} — ${s.locator_label_ar}`} />
            </span>
            {!compact && <BidiText as="blockquote" className="lw-evidence__quote" text={s.quote} />}
            <span className="lw-muted">{reason}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ───────── occlusion picture ─────────
export interface CardImageState {
  url: string | null;
  loading: boolean;
  reason_ar: string | null;
}

/**
 * The picture of an occlusion card: this device's saved copy first (works offline), otherwise fetched once through
 * the card's short-lived media link (served without a file name) and saved explicitly in IndexedDB.
 */
export function useCardImage(card: Pick<LocalCardRow, 'id' | 'kind' | 'image' | 'sourceId'> | null): CardImageState {
  const online = useOnline();
  const assetId = card?.kind === 'image_occlusion' ? (card.image?.image_asset_id ?? null) : null;
  const [st, setSt] = useState<CardImageState>({ url: null, loading: !!assetId, reason_ar: null });
  useEffect(() => {
    if (!card || !assetId) {
      setSt({ url: null, loading: false, reason_ar: null });
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    const db = getDb();
    setSt({ url: null, loading: true, reason_ar: null });
    void (async () => {
      let blob = await storedCardImage(db, assetId).catch(() => null);
      if (!blob && online) {
        try {
          const payload = await learningApi.reviewPayload(card.id);
          if (payload.image) {
            const res = await fetch(payload.image.url, { credentials: 'same-origin' });
            if (res.ok) {
              blob = await res.blob();
              await storeCardImage(db, assetId, blob, card.sourceId ?? null).catch(() => undefined);
            }
          }
        } catch {
          blob = null;
        }
      }
      if (cancelled) return;
      if (blob) {
        url = URL.createObjectURL(blob);
        setSt({ url, loading: false, reason_ar: null });
      } else {
        setSt({ url: null, loading: false, reason_ar: online ? 'تعذّر تحميل صورة البطاقة؛ ربما لم تعد الصورة متاحة في المصدر.' : 'صورة هذه البطاقة غير محفوظة على هذا الجهاز بعد؛ افتحها مرة مع اتصال لتُحفظ.' });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, assetId, online]);
  return st;
}

export interface OcclusionViewProps {
  url: string;
  masks: Array<{ id: string; box: NormBox }>;
  activeId: string | null | undefined;
  side: 'front' | 'back';
}

/**
 * The picture with its masks (non-destructive overlay in normalized coordinates). Front: every mask covered, the asked
 * one marked with a pattern + «؟» (not colour alone). Back: the asked one revealed with an outline. Neutral alt text —
 * nothing in the DOM names the hidden part.
 */
export function OcclusionView({ url, masks, activeId, side }: OcclusionViewProps) {
  const index = masks.findIndex((m) => m.id === activeId);
  return (
    <figure className="lw-occl">
      <div className="lw-occl__frame">
        <img className="lw-occl__img" src={url} alt="صورة البطاقة؛ المنطقة المطلوب تسميتها محددة بإطار مميز." draggable={false} />
        {masks.map((m) => {
          const active = m.id === activeId;
          const revealed = active && side === 'back';
          return (
            <span
              key={m.id}
              aria-hidden="true"
              className={cx('lw-occl__mask', active && 'lw-occl__mask--active', revealed && 'lw-occl__mask--revealed')}
              style={{ left: `${m.box.x * 100}%`, top: `${m.box.y * 100}%`, width: `${m.box.w * 100}%`, height: `${m.box.h * 100}%` }}
            >
              {active && !revealed && <span className="lw-occl__q">؟</span>}
            </span>
          );
        })}
      </div>
      <figcaption className="lw-muted">
        {index >= 0
          ? side === 'front'
            ? `المطلوب: المنطقة ${index + 1} من ${masks.length} (المحاطة بإطار وعلامة «؟»).`
            : `كُشفت المنطقة ${index + 1} من ${masks.length}؛ الجواب أدناه.`
          : 'لم تُحدَّد المنطقة المطلوبة في هذه البطاقة.'}
      </figcaption>
    </figure>
  );
}
