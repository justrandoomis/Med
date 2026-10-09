import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SourceNavigationContext, type SourceNavigationApi } from '../workspace/nav/SourceNavigation';
import { CitationChip } from './CitationChip';
import { ev } from './model.test';

function Where() {
  const l = useLocation();
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>;
}

function renderChip(e = ev(), nav?: SourceNavigationApi) {
  const chip = <CitationChip evidence={e} context={{ support_type: 'directly_stated', verification_status: 'linked', relation: 'supports' }} />;
  return render(
    <MemoryRouter initialEntries={['/book']}>
      <Routes>
        <Route path="/book" element={nav ? <SourceNavigationContext.Provider value={nav}>{chip}</SourceNavigationContext.Provider> : chip} />
        <Route path="/study/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const chipButton = () => screen.getByRole('button', { name: /فتح المصدر: .*محاضرة ص12/ });

afterEach(() => {
  vi.useRealTimers();
});

describe('CitationChip + EvidencePeek', () => {
  it('is a real button that opens a labelled peek (not hover-only) and moves focus into it', () => {
    renderChip();
    const b = chipButton();
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    fireEvent.mouseEnter(b);
    expect(screen.queryByRole('dialog')).toBeNull(); // hover alone opens nothing
    fireEvent.click(b);
    const dialog = screen.getByRole('dialog', { name: 'الدليل: محاضرة ص12' });
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(dialog.textContent).toContain('Ultrasound is the first-line imaging test in children.');
    expect(dialog.textContent).toContain('ص 12 (الصفحة 2 في الملف)'); // both numberings
    expect(dialog.textContent).toContain('النسخة 1');
    expect(dialog.textContent).toContain('مذكور نصًا');
    expect(dialog.textContent).toContain('مستخرج');
    expect(dialog.textContent).toContain('مرتبط بدليل');
    expect(dialog.textContent).not.toMatch(/AI Verified/i);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'افتح المصدر' }));
  });

  it('keyboard: Escape closes and returns focus to the chip; Tab past the last action closes too', () => {
    renderChip();
    fireEvent.click(chipButton());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chipButton());
    fireEvent.click(chipButton());
    fireEvent.keyDown(screen.getByRole('button', { name: 'افتح المصدر' }), { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chipButton());
  });

  it('a touch long-press opens the peek', () => {
    vi.useFakeTimers();
    renderChip();
    const anchor = chipButton().closest('.ev-chip')!;
    fireEvent.pointerDown(anchor, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('outside the workspace «افتح المصدر» goes to the exact version/page/region of the reader', async () => {
    renderChip();
    fireEvent.click(chipButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'افتح المصدر' }));
    });
    const where = screen.getByTestId('where').textContent!;
    expect(where).toContain('/study/S1?');
    expect(where).toContain('v=V1');
    expect(where).toContain('page=1');
    expect(where).toContain('region=R1');
  });

  it('inside the workspace it uses Source Jump & Back and reports a refusal instead of opening something else', async () => {
    const openSourceLocation = vi.fn().mockResolvedValue({ ok: false, reason_ar: 'هذه النسخة لم تعد موجودة.' });
    renderChip(ev(), { openSourceLocation, goBack: () => false, canGoBack: false, backLabel: null, clearHighlight: () => undefined });
    fireEvent.click(chipButton());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'افتح المصدر' }));
    });
    expect(openSourceLocation).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'S1', versionId: 'V1', pageId: 'P2', pageIndex: 1, regionId: 'R1', bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.05 } }));
    expect(screen.getByRole('alert').textContent).toContain('هذه النسخة لم تعد موجودة.');
  });

  it('a deleted source says so and cannot be opened', () => {
    renderChip(ev({ availability: 'source_deleted' }));
    expect(chipButton().getAttribute('data-available')).toBe('false');
    fireEvent.click(chipButton());
    const open = screen.getByRole('button', { name: 'افتح المصدر' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(screen.getByRole('dialog').textContent).toContain('حُذف هذا المصدر');
  });
});
