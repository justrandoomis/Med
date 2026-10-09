import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { hasBidiControls, richTextFromPlain, richTextToPlain, type RichText } from '@medlevo/shared';
import { Bidi, RichTextView } from '../src/design';

describe('RichTextView (§21 bidi)', () => {
  it('isolates LTR runs inside Arabic paragraphs with <bdi dir="ltr" lang="en">', () => {
    const text = 'الجرعة 5 mg IV مرتين، ثم CT abdomen للتأكد.';
    const rt = richTextFromPlain(text);
    const { container } = render(<RichTextView value={rt} />);
    const p = container.querySelector('p')!;
    expect(p.getAttribute('dir')).toBe('rtl');
    expect(p.getAttribute('lang')).toBe('ar');
    const bdis = Array.from(container.querySelectorAll('bdi[dir="ltr"]'));
    const texts = bdis.map((b) => b.textContent);
    expect(texts).toContain('5 mg IV');
    expect(texts).toContain('CT abdomen');
    for (const b of bdis) expect(b.getAttribute('lang')).toBe('en');
  });

  it('preserves the logical text for copy/search (DOM order = stored order, no bidi controls)', () => {
    const samples = ['pH 7.35 طبيعي', 'قيمة Na+ 135 mmol/L في المختبر', 'بكتيريا H. pylori (الملوية البوابية)', 'المسار A → B → C ثم النهاية'];
    for (const s of samples) {
      const rt = richTextFromPlain(s);
      const { container, unmount } = render(<RichTextView value={rt} />);
      const p = container.querySelector('p')!;
      expect(p.textContent).toBe(richTextToPlain(rt));
      expect(p.textContent).toBe(s);
      expect(hasBidiControls(container.innerHTML)).toBe(false);
      // selecting the paragraph yields the logical string
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.selectAllChildren(p);
      expect(sel.toString()).toBe(s);
      unmount();
    }
  });

  it('renders explicit runs: marks, opposite-direction islands, list grouping, headings', () => {
    const rt: RichText = {
      v: 1,
      paragraphs: [
        { dir: 'rtl', kind: 'h', level: 1, runs: [{ t: 'الأملاح' }] },
        {
          dir: 'rtl',
          runs: [
            { t: 'تركيز ' },
            { t: 'Na', dir: 'ltr', lang: 'en', kind: 'term' },
            { t: '+', dir: 'ltr', marks: ['sup'] },
            { t: ' مهم.' },
          ],
        },
        { dir: 'rtl', kind: 'li', runs: [{ t: 'أولًا' }] },
        { dir: 'rtl', kind: 'li', runs: [{ t: 'ثانيًا' }] },
        { dir: 'ltr', runs: [{ t: 'Term: ' }, { t: 'قرحة', dir: 'rtl' }] },
      ],
    };
    const { container } = render(<RichTextView value={rt} headingOffset={2} />);
    expect(container.querySelector('h3')?.textContent).toBe('الأملاح');
    const term = container.querySelector('bdi[data-kind="term"]')!;
    expect(term.getAttribute('dir')).toBe('ltr');
    expect(term.className).toContain('ml-run--term');
    expect(container.querySelector('bdi sup')?.textContent).toBe('+');
    const lists = container.querySelectorAll('ul');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelectorAll('li')).toHaveLength(2);
    // Regression: LTR paragraphs inherited lang="ar" from <html> (English read with an Arabic voice)
    expect(container.querySelector('p[dir="ltr"]')!.getAttribute('lang')).toBe('en');
    const island = container.querySelector('p[dir="ltr"] bdi[dir="rtl"]')!;
    expect(island.getAttribute('lang')).toBe('ar');
    expect(island.textContent).toBe('قرحة');
  });

  it('renders the empty fallback and the <Bidi> helper', () => {
    const { container, getByText } = render(
      <div>
        <RichTextView value={{ v: 1, paragraphs: [] }} empty={<span>لا يوجد نص</span>} />
        <p>
          افحص <Bidi dir="ltr">CT abdomen</Bidi> أولًا
        </p>
      </div>,
    );
    expect(getByText('لا يوجد نص')).toBeTruthy();
    const b = container.querySelector('bdi')!;
    expect(b.getAttribute('dir')).toBe('ltr');
    expect(b.getAttribute('lang')).toBe('en');
  });
});
