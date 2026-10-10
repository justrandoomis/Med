// /review — the Review hub (§23 «المراجعة: البطاقات والأخطاء والمواضيع المستحقة», §43–§45). Calm and book-first:
// today's cards in one sentence with one primary action, a one-tap revision by minutes, passages the owner marked
// for revision in the book, and the learning tools as a plain list — no dashboard of counters.
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookMarked, BrainCircuit, CalendarDays, Dna, FileQuestion, GraduationCap, Images, Layers, Plus, Sparkles, Stethoscope, Target, Trash2, UserRound } from 'lucide-react';
import { Button, IconButton, ListItem, buttonClass, useToast } from '../../design';
import { useCapabilities } from '../../lib/capabilities';
import { useSyncSnapshot } from '../../lib/sync';
import { getDb } from '../../lib/localdb';
import { formatRelative } from '../../lib/time';
import { usePageTitle } from '../../lib/usePageTitle';
import { BidiText } from '../evidence';
import { useLibrary } from '../library/useLibrary';
import { MinutesPicker } from './components/MinutesPicker';
import { prefetchCardImages, useMissingCardImages } from './components/useCardImages';
import { useLearningSync, useLocalCards, useNow, useSrsConfig } from './local/hooks';
import { computeQueue } from './local/queue';
import { removeRevisionMark, useRevisionMarks } from './local/revisionMarks';
import { cardsAr } from './local/time';
import { sessionUrl, studyUrl } from './links';
import './learning.css';

function TodayCards() {
  const cfg = useSrsConfig();
  const local = useLocalCards();
  const now = useNow();
  const queue = useMemo(
    () => (cfg.config && cfg.parity?.ok && local.ready ? computeQueue({ params: cfg.config.params, daily_new_limit: cfg.config.daily_new_limit, timezone: cfg.config.timezone }, local.cards, local.events, now) : null),
    [cfg.config, cfg.parity, local, now],
  );
  const missing = useMissingCardImages(local.cards);
  const sync = useSyncSnapshot();
  const caps = useCapabilities();
  const [saving, setSaving] = useState<{ done: number; total: number } | null>(null);
  const toast = useToast();

  let sentence: string;
  if (!cfg.config) sentence = cfg.loading ? 'جارٍ تجهيز البطاقات على هذا الجهاز…' : 'لم تُحفظ إعدادات الجدولة على هذا الجهاز بعد؛ افتح هذه الصفحة مرة مع اتصال.';
  else if (!queue) sentence = 'جارٍ قراءة البطاقات المحفوظة على هذا الجهاز…';
  else if (queue.counts.total === 0 && sync.online && sync.lastSyncedAt === null && !sync.lastError) sentence = 'جارٍ تنزيل بطاقاتك إلى هذا الجهاز لأول مرة…';
  else if (queue.counts.total === 0) sentence = 'لا توجد بطاقات بعد. أنشئ بطاقة من نص تحدده في الكتاب، أو من سؤال أخطأت فيه، أو اكتبها بنفسك.';
  else if (queue.counts.due_now + queue.counts.new_available === 0)
    sentence = `لا شيء مستحق الآن.${queue.next_due_at ? ` أقرب موعد ${formatRelative(queue.next_due_at, now)}.` : ''}`;
  else {
    const parts: string[] = [];
    if (queue.counts.due_now) parts.push(`${cardsAr(queue.counts.due_now)} مستحقة الآن`);
    if (queue.counts.new_available) parts.push(`${cardsAr(queue.counts.new_available)} جديدة ضمن حدّك اليومي (${queue.counts.new_limit})`);
    sentence = `${parts.join('، و')}.`;
  }
  const canStart = !!queue && queue.counts.due_now + queue.counts.new_available > 0;

  return (
    <section className="lw-sheet lw-today" aria-labelledby="lw-today-h">
      <div className="lw-today__main">
        <h2 id="lw-today-h" className="lw-sheet__title">
          بطاقات اليوم
        </h2>
        <p className="lw-today__sentence">{sentence}</p>
        <div className="ml-cluster">
          {canStart ? (
            <Link to={sessionUrl({ back: '/review' })} className={buttonClass({ variant: 'primary', size: 'lg' })}>
              <Layers size={18} aria-hidden="true" />
              ابدأ المراجعة
            </Link>
          ) : (
            <Button variant="primary" size="lg" icon={<Layers size={18} />} disabled aria-describedby="lw-today-why">
              ابدأ المراجعة
            </Button>
          )}
          <Link to="/review/cards/new" className={buttonClass({ variant: 'secondary' })}>
            <Plus size={16} aria-hidden="true" />
            بطاقة جديدة
          </Link>
          <Link to="/review/cards" className={buttonClass({ variant: 'plain' })}>
            كل البطاقات
          </Link>
        </div>
        {!canStart && (
          <p id="lw-today-why" className="ml-visually-hidden">
            {sentence}
          </p>
        )}
      </div>
      {queue && queue.counts.total > 0 && (
        <p className="lw-footnote">
          {`${cardsAr(queue.counts.total)} على هذا الجهاز وتعمل دون اتصال`}
          {queue.counts.suspended ? `، منها ${queue.counts.suspended} موقوفة` : ''}
          {queue.counts.needs_review ? `، و${queue.counts.needs_review} تحتاج مراجعتك بعد تغيّر مصدرها` : ''}. الجدولة بخوارزمية <bdi dir="ltr">FSRS</bdi> نفسها على
          الجهاز والخادم، ومواعيدها تقدير من سجل مراجعاتك.
        </p>
      )}
      {missing.length > 0 && (
        <div className="lw-footnote lw-footnote--action">
          <span>
            {missing.length === 1 ? 'صورة بطاقة واحدة من بطاقات إخفاء الصور غير محفوظة على هذا الجهاز بعد.' : `صور ${missing.length} من بطاقات إخفاء الصور غير محفوظة على هذا الجهاز بعد.`}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!caps.online || !!saving}
            loading={!!saving}
            loadingLabel={saving ? `جارٍ الحفظ: ${saving.done} من ${saving.total}` : undefined}
            onClick={async () => {
              setSaving({ done: 0, total: missing.length });
              const r = await prefetchCardImages(missing, (done) => setSaving({ done, total: missing.length }));
              setSaving(null);
              toast.show({ title: r.failed ? `حُفظت ${r.saved} صورة، وتعذّر حفظ ${r.failed}.` : `حُفظت ${r.saved} صورة على هذا الجهاز.`, tone: r.failed ? 'warning' : 'success' });
            }}
          >
            احفظ الصور للمراجعة دون اتصال
          </Button>
          {!caps.online && <span className="lw-muted">يحتاج اتصالًا.</span>}
        </div>
      )}
    </section>
  );
}

function OneTapRevision() {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const [minutes, setMinutes] = useState(20);
  return (
    <section className="lw-sheet" aria-labelledby="lw-onetap-h">
      <h2 id="lw-onetap-h" className="lw-sheet__title">
        مراجعة بنقرة واحدة <bdi dir="ltr" lang="en" className="lw-term">One-Tap Revision</bdi>
      </h2>
      <p className="lw-muted">حدّد وقتك، فتُبنى جلسة من أخطائك الأخيرة ونقاط ضعفك والبطاقات المستحقة وصفحاتها — مع سبب كل عنصر، ودون أن تتجاوز المدة.</p>
      <MinutesPicker value={minutes} onChange={setMinutes} />
      <div className="ml-cluster">
        <Button variant="secondary" icon={<Sparkles size={16} />} disabled={!caps.online} onClick={() => navigate(`/review/revision?minutes=${minutes}`)}>
          ابنِ جلسة {minutes} دقيقة
        </Button>
        {!caps.online && <span className="lw-muted">بناء الجلسة يحتاج اتصالًا (يقرأ أخطاءك ونقاط ضعفك من الخادم). البطاقات وحدها تعمل دون اتصال.</span>}
      </div>
    </section>
  );
}

function RevisionMarks() {
  const marks = useRevisionMarks();
  const toast = useToast();
  // the selection toolbar does not know the book's title: name each mark's book from the library (cached offline)
  const lib = useLibrary();
  const titles = useMemo(() => new Map((lib.data?.sources ?? []).map((s) => [s.id, s.title])), [lib.data]);
  if (!marks || marks.length === 0) return null;
  return (
    <section aria-labelledby="lw-marks-h">
      <h2 id="lw-marks-h" className="ml-group-header">
        مقاطع أضفتها للمراجعة من الكتاب
      </h2>
      <ul className="ml-list">
        {marks.slice(0, 20).map((m) => (
          <li key={m.row.id} className="ml-list__row lw-mark">
            <Link className="lw-mark__link" to={studyUrl(m.sourceId, { versionId: m.versionId, pageId: m.pageId })}>
              <BookMarked size={18} aria-hidden="true" />
              <span className="lw-mark__text">
                <BidiText
                  as="span"
                  dir="rtl"
                  className="lw-mark__where"
                  text={[m.data.source_title ?? titles.get(m.sourceId) ?? null, m.data.page_label ?? `الصفحة ${m.pageIndex + 1} في الملف`].filter(Boolean).join(' — ')}
                />
                {m.data.quote && <BidiText as="span" className="lw-mark__quote" text={m.data.quote} />}
              </span>
            </Link>
            <IconButton
              label="أزل من قائمة المراجعة"
              icon={<Trash2 size={16} />}
              onClick={async () => {
                await removeRevisionMark(getDb(), m.row);
                toast.show({ title: 'أُزيل المقطع من قائمة المراجعة (النص في الكتاب لم يتغير).', tone: 'success' });
              }}
            />
          </li>
        ))}
      </ul>
      <p className="ml-group-footer">تضيفها من شريط التحديد في الكتاب: «أضف إلى المراجعة». تُحفظ على هذا الجهاز وتُزامَن مع علاماتك.</p>
    </section>
  );
}

const TOOLS = [
  { to: '/weakness', icon: Target, title: 'نقاط الضعف وأنماط الأخطاء', subtitle: 'أين تخطئ ولماذا، مع ما يُقترح مراجعته وسببه.' },
  { to: '/exams/new', icon: GraduationCap, title: 'التدريب والامتحانات', subtitle: 'أسئلة من مصادرك بوضع التدريب أو الامتحان.' },
  { to: '/questions', icon: FileQuestion, title: 'خزنة الأسئلة', subtitle: 'كل أسئلتك ومفاتيحها ومصادرها.' },
  { to: '/planner', icon: CalendarDays, title: 'مخطط الدراسة', subtitle: 'خطة واقعية حتى موعد الامتحان، تُعاد موازنتها عند التأخر.' },
  { to: '/review/dna', icon: Dna, title: 'بصمة امتحاناتك', term: 'Exam DNA', subtitle: 'ما يتكرر في مصادر أسئلتك، مع حجم العينة وحدودها.' },
  { to: '/review/profile', icon: UserRound, title: 'ملف التعلّم', subtitle: 'ما تستخدمه المنصة لتخصيص الشرح، وتستطيع تصحيحه أو إعادة ضبطه.' },
  { to: '/review/cards', icon: BrainCircuit, title: 'مكتبة البطاقات', subtitle: 'تعديل، إيقاف، دمج المكرر، وتصدير بصيغة استيراد Anki النصية.' },
  { to: '/cases', icon: Stethoscope, title: 'حالات وOSCE', subtitle: 'حالات سريرية تتقدم بقراراتك، ومحطات OSCE نصية، وامتحان شفهي بمتابعة.' },
  { to: '/media', icon: Images, title: 'الصور والصوت', subtitle: 'صور مصادرك مع أصلها، واختبار الصور، وتفريغ تسجيلات المحاضرات.' },
] as const;

export function ReviewHub() {
  usePageTitle('المراجعة');
  useLearningSync();
  return (
    <div className="ml-page lw-page">
      <header className="ml-page__header">
        <h1 className="ml-page__title">المراجعة</h1>
        <p className="ml-page__lede">البطاقات المستحقة، وجلسة بالمدة التي لديك، وما تخطئ فيه — كل اقتراح مع سببه.</p>
      </header>
      <div className="lw-hub">
        <div className="lw-hub__main">
          <TodayCards />
          <OneTapRevision />
          <RevisionMarks />
        </div>
        <nav className="lw-hub__tools" aria-labelledby="lw-tools-h">
          <h2 id="lw-tools-h" className="ml-group-header">
            أدوات التعلّم
          </h2>
          <ul className="ml-list">
            {TOOLS.map((t) => (
              <li key={t.to} className="ml-list__row">
                <ListItem
                  to={t.to}
                  leading={<t.icon size={20} aria-hidden="true" />}
                  title={
                    'term' in t ? (
                      <>
                        {t.title} <bdi dir="ltr" lang="en" className="lw-term">{t.term}</bdi>
                      </>
                    ) : (
                      t.title
                    )
                  }
                  subtitle={t.subtitle}
                />
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
