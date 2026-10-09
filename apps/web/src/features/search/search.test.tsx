import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SearchResponse, SearchResult } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import type { NoteRow } from '../../lib/localdb';
import { BidiText } from '../evidence/BidiText';
import { searchNotesLocally } from './localSearch';
import { groupResults, ResultItem, resultHref, resultsAr, SearchScreen } from './SearchScreen';

const result = (over: Partial<SearchResult>): SearchResult => ({
  type: 'chunks',
  id: 'C1',
  title: 'Acute Appendicitis',
  snippet: { text: 'يبدأ الألم حول السرة', highlights: [{ start: 5, end: 10 }] },
  location: { source_id: 'S1', version_id: 'V1', page_id: 'P1', page_index: 0, page_label_ar: 'ص 11 (الصفحة 1 في الملف)', region_id: 'R1' },
  origin: 'source',
  source_type: 'lecture',
  source_title: 'Acute Appendicitis',
  is_evidence: false,
  ...over,
});

afterEach(() => setFetchImpl(null));

describe('bidi-safe highlighted snippets', () => {
  it('a highlight never splits an LTR island (no visual reordering of «11 ×10⁹/L»)', () => {
    const text = 'عدد الكريات فوق 11 ×10⁹/L يدعم التشخيص';
    const start = text.indexOf('11');
    const { container } = render(<BidiText text={text} highlights={[{ start, end: start + 2 }]} />);
    const islands = container.querySelectorAll('bdi[dir="ltr"]');
    expect(islands).toHaveLength(1);
    expect(islands[0]!.textContent).toBe('11 ×10⁹/L');
    expect(islands[0]!.querySelector('mark')!.textContent).toBe('11');
    expect(container.textContent).toBe(text); // logical order, nothing inserted
  });
});

describe('search results', () => {
  it('generated results form the last group and are labelled as not evidence', () => {
    const groups = groupResults([result({ origin: 'generated', type: 'generated', id: 'G' }), result({}), result({ type: 'notes', origin: 'owner_note', id: 'N' })]);
    expect(groups.map((g) => g.type)).toEqual(['chunks', 'notes', 'generated']);
    render(
      <MemoryRouter>
        <ul>
          <ResultItem r={result({ origin: 'generated', type: 'generated' })} />
        </ul>
      </MemoryRouter>,
    );
    expect(screen.getByText('مولَّد — ليس دليلًا')).toBeTruthy();
  });

  it('counts results with Arabic agreement', () => {
    expect([1, 2, 3, 11].map(resultsAr)).toEqual(['نتيجة واحدة', 'نتيجتان', '3 نتائج', '11 نتيجة']);
  });

  it('opens the exact place: version, page and region', () => {
    expect(resultHref(result({}))).toBe('/study/S1?v=V1&page=0&page_id=P1&region=R1');
    expect(resultHref(result({ location: null }))).toBeNull();
  });

  it('offline: searches this device’s notes with Arabic normalization; deleted notes are skipped', () => {
    const note = (id: string, text: string, deletedAt: number | null = null): NoteRow =>
      ({ id, body: { v: 1, paragraphs: [{ dir: 'rtl', runs: [{ t: text }] }] }, title: null, updatedAt: 1, syncState: 'synced', deletedAt }) as NoteRow;
    const r = searchNotesLocally([note('N1', 'يبدأ الألم حول السرة'), note('N2', 'الألم المحذوف', 5), note('N3', 'نص آخر')], 'الالم');
    expect(r.map((x) => x.id)).toEqual(['N1']);
    expect(r[0]!.snippet.text.slice(r[0]!.snippet.highlights[0]!.start, r[0]!.snippet.highlights[0]!.end)).toBe('الألم');
    expect(r[0]!.origin).toBe('owner_note');
  });

  it('the screen renders grouped results with origin badges and page labels from the server', async () => {
    const response: SearchResponse = {
      query: 'الالم',
      mode: 'keyword',
      results: [result({}), result({ id: 'G1', type: 'generated', origin: 'generated', title: 'ملخص مولَّد', location: { source_id: 'S1', version_id: null, page_id: null, page_index: null, page_label_ar: null, region_id: null } })],
      next_cursor: null,
      expansions: [],
      searched_types: ['chunks', 'questions', 'notes', 'generated', 'transcripts'],
      notices_ar: ['التفريغ الصوتي غير متاح بعد، فلا يوجد ما يُبحث فيه من التسجيلات.'],
    };
    setFetchImpl(async (url) => {
      const body = url.startsWith('/api/search')
        ? response
        : url.startsWith('/api/capabilities')
          ? { features: { 'search.semantic': { key: 'search.semantic', state: 'requires_configuration', reason_ar: 'يحتاج مزود embeddings' } }, ai: { configured: false }, server_time: 1, app_version: 't' }
          : { nodes: [], sources: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    render(
      <MemoryRouter initialEntries={['/search?q=%D8%A7%D9%84%D8%A7%D9%84%D9%85']}>
        <SearchScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('heading', { name: 'من المصادر (1)' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'محتوى مولَّد — ليس دليلًا (1)' })).toBeTruthy();
    expect(screen.getByText('ص 11 (الصفحة 1 في الملف)')).toBeTruthy();
    expect(screen.getByText('من المصدر')).toBeTruthy();
    expect(screen.getByText(/التفريغ الصوتي غير متاح/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'دلالي' }).getAttribute('aria-disabled') ?? (screen.getByRole('radio', { name: 'دلالي' }) as HTMLButtonElement).disabled.toString()).toMatch(/true/);
    expect(screen.getByText('يحتاج مزود embeddings')).toBeTruthy();
    expect(screen.getByText('نتيجتان')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acute Appendicitis' }).getAttribute('href')).toBe('/study/S1?v=V1&page=0&page_id=P1&region=R1');
  });
});

describe('review regressions (C1 adversarial review)', () => {
  it('overlapping highlight ranges never print the same characters twice', () => {
    const { container } = render(<BidiText text="abdominal pain" highlights={[{ start: 0, end: 5 }, { start: 3, end: 9 }]} />);
    expect(container.textContent).toBe('abdominal pain');
  });

  it('offline exact mode matches the phrase as typed (not the normalized words)', () => {
    const note = (id: string, text: string): NoteRow => ({ id, body: { v: 1, paragraphs: [{ dir: 'ltr', runs: [{ t: text }] }] }, title: null, updatedAt: 1, syncState: 'synced', deletedAt: null }) as NoteRow;
    const notes = [note('N1', 'a normal count does NOT exclude it'), note('N2', 'exclude it? not with a normal count')];
    expect(searchNotesLocally(notes, 'does NOT exclude', 50, 'exact').map((x) => x.id)).toEqual(['N1']);
    expect(searchNotesLocally(notes, 'does NOT exclude', 50, 'keyword').map((x) => x.id)).toEqual(['N1']);
    expect(searchNotesLocally(notes, 'exclude not', 50, 'exact')).toEqual([]);
    expect(searchNotesLocally(notes, 'exclude not', 50, 'keyword').map((x) => x.id)).toEqual(['N1', 'N2']);
  });

  it('«إعادة المحاولة» after a server error really searches again', async () => {
    let calls = 0;
    const ok: SearchResponse = { query: 'x', mode: 'keyword', results: [result({})], next_cursor: null, expansions: [], searched_types: ['chunks'], notices_ar: [] };
    setFetchImpl(async (url) => {
      if (url.startsWith('/api/search')) {
        calls++;
        if (calls === 1) return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'خطأ مؤقت في الخادم' } }), { status: 500, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify(ok), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = url.startsWith('/api/capabilities') ? { features: {}, ai: { configured: false }, server_time: 1, app_version: 't' } : { nodes: [], sources: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    render(
      <MemoryRouter initialEntries={['/search?q=x']}>
        <SearchScreen />
      </MemoryRouter>,
    );
    const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'من المصادر (1)' })).toBeTruthy());
    expect(calls).toBe(2);
  });
});
