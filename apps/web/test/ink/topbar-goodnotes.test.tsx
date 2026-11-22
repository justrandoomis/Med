// The reading bar laid out like GoodNotes (wp/smart-rail): back + title at the leading side, the writing tools
// themselves in the bar's centre (a second tap on the active tool opens its colour / width options), undo / redo ·
// «المحادثة» · search · the rail · «⋯» at the trailing side; the views, zoom, page layout, rotation and focus mode moved
// into «⋯» (nothing lost); on a phone the writing tools float in a slim strip at the bottom. Width guards: undo / redo
// never take a slot of the writing bar in the reading bar, and a squeezed bar always keeps the pen and «المزيد».
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { SourcePageView } from '@medlevo/shared';
import { MenuItem } from '../../src/design';
import { InkProvider, InkToolbar } from '../../src/features/workspace/ink';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { TopBar, type TopBarProps } from '../../src/features/workspace/chrome/TopBar';

const pages = [0, 1].map((i) => ({ id: `P${i}`, page_index: i, printed_label: String(i + 1), kind: 'page', numbered_version: true })) as unknown as SourcePageView[];

function props(over: Partial<TopBarProps> = {}): TopBarProps {
  return {
    title: 'A very long lecture title that truncates in the bar',
    backTo: '/library',
    phone: false,
    pages,
    pageIndex: 0,
    onGoToPage: () => undefined,
    view: 'original',
    onView: vi.fn(),
    splitReason: null,
    studyBookReason: null,
    searchOpen: false,
    onToggleSearch: () => undefined,
    zoomLabel: '100%',
    fit: true,
    onZoomIn: vi.fn(),
    onZoomOut: () => undefined,
    onZoomTo: () => undefined,
    onRotate: () => undefined,
    layout: 'continuous',
    spreadReason: null,
    onLayout: () => undefined,
    flipAnimation: false,
    onFlipAnimation: () => undefined,
    focusMode: false,
    onFocusMode: vi.fn(),
    leftOpen: false,
    onToggleLeft: () => undefined,
    railOpen: false,
    onToggleRail: () => undefined,
    chatOpen: false,
    onToggleChat: () => undefined,
    saveState: 'synced',
    saveDetail: '',
    back: null,
    onBack: () => undefined,
    inkAvailable: true,
    extraMenuItems: <MenuItem onSelect={() => undefined}>أسئلة المحاضرة</MenuItem>,
    ...over,
  };
}

function bar(over: Partial<TopBarProps> = {}) {
  return render(
    <MemoryRouter>
      <InkProvider documentKey="doc-goodnotes">
        <TopBar {...props(over)} />
      </InkProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
});
afterEach(() => {
  __resetStores();
  vi.unstubAllGlobals();
});

describe('GoodNotes reading bar (tablet / desktop)', () => {
  it('one row: back + title leading, the writing tools in the centre, undo / redo · chat · search · rail · «⋯» trailing', () => {
    const { container } = bar();
    const start = container.querySelector('.wk-topbar__start')!;
    const center = container.querySelector('.wk-topbar__center')!;
    const end = container.querySelector('.wk-topbar__end')!;
    expect(within(start as HTMLElement).getByRole('link', { name: 'العودة إلى المكتبة' })).toBeTruthy();
    expect(start.querySelector('h1')!.textContent).toBe('A very long lecture title that truncates in the bar');
    const tools = within(center as HTMLElement).getByRole('toolbar', { name: 'أدوات الكتابة' });
    for (const name of ['القلم', 'قلم التظليل', 'الممحاة', 'التحديد الحر (Lasso)', 'الأشكال', 'مربع نص']) expect(within(tools).getByRole('button', { name })).toBeTruthy();
    // undo / redo left the writing bar for the trailing side
    expect(within(tools).queryByRole('button', { name: 'تراجع' })).toBeNull();
    const names = within(end as HTMLElement)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['تراجع', 'إعادة', 'المحادثة', 'البحث في المصدر', 'لوحة الدراسة', 'خيارات العرض']);
    // no zoom group / view switch in the bar any more
    expect(screen.queryByRole('group', { name: 'التكبير' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'المحاضرة الأصلية' })).toBeNull();
  });

  it('a second tap on the active tool opens its colour / width options; a third closes them', () => {
    bar();
    const tools = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    fireEvent.click(within(tools).getByRole('button', { name: 'القلم' }));
    expect(screen.queryByRole('dialog', { name: /^خيارات قلم/ })).toBeNull();
    const pen = within(tools).getByRole('button', { name: 'القلم: قلم' });
    fireEvent.pointerDown(pen);
    fireEvent.click(pen);
    const pop = screen.getByRole('dialog', { name: /^خيارات قلم/ });
    expect(within(pop).getByRole('slider')).toBeTruthy();
    fireEvent.pointerDown(pen);
    fireEvent.click(pen);
    expect(screen.queryByRole('dialog', { name: /^خيارات قلم/ })).toBeNull();
    // another tool is simply picked (no popover)
    fireEvent.click(within(tools).getByRole('button', { name: 'الممحاة' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('«⋯» holds everything that moved out of the bar: views, zoom, page layout, rotation, focus mode, the pages panel, the study tools', () => {
    bar();
    fireEvent.click(screen.getByRole('button', { name: 'خيارات العرض' }));
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
    for (const want of ['المحاضرة الأصلية', 'كتاب الدراسة', 'المحاضرة + كتاب الدراسة', 'المحاضرة + الأسئلة', 'المحاضرة + الشرح', 'جنبًا إلى جنب مع مصدر آخر', 'تكبير', 'تصغير', 'ملاءمة العرض', '100%', 'تمرير متصل', 'صفحة واحدة', 'صفحتان متقابلتان', 'تدوير مع عقارب الساعة', 'تدوير عكس عقارب الساعة', 'حركة تقليب الصفحات', 'وضع التركيز', 'أسئلة المحاضرة']) {
      expect(items.some((t) => t.includes(want)), want).toBe(true);
    }
    // the pages panel is a leading icon on a wide bar (GoodNotes' page grid)
    expect(screen.getByRole('button', { name: 'الصفحات والفهرس والعلامات' })).toBeTruthy();
  });

  it('keyboard shortcuts stay announced on the controls (pen P, undo Ctrl+Z, redo Ctrl+Shift+Z)', () => {
    bar();
    const tools = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    expect(within(tools).getByRole('button', { name: 'القلم' }).getAttribute('aria-keyshortcuts')).toBe('P');
    expect(screen.getByRole('button', { name: 'تراجع' }).getAttribute('aria-keyshortcuts')).toBe('Control+Z Meta+Z');
    expect(screen.getByRole('button', { name: 'إعادة' }).getAttribute('aria-keyshortcuts')).toBe('Control+Shift+Z Meta+Shift+Z');
  });
});

describe('GoodNotes phone bar', () => {
  it('the writing tools leave the header for a slim floating strip at the bottom; the row keeps back · title · mode · search · chat · rail · «⋯»', () => {
    const { container } = bar({ phone: true, modeSwitch: <button type="button">وضع الدراسة: تعلّم</button> });
    const header = container.querySelector('header.wk-topbar--phone')!;
    expect(within(header as HTMLElement).queryByRole('toolbar', { name: 'أدوات الكتابة' })).toBeNull();
    const strip = container.querySelector('.wk-inkstrip')!;
    expect(strip.getAttribute('role')).toBe('group');
    expect(within(strip as HTMLElement).getByRole('toolbar', { name: 'أدوات الكتابة' })).toBeTruthy();
    // on the phone the strip keeps its own undo / redo (the header has no room for them)
    expect(within(strip as HTMLElement).getByRole('button', { name: 'تراجع' })).toBeTruthy();
    expect(header.querySelector('.wk-topbar__row')!.children).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'خيارات القراءة' }));
    expect(screen.getByRole('menuitem', { name: 'الصفحات والفهرس والعلامات' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^تكبير/ })).toBeTruthy();
  });
});

describe('the pen is never laid under the bar (width guards)', () => {
  it('a squeezed writing bar keeps the pen and «المزيد»; in the reading bar undo / redo never take its slots', () => {
    let cb: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(fn: ResizeObserverCallback) {
          cb = fn;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    render(
      <InkProvider documentKey="doc-narrow">
        <InkToolbar history="external" />
      </InkProvider>,
    );
    const tools = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    // 3 slots of 40 px: the pen, the options, then «المزيد» — never undo first
    act(() => cb!([{ contentRect: { width: 3 * 44 + 12 + 40 } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(within(tools).getByRole('button', { name: /^القلم/ })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: 'المزيد من أدوات الكتابة' })).toBeTruthy();
    expect(within(tools).queryByRole('button', { name: 'تراجع' })).toBeNull();
    // a 0 px measure (squeezed) still keeps the pen + «المزيد»
    act(() => cb!([{ contentRect: { width: 0 } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(within(tools).getByRole('button', { name: /^القلم/ })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: 'المزيد من أدوات الكتابة' })).toBeTruthy();
  });

  it('workspace.css keeps the minimum widths that stop the slots from lying over each other', () => {
    const css = readFileSync(join(__dirname, '../../src/features/workspace/workspace.css'), 'utf8');
    expect(css).toMatch(/\.wk-topbar__center:has\(> \.wk-topbar__ink\) \{\s*min-width: 22rem;/);
    expect(css).toMatch(/\.wk-topbar__end \{[^}]*min-width: max-content;/);
    expect(css).toMatch(/\.wk-topbar__center \{[^}]*min-width: 0;/);
  });
});
