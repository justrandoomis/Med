// The course page (§23 «تفاصيل الكورس: المحاضرات والمراجع ومصادر الأسئلة والخريطة والتقدم»): the library's course view
// gets four tabs — sources (the library's own list), the knowledge map, progress and the question coverage map.
// The tab lives in the URL (?tab=) so a link can open the map directly.
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BrainCircuit, ListChecks, RefreshCw } from 'lucide-react';
import type { CourseBrainResponse, KnowledgeMapResponse } from '@medlevo/shared';
import { Button, ErrorState, LoadingState, StatusPill, Tab, TabList, TabPanel, Tabs, useToast } from '../../design';
import { errorMessage } from '../../lib/api';
import { useQuery } from '../library/data';
import { BRAIN_PATHS, brainApi, conceptsUrl, knowledgeUrl } from './api';
import { CoverageView } from './CoverageView';
import { KnowledgeGraph } from './KnowledgeGraph';
import { extractionCut } from './model';
import { ProgressView } from './ProgressView';
import '../review/learning.css';
import './brain.css';

const TABS = [
  { value: 'sources', label: 'المصادر' },
  { value: 'map', label: 'خريطة المعرفة' },
  { value: 'progress', label: 'التقدم' },
  { value: 'coverage', label: 'تغطية الأسئلة' },
] as const;
type TabValue = (typeof TABS)[number]['value'];

export function CourseBrainTabs({ courseNodeId, sources, readOnly }: { courseNodeId: string; sources: ReactNode; readOnly?: boolean }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabValue = TABS.some((t) => t.value === raw) ? (raw as TabValue) : 'sources';
  const setTab = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === 'sources') next.delete('tab');
    else next.set('tab', v);
    setParams(next, { replace: true });
  };
  return (
    <Tabs value={tab} onValueChange={setTab} className="kb-course-tabs">
      <TabList label="أقسام الكورس">
        {TABS.map((t) => (
          <Tab key={t.value} value={t.value}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <TabPanel value="sources">{sources}</TabPanel>
      <TabPanel value="map">{tab === 'map' && <CourseMapPanel courseNodeId={courseNodeId} readOnly={readOnly} />}</TabPanel>
      <TabPanel value="progress">{tab === 'progress' && <ProgressView courseNodeId={courseNodeId} />}</TabPanel>
      <TabPanel value="coverage">{tab === 'coverage' && <CoverageView courseNodeId={courseNodeId} />}</TabPanel>
    </Tabs>
  );
}

function CourseMapPanel({ courseNodeId, readOnly }: { courseNodeId: string; readOnly?: boolean }) {
  const status = useQuery<CourseBrainResponse>(BRAIN_PATHS.course(courseNodeId), { cache: true });
  const map = useQuery<KnowledgeMapResponse>(BRAIN_PATHS.map(courseNodeId), { cache: true });
  const toast = useToast();
  const running = (status.data?.lectures ?? []).some((l) => l.job && (l.job.status === 'queued' || l.job.status === 'running'));
  // while extraction jobs run, re-read the status (real job states — never a fake percentage)
  const polls = useRef(0);
  useEffect(() => {
    if (!running) {
      polls.current = 0;
      return;
    }
    if (polls.current > 60) return;
    const t = window.setTimeout(() => {
      polls.current++;
      void status.refresh().then(() => map.refresh());
    }, 2000);
    return () => window.clearTimeout(t);
  }, [running, status, map]);

  const reExtract = async () => {
    try {
      const r = await brainApi.extract({ course_node_id: courseNodeId });
      toast.show({ title: r.jobs.length ? `بدأ استخراج هيكل ${r.jobs.length} ${r.jobs.length === 1 ? 'مصدر' : 'مصادر'} — قراراتك تبقى كما هي` : 'لا مصادر جاهزة للاستخراج الآن', tone: r.jobs.length ? 'success' : 'neutral' });
    } catch (e) {
      toast.show({ title: errorMessage(e), tone: 'danger' });
    }
  };

  if (status.loading && !status.data) return <LoadingState stage="جارٍ تحميل هيكل الكورس…" />;
  if (status.error && !status.data) return <ErrorState message={status.error.message} onRetry={() => void status.refresh()} />;
  const s = status.data!;
  return (
    <div className="lw-stack">
      {status.fromCache && <p className="lw-note">معروضة من آخر نسخة محفوظة على هذا الجهاز (دون اتصال).</p>}
      <section className="lw-sheet" aria-labelledby="cb-status">
        <div className="lw-head">
          <h3 id="cb-status" className="lw-sheet__title">
            <BrainCircuit size={20} aria-hidden="true" /> هيكل المعرفة
          </h3>
          <div className="kb-actions">
            <Link className="lw-link" to={conceptsUrl({ courseNodeId })}>
              <ListChecks size={16} aria-hidden="true" /> المفاهيم والعلاقات (تصحيح)
            </Link>
            <Link className="lw-link" to={knowledgeUrl(courseNodeId)}>
              خريطة معرفتي
            </Link>
            <Button size="sm" icon={<RefreshCw size={16} />} onClick={() => void reExtract()} disabled={readOnly || running} loading={running}>
              أعد الاستخراج
            </Button>
          </div>
        </div>
        <p className="lw-muted">
          استُخرج هيكل {s.totals.extracted} من {s.totals.lectures} {s.totals.lectures === 1 ? 'مصدر' : 'مصادر'} · {s.totals.concepts} مفهومًا · علاقات مقترحة {s.totals.relations.suggested}، مقبولة{' '}
          {s.totals.relations.accepted}، مرفوضة {s.totals.relations.rejected}
        </p>
        <ul className="kb-lectures">
          {s.lectures.map((l) => (
            <li key={l.source_id} className="kb-lecture">
              <span className="kb-lecture__title">
                <bdi>{l.title}</bdi>
              </span>
              {l.extraction ? (
                <StatusPill tone={l.extraction.current && !extractionCut(l.extraction.counts) ? 'success' : 'warning'}>
                  {!l.extraction.current
                    ? 'مستخرج بإصدار أقدم'
                    : extractionCut(l.extraction.counts)
                      ? `مستخرج جزئيًا — أول ${l.extraction.counts.mentions} من ${l.extraction.counts.mentions_found} ذكرًا`
                      : `مستخرج — ${l.extraction.counts.concepts} مفهومًا`}
                </StatusPill>
              ) : l.job && (l.job.status === 'queued' || l.job.status === 'running') ? (
                <StatusPill tone="info">{l.job.status === 'queued' ? 'في الانتظار' : 'جارٍ الاستخراج'}</StatusPill>
              ) : !l.processed ? (
                <StatusPill tone="neutral">لم تكتمل المعالجة</StatusPill>
              ) : (
                <StatusPill tone="warning">لم يُستخرج بعد</StatusPill>
              )}
              {l.extraction && l.extraction.objectives.length > 0 && (
                <details className="kb-objectives">
                  <summary>أهداف التعلم المذكورة ({l.extraction.objectives.length})</summary>
                  <ul>
                    {l.extraction.objectives.map((o) => (
                      <li key={o.region_id + o.text}>
                        <bdi>{o.text}</bdi> {o.page_label_ar && <span className="lw-muted">— {o.page_label_ar}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
        <ul className="kb-notes">
          {s.notes_ar.map((n) => (
            <li key={n} className="lw-muted">
              {n}
            </li>
          ))}
        </ul>
      </section>
      <section className="lw-sheet" aria-labelledby="cb-map">
        <h3 id="cb-map" className="lw-sheet__title">
          خريطة المعرفة: المحاضرات ↔ المفاهيم ↔ الأسئلة
        </h3>
        {map.loading && !map.data && <LoadingState stage="جارٍ رسم الخريطة…" inline />}
        {map.error && !map.data && <ErrorState message={map.error.message} onRetry={() => void map.refresh()} inline />}
        {map.data && <KnowledgeGraph data={map.data} />}
      </section>
    </div>
  );
}
