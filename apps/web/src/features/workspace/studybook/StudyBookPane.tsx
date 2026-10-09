// MedLevo Study Book view (§24) inside the workspace: generate (with the Source Lock shown first), real per-section
// progress, the book rendered with C1's ArtifactContent (chips → Evidence Peek → open source → back), sections with
// «open in the lecture», freeze, regeneration as a NEW version (notes never move; vanished anchors listed), and
// Lecture Twin: the pane scrolls to the block nearest the lecture page and reports the page of the block on top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ListTree, Lock, LockOpen, RefreshCw, RotateCcw, Square } from 'lucide-react';
import {
  SCOPE_MODE_LABELS_AR,
  type SourceScope,
  type StudyBookSectionView,
  type StudyBookView,
} from '@medlevo/shared';
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, StatusPill, useToast, type StatusTone } from '../../../design';
import { errorMessage } from '../../../lib/api';
import { useCapabilities } from '../../../lib/capabilities';
import { useSettings } from '../../../lib/settings';
import { ArtifactContent, ScopeBadge, ScopePicker } from '../../evidence';
import { studybookApi } from '../../studybook/api';
import { coverageSummary, defaultScopeFor, nearestBlock, pageOfBlock, referencesOf, sectionsProgressAr } from '../../studybook/model';
import type { SourceDocument } from '../data/useSourceDocument';
import { SummaryPanel } from './SummaryPanel';
import { useStudyBook } from './useStudyBook';
import './studybook.css';

const SECTION_TONE: Record<StudyBookSectionView['status'], StatusTone> = { pending: 'neutral', generating: 'info', complete: 'success', abstained: 'warning', failed: 'danger' };

export interface StudyBookPaneProps {
  doc: SourceDocument;
  /** the lecture page the owner is on (Lecture Twin target) */
  pageIndex: number;
  /** bump to scroll the book to the block nearest `pageIndex` (switching views / sync) */
  jumpKey: number;
  /** the original page of the block currently at the top of the book */
  onVisiblePage?: (pageIndex: number) => void;
  /** open a lecture page (Lecture Twin back to the original) */
  onOpenPage: (pageIndex: number) => void;
  online: boolean;
  /** split view: narrower header */
  compact?: boolean;
}

export function StudyBookPane({ doc, pageIndex, jumpKey, onVisiblePage, onOpenPage, online, compact }: StudyBookPaneProps) {
  const sb = useStudyBook(doc.detail.id, online);
  const caps = useCapabilities();
  const [tab, setTab] = useState<'book' | 'summaries'>('book');
  const book = sb.book;
  return (
    <section className={`sb-pane${compact ? ' sb-pane--compact' : ''}`} aria-label="كتاب الدراسة">
      <div className="sb-pane__tabs" role="tablist" aria-label="كتاب الدراسة والملخصات">
        <button type="button" role="tab" aria-selected={tab === 'book'} className="sb-tab" onClick={() => setTab('book')}>
          <BookOpen size={16} aria-hidden="true" />
          كتاب الدراسة
        </button>
        <button type="button" role="tab" aria-selected={tab === 'summaries'} className="sb-tab" onClick={() => setTab('summaries')}>
          <ListTree size={16} aria-hidden="true" />
          الملخصات
        </button>
      </div>
      {tab === 'summaries' ? (
        <SummaryPanel doc={doc} pageIndex={pageIndex} online={online} gate={caps.feature('ai.summaries')} />
      ) : sb.status === 'loading' ? (
        <LoadingState inline stage="جارٍ تحميل كتاب الدراسة…" />
      ) : sb.status === 'offline' ? (
        <EmptyState headingLevel={3} title="كتاب الدراسة يحتاج اتصالًا" description="لم يُحمَّل كتاب الدراسة على هذا الجهاز. يظهر عند عودة الاتصال." />
      ) : sb.status === 'error' && !sb.data ? (
        <ErrorState inline message={sb.error ?? 'تعذّر تحميل كتاب الدراسة.'} onRetry={() => void sb.reload()} />
      ) : !book ? (
        <GeneratePanel doc={doc} canGenerate={sb.data?.can_generate ?? { available: false, reason_ar: null }} onCreated={(b) => sb.setBook(b)} />
      ) : (
        <BookView
          doc={doc}
          book={book}
          pageIndex={pageIndex}
          jumpKey={jumpKey}
          onVisiblePage={onVisiblePage}
          onOpenPage={onOpenPage}
          canGenerate={sb.data?.can_generate ?? { available: false, reason_ar: null }}
          onChanged={(b) => sb.setBook(b)}
          onOpenVersion={(id) => sb.openVersion(id)}
          onReload={() => void sb.reload()}
        />
      )}
    </section>
  );
}

function GeneratePanel({ doc, canGenerate, onCreated }: { doc: SourceDocument; canGenerate: { available: boolean; reason_ar: string | null }; onCreated: (b: StudyBookView) => void }) {
  const { settings } = useSettings();
  const toast = useToast();
  const [scope, setScope] = useState<SourceScope>(() => defaultScopeFor(doc.detail, settings.default_scope_mode));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = 'sb-generate-reason';
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await studybookApi.createBook({ source_id: doc.detail.id, scope });
      onCreated(res.book);
      if (res.cached) toast.show({ title: 'كتاب الدراسة موجود بالنطاق والقواعد نفسها؛ فُتحت النسخة المحفوظة.', tone: 'info' });
    } catch (e) {
      setError(errorMessage(e, 'تعذّر بدء توليد كتاب الدراسة.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sb-generate">
      <EmptyState
        headingLevel={3}
        icon={<BookOpen size={28} />}
        title="لم يُنشأ كتاب الدراسة لهذه المحاضرة بعد"
        description="نسخة تعليمية منظّمة بالعربية تتبع ترتيب المحاضرة، وكل جملة طبية فيها مرتبطة بدليل من مصادرك. يُولَّد قسمًا قسمًا، والقسم الذي لم يكتمل لا يُعرض."
      />
      <div className="sb-generate__scope">
        <p className="sb-label">نطاق المصادر لهذا الكتاب</p>
        <ScopeBadge scope={{ mode: scope.mode, source_ids: [scope.lecture_source_id ?? '', ...scope.reference_source_ids].filter(Boolean) }} />
        <Button size="sm" variant="plain" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          {picking ? 'إخفاء اختيار النطاق' : 'غيّر النطاق'}
        </Button>
        {picking && (
          <ScopePicker
            value={scope}
            lectureSourceId={doc.detail.id}
            references={referencesOf(doc.detail)}
            onApply={(s) => {
              setScope(s);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        )}
      </div>
      <Button variant="primary" onClick={() => void create()} loading={busy} loadingLabel="جارٍ البدء…" disabled={!canGenerate.available} aria-describedby={!canGenerate.available ? reasonId : undefined}>
        أنشئ كتاب الدراسة ({SCOPE_MODE_LABELS_AR[scope.mode]})
      </Button>
      {!canGenerate.available && (
        <p id={reasonId} className="sb-reason" role="note">
          {canGenerate.reason_ar ?? 'التوليد غير متاح الآن.'}
        </p>
      )}
      {error && <ErrorState inline message={error} onRetry={() => void create()} />}
    </div>
  );
}

interface BookViewProps {
  doc: SourceDocument;
  book: StudyBookView;
  pageIndex: number;
  jumpKey: number;
  onVisiblePage?: (pageIndex: number) => void;
  onOpenPage: (pageIndex: number) => void;
  canGenerate: { available: boolean; reason_ar: string | null };
  onChanged: (b: StudyBookView) => void;
  onOpenVersion: (id: string | null) => void;
  onReload: () => void;
}

function BookView({ doc, book, pageIndex, jumpKey, onVisiblePage, onOpenPage, canGenerate, onChanged, onOpenVersion, onReload }: BookViewProps) {
  const toast = useToast();
  const a = book.artifact;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const programmatic = useRef(0);
  const cov = coverageSummary(a.coverage);
  const needsReanchor = book.reanchor.filter((r) => r.status === 'needs_reanchor');
  const generating = a.status === 'generating';

  // Lecture Twin: scroll to the block nearest the lecture page when asked (view switch / sync)
  const scrollToPage = useCallback(
    (pi: number) => {
      const key = nearestBlock(book.twin, pi);
      if (!key || !bodyRef.current) return;
      const el = bodyRef.current.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);
      if (!el) return;
      programmatic.current = Date.now();
      el.scrollIntoView({ block: 'start', behavior: 'auto' });
    },
    [book.twin],
  );
  useEffect(() => {
    scrollToPage(pageIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpKey, a.id]);

  // report the page of the block on top (for switching back and optional sync)
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !onVisiblePage || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.block!;
          if (e.isIntersecting) visible.set(key, e.boundingClientRect.top);
          else visible.delete(key);
        }
        if (Date.now() - programmatic.current < 600) return; // our own scroll: no feedback loop
        const top = [...visible.entries()].sort((x, y) => x[1] - y[1])[0];
        if (!top) return;
        const p = pageOfBlock(book.twin, top[0]);
        if (p !== null) onVisiblePage(p);
      },
      { root: null, threshold: [0, 0.25] },
    );
    root.querySelectorAll<HTMLElement>('[data-block]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [book.twin, onVisiblePage, a.id, a.blocks.length]);

  const act = async (name: string, fn: () => Promise<StudyBookView>, done?: string) => {
    setBusy(name);
    setError(null);
    try {
      const b = await fn();
      onChanged(b);
      if (done) toast.show({ title: done, tone: 'success' });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const sectionsByKey = useMemo(() => new Map(book.sections.map((s) => [s.section_key, s])), [book.sections]);
  const firstBlockOf = (key: string) => a.blocks.find((b) => b.section_key === key)?.block_key ?? null;

  return (
    <div className="sb-book">
      <header className="sb-book__head">
        <div className="sb-book__meta">
          <StatusPill tone="neutral">{`النسخة ${a.version_no}`}</StatusPill>
          {a.is_frozen && (
            <StatusPill tone="accent" icon={<Lock size={14} />}>
              مثبّتة
            </StatusPill>
          )}
          {cov.text && <span className="sb-muted">{cov.complete ? `${cov.text} — كل الأقسام المعالجة` : cov.text}</span>}
        </div>
        <div className="sb-book__actions">
          {generating ? (
            <Button size="sm" variant="secondary" icon={<Square size={14} />} loading={busy === 'cancel'} onClick={() => void act('cancel', () => studybookApi.cancelBook(a.id), 'أُوقف التوليد؛ الأقسام المكتملة محفوظة.')}>
              أوقف التوليد
            </Button>
          ) : (
            <>
              {(a.status === 'partial' || a.status === 'failed') && (
                <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} loading={busy === 'resume'} disabled={!canGenerate.available} title={canGenerate.reason_ar ?? undefined} onClick={() => void act('resume', () => studybookApi.resumeBook(a.id))}>
                  أكمل الأقسام الناقصة
                </Button>
              )}
              <Button
                size="sm"
                variant="plain"
                icon={a.is_frozen ? <LockOpen size={14} /> : <Lock size={14} />}
                loading={busy === 'freeze'}
                onClick={() => void act('freeze', () => studybookApi.freezeBook(a.id, !a.is_frozen), a.is_frozen ? 'أُلغي التثبيت.' : 'ثُبّتت هذه النسخة؛ لن تتغير أثناء دراستك.')}
              >
                {a.is_frozen ? 'ألغِ التثبيت' : 'ثبّت هذه النسخة'}
              </Button>
              <Button size="sm" variant="plain" icon={<RefreshCw size={14} />} disabled={!canGenerate.available} title={canGenerate.reason_ar ?? undefined} onClick={() => setConfirmRegen(true)}>
                أنشئ نسخة جديدة
              </Button>
            </>
          )}
        </div>
      </header>

      {!canGenerate.available && canGenerate.reason_ar && !generating && <p className="sb-reason" role="note">{`التوليد غير متاح: ${canGenerate.reason_ar} قراءة النسخ الموجودة متاحة.`}</p>}
      {book.newer_version_id && (
        <p className="sb-note" role="note">
          توجد نسخة أحدث من كتاب الدراسة؛ هذه النسخة {a.is_frozen ? 'مثبّتة ولن تتغير' : 'أقدم'}.{' '}
          <Button size="sm" variant="plain" onClick={() => onOpenVersion(book.newer_version_id)}>
            افتح النسخة الأحدث
          </Button>
        </p>
      )}
      {a.versions.length > 1 && (
        <details className="sb-versions">
          <summary>{`نسخ هذا الكتاب (${a.versions.length})`}</summary>
          <ul role="list">
            {a.versions.map((v) => (
              <li key={v.id}>
                <Button size="sm" variant={v.id === a.id ? 'secondary' : 'plain'} onClick={() => onOpenVersion(v.id)} aria-current={v.id === a.id ? 'true' : undefined}>
                  {`النسخة ${v.version_no}`}
                  {v.is_frozen ? ' — مثبّتة' : ''}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {generating && (
        <div className="sb-progress" role="status" aria-live="polite">
          <LoadingState inline stage={`يُولَّد كتاب الدراسة قسمًا قسمًا: ${sectionsProgressAr(book.progress)}. الأقسام المكتملة تظهر أدناه، ولا يُعرض قسم قبل اكتمال التحقق منه.`} done={book.progress.sections_complete + book.progress.sections_abstained} total={book.progress.sections_total} unit="أقسام" />
        </div>
      )}
      {error && <ErrorState inline message={error} onRetry={onReload} />}

      <nav className="sb-toc" aria-label="أقسام كتاب الدراسة">
        <ol role="list">
          {book.sections.map((s) => {
            const first = firstBlockOf(s.section_key);
            return (
              <li key={s.section_key} className="sb-toc__item">
                <StatusPill tone={SECTION_TONE[s.status]}>{s.status_label_ar}</StatusPill>
                {first ? (
                  <button
                    type="button"
                    className="sb-toc__link"
                    onClick={() => {
                      programmatic.current = Date.now();
                      bodyRef.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'start' });
                    }}
                  >
                    {s.title ?? 'قسم'}
                  </button>
                ) : (
                  <span className="sb-toc__title">{s.title ?? 'قسم'}</span>
                )}
                {s.page_indexes.length > 0 && (
                  <Button size="sm" variant="plain" onClick={() => onOpenPage(s.page_indexes[0]!)} aria-label={`افتح ${s.page_labels_ar[0] ?? ''} في المحاضرة`}>
                    {s.page_labels_ar[0] ?? ''}
                  </Button>
                )}
                {s.detail_ar && s.status !== 'complete' && <span className="sb-muted">{s.detail_ar}</span>}
              </li>
            );
          })}
        </ol>
      </nav>

      {needsReanchor.length > 0 && (
        <details className="sb-reanchor">
          <summary>{`ملاحظات تحتاج إعادة ربط (${needsReanchor.length})`}</summary>
          <p className="sb-muted">لم تُنقل هذه الملاحظات إلى فقرة أخرى؛ بقيت محفوظة كما هي في «ملاحظاتي» حتى تربطها بنفسك.</p>
          <ul role="list">
            {needsReanchor.map((r) => (
              <li key={`${r.target_kind}:${r.target_id}`}>{r.reason_ar}</li>
            ))}
          </ul>
        </details>
      )}

      <div ref={bodyRef} className="sb-book__body" data-sections={sectionsByKey.size}>
        <ArtifactContent artifact={a} showRibbon={!generating} />
      </div>

      <ConfirmDialog
        open={confirmRegen}
        onCancel={() => setConfirmRegen(false)}
        title="إنشاء نسخة جديدة من كتاب الدراسة"
        impact="تُولَّد نسخة جديدة بالقواعد والمصادر الحالية وتبقى هذه النسخة محفوظة. ملاحظاتك لا تُنقل إلى فقرات أخرى: ما بقيت فقرته يبقى مرتبطًا بها، وما اختفت فقرته يُعرض في «تحتاج إعادة ربط»."
        confirmLabel="أنشئ النسخة الجديدة"
        onConfirm={async () => {
          const scope: SourceScope = {
            mode: a.scope.mode,
            lecture_source_id: a.scope.mode === 'references_only' ? undefined : doc.detail.id,
            reference_source_ids: a.scope.source_ids.filter((x) => x !== doc.detail.id),
            version_pins: {},
            include_my_notes: false,
          };
          await act('regen', async () => (await studybookApi.createBook({ source_id: doc.detail.id, scope, regenerate: true })).book, 'بدأ توليد نسخة جديدة؛ النسخة الحالية تبقى كما هي.');
          setConfirmRegen(false);
        }}
      />
    </div>
  );
}
