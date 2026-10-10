// Interactive study diagrams (§31, track F3) in the DOM: always labelled as re-organized (never a source figure),
// nodes are buttons with one roving tab stop and RTL-aware arrow keys, the details region shows the verified
// statement with its citation chips and the relations in words, review state is in words (not colour), the text twin
// carries the same content, and the rail panel shows the capability reason without a provider.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  FEATURE_KEYS,
  REORGANIZED_DIAGRAM_LABEL_AR,
  type CapabilitiesResponse,
  type EvidenceView,
  type FeatureKey,
  type SourcePageView,
  type StudyDiagramView,
} from '@medlevo/shared';
import { setFetchImpl } from '../../../lib/api';
import { capabilitiesStore } from '../../../lib/capabilities';
import type { SourceDocument } from '../../workspace/data/useSourceDocument';
import { DiagramPanel } from './DiagramPanel';
import { StudyDiagram } from './StudyDiagram';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function caps(state: 'available' | 'requires_configuration'): CapabilitiesResponse {
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, { key: k, state: 'available' }])) as CapabilitiesResponse['features'];
  features['ai.summaries' as FeatureKey] = state === 'available' ? { key: 'ai.summaries', state } : { key: 'ai.summaries', state, reason_ar: 'الملخصات والمخططات تحتاج مزود ذكاء اصطناعي (ANTHROPIC_API_KEY).' };
  return { features, ai: { configured: state === 'available' }, server_time: 0, app_version: 'test' };
}

const ev = (id: string, quote: string): EvidenceView => ({
  id,
  source_id: 'L1',
  source_title: 'Acute Appendicitis',
  source_type: 'lecture',
  version_id: 'V1',
  version_no: 1,
  page_id: 'P1',
  page_index: 1,
  locator_label_ar: 'ص 12 (الصفحة 2 في الملف)',
  region_id: `R-${id}`,
  region_kind: 'paragraph',
  quote,
  bbox: null,
  extraction_status: 'extracted',
  availability: 'available',
});

function diagram(over: Partial<StudyDiagramView> = {}): StudyDiagramView {
  return {
    id: 'D1',
    kind: 'flowchart',
    kind_label_ar: 'مخطط انسيابي',
    title: 'Suspected appendicitis work-up',
    label_ar: REORGANIZED_DIAGRAM_LABEL_AR,
    status: 'published',
    source_id: 'L1',
    scope_describe_ar: 'المحاضرة فقط — Acute Appendicitis (النسخة 1)',
    page_ids: ['P1'],
    nodes: [
      { key: 'N1', label: 'RIF pain', kind: 'start', order: null, time_label: null, statement: 'Pain migrates to the RIF.', claim_ids: ['C1'], verification: 'linked' },
      { key: 'N2', label: 'Alvarado score', kind: 'decision', order: null, time_label: null, statement: 'Score the patient with Alvarado.', claim_ids: ['C2'], verification: 'linked' },
      { key: 'N3', label: 'Ultrasound', kind: 'step', order: null, time_label: null, statement: 'Ultrasound is first-line in children.', claim_ids: ['C3'], verification: 'linked' },
      { key: 'N4', label: 'Surgical review', kind: 'outcome', order: null, time_label: null, statement: 'High scores need a surgical review.', claim_ids: [], verification: 'needs_review' },
    ],
    edges: [
      { from: 'N1', to: 'N2', label: null, statement: 'RIF pain leads to scoring.', claim_ids: ['C2'], verification: 'linked' },
      { from: 'N2', to: 'N3', label: 'score 5–6', statement: 'Equivocal scores are imaged.', claim_ids: ['C3'], verification: 'linked' },
      { from: 'N2', to: 'N4', label: 'score ≥ 7', statement: 'High scores go to surgery.', claim_ids: [], verification: 'needs_review' },
    ],
    claims: {
      C1: { id: 'C1', text: 'Pain migrates to the RIF.', support_type: 'directly_stated', verification_status: 'linked', citations: [{ evidence: ev('E1', 'Pain migrates to the right iliac fossa.'), relation: 'supports' }], issues: [] },
      C2: { id: 'C2', text: 'Score with Alvarado.', support_type: 'directly_stated', verification_status: 'linked', citations: [{ evidence: ev('E2', 'The Alvarado score stratifies risk.'), relation: 'supports' }], issues: [] },
      C3: { id: 'C3', text: 'Ultrasound first-line.', support_type: 'directly_stated', verification_status: 'linked', citations: [{ evidence: ev('E3', 'Ultrasound is the first-line imaging test in children.'), relation: 'supports' }], issues: [] },
    },
    removed: [{ text: 'CT is always required.', reason_ar: 'لا يدعمها دليل في النطاق.' }],
    abstain: null,
    stale_reason_ar: null,
    model: 'test',
    created_at: 1,
    ...over,
  } as StudyDiagramView;
}

/** a list item whose text (split by bidi isolates) contains the sentence */
const li = (sentence: string) => (_: string, el: Element | null) => el?.tagName === 'LI' && (el.textContent ?? '').includes(sentence);

function renderDiagram(d = diagram(), initialView: 'map' | 'list' = 'map') {
  return render(
    <MemoryRouter>
      <div dir="rtl">
        <StudyDiagram diagram={d} initialView={initialView} />
      </div>
    </MemoryRouter>,
  );
}

beforeEach(() => capabilitiesStore.reset(caps('available')));
afterEach(() => {
  setFetchImpl(null);
  capabilitiesStore.reset(null);
});

describe('StudyDiagram', () => {
  it('is labelled as re-organized with its scope; nodes are named in words (kind, verification, relations)', () => {
    renderDiagram();
    expect(screen.getByText(REORGANIZED_DIAGRAM_LABEL_AR)).toBeTruthy();
    expect(screen.getByText(/المحاضرة فقط — Acute Appendicitis/)).toBeTruthy();
    const n2 = screen.getByRole('button', { name: 'قرار: Alvarado score، مرتبط بدليل، 1 قبلها، 2 بعدها' });
    expect(n2.getAttribute('aria-pressed')).toBe('false');
    const n4 = screen.getByRole('button', { name: /Surgical review، يحتاج مراجعة/ });
    expect(n4.textContent).toContain('يحتاج مراجعة'); // review state in words, not only a dashed border
    // one tab stop
    const nodes = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-node'));
    expect(nodes.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // the parts that failed verification are only on demand, never shown as supported
    expect(screen.getByText(/أُزيل جزء واحد لم تجتز التحقق/).closest('summary')).toBeTruthy();
  });

  it('keyboard: ↓ follows a relation, ← moves to the next branch in RTL, Enter shows the verified statement with chips', () => {
    renderDiagram();
    const n1 = screen.getByRole('button', { name: /^بداية: RIF pain/ });
    n1.focus();
    fireEvent.keyDown(n1, { key: 'ArrowDown' });
    const n2 = screen.getByRole('button', { name: /^قرار: Alvarado score/ });
    expect(document.activeElement).toBe(n2);
    fireEvent.keyDown(n2, { key: 'ArrowDown' });
    const n3 = screen.getByRole('button', { name: /^خطوة: Ultrasound/ });
    expect(document.activeElement).toBe(n3);
    fireEvent.keyDown(n3, { key: 'ArrowLeft' }); // RTL: the next branch in reading order
    const n4 = screen.getByRole('button', { name: /^نتيجة: Surgical review/ });
    expect(document.activeElement).toBe(n4);
    expect(n4.tabIndex).toBe(0);
    fireEvent.keyDown(n4, { key: 'Home' });
    expect(document.activeElement).toBe(n1);
    // select N2 → details
    fireEvent.keyDown(n2, { key: 'Enter' });
    expect(n2.getAttribute('aria-pressed')).toBe('true');
    const details = screen.getByRole('region', { name: 'تفاصيل الخطوة المختارة' });
    expect(within(details).getByText('Score the patient with Alvarado.')).toBeTruthy();
    expect(within(details).getAllByRole('button', { name: /ص 12/ }).length).toBeGreaterThan(0);
    expect(within(details).getByText(li('من «Alvarado score» إلى «Ultrasound» — الشرط: score 5–6'))).toBeTruthy();
    expect(within(details).getByText(li('من «RIF pain» إلى «Alvarado score»'))).toBeTruthy();
    fireEvent.keyDown(n2, { key: 'Escape' });
    expect(n2.getAttribute('aria-pressed')).toBe('false');
  });

  it('the text twin carries the same steps (in order), relations in words, statements and chips', () => {
    renderDiagram(diagram(), 'list');
    const steps = screen.getAllByRole('listitem').filter((li) => li.className === 'dg-step');
    expect(steps.map((s) => s.querySelector('.dg-step__label')!.textContent)).toEqual(['RIF pain', 'Alvarado score', 'Ultrasound', 'Surgical review']);
    expect(screen.getByText(li('من «Alvarado score» إلى «Surgical review» — الشرط: score ≥ 7'))).toBeTruthy();
    expect(screen.getAllByText('يحتاج مراجعة').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('button', { name: /ص 12/ }).length).toBeGreaterThanOrEqual(3);
    // switching back to the map keeps the same diagram
    fireEvent.click(screen.getByRole('radio', { name: 'المخطط' }));
    expect(screen.getByRole('button', { name: /^بداية: RIF pain/ })).toBeTruthy();
  });

  it('a timeline lists its events by order with their time labels', () => {
    renderDiagram(
      diagram({
        kind: 'timeline',
        kind_label_ar: 'خط زمني',
        nodes: [
          { key: 'N2', label: 'Localised RIF pain', kind: 'event', order: 2, time_label: '12–24 h', statement: 'Pain localises.', claim_ids: [], verification: 'linked' },
          { key: 'N1', label: 'Periumbilical pain', kind: 'event', order: 1, time_label: '0–12 h', statement: 'Pain starts centrally.', claim_ids: [], verification: 'linked' },
        ],
        edges: [],
        removed: [],
      }),
      'list',
    );
    const labels = screen.getAllByRole('listitem').map((li) => li.querySelector('.dg-step__label')?.textContent);
    expect(labels).toEqual(['Periumbilical pain', 'Localised RIF pain']);
    expect(screen.getByText('0–12 h')).toBeTruthy();
  });
});

const pages = [{ id: 'P1', page_index: 1, printed_label: '12', kind: 'page', version_id: 'V1' }] as unknown as SourcePageView[];
const doc = { detail: { id: 'L1', title: 'Acute Appendicitis', links: [] }, version: { id: 'V1' }, pages } as unknown as SourceDocument;

describe('DiagramPanel (rail)', () => {
  it('without an AI provider: the reason, a disabled action, no request', async () => {
    capabilitiesStore.reset(caps('requires_configuration'));
    const calls: string[] = [];
    setFetchImpl(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return json({ diagrams: [] });
    });
    render(
      <MemoryRouter>
        <DiagramPanel doc={doc} page={pages[0]!} online />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: 'ارسم المخطط' });
    expect(btn).toHaveProperty('disabled', true);
    expect(screen.getByText('الملخصات والمخططات تحتاج مزود ذكاء اصطناعي (ANTHROPIC_API_KEY).')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.startsWith('GET /api/studybook/diagrams'))).toBe(true));
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('draws for the current page and shows an abstention with its reason', async () => {
    const posts: unknown[] = [];
    setFetchImpl(async (url, init) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ diagram: diagram({ status: 'abstained', nodes: [], edges: [], abstain: { reason: 'insufficient_evidence', reason_ar: 'لا تكفي الأدلة لرسم خطوات مترابطة.', detail: 'وُجدت خطوة واحدة فقط.' } }) });
      }
      return json({ diagrams: [] });
    });
    render(
      <MemoryRouter>
        <DiagramPanel doc={doc} page={pages[0]!} online />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ارسم المخطط' }));
    expect(await screen.findByText('لا تكفي الأدلة لرسم خطوات مترابطة.')).toBeTruthy();
    expect(screen.getByText('امتنع عن الرسم')).toBeTruthy();
    expect(posts[0]).toMatchObject({ kind: 'flowchart', source_id: 'L1', page_ids: ['P1'], topic: null });
  });
});
