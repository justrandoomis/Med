// /weakness — Weakness Center (§44, AC-27): where the owner keeps getting things wrong, WHY each weakness is listed
// (reasons in words), its transparent score with the formula (an estimate), and what to do next. Then the Mistake
// Genome and the Forgetting Forecast. Read-only offline from the last saved answer.
import { useState } from 'react';
import { Button } from '../../design';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { ForgettingForecastView, MistakeGenomeView, WeaknessListResponse } from '@medlevo/shared';
import { EmptyState, ErrorState, LoadingState, SegmentedControl } from '../../design';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useQuery } from '../library/data';
import { LEARNING_PATHS } from '../review/api';
import { weaknessUrl } from '../review/links';
import { ActionButton, ForecastSection, GenomeSection, WEAKNESS_KIND_AR, WeaknessStatus } from './parts';
import '../review/learning.css';
import './weakness.css';

type Filter = 'open' | 'resolved' | 'dismissed' | 'all';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'open', label: 'تحتاج انتباهك' },
  { value: 'resolved', label: 'تجاوزتها' },
  { value: 'dismissed', label: 'استبعدتها' },
  { value: 'all', label: 'الكل' },
];

export function WeaknessCenter() {
  usePageTitle('نقاط الضعف');
  const [filter, setFilter] = useState<Filter>('open');
  const [all, setAll] = useState(false);
  const list = useQuery<WeaknessListResponse>(LEARNING_PATHS.weakness(filter), { cache: true });
  const genome = useQuery<MistakeGenomeView>(LEARNING_PATHS.genome, { cache: true });
  const forecast = useQuery<ForgettingForecastView>(LEARNING_PATHS.forecast, { cache: true });
  const items = list.data?.items ?? [];

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">نقاط الضعف</h1>
        <p className="ml-page__lede">أين تخطئ ولماذا، وما الذي يستحق المراجعة الآن. الإجابة الصحيحة بالتخمين أو بعد تلميح لا تُحسب كإتقان.</p>
        <Link className="lw-link" to="/knowledge">
          خريطة معرفتي: كل مفهوم بحالته ومتطلباته السابقة
        </Link>
      </header>
      {(list.fromCache || genome.fromCache) && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}

      <div className="lw-stack">
        <section aria-labelledby="lw-wk-h">
          <div className="lw-head lw-wk-head">
            <h2 id="lw-wk-h" className="lw-sheet__title">
              ما يحتاج انتباهك
            </h2>
            <SegmentedControl<Filter>
              label="عرض"
              options={FILTERS}
              value={filter}
              onValueChange={(v) => {
                setFilter(v);
                setAll(false);
              }}
              size="sm"
            />
          </div>
          {list.error && !list.data && <ErrorState message={list.error.message} onRetry={() => void list.refresh()} />}
          {!list.data && !list.error && <LoadingState stage="جارٍ جمع إشارات أخطائك…" />}
          {list.data && items.length === 0 && (
            <EmptyState
              headingLevel={3}
              title={filter === 'open' ? 'لا نقاط ضعف نشطة الآن' : 'لا شيء هنا'}
              description={filter === 'open' ? 'تظهر هنا المفاهيم والمحاضرات التي تتكرر أخطاؤك فيها، مع سبب كل منها. أجب عن أسئلة وراجع بطاقات ليتكوّن سجلك.' : undefined}
            />
          )}
          {items.length > 0 && (
            <ul className="lw-wk-list">
              {(all ? items : items.slice(0, 5)).map((w) => (
                <li key={w.id} className="lw-wk">
                  <div className="lw-wk__head">
                    <Link to={weaknessUrl(w.id)} className="lw-wk__title">
                      <BidiText as="span" text={w.label} />
                      <ChevronLeft size={18} aria-hidden="true" />
                    </Link>
                    <span className="lw-muted">{WEAKNESS_KIND_AR[w.kind] ?? w.kind}</span>
                    <WeaknessStatus status={w.status} />
                  </div>
                  {w.reasons_ar[0] && <p className="lw-wk__reason">{w.reasons_ar[0]}</p>}
                  <p className="lw-muted">
                    {`مؤشر الضعف (تقدير): ${w.score.toFixed(2)}`}
                    {w.reasons_ar.length > 1 && ` · ${w.reasons_ar.length - 1 === 1 ? 'سبب آخر' : w.reasons_ar.length - 1 === 2 ? 'سببان آخران' : `${w.reasons_ar.length - 1} أسباب أخرى`} وطريقة الحساب في التفاصيل`}
                  </p>
                  {w.suggested_actions.length > 0 && (
                    <div className="ml-cluster lw-wk__actions">
                      {w.suggested_actions.slice(0, 2).map((a, i) => (
                        <ActionButton key={`${a.kind}-${i}`} action={a} back="/weakness" />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {items.length > 5 && (
            <Button variant="plain" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? 'اعرض الأبرز فقط' : `اعرض كل نقاط الضعف (${items.length})`}
            </Button>
          )}
          {list.data?.sources_note_ar.length ? (
            <ul className="lw-basis lw-wk-sources" aria-label="ما يغذّي مركز الضعف">
              {list.data.sources_note_ar.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : null}
        </section>

        <div className="lw-two lw-two--flush">
          {genome.data ? <GenomeSection genome={genome.data} onChanged={() => void genome.refresh()} /> : genome.error ? <ErrorState inline message={genome.error.message} onRetry={() => void genome.refresh()} /> : <LoadingState stage="جارٍ تحميل أنماط الأخطاء…" />}
          {forecast.data ? <ForecastSection forecast={forecast.data} /> : forecast.error ? <ErrorState inline message={forecast.error.message} onRetry={() => void forecast.refresh()} /> : <LoadingState stage="جارٍ حساب التقدير…" />}
        </div>
      </div>
    </div>
  );
}
