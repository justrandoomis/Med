// Impact preview → explicit apply (§48): what a rule / priority / model change would do to stored generated
// content, shown BEFORE anything changes. Nothing is regenerated; applying needs a fresh preview token.
import { useEffect, useState } from 'react';
import type { ImpactChange, ImpactPreviewResponse } from '@medlevo/shared';
import { Button, ErrorState, LoadingState } from '../../design';
import { errorMessage, isApiError } from '../../lib/api';
import { settingsStore } from '../../lib/settings';
import { BidiText } from '../evidence/BidiText';
import { controlApi } from './api';

const SHOWN = 12;

function countSentence(p: ImpactPreviewResponse): string[] {
  const out: string[] = [];
  out.push(
    p.affected_count === 0
      ? 'لن يتأثر أي محتوى مخزّن: يبقى كل شيء كما هو ويُعاد استخدامه.'
      : `${p.affected_count === 1 ? 'محتوى مخزّن واحد' : `${p.affected_count} من المحتوى المخزّن`} لن ${p.affected_count === 1 ? 'يُعاد' : 'تُعاد'} استخدامه لطلب جديد مماثل. يبقى كما هو للقراءة ولا يُعاد توليده إلا إن طلبت ذلك.`,
  );
  if (p.unaffected_count) out.push(`${p.unaffected_count} لا يتأثر بهذا التغيير.`);
  if (p.not_comparable_count) out.push(`${p.not_comparable_count} صُنع بقواعد سابقة أو بخيارات خاصة بطلبه، فلا يُعاد استخدامه للطلبات الافتراضية أصلًا.`);
  return out;
}

export function ImpactReview({ change, onApplied, onCancel }: { change: ImpactChange; onApplied: (effects: string[]) => void; onCancel: () => void }) {
  const [preview, setPreview] = useState<ImpactPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const key = JSON.stringify(change);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    setStale(false);
    controlApi
      .preview(change)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const apply = async () => {
    if (!preview?.confirm_token) return;
    setApplying(true);
    setError(null);
    try {
      const r = await controlApi.apply(change, preview.confirm_token);
      // the app's own copy of the settings follows the server (nothing else is touched)
      if (change.kind === 'settings') void settingsStore.load();
      onApplied(r.effects_ar);
    } catch (e) {
      if (isApiError(e) && e.status === 409) setStale(true);
      setError(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="cc-impact" aria-label="أثر التغيير قبل تطبيقه" aria-busy={!preview && !error ? true : undefined}>
      <h3 className="cc-impact__title">أثر التغيير قبل تطبيقه</h3>
      {error && !preview ? (
        <ErrorState inline message={error} onRetry={() => setTick((t) => t + 1)} />
      ) : !preview ? (
        <LoadingState inline stage="جارٍ حساب الأثر دون تغيير أي شيء…" />
      ) : (
        <>
          <ul className="cc-bullets cc-impact__change">
            {preview.change_ar.map((c, i) => (
              <li key={i}>
                <BidiText as="span" dir="rtl" text={c} />
              </li>
            ))}
          </ul>
          {countSentence(preview).map((s, i) => (
            <p key={i} className={i === 0 ? 'cc-impact__lead' : 'cc-muted'}>
              {s}
            </p>
          ))}
          {preview.may_differ_count > 0 && <p className="cc-muted">{preview.may_differ_count} نطاقه يضم أنواع مصادر تغيّر ترتيبها؛ قد يختلف لو أعدت توليده بنفسك.</p>}
          {preview.affected.length > 0 && (
            <ul className="cc-impact__list" aria-label="المحتوى الذي لن يُعاد استخدامه">
              {(showAll ? preview.affected : preview.affected.slice(0, SHOWN)).map((a) => (
                <li key={a.id}>
                  <span className="cc-impact__kind">{a.kind_label_ar}</span>
                  <BidiText as="span" dir="rtl" className="cc-impact__name" text={a.title ?? 'بلا عنوان'} />
                  {a.source_title && <BidiText as="span" dir="rtl" className="cc-muted" text={a.source_title} />}
                  <BidiText as="span" dir="rtl" className="cc-impact__why" text={a.reason_ar} />
                </li>
              ))}
            </ul>
          )}
          {preview.affected.length > SHOWN && !showAll && (
            <Button size="sm" variant="plain" onClick={() => setShowAll(true)}>
              اعرض الكل ({preview.affected.length})
            </Button>
          )}
          <ul className="cc-bullets cc-muted">
            {preview.effects_ar.map((e, i) => (
              <li key={i}>
                <BidiText as="span" dir="rtl" text={e} />
              </li>
            ))}
          </ul>
          <p className="cc-impact__note">{preview.apply_note_ar}</p>
          {error && <ErrorState inline message={error} onRetry={stale ? () => setTick((t) => t + 1) : undefined} retryLabel="احسب الأثر من جديد" />}
          <div className="cc-impact__actions">
            {preview.can_apply && (
              <Button variant="primary" loading={applying} loadingLabel="جارٍ التطبيق…" onClick={() => void apply()} disabled={stale}>
                طبّق التغيير
              </Button>
            )}
            <Button variant="secondary" onClick={onCancel}>
              {preview.can_apply ? 'تراجع دون تطبيق' : 'إغلاق'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
