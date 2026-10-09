import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { Button, ConfirmDialog, Dialog, Menu, MenuItem, Popover, SaveStatus, SegmentedControl, Tab, TabList, TabPanel, Tabs } from '../src/design';
import { isSearchShortcut } from '../src/app/shortcuts';
import { applyAppearance, normalizeAppearance } from '../src/design/ThemeProvider';

function TabsHarness({ dir }: { dir: 'rtl' | 'ltr' }) {
  const [v, setV] = useState('a');
  return (
    <div dir={dir}>
      <Tabs value={v} onValueChange={setV}>
        <TabList label="أقسام">
          <Tab value="a">الأول</Tab>
          <Tab value="b">الثاني</Tab>
          <Tab value="c" disabled>
            الثالث
          </Tab>
          <Tab value="d">الرابع</Tab>
        </TabList>
        <TabPanel value="a">لوحة 1</TabPanel>
        <TabPanel value="b">لوحة 2</TabPanel>
        <TabPanel value="c">لوحة 3</TabPanel>
        <TabPanel value="d">لوحة 4</TabPanel>
      </Tabs>
    </div>
  );
}

const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true');

describe('Tabs keyboard navigation', () => {
  it('in RTL, ArrowLeft moves to the next tab and ArrowRight to the previous (skipping disabled, wrapping)', () => {
    render(<TabsHarness dir="rtl" />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[1]);
    expect(selected()).toBe(tabs[1]);
    expect(screen.getByRole('tabpanel').textContent).toBe('لوحة 2');

    fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' }); // skips disabled "الثالث"
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: 'ArrowLeft' }); // wraps
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' }); // previous, wraps to the end
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: 'Home' });
    expect(selected()).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'End' });
    expect(selected()).toBe(tabs[3]);
  });

  it('in LTR, ArrowRight moves to the next tab', () => {
    render(<TabsHarness dir="ltr" />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(selected()).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowLeft' });
    expect(selected()).toBe(tabs[0]);
  });

  it('uses a roving tabindex and links tabs to panels', () => {
    render(<TabsHarness dir="rtl" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('أقسام');
  });
});

describe('SegmentedControl', () => {
  it('is a radiogroup with RTL-aware arrows', () => {
    function H() {
      const [v, setV] = useState('system');
      return (
        <div dir="rtl">
          <SegmentedControl
            label="السمة"
            value={v}
            onValueChange={setV}
            options={[
              { value: 'system', label: 'حسب الجهاز' },
              { value: 'light', label: 'فاتح' },
              { value: 'dark', label: 'داكن' },
            ]}
          />
        </div>
      );
    }
    render(<H />);
    expect(screen.getByRole('radiogroup', { name: 'السمة' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' });
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios[1]);
  });
});

describe('Dialog', () => {
  it('traps focus, closes on Escape and returns focus to the opener', async () => {
    function H() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>افتح</Button>
          <Dialog open={open} onClose={() => setOpen(false)} title="عنوان" footer={<Button>تأكيد</Button>}>
            <input aria-label="حقل" />
          </Dialog>
        </>
      );
    }
    render(<H />);
    const opener = screen.getByRole('button', { name: 'افتح' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'عنوان' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab from the last focusable wraps to the first
    const confirm = screen.getByRole('button', { name: 'تأكيد' });
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(confirm);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('ConfirmDialog shows the impact text and starts destructive actions on Cancel', async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmDialog open title="إنهاء الجلسة؟" impact="سيُسجَّل خروج الجهاز فورًا." confirmLabel="إنهاء الجلسة" destructive onConfirm={onConfirm} onCancel={() => {}} />);
    const dialog = screen.getByRole('alertdialog', { name: 'إنهاء الجلسة؟' });
    expect(dialog.textContent).toContain('سيُسجَّل خروج الجهاز فورًا.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'إلغاء' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'إنهاء الجلسة' }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('SaveStatus', () => {
  it('always shows text with the icon (never colour only)', () => {
    const { container } = render(
      <>
        <SaveStatus state="saved_locally" />
        <SaveStatus state="pending_sync" />
        <SaveStatus state="synced" />
        <SaveStatus state="conflict" />
        <SaveStatus state="error" />
      </>,
    );
    const texts = Array.from(container.querySelectorAll('.ml-save-status')).map((n) => n.textContent);
    expect(texts).toEqual(['محفوظ محليًا', 'ينتظر المزامنة', 'تمت المزامنة', 'تعارض', 'خطأ']);
    for (const n of container.querySelectorAll('.ml-save-status')) expect(n.querySelector('svg')).toBeTruthy();
  });
});

describe('appearance attributes', () => {
  it('applies theme, paper, motion and text scale to <html>', () => {
    const root = document.documentElement;
    applyAppearance(normalizeAppearance({ theme: 'dark', paper_texture: false, reduce_motion: 'on', text_scale: 1.3 }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-paper')).toBe('off');
    expect(root.getAttribute('data-reduce-motion')).toBe('on');
    expect(root.getAttribute('data-text-scale')).toBe('1.3');
    expect(root.style.getPropertyValue('--ml-text-scale')).toBe('1.3');
    applyAppearance(normalizeAppearance({ theme: 'system', reduce_motion: 'system', text_scale: 9 }));
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.hasAttribute('data-reduce-motion')).toBe(false);
    expect(root.getAttribute('data-text-scale')).toBe('1.6'); // clamped
  });
});

describe('nested modals', () => {
  it('only the innermost focus trap handles Tab (a confirm dialog opened from a dialog)', () => {
    // Regression: both traps listened on document; the outer one pulled focus out of the inner dialog
    // and the inner one pushed it back to its first control, so Tab always jumped to the first control.
    function H() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(false);
      return (
        <Dialog open={outer} onClose={() => setOuter(false)} title="الخارجي">
          <Button onClick={() => setInner(true)}>حذف</Button>
          <ConfirmDialog open={inner} title="تأكيد الحذف" impact="سيُحذف العنصر." confirmLabel="احذف" onConfirm={() => setInner(false)} onCancel={() => setInner(false)} />
        </Dialog>
      );
    }
    render(<H />);
    const opener = screen.getByRole('button', { name: 'حذف' });
    opener.focus(); // a real click focuses the button (jsdom's fireEvent.click does not)
    fireEvent.click(opener);
    const inner = screen.getByRole('alertdialog', { name: 'تأكيد الحذف' });
    const cancel = within(inner).getByRole('button', { name: 'إلغاء' });
    const confirm = within(inner).getByRole('button', { name: 'احذف' });
    // a middle control: Tab is left to the browser (no forced jump anywhere)
    cancel.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    // the last control wraps to the inner dialog's first control, never into the outer dialog
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(inner.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(confirm);
    // closing the inner dialog returns focus to its opener and the outer trap works again
    fireEvent.click(cancel);
    expect(screen.getByRole('dialog', { name: 'الخارجي' }).contains(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
  });
});

describe('Popover keyboard order', () => {
  it('Tab from the last control closes it and continues after the trigger; Shift+Tab from the first returns to the trigger', () => {
    // Regression: the popover is portaled to <body>, so Tab left it for the end of the page.
    render(
      <div id="root">
        <Popover label="تفاصيل" trigger={<button type="button">التفاصيل</button>}>
          <button type="button">أول</button>
          <button type="button">أخير</button>
        </Popover>
        <button type="button">بعده</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'التفاصيل' });
    fireEvent.click(trigger);
    const last = screen.getByRole('button', { name: 'أخير' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.queryByRole('dialog', { name: 'تفاصيل' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'بعده' }));

    fireEvent.click(trigger);
    const first = screen.getByRole('button', { name: 'أول' });
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog', { name: 'تفاصيل' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Menu keyboard order', () => {
  it('Tab from a menu item closes the menu and moves on from the trigger (not to the end of <body>)', () => {
    render(
      <div id="root">
        <button type="button">قبله</button>
        <Menu trigger={<button type="button">خيارات</button>}>
          <MenuItem onSelect={() => {}}>إعادة تسمية</MenuItem>
          <MenuItem onSelect={() => {}}>نقل</MenuItem>
        </Menu>
        <button type="button">بعده</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'خيارات' });
    fireEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: 'إعادة تسمية' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'بعده' }));
    fireEvent.click(trigger);
    const item2 = screen.getByRole('menuitem', { name: 'نقل' });
    item2.focus();
    fireEvent.keyDown(item2, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'قبله' }));
  });
});

describe('search shortcut', () => {
  it('is ignored while typing and while a modal makes the app inert', () => {
    const root = document.createElement('div');
    root.id = 'root';
    const input = document.createElement('input');
    root.appendChild(input);
    document.body.appendChild(root);
    try {
      const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
        const e = new KeyboardEvent('keydown', { ...init, bubbles: true });
        Object.defineProperty(e, 'target', { value: target });
        return e;
      };
      expect(isSearchShortcut(key({ key: '/' }))).toBe(true);
      expect(isSearchShortcut(key({ key: 'k', ctrlKey: true }))).toBe(true);
      expect(isSearchShortcut(key({ key: '/' }, input))).toBe(false);
      root.setAttribute('inert', '');
      expect(isSearchShortcut(key({ key: '/' }))).toBe(false);
      expect(isSearchShortcut(key({ key: 'k', metaKey: true }))).toBe(false);
    } finally {
      root.remove();
    }
  });
});
