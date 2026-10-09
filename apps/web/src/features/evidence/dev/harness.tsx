// DEV-ONLY harness for the evidence components (vite dev server: /src/features/evidence/dev/harness.html,
// /api proxied to a real server). Not part of the production build (vite builds index.html only).
// It loads REAL evidence of a processed source (the first lecture in the library) and arranges it as an
// ArtifactView so chips, peek, Source Inspector (real page render), ribbon, abstention, scope picker and
// content alerts can be looked at. The claim statuses below are display fixtures of this harness only.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/noto-naskh-arabic/400.css';
import '@fontsource/noto-naskh-arabic/600.css';
import '../../../design/tokens.css';
import '../../../design/base.css';
import '../../../design/components.css';
import type { ArtifactView, EvidenceView, LibraryTreeResponse, PageRegionsResponse, SourcePagesResponse, SourceScope } from '@medlevo/shared';
import { applyAppearance, appearanceStore } from '../../../design';
import { api } from '../../../lib/api';
import { ArtifactContent, ContentAlertsPanel, ScopeBadge, ScopePicker } from '../index';

applyAppearance(appearanceStore.get());
const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.setAttribute('data-theme', theme);

async function loadEvidence(): Promise<{ lectureId: string; evidence: EvidenceView[] }> {
  const tree = await api.get<LibraryTreeResponse>('/library/tree');
  const lecture = tree.sources.find((s) => s.source_type === 'lecture' && s.active_version_id)!;
  const pages = await api.get<SourcePagesResponse>(`/sources/${lecture.id}/versions/${lecture.active_version_id}/pages`);
  const wanted = ['white cell count above 11', 'Ultrasound is the first-line', 'CT abdomen is preferred', 'يبدأ الألم'];
  const out: EvidenceView[] = [];
  for (const p of pages.pages) {
    const regs = await api.get<PageRegionsResponse>(`/sources/pages/${p.id}/regions`);
    for (const r of regs.regions) {
      if (r.text && wanted.some((w) => r.text!.includes(w))) {
        out.push((await api.post<{ evidence: EvidenceView }>('/evidence/from-region', { region_id: r.id })).evidence);
      }
    }
  }
  return { lectureId: lecture.id, evidence: out };
}

function makeArtifact(e: EvidenceView[], lectureId: string): ArtifactView {
  const [wcc, us, ct, ar] = [
    e.find((x) => x.quote.includes('white cell'))!,
    e.find((x) => x.quote.includes('Ultrasound'))!,
    e.find((x) => x.quote.includes('CT abdomen'))!,
    e.find((x) => x.quote.includes('الألم'))!,
  ];
  const cl = (id: string, status: 'linked' | 'needs_review' | 'conflict', ev: EvidenceView, relation: 'supports' | 'contradicts' = 'supports') => ({
    id,
    text: id,
    support_type: 'derived' as const,
    verification_status: status,
    citations: [{ evidence: ev, relation }],
    issues: status === 'linked' ? [] : [{ check: 'entailment' as const, reason_ar: 'لم يُجرَ التحقق المستقل من الدعم: خدمة الذكاء الاصطناعي غير مُعدّة.' }],
  });
  return {
    id: 'HARNESS',
    lineage_id: 'HARNESS',
    version_no: 1,
    kind: 'explanation',
    title: 'الفحوصات في التهاب الزائدة',
    primary_source_id: lectureId,
    scope: { mode: 'lecture_only', source_ids: [lectureId], version_ids: [us.version_id], describe_ar: `المحاضرة فقط — محاضرة: ${us.source_title} (النسخة ${us.version_no})` },
    params: {},
    status: 'published',
    model: null,
    rules_version: 'harness',
    coverage: { missing_ar: ['جدول مقياس Alvarado لم يُشرح بعد.'] },
    is_frozen: false,
    stale_reason: null,
    created_at: Date.now(),
    published_at: Date.now(),
    blocks: [
      { id: 'B0', block_key: 'h', section_key: null, ord: 0, kind: 'heading', content: { v: 1, paragraphs: [{ dir: 'rtl', kind: 'h', level: 1, runs: [{ t: 'متى نطلب التصوير؟' }] }] }, table: null, source_region_ids: [], status: 'complete', verification_status: 'not_applicable' },
      {
        id: 'B1',
        block_key: 'p1',
        section_key: null,
        ord: 1,
        kind: 'paragraph',
        content: {
          v: 1,
          paragraphs: [
            {
              dir: 'rtl',
              runs: [
                { t: 'الفحص الأول عند الأطفال والحوامل هو ', claim: 'C1' },
                { t: 'Ultrasound', dir: 'ltr', kind: 'term', claim: 'C1' },
                { t: '. ' },
                { t: 'ويُفضَّل ', claim: 'C2' },
                { t: 'CT abdomen', dir: 'ltr', kind: 'term', claim: 'C2' },
                { t: ' عند البالغين إذا بقي التشخيص غير مؤكد.', claim: 'C2' },
              ],
            },
            {
              dir: 'rtl',
              runs: [
                { t: 'عدد كريات الدم البيضاء فوق ', claim: 'C3' },
                { t: '11 ×10⁹/L', dir: 'ltr', kind: 'unit', claim: 'C3' },
                { t: ' يدعم التشخيص، والعدد الطبيعي يستبعده تمامًا.', claim: 'C4' },
              ],
            },
          ],
        },
        table: null,
        source_region_ids: [],
        status: 'complete',
        verification_status: 'needs_review',
      },
      {
        id: 'B2',
        block_key: 'q',
        section_key: null,
        ord: 2,
        kind: 'original_quote',
        content: { v: 1, paragraphs: [{ dir: 'rtl', kind: 'quote', runs: [{ t: ar.quote, kind: 'original_quote', claim: 'C5' }] }] },
        table: null,
        source_region_ids: [],
        status: 'complete',
        verification_status: 'linked',
      },
    ],
    claims: { C1: cl('C1', 'linked', us), C2: cl('C2', 'needs_review', ct), C3: cl('C3', 'linked', wcc), C4: cl('C4', 'conflict', wcc, 'contradicts'), C5: cl('C5', 'linked', ar) },
    removed: [{ text: 'A white cell count above 12 ×10⁹/L is diagnostic.', reason_ar: 'القيم العددية 12 غير موجودة في الدليل المستشهد به.' }],
    abstain: null,
  };
}

function Harness() {
  const [data, setData] = useState<{ lectureId: string; evidence: EvidenceView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  useEffect(() => {
    loadEvidence().then(setData, (e) => setError(String(e)));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>…</p>;
  const artifact = makeArtifact(data.evidence, data.lectureId);
  const scope: SourceScope = { mode: 'lecture_only', lecture_source_id: data.lectureId, reference_source_ids: [], version_pins: {}, include_my_notes: false };
  const abstained: ArtifactView = {
    ...artifact,
    id: 'HARNESS2',
    title: 'سؤال خارج المحاضرة',
    blocks: [],
    claims: {},
    removed: [],
    coverage: null,
    abstain: {
      reason: 'not_found_in_scope',
      reason_ar: 'لم أجد هذه المعلومة في المصادر المسموحة ضمن النطاق الحالي.',
      detail: 'بُحث في 4 صفحات معالَجة من مصدر واحد ضمن النطاق.',
      suggest_scope: { ...scope, mode: 'lecture_plus_references', reference_source_ids: ['REF'] },
    },
  };
  return (
    <main className="ml-page" style={{ display: 'grid', gap: 'var(--ml-space-6)' }}>
      <h1 className="ml-page__title">Evidence harness</h1>
      <section data-harness="artifact">
        <ArtifactContent artifact={artifact} />
      </section>
      <section data-harness="abstain">
        <ArtifactContent artifact={abstained} onWidenScope={() => setApplied('widen')} />
      </section>
      <section data-harness="scope" style={{ maxWidth: '36rem' }}>
        <ScopeBadge scope={{ mode: 'lecture_only', describe_ar: artifact.scope.describe_ar, source_ids: [data.lectureId] }} detailed />
        <ScopePicker value={scope} onApply={(s) => setApplied(s.mode)} />
        {applied && <p data-applied={applied}>{applied}</p>}
      </section>
      <section data-harness="alerts" style={{ maxWidth: '44rem' }}>
        <ContentAlertsPanel status="all" />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <Harness />
    </MemoryRouter>
  </StrictMode>,
);
