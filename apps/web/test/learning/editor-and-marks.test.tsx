// Card editor pieces: the occlusion mask editor's keyboard path (add, move, resize, delete, label), the selection →
// exact excerpt lookup (whitespace-tolerant, never a guessed paragraph), «أضف إلى المراجعة» marks, and the planner day
// list showing the PLAN's timezone and calendar days.
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import type { SourceRegionView } from '@medlevo/shared';
import { getDb } from '../../src/lib/localdb';
import { OcclusionEditor, type MaskDraft } from '../../src/features/review/components/OcclusionEditor';
import { locateQuote, regionForQuote } from '../../src/features/review/selectionDraft';
import { addRevisionMark, isRevisionMark, toRevisionMark } from '../../src/features/review/local/revisionMarks';
import { DayList } from '../../src/features/planner/DayList';
import { clearDb } from './helpers';

beforeEach(async () => {
  await clearDb();
});

function Harness({ onState }: { onState: (m: MaskDraft[]) => void }) {
  const [masks, setMasks] = useState<MaskDraft[]>([]);
  return (
    <OcclusionEditor
      imageUrl="blob:test"
      masks={masks}
      onChange={(m) => {
        setMasks(m);
        onState(m);
      }}
    />
  );
}

describe('occlusion editor — keyboard alternative', () => {
  it('adds a centred mask, moves / resizes it with arrows, names it, deletes it', async () => {
    let state: MaskDraft[] = [];
    render(<Harness onState={(m) => (state = m)} />);
    fireEvent.click(screen.getByRole('button', { name: 'أضف منطقة' }));
    expect(state).toHaveLength(1);
    const before = state[0]!.box;
    const mask = await screen.findByRole('button', { name: /^المنطقة 1 \(بلا اسم بعد\)/ });
    fireEvent.keyDown(mask, { key: 'ArrowRight' });
    expect(state[0]!.box.x).toBeCloseTo(before.x + 0.01, 6);
    fireEvent.keyDown(mask, { key: 'ArrowDown', shiftKey: true });
    expect(state[0]!.box.y).toBeCloseTo(before.y + 0.05, 6);
    fireEvent.keyDown(mask, { key: 'ArrowRight', altKey: true });
    expect(state[0]!.box.w).toBeCloseTo(before.w + 0.01, 6);
    // the label field (the answer) is reachable and labelled
    fireEvent.change(screen.getByLabelText(/^اسم المنطقة 1 \(الجواب\)/), { target: { value: 'Caecum' } });
    expect(state[0]!.label).toBe('Caecum');
    expect(screen.getByRole('button', { name: /^المنطقة 1: Caecum/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: /^المنطقة 1: Caecum/ }), { key: 'Delete' });
    expect(state).toHaveLength(0);
  });

  it('correcting one card: only its own mask is editable, the others are context', () => {
    const masks: MaskDraft[] = [
      { id: 'a', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, label: 'A' },
      { id: 'b', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, label: 'B' },
    ];
    render(<OcclusionEditor imageUrl="blob:test" masks={masks} onChange={() => undefined} onlyMaskId="b" />);
    expect(screen.queryByRole('button', { name: 'أضف منطقة' })).toBeNull();
    expect(screen.getByRole('button', { name: /^المنطقة 1: A/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: /^المنطقة 2: B/ }).getAttribute('tabindex')).toBe('0');
    expect(screen.queryByLabelText(/^اسم المنطقة 1 \(الجواب\)/)).toBeNull();
    expect(screen.getByLabelText(/^اسم المنطقة 2 \(الجواب\)/)).toBeTruthy();
  });
});

describe('selection → exact excerpt', () => {
  const region = (id: string, text: string, extra: Partial<SourceRegionView> = {}): SourceRegionView => ({
    id,
    version_id: 'V',
    page_id: 'P',
    parent_region_id: null,
    kind: 'paragraph',
    reading_order: 0,
    bbox: { x: 0, y: 0, w: 1, h: 0.1 },
    locator: null,
    text,
    text_origin: 'digital',
    lang: 'en',
    confidence: null,
    structure: null,
    status: 'extracted',
    ...extra,
  });
  it('finds the quote despite whitespace differences and returns offsets into the region text', () => {
    const text = 'The appendix  is\na blind-ended tube.';
    expect(locateQuote(text, 'appendix is a blind-ended')).toEqual({ start: 4, end: 30 });
    expect(locateQuote(text, 'not there')).toBeNull();
  });
  it('picks the region under the selection that contains the quote; cites the first one whole when it spans', () => {
    const regions = [region('R1', 'Intro paragraph.'), region('R2', 'McBurney point tenderness is classic.')];
    expect(regionForQuote(regions, ['R1', 'R2'], 'point tenderness')).toEqual({ region_id: 'R2', start: 9, end: 25, whole: false });
    expect(regionForQuote(regions, ['R1', 'R2'], 'paragraph. McBurney')).toEqual({ region_id: 'R1', start: null, end: null, whole: true });
  });
  it('without selection rectangles it searches the page text, and never guesses a paragraph that does not contain the quote', () => {
    const regions = [region('R1', 'Intro paragraph.'), region('R2', 'McBurney point.')];
    expect(regionForQuote(regions, [], 'McBurney')).toMatchObject({ region_id: 'R2', whole: false });
    expect(regionForQuote(regions, [], 'Rovsing sign')).toBeNull();
  });
});

describe('«أضف إلى المراجعة»', () => {
  it('saves a page mark locally with its op (synced like every annotation) and is recognised as a revision mark', async () => {
    const db = getDb();
    const row = await addRevisionMark(db, { type: 'page', source_id: 'S1', version_id: 'V1', page_id: 'P3', page_index: 2, space: 'page_norm' }, { quote: '  The appendix …  ', pageLabel: 'ص 3', sourceTitle: null });
    expect(isRevisionMark(row)).toBe(true);
    expect(toRevisionMark(row)).toMatchObject({ sourceId: 'S1', pageId: 'P3', pageIndex: 2, data: { label: 'للمراجعة', revision: true, quote: 'The appendix …', page_label: 'ص 3' } });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity_type: 'annotation', op: 'upsert', entity_id: row.id });
    expect(isRevisionMark({ kind: 'bookmark', data: { v: 1 }, deletedAt: null })).toBe(false); // a plain page bookmark is not one
  });
});

describe('planner day list', () => {
  it('shows the plan timezone and calendar days (today first among upcoming), with check-off', () => {
    const tasks = [
      { id: 'a', plan_id: 'P', day: '2026-10-10', kind: 'learn' as const, title_ar: 'تعلّم «Shock» — ص 1–8', ref: { source_id: 'S1', page_from: 1, page_to: 8 }, minutes: 32, status: 'todo' as const, moved_from_day: null },
      { id: 'b', plan_id: 'P', day: '2026-10-11', kind: 'mcq' as const, title_ar: 'أسئلة على «Shock»', ref: { source_id: 'S1' }, minutes: 15, status: 'todo' as const, moved_from_day: '2026-10-09' },
    ];
    const set: Array<[string, string]> = [];
    render(
      <MemoryRouter>
        <DayList tasks={tasks} today="2026-10-10" timezone="Asia/Baghdad" dailyMinutes={60} onSet={(t, s) => set.push([t.id, s])} />
      </MemoryRouter>,
    );
    expect(screen.getByText('الأيام بتوقيت الخطة: Asia/Baghdad')).toBeTruthy();
    const days = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(days).toEqual(['اليوم — السبت 10 أكتوبر', 'غدًا — الأحد 11 أكتوبر']);
    expect(screen.getByText(/نُقلت إليه من أمس/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /تعلّم «Shock»/ }));
    expect(set).toEqual([['a', 'done']]);
    expect(screen.getByRole('link', { name: 'افتح في الكتاب' }).getAttribute('href')).toBe('/study/S1?page=0');
  });
});
