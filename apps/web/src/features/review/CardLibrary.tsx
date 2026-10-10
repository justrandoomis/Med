// /review/cards — every card on this device (works offline): search, filter by state, open to edit. Online extras:
// possible duplicates (suggestions only — merging keeps both review histories) and the Anki-compatible TEXT export
// (Anki's documented text import with headers; not .apkg, and it says so).
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, Download, Plus } from 'lucide-react';
import type { CardDuplicateSuggestion } from '@medlevo/shared';
import { Button, Checkbox, EmptyState, ErrorState, LoadingState, SegmentedControl, StatusPill, TextField, buttonClass, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useCapabilities } from '../../lib/capabilities';
import { getDb } from '../../lib/localdb';
import { getSyncEngine } from '../../lib/sync';
import { formatDate, formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { learningApi } from './api';
import { StateLabel } from './components/CardBits';
import { useLearningSync, useLocalCards, useNow, useSrsConfig } from './local/hooks';
import { scheduleOf, type CardSchedule } from './local/queue';
import { cardPreview } from './local/render';
import { putServerCards, type LocalCardRow } from './local/store';
import { cardsAr } from './local/time';
import { cardUrl, sessionUrl } from './links';
import './learning.css';

type Filter = 'all' | 'due' | 'new' | 'suspended' | 'needs_review' | 'deleted';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'الكل' },
  { value: 'due', label: 'مستحقة' },
  { value: 'new', label: 'جديدة' },
  { value: 'suspended', label: 'موقوفة' },
  { value: 'needs_review', label: 'تحتاج مراجعة' },
  { value: 'deleted', label: 'محذوفة' },
];
const PAGE = 150;

function matches(f: Filter, c: LocalCardRow, s: CardSchedule | null, now: number): boolean {
  if (f === 'deleted') return !!c.deletedAt;
  if (c.deletedAt) return false;
  if (f === 'all') return true;
  if (f === 'suspended') return !!c.suspended;
  if (f === 'needs_review') return !!c.needsReview;
  if (!s) return false;
  if (f === 'new') return s.view.state === 'new' && s.fold.eventCount === 0;
  return !c.suspended && s.fold.eventCount > 0 && s.view.due_at <= now;
}

function Duplicates() {
  const caps = useCapabilities();
  const toast = useToast();
  const [items, setItems] = useState<CardDuplicateSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const local = useLocalCards();
  const byId = useMemo(() => new Map(local.cards.map((c) => [c.id, c])), [local.cards]);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems((await learningApi.duplicates()).items);
    } catch (e) {
      setError(errorMessage(e, 'تعذّر البحث عن التكرارات.'));
    } finally {
      setLoading(false);
    }
  };
  const decide = async (d: CardDuplicateSuggestion, decision: 'not_duplicate' | 'merge', keep?: string) => {
    try {
      const r = await learningApi.decideDuplicate({ card_a_id: d.card_a_id, card_b_id: d.card_b_id, decision, keep_id: keep ?? null });
      if (r.kept) await putServerCards(getDb(), [r.kept]);
      // the merged-away card is tombstoned on the server: pull now so this device stops asking it
      if (decision === 'merge') void getSyncEngine().syncNow();
      setItems((xs) => xs?.filter((x) => x !== d) ?? null);
      toast.show({ title: decision === 'merge' ? 'دُمجت البطاقتان: بقيت المختارة، وحُفظ سجل مراجعات الأخرى ويمكن استرجاعها.' : 'سُجّل أنهما ليستا مكررتين.', tone: 'success' });
    } catch (e) {
      toast.show({ title: errorMessage(e, 'تعذّر حفظ القرار.'), tone: 'danger' });
    }
  };
  return (
    <section className="lw-sheet" aria-labelledby="lw-dup-h">
      <h2 id="lw-dup-h" className="lw-sheet__title">
        بطاقات قد تكون مكررة
      </h2>
      <p className="lw-muted">اقتراحات فقط (تشابه نصي)، ولا يُدمج شيء دون قرارك. عند الدمج تبقى البطاقة التي تختارها، ويُحفظ سجل مراجعات الأخرى ويمكن استرجاعها.</p>
      {items === null ? (
        <Button variant="secondary" icon={<Copy size={16} />} loading={loading} disabled={!caps.online} onClick={() => void load()}>
          ابحث عن التكرارات
        </Button>
      ) : items.length === 0 ? (
        <p>لا توجد اقتراحات تكرار الآن.</p>
      ) : (
        <ul className="lw-dups">
          {items.map((d) => {
            const a = byId.get(d.card_a_id);
            const b = byId.get(d.card_b_id);
            return (
              <li key={`${d.card_a_id}-${d.card_b_id}`} className="lw-dup">
                <p className="lw-muted">{d.reason_ar}</p>
                <ol className="lw-dup__pair">
                  <li>
                    <BidiText as="span" text={a ? cardPreview(a) : d.card_a_id} />
                  </li>
                  <li>
                    <BidiText as="span" text={b ? cardPreview(b) : d.card_b_id} />
                  </li>
                </ol>
                <div className="ml-cluster">
                  <Button size="sm" variant="secondary" onClick={() => void decide(d, 'merge', d.card_a_id)}>
                    ادمج واحتفظ بالأولى
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void decide(d, 'merge', d.card_b_id)}>
                    ادمج واحتفظ بالثانية
                  </Button>
                  <Button size="sm" variant="plain" onClick={() => void decide(d, 'not_duplicate')}>
                    ليستا مكررتين
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!caps.online && <p className="lw-muted">يحتاج اتصالًا.</p>}
      {error && <ErrorState inline message={error} onRetry={() => void load()} />}
    </section>
  );
}

function AnkiExport() {
  const caps = useCapabilities();
  const gate = caps.feature('export.anki_tsv');
  const [suspended, setSuspended] = useState(false);
  return (
    <section className="lw-sheet" aria-labelledby="lw-anki-h">
      <h2 id="lw-anki-h" className="lw-sheet__title">
        تصدير بصيغة استيراد Anki النصية
      </h2>
      <p className="lw-muted">
        ملف نصي بالأعمدة والرؤوس التي يقرؤها استيراد النصوص في <bdi dir="ltr">Anki</bdi> (سؤال وجواب وإكمال فراغ، مع المصدر في عمود مستقل). بطاقات الصور تأتي في ملف
        مضغوط مع مجلد الوسائط وتعليمات نسخه. ليست صيغة <bdi dir="ltr">.apkg</bdi>.
      </p>
      <Checkbox checked={suspended} onCheckedChange={setSuspended} label="ضمّن البطاقات الموقوفة" />
      {gate.available ? (
        <a className={buttonClass({ variant: 'secondary' })} href={learningApi.ankiExportUrl({ include_suspended: suspended })} download>
          <Download size={16} aria-hidden="true" />
          نزّل ملف التصدير
        </a>
      ) : (
        <p className="lw-muted">{gate.reason}</p>
      )}
    </section>
  );
}

export function CardLibrary() {
  usePageTitle('مكتبة البطاقات');
  useLearningSync();
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.some((f) => f.value === params.get('filter')) ? params.get('filter') : 'all') as Filter;
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const cfg = useSrsConfig();
  const local = useLocalCards();
  const now = useNow(60_000);
  const schedules = useMemo(() => {
    const m = new Map<string, CardSchedule>();
    if (!cfg.config || !cfg.parity?.ok) return m;
    for (const c of local.cards) if (!c.deletedAt) m.set(c.id, scheduleOf({ params: cfg.config.params }, c, local.events.get(c.id), now));
    return m;
  }, [cfg.config, cfg.parity, local.cards, local.events, now]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return local.cards
      .filter((c) => matches(filter, c, schedules.get(c.id) ?? null, now))
      .filter((c) => !needle || cardPreview(c, 400).toLowerCase().includes(needle))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [local.cards, filter, q, schedules, now]);

  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header lw-head">
        <div>
          <h1 className="ml-page__title">مكتبة البطاقات</h1>
          <p className="ml-page__lede">كل بطاقاتك على هذا الجهاز. افتح بطاقة لتعديلها أو إيقافها أو مراجعة أثر تغيّر مصدرها.</p>
        </div>
        <div className="ml-cluster">
          <Link to="/review/cards/new" className={buttonClass({ variant: 'primary' })}>
            <Plus size={16} aria-hidden="true" />
            بطاقة جديدة
          </Link>
        </div>
      </header>

      <div className="lw-filters">
        <SegmentedControl<Filter>
          label="عرض البطاقات"
          options={FILTERS}
          value={filter}
          onValueChange={(v) => {
            const next = new URLSearchParams(params);
            next.set('filter', v);
            setParams(next, { replace: true });
            setShown(PAGE);
          }}
          size="sm"
        />
        <TextField label="ابحث في نص البطاقات" type="search" value={q} onChange={(e) => setQ(e.target.value)} fieldClassName="lw-filters__search" />
      </div>

      {!local.ready ? (
        <LoadingState stage="جارٍ قراءة البطاقات المحفوظة على هذا الجهاز…" />
      ) : local.cards.length === 0 ? (
        <EmptyState
          title="لا توجد بطاقات على هذا الجهاز"
          description="أنشئ بطاقة من نص تحدده في الكتاب («أنشئ بطاقة مراجعة»)، أو من سؤال أخطأت فيه، أو اكتبها بنفسك. البطاقات المنشأة على أجهزتك الأخرى تصل مع المزامنة."
          actions={
            <Link to="/review/cards/new" className={buttonClass({ variant: 'primary' })}>
              بطاقة جديدة
            </Link>
          }
        />
      ) : list.length === 0 ? (
        <p className="lw-muted lw-empty-line">لا توجد بطاقات تطابق هذا العرض.</p>
      ) : (
        <>
          <p className="lw-muted" aria-live="polite">
            {cardsAr(list.length)}
            {filter === 'due' && list.length > 0 && (
              <>
                {' — '}
                <Link className="lw-link" to={sessionUrl({ cards: list.slice(0, 200).map((c) => c.id), back: '/review/cards?filter=due' })}>
                  راجعها الآن
                </Link>
              </>
            )}
          </p>
          <ul className="ml-list lw-cards">
            {list.slice(0, shown).map((c) => {
              const s = schedules.get(c.id);
              return (
                <li key={c.id} className="ml-list__row">
                  <Link to={cardUrl(c.id, `/review/cards${filter !== 'all' ? `?filter=${filter}` : ''}`)} className="lw-cardrow">
                    <BidiText as="span" className="lw-cardrow__text" text={cardPreview(c) || '—'} />
                    <span className="lw-cardrow__meta">
                      <span>{c.kindLabelAr ?? 'بطاقة'}</span>
                      {s && <StateLabel state={s.view.state} mastered={s.mastered} />}
                      {s && s.fold.eventCount > 0 && !c.deletedAt && <span>{s.view.due_at <= now ? 'مستحقة الآن' : `الموعد ${formatRelative(s.view.due_at, now)}`}</span>}
                      {c.suspended && !c.deletedAt && <StatusPill tone="neutral">موقوفة</StatusPill>}
                      {c.buriedUntil != null && c.buriedUntil > now && <StatusPill tone="neutral">مؤجلة حتى {formatDate(c.buriedUntil)}</StatusPill>}
                      {c.needsReview && !c.deletedAt && <StatusPill tone="warning">تغيّر مصدرها — تحتاج مراجعتك</StatusPill>}
                      {c.deletedAt && <StatusPill tone="neutral">محذوفة {formatDate(c.deletedAt)}</StatusPill>}
                      {c.syncState && c.syncState !== 'synced' && <span className="lw-muted">لم تُزامَن بعد</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {list.length > shown && (
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
              اعرض المزيد ({list.length - shown})
            </Button>
          )}
        </>
      )}

      <div className="lw-two">
        <Duplicates />
        <AnkiExport />
      </div>
    </div>
  );
}
