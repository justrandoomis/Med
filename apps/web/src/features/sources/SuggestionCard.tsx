// One import suggestion (lecture number, date, title, subject, «إصدار جديد من …») with its reasons and the stated
// effect of accepting — nothing is applied until the owner taps «أكّد» (PRD AOS-3.18). Used on the source screen, after
// an upload and in the review list.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, GitCompare, X } from 'lucide-react';
import type { DecideSuggestionResponse, ImportSuggestionView } from '@medlevo/shared';
import { Button, buttonClass, StatusPill, useToast } from '../../design';
import { api, errorMessage } from '../../lib/api';
import { invalidate } from '../library/data';
import { compareHref, suggestionStatusAr, suggestionStatusTone, suggestionTitleAr, suggestionValueAr } from './versionsModel';

export interface SuggestionCardProps {
  suggestion: ImportSuggestionView;
  /** show the source title (lists across sources) */
  showSource?: boolean;
  readOnly?: boolean;
  /** already on the compare screen of this proposal */
  hideCompareLink?: boolean;
  onDecided?: (r: DecideSuggestionResponse) => void;
}

export function SuggestionCard({ suggestion: s, showSource = false, readOnly = false, hideCompareLink = false, onDecided }: SuggestionCardProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decidable = !readOnly && (s.status === 'open' || s.status === 'applied');
  const decide = async (action: 'accept' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const r = await api.post<DecideSuggestionResponse>(`/versions/suggestions/${encodeURIComponent(s.id)}/decide`, { action });
      toast.show({ title: r.result_ar, tone: 'success' });
      invalidate('/versions');
      invalidate('/sources');
      invalidate('/library');
      onDecided?.(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const titleId = `sugg-${s.id}`;
  const v = s.value;
  return (
    <li className="ml-upload__item ml-sugg" aria-labelledby={titleId}>
      <div className="ml-upload__head">
        <span className="ml-row__text">
          <span className="ml-sugg__title" id={titleId}>
            {suggestionTitleAr(s)}
          </span>
          {showSource && (
            <span className="ml-row__sub">
              الملف: <Link to={`/sources/${encodeURIComponent(s.source_id)}`}><bdi>{s.source_title}</bdi></Link>
            </span>
          )}
          <span className="ml-sugg__value">
            <bdi>{suggestionValueAr(s)}</bdi>
          </span>
        </span>
        <StatusPill tone={suggestionStatusTone(s)}>{suggestionStatusAr(s)}</StatusPill>
      </div>
      {s.reasons_ar.length > 0 && (
        <ul className="ml-sugg__reasons" aria-label="سبب الاقتراح">
          {s.reasons_ar.map((r, i) => (
            <li key={i}>
              <bdi>{r}</bdi>
            </li>
          ))}
        </ul>
      )}
      {decidable && (
        <p className="ml-field__hint">
          {s.status !== 'applied'
            ? `إن أكّدت: ${s.effect_ar}`
            : s.certainty === 'certain'
              ? 'حُفظ هذا تلقائيًا لأنه واضح في الملف. أكّده، أو أزله إن كان خطأ.'
              : 'حُفظ هذا من تحليل سابق، والتحليل الأخير غير متأكد منه. أكّده، أو أزله إن كان خطأ.'}
        </p>
      )}
      {decidable && (
        <div className="ml-upload__row-actions">
          {v.field === 'new_version_of' && s.version_id && !hideCompareLink && (
            <Link to={compareHref(v.source_id, v.version_id, s.version_id)} className={buttonClass({ size: 'sm', variant: 'secondary' })}>
              <GitCompare size={16} aria-hidden="true" />
              قارن الصفحات قبل التأكيد
            </Link>
          )}
          <Button size="sm" variant="primary" icon={<Check size={16} />} onClick={() => void decide('accept')} loading={busy === 'accept'} loadingLabel="جارٍ الحفظ…" disabled={!!busy}>
            {s.status === 'applied' ? 'صحيح' : v.field === 'new_version_of' ? 'نعم، أضفه كإصدار جديد' : 'أكّد'}
          </Button>
          <Button size="sm" variant="plain" icon={<X size={16} />} onClick={() => void decide('reject')} loading={busy === 'reject'} loadingLabel="جارٍ الحفظ…" disabled={!!busy}>
            {s.status === 'applied' ? 'ليس صحيحًا' : v.field === 'new_version_of' ? 'ليس إصدارًا جديدًا' : 'ارفض'}
          </Button>
        </div>
      )}
      {error && (
        <p className="ml-field__error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
