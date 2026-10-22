// GATE-1 critic pass (2026-10-22): axe-core reported a SERIOUS `label-content-name-mismatch` (WCAG 2.5.3 «label in
// name») on the reader's page indicator in every look (light, dark, e-ink) at 390 and 1280 px: the button showed
// «ص 2 4/5» but was named «ص 2، 4 من 5. الانتقال إلى صفحة» — a speech-control user saying what they see («ص 2 4/5»)
// could not reach it, and with a printed page the file position sat inside parentheses, which axe (and speech tools)
// drop. The name now starts with the visible words in their order; the spoken extras follow them.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SourcePageView } from '@medlevo/shared';
import { GoToPage } from './GoToPage';

const book = [null, null, '1', '2', '3'].map(
  (printed_label, page_index) => ({ id: `P${page_index}`, page_index, printed_label, kind: 'page', numbered_version: true }) as unknown as SourcePageView,
);
const plain = [0, 1, 2].map((page_index) => ({ id: `Q${page_index}`, page_index, printed_label: null, kind: 'page', numbered_version: false }) as unknown as SourcePageView);

/** axe's tokens: parentheticals removed, anything but letters / digits is a separator */
const tokens = (s: string) =>
  s
    .replace(/\([^()]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
function containsInOrder(name: string, visible: string): boolean {
  const n = tokens(name);
  const v = tokens(visible);
  for (let i = 0; i + v.length <= n.length; i++) if (v.every((t, j) => n[i + j] === t)) return true;
  return false;
}

describe('GATE-1: the page indicator’s name contains what it shows (WCAG 2.5.3)', () => {
  const cases: Array<[string, readonly SourcePageView[], number, boolean]> = [
    ['plain document, desktop', plain, 1, false],
    ['plain document, phone', plain, 1, true],
    ['printed page, desktop (file position shown beside it)', book, 3, false],
    ['printed page, phone', book, 3, true],
    ['unnumbered front matter, phone', book, 0, true],
    ['unnumbered front matter, desktop', book, 0, false],
  ];
  it.each(cases)('%s', (_label, pages, pageIndex, compact) => {
    render(<GoToPage pages={pages} pageIndex={pageIndex} onGo={() => undefined} compact={compact} />);
    const trigger = screen.getByRole('button', { name: /الانتقال إلى صفحة/ });
    const name = trigger.getAttribute('aria-label')!;
    const visible = trigger.textContent!;
    expect(containsInOrder(name, visible), `«${visible}» in «${name}»`).toBe(true);
    // the spoken name still says where the reader is and how many pages there are
    expect(name).toContain(`${pageIndex + 1} من ${pages.length}`);
  });
});
