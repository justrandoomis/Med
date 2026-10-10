// Weakness Center pieces (§44, AC-27): status in words + icon (never colour alone), suggested actions with their
// reasons (AI-gated ones say why), the Mistake Genome (accessible bar list + table, editable types, estimate label)
// and the Forgetting Forecast (an ESTIMATE from the review log — never a measurement of memory).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, CircleCheck, CircleDot, CircleOff, Layers, Sparkles, TrendingUp, FileQuestion, Brain } from 'lucide-react';
import { MISTAKE_TYPES, MISTAKE_TYPE_LABELS_AR, type ForgettingForecastView, type MistakeGenomeView, type MistakeType, type WeaknessView } from '@medlevo/shared';
import { Button, Select, StatusPill, buttonClass, useToast, type StatusTone } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { formatDate } from '../../lib/time';
import { BidiText } from '../evidence';
import { learningApi } from '../review/api';
import { BarList } from '../review/components/BarList';
import { cardsAr } from '../review/local/time';
import { replayUrl, sessionUrl, studyUrl } from '../review/links';
import { startPracticeSet } from '../review/practice';

export const WEAKNESS_STATUS: Record<WeaknessView['status'], { label: string; tone: StatusTone; icon: React.ReactNode }> = {
  active: { label: 'نشطة', tone: 'warning', icon: <CircleDot size={14} /> },
  improving: { label: 'تتحسن', tone: 'info', icon: <TrendingUp size={14} /> },
  resolved: { label: 'تجاوزتها', tone: 'success', icon: <CircleCheck size={14} /> },
  dismissed: { label: 'استبعدتها', tone: 'neutral', icon: <CircleOff size={14} /> },
};

export const WEAKNESS_KIND_AR: Record<string, string> = { concept: 'مفهوم', lecture: 'محاضرة', topic: 'موضوع', question: 'سؤال تكرر خطؤك فيه' };

export function WeaknessStatus({ status }: { status: WeaknessView['status'] }) {
  const s = WEAKNESS_STATUS[status];
  return (
    <StatusPill tone={s.tone} icon={s.icon}>
      {s.label}
    </StatusPill>
  );
}

/** One suggested action as a real control (or its reason when it cannot run now). */
export function ActionButton({ action, back }: { action: WeaknessView['suggested_actions'][number]; back: string }) {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ref = action.ref as Record<string, unknown>;
  const label = <BidiText as="span" text={action.label_ar} />;
  if (action.kind === 'review_pages' && typeof ref.source_id === 'string') {
    const pageIds = (ref.page_ids as string[] | undefined) ?? [];
    return (
      <Link className={buttonClass({ variant: 'secondary', size: 'sm' })} to={studyUrl(ref.source_id, { pageId: pageIds[0] ?? null })}>
        <BookOpen size={16} aria-hidden="true" />
        {label}
      </Link>
    );
  }
  if (action.kind === 'flashcards' && Array.isArray(ref.card_ids)) {
    return (
      <Link className={buttonClass({ variant: 'secondary', size: 'sm' })} to={sessionUrl({ cards: ref.card_ids as string[], back })}>
        <Layers size={16} aria-hidden="true" />
        {label}
      </Link>
    );
  }
  if (action.kind === 'flashcards' && Array.isArray(ref.create_from_attempt_ids)) {
    const first = (ref.create_from_attempt_ids as string[])[0];
    return first ? (
      <Link className={buttonClass({ variant: 'secondary', size: 'sm' })} to={`/review/cards/new?from=mistake&attempt=${encodeURIComponent(first)}&back=${encodeURIComponent(back)}`}>
        <Layers size={16} aria-hidden="true" />
        {label}
      </Link>
    ) : null;
  }
  if (action.kind === 'practice_questions' && Array.isArray(ref.question_ids)) {
    const ids = ref.question_ids as string[];
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<FileQuestion size={16} />}
        loading={busy}
        disabled={!caps.online}
        title={!caps.online ? 'يحتاج اتصالًا' : undefined}
        onClick={async () => {
          setBusy(true);
          try {
            navigate(await startPracticeSet(ids, 'إعادة أسئلة أخطأت فيها'));
          } catch (e) {
            toast.show({ title: errorMessage(e, 'تعذّر بدء التدريب.'), tone: 'danger' });
          } finally {
            setBusy(false);
          }
        }}
      >
        {label}
      </Button>
    );
  }
  if (action.kind === 'simplified_explanation') {
    const available = ref.available === true && caps.feature('ai.explain').available;
    const pageIds = (ref.page_ids as string[] | undefined) ?? [];
    if (!available || typeof ref.source_id !== 'string') {
      return (
        <p className="lw-muted">
          <Sparkles size={14} aria-hidden="true" /> {action.label_ar}
          {!caps.online ? ' (يحتاج اتصالًا)' : ''}
        </p>
      );
    }
    return (
      <Link className={buttonClass({ variant: 'secondary', size: 'sm' })} to={studyUrl(ref.source_id, { pageId: pageIds[0] ?? null })} title="افتح الصفحة ثم اختر «بسّط» من الشرح؛ الشرح مولد من المحاضرة ومتحقق من أدلته.">
        <Sparkles size={16} aria-hidden="true" />
        {label}
      </Link>
    );
  }
  return null;
}

// ───────── Mistake Genome ─────────
export function GenomeSection({ genome, onChanged }: { genome: MistakeGenomeView; onChanged: () => void }) {
  const caps = useCapabilities();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const data = genome.distribution
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((d) => ({ key: d.type, label: d.label_ar, labelText: d.label_ar, value: d.count, denominator: genome.denominator, note: `صنّفتها بنفسك ${d.by_owner}، تلقائيًا ${d.by_auto}` }));
  return (
    <section className="lw-sheet" aria-labelledby="lw-genome-h">
      <h2 id="lw-genome-h" className="lw-sheet__title">
        <Brain size={20} aria-hidden="true" /> أنماط أخطائك <bdi dir="ltr" lang="en" className="lw-term">Mistake Genome</bdi>
      </h2>
      <p className="lw-note" role="note">
        <span>{genome.estimate_note_ar}</span>
      </p>
      <BarList
        caption={`أنواع الأخطاء في الإجابات الخاطئة المحسوبة (${genome.denominator})`}
        description={<p className="lw-muted">{genome.unclassified ? `${genome.unclassified} منها بلا تصنيف بعد.` : 'كل الإجابات الخاطئة مصنّفة.'}</p>}
        valueHeader="عدد الأخطاء"
        data={data}
        emptyText="لا أخطاء مصنّفة بعد."
      />
      {genome.recent.length > 0 && (
        <>
          <h3 className="lw-sheet__subtitle">آخر الأخطاء — صحّح التصنيف إن لم يناسبك</h3>
          <ul className="lw-genome-recent">
            {(more ? genome.recent : genome.recent.slice(0, 4)).map((r) => (
              <li key={r.attempt_id} className="lw-genome-recent__item">
                <BidiText as="p" className="lw-genome-recent__stem" text={r.stem_preview} />
                <p className="lw-muted">
                  {formatDate(r.answered_at)}
                  {r.auto_mistake_type && ` — الاقتراح الآلي: ${MISTAKE_TYPE_LABELS_AR[r.auto_mistake_type]}`}
                  {r.auto_reason_ar && ` (${r.auto_reason_ar})`}
                  {r.mistake_origin === 'owner' ? ' — صنّفته بنفسك.' : ''}
                </p>
                <div className="lw-genome-recent__row">
                  <Select<MistakeType | ''>
                    label="نوع الخطأ"
                    options={[{ value: '', label: 'بلا تصنيف' }, ...MISTAKE_TYPES.map((t) => ({ value: t, label: MISTAKE_TYPE_LABELS_AR[t] }))]}
                    value={r.mistake_type ?? ''}
                    disabled={!caps.online || saving === r.attempt_id}
                    onValueChange={async (v) => {
                      setSaving(r.attempt_id);
                      try {
                        await learningApi.setMistakeType(r.attempt_id, v || null);
                        toast.show({ title: 'حُفظ تصنيفك. الإجابة نفسها لم تتغير.', tone: 'success' });
                        onChanged();
                      } catch (e) {
                        toast.show({ title: errorMessage(e, 'تعذّر حفظ التصنيف.'), tone: 'danger' });
                      } finally {
                        setSaving(null);
                      }
                    }}
                  />
                  <Link className="lw-link" to={replayUrl(r.question_id, r.attempt_id)}>
                    لماذا ترجح إجابة على أخرى؟
                  </Link>
                </div>
              </li>
            ))}
          </ul>
          {genome.recent.length > 4 && (
            <Button variant="plain" size="sm" onClick={() => setMore((v) => !v)} aria-expanded={more}>
              {more ? 'أقل' : `اعرض كل الأخطاء الأخيرة (${genome.recent.length})`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

// ───────── Forgetting Forecast ─────────
const inDays = (d: number) => (d === 0 ? 'الآن' : d === 1 ? 'بعد يوم' : d === 2 ? 'بعد يومين' : d <= 10 ? `بعد ${d} أيام` : `بعد ${d} يومًا`);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}٪`);

export function ForecastSection({ forecast }: { forecast: ForgettingForecastView }) {
  const total = forecast.overall[0]?.cards ?? 0;
  return (
    <section className="lw-sheet" aria-labelledby="lw-forecast-h">
      <h2 id="lw-forecast-h" className="lw-sheet__title">
        توقّع النسيان <bdi dir="ltr" lang="en" className="lw-term">Forgetting Forecast</bdi> <StatusPill tone="info">تقدير</StatusPill>
      </h2>
      <p className="lw-note" role="note">
        <span>{forecast.estimate_note_ar}</span>
      </p>
      {total === 0 ? (
        <p className="lw-muted">لا توجد بطاقات راجعتها بعد، فلا يوجد ما يُبنى عليه تقدير.</p>
      ) : (
        <>
          <BarList
            caption={`بطاقات يُقدَّر أن احتمال تذكّرها دون هدفك (${pct(forecast.desired_retention)}) إن لم تُراجَع`}
            description={<p className="lw-muted">{`من ${cardsAr(total)} راجعتها من قبل. متوسط احتمال التذكّر المقدَّر: ${forecast.overall.map((o) => `${inDays(o.days)} ${pct(o.avg_recall)}`).join('، ')}.`}</p>}
            valueHeader="بطاقات دون الهدف"
            data={forecast.overall.map((o) => ({ key: String(o.days), label: inDays(o.days), labelText: inDays(o.days), value: o.below_desired, denominator: o.cards, note: `المتوسط المقدَّر ${pct(o.avg_recall)}` }))}
          />
          {forecast.by_source.length > 1 && (
            <div className="lw-table-wrap">
              <table className="lw-table">
                <caption className="lw-table__caption">حسب المصدر (الأضعف أولًا) — تقدير</caption>
                <thead>
                  <tr>
                    <th scope="col">المصدر</th>
                    <th scope="col">بطاقات</th>
                    <th scope="col">الآن</th>
                    {forecast.horizons_days.map((d) => (
                      <th key={d} scope="col">
                        {inDays(d)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {forecast.by_source.map((s) => (
                    <tr key={s.source_id ?? 'none'}>
                      <th scope="row">
                        <BidiText as="span" text={s.label} />
                      </th>
                      <td>{s.cards}</td>
                      <td>{pct(s.now_avg)}</td>
                      {s.at.map((a) => (
                        <td key={a.days}>{`${pct(a.avg_recall)} (${a.below_desired} دون الهدف)`}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {forecast.not_estimated.cards > 0 && <p className="lw-muted">{`${cardsAr(forecast.not_estimated.cards)} بلا تقدير: ${forecast.not_estimated.reason_ar}`}</p>}
    </section>
  );
}
