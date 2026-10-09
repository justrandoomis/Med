// Evidence Ribbon (§11): which sources the current part uses, as COVERAGE counts («3 جمل مرتبطة»). Never a
// correctness score, never a percentage.
import { useEffect, useState } from 'react';
import type { EvidenceRibbonItem } from '@medlevo/shared';
import { isApiError } from '../../lib/api';
import { BidiText } from './BidiText';
import { fetchRibbon } from './api';
import { linkedSentencesAr, sourceTypeLabel } from './model';

export const RIBBON_NOTE_AR = 'عدد الجمل المرتبطة بدليل من كل مصدر — تغطية وليست مقياسًا للصحة الطبية.';

export interface EvidenceRibbonProps {
  /** precomputed items (e.g. ribbonFromClaims(artifact.claims)) … */
  items?: EvidenceRibbonItem[];
  /** … or fetched from the server for an owner (artifact, content_block, message, …) */
  owner?: { type: string; id: string };
  className?: string;
}

export function EvidenceRibbon({ items: given, owner, className }: EvidenceRibbonProps) {
  const [fetched, setFetched] = useState<EvidenceRibbonItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (given || !owner) return;
    let alive = true;
    fetchRibbon(owner.type, owner.id)
      .then((r) => alive && setFetched(r.items))
      .catch((e) => alive && setError(isApiError(e) && e.offline ? 'شريط الأدلة يحتاج الاتصال بالخادم.' : 'تعذّر تحميل شريط الأدلة.'));
    return () => {
      alive = false;
    };
  }, [given, owner?.type, owner?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = given ?? fetched;
  if (error) return <p className="ev-note">{error}</p>;
  if (!items) return null;
  return (
    <section className={['ev-ribbon', className].filter(Boolean).join(' ')} aria-label="المصادر المستخدمة هنا">
      {items.length === 0 ? (
        <p className="ev-ribbon__empty">لا توجد جمل مرتبطة بدليل هنا بعد.</p>
      ) : (
        <ul className="ev-ribbon__list">
          {items.map((it) => (
            <li key={it.source_id} className="ev-ribbon__item">
              <span className="ev-ribbon__type">{sourceTypeLabel(it.source_type)}</span>
              <BidiText as="span" className="ev-ribbon__title" text={it.source_title} />
              <span className="ev-ribbon__count">{linkedSentencesAr(it.supported_claims)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="ev-ribbon__note">{RIBBON_NOTE_AR}</p>
    </section>
  );
}
