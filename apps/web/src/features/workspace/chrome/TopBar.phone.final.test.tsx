// Round 7 final verification — the phone reading bar (AC-04, §26, §55). Found by the real-server E2E
// `g1-ac04-printed-page.spec.ts` «detected labels» on the phone: at 390 px the bar held back · title column · save state
// · mode · search · rail · more, which left the title column ~60 px wide; the compact page indicator («الصفحة 1 في الملف
// 1/14», ~155 px; even «ص 12 14/14», ~94 px) ran under the save icon and the mode switch, and the save icon took the taps
// meant for «الانتقال إلى صفحة». jsdom has no layout, so these tests pin the STRUCTURE the fix relies on (the geometry is
// asserted in the E2E spec): the save state lives on the title line (not as a row item of its own), and the compact
// indicator drops the «n/N» count when its label already IS the file position.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SourcePageView } from '@medlevo/shared';
import { GoToPage } from './GoToPage';
import { TopBar, type TopBarProps } from './TopBar';

/** a book with two unnumbered front-matter pages, then pages printed 1, 2, 3 */
const book = [null, null, '1', '2', '3'].map(
  (printed_label, page_index) => ({ id: `P${page_index}`, page_index, printed_label, kind: 'page', numbered_version: true }) as unknown as SourcePageView,
);
/** a document without any printed number */
const plain = [0, 1, 2].map((page_index) => ({ id: `Q${page_index}`, page_index, printed_label: null, kind: 'page', numbered_version: false }) as unknown as SourcePageView);

function bar(over: Partial<TopBarProps>) {
  const props: TopBarProps = {
    title: 'G1 front matter detected phone',
    backTo: '/library',
    phone: true,
    pages: book,
    pageIndex: 0,
    onGoToPage: () => undefined,
    view: 'original',
    onView: () => undefined,
    splitReason: null,
    studyBookReason: null,
    searchOpen: false,
    onToggleSearch: () => undefined,
    zoomLabel: '100%',
    fit: true,
    onZoomIn: () => undefined,
    onZoomOut: () => undefined,
    onZoomTo: () => undefined,
    onRotate: () => undefined,
    layout: 'continuous',
    spreadReason: null,
    onLayout: () => undefined,
    flipAnimation: false,
    onFlipAnimation: () => undefined,
    focusMode: false,
    onFocusMode: () => undefined,
    leftOpen: false,
    onToggleLeft: () => undefined,
    railOpen: false,
    onToggleRail: () => undefined,
    saveState: 'synced',
    saveDetail: '',
    back: null,
    onBack: () => undefined,
    inkAvailable: false,
    modeSwitch: <button type="button">وضع الدراسة: تعلّم</button>,
    ...over,
  };
  return render(
    <MemoryRouter>
      <TopBar {...props} />
    </MemoryRouter>,
  );
}

describe('phone reading bar (Round 7 final)', () => {
  it('the save state is on the title line, not an item of the row next to the page indicator', () => {
    const { container } = bar({});
    const row = container.querySelector('.wk-topbar--phone .wk-topbar__row')!;
    const save = container.querySelector('.ml-save-status')!;
    expect(save).toBeTruthy();
    // not a direct child of the row (that is what squeezed the title column to ~60 px)
    expect(save.parentElement).not.toBe(row);
    const titleLine = save.closest('.wk-topbar__titleline')!;
    expect(titleLine).toBeTruthy();
    expect(titleLine.querySelector('h1')?.textContent).toBe('G1 front matter detected phone');
    // the indicator is the title column's own line, after the title line
    const column = container.querySelector('.wk-topbar__title')!;
    expect(Array.from(column.children).map((c) => c.className)).toEqual(['wk-topbar__titleline', 'wk-pageind wk-pageind--compact']);
    // the row: back · title column · mode switch · search · rail · more — five controls around the title
    expect(row.children).toHaveLength(6);
    // still announced: the compact state keeps its words for screen readers
    expect(save.textContent).toContain('تمت المزامنة');
  });

  it('an unnumbered page in a numbered book: the compact indicator shows only «الصفحة 1 في الملف»; the total stays in its name', () => {
    bar({ pageIndex: 0 });
    const trigger = screen.getByRole('button', { name: /الانتقال إلى صفحة/ });
    expect(trigger.querySelector('.wk-pageind__primary')?.textContent).toBe('الصفحة 1 في الملف');
    expect(trigger.querySelector('.wk-pageind__count')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('الصفحة 1 في الملف، 1 من 5. الانتقال إلى صفحة');
  });

  it('a printed page keeps its count on the phone; the desktop indicator is unchanged for every page', () => {
    const { unmount } = bar({ pageIndex: 3 });
    let trigger = screen.getByRole('button', { name: /الانتقال إلى صفحة/ });
    expect(trigger.querySelector('.wk-pageind__primary')?.textContent).toBe('ص 2');
    expect(trigger.querySelector('.wk-pageind__count')?.textContent).toBe('4/5');
    unmount();

    // a document without printed numbers: «ص N» is the file position and its count stays too
    const plainBar = render(<GoToPage pages={plain} pageIndex={1} onGo={() => undefined} compact />);
    trigger = screen.getByRole('button', { name: /الانتقال إلى صفحة/ });
    expect(trigger.querySelector('.wk-pageind__primary')?.textContent).toBe('ص 2');
    expect(trigger.querySelector('.wk-pageind__count')?.textContent).toBe('2/3');
    plainBar.unmount();

    render(<GoToPage pages={book} pageIndex={0} onGo={() => undefined} />);
    trigger = screen.getByRole('button', { name: /الانتقال إلى صفحة/ });
    expect(trigger.querySelector('.wk-pageind__primary')?.textContent).toBe('الصفحة 1 في الملف');
    expect(trigger.querySelector('.wk-pageind__count')?.textContent).toBe('1/5');
  });
});
