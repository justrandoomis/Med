// Regression tests for defects found in the independent review of track A1 (library / upload / sources web).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImpactReport, LibraryNodeView, ProcessingStatusResponse } from '@medlevo/shared';
import { setFetchImpl } from '../../lib/api';
import { failedPagesLine } from '../sources/PagesPanel';
import { useProcessingStatus } from '../sources/ProcessingStatus';
import { MoveDialog } from './components/FolderPicker';
import { buildIndex } from './model';
import { ownWorkAtStake } from './TrashView';

afterEach(() => setFetchImpl(null));

function node(id: string, parent: string | null): LibraryNodeView {
  return {
    id,
    parent_id: parent,
    kind: 'folder',
    title: `Folder ${id}`,
    description: null,
    color: null,
    icon: null,
    cover: null,
    template: null,
    sort_order: 1024,
    sort_mode: 'manual',
    is_favorite: false,
    archived_at: null,
    deleted_at: null,
    created_at: 1,
    updated_at: 1,
    tags: [],
  };
}

describe('MoveDialog', () => {
  const index = buildIndex([node('A', null), node('B', null)], []);

  it('restoring: the preselected «library root» is a valid answer (was impossible to confirm)', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<MoveDialog open title="أين تريد الاستعادة؟" index={index} initial={null} allowRoot requireChange={false} confirmLabel="استعادة إلى هنا" onConfirm={onConfirm} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'استعادة إلى هنا' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('restoring a source (no root allowed): a folder must be chosen first', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<MoveDialog open title="اختر مجلدًا" index={index} initial={null} allowRoot={false} requireChange={false} confirmLabel="استعادة إلى هنا" onConfirm={onConfirm} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'استعادة إلى هنا' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Folder B/ }));
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(onConfirm).toHaveBeenCalledWith('B');
  });

  it('moving: confirming the current place stays disabled until another destination is picked', () => {
    render(<MoveDialog open title="نقل" index={index} initial="A" allowRoot onConfirm={vi.fn(async () => undefined)} onClose={vi.fn()} />);
    const confirm = screen.getByRole('button', { name: 'نقل إلى هنا' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Folder B/ }));
    expect(confirm.disabled).toBe(false);
  });
});

describe('trash: typed confirmation guards the owner’s own work', () => {
  const impact = (over: Partial<ImpactReport>): ImpactReport => ({
    nodes: 1,
    sources: 1,
    versions: 1,
    pages: 3,
    annotations: 0,
    notes: 0,
    questions: 0,
    flashcards: 0,
    artifacts: 0,
    lines_ar: [],
    ...over,
  });
  it('ink/notes and also question attempts and flashcards (review history) require typing the title', () => {
    expect(ownWorkAtStake(impact({}))).toBe(false);
    expect(ownWorkAtStake(impact({ annotations: 2 }))).toBe(true);
    expect(ownWorkAtStake(impact({ flashcards: 1 }))).toBe(true);
    expect(ownWorkAtStake(impact({ questions: 4 }))).toBe(true);
  });
});

describe('pages panel copy', () => {
  it('failed-page line uses Arabic number agreement (was «11 صفحات»)', () => {
    expect(failedPagesLine(1)).toBe('صفحة واحدة تعثّرت معالجتها');
    expect(failedPagesLine(2)).toBe('صفحتان تعثّرت معالجتهما');
    expect(failedPagesLine(3)).toBe('3 صفحات تعثّرت معالجتها');
    expect(failedPagesLine(11)).toBe('11 صفحة تعثّرت معالجتها');
  });
});

describe('useProcessingStatus', () => {
  function Probe({ refreshKey }: { refreshKey: number }) {
    const { status } = useProcessingStatus('V1', { refreshKey, intervalMs: 10 });
    return <p>{status?.job?.status ?? 'none'}</p>;
  }

  it('looks again after «retry» (refreshKey) even though polling had stopped on a finished job', async () => {
    let calls = 0;
    let jobStatus: 'completed' | 'queued' = 'completed';
    setFetchImpl(async () => {
      calls++;
      const body: ProcessingStatusResponse = { summary: null, job: { id: 'J', kind: 'process_source_version', status: jobStatus } as unknown as ProcessingStatusResponse['job'] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { rerender } = render(<Probe refreshKey={0} />);
    await screen.findByText('completed');
    await new Promise((r) => setTimeout(r, 50));
    const afterFirst = calls;
    expect(afterFirst).toBe(1); // finished job → no more polling
    jobStatus = 'queued';
    rerender(<Probe refreshKey={1} />);
    await screen.findByText('queued');
    await waitFor(() => expect(calls).toBeGreaterThan(afterFirst));
  });
});
