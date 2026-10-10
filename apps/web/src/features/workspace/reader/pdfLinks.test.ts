// PDF link annotations (§26 «روابط داخلية», track F1): rects map onto the unrotated page (y flipped), internal
// destinations resolve to a page of the same document, page actions work, unknown ones are not offered, and external
// URLs only ever open after a confirmation — and only web / mail URLs.
import { describe, expect, it, vi } from 'vitest';
import { safeExternalUrl } from '../notes/NotePageDialogs';
import { linkRectToNorm, pageLinks, resolveDest } from './pdfLinks';

const VIEW = [0, 0, 600, 800];

describe('PDF link rects', () => {
  it('maps a PDF rect (y up) to a normalized box (origin top-left), in any corner order', () => {
    expect(linkRectToNorm([60, 720, 300, 760], VIEW)).toEqual({ x: 0.1, y: 0.05, w: 0.4, h: 0.05 });
    expect(linkRectToNorm([300, 760, 60, 720], VIEW)).toEqual({ x: 0.1, y: 0.05, w: 0.4, h: 0.05 });
    // a cropped page (view does not start at 0)
    const b = linkRectToNorm([110, 110, 210, 210], [100, 100, 500, 600])!;
    expect([b.x, b.y, b.w, b.h].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.025, 0.78, 0.25, 0.2]);
  });
  it('clamps what lies outside the page and drops empty rects', () => {
    expect(linkRectToNorm([-50, 700, 60, 900], VIEW)).toEqual({ x: 0, y: 0, w: 0.1, h: 0.125 });
    expect(linkRectToNorm([10, 10, 10, 50], VIEW)).toBeNull();
    expect(linkRectToNorm([1, 2, 3], VIEW)).toBeNull();
  });
});

describe('destinations', () => {
  const ref = { num: 12, gen: 0 };
  const doc = {
    getDestination: vi.fn(async (name: string) => (name === 'chap2' ? [ref, { name: 'XYZ' }, 0, 700, null] : null)),
    getPageIndex: vi.fn(async () => 4),
  };
  it('resolves named and explicit destinations to a page index of this document', async () => {
    expect(await resolveDest(doc as never, 'chap2', 10)).toBe(4);
    expect(await resolveDest(doc as never, [ref, { name: 'Fit' }], 10)).toBe(4);
    expect(await resolveDest(doc as never, [2, { name: 'Fit' }], 10)).toBe(2);
  });
  it('a destination that does not exist, or lies outside the document, is not a link', async () => {
    expect(await resolveDest(doc as never, 'missing', 10)).toBeNull();
    expect(await resolveDest(doc as never, [44], 10)).toBeNull();
    expect(await resolveDest({ getDestination: async () => { throw new Error('bad'); }, getPageIndex: async () => 0 } as never, 'x', 10)).toBeNull();
  });
  it('classifies a page\'s links: internal (dest / page actions), external, unsupported', async () => {
    const page = {
      view: VIEW,
      getAnnotations: async () => [
        { subtype: 'Link', rect: [0, 0, 100, 20], dest: 'chap2' },
        { subtype: 'Link', rect: [0, 30, 100, 50], url: 'https://example.org/guide' },
        { subtype: 'Link', rect: [0, 60, 100, 80], action: 'NextPage' },
        { subtype: 'Link', rect: [0, 90, 100, 110], action: 'PrevPage' },
        { subtype: 'Link', rect: [0, 120, 100, 140], dest: 'missing' },
        { subtype: 'Widget', rect: [0, 150, 100, 170] },
      ],
    };
    const links = await pageLinks(doc as never, page as never, 0, 10);
    expect(links.map((l) => [l.kind, l.pageIndex ?? l.url ?? null])).toEqual([
      ['internal', 4],
      ['external', 'https://example.org/guide'],
      ['internal', 1],
      ['unsupported', null], // «previous» on the first page
      ['unsupported', null],
    ]);
    expect(links[0]!.label).toBe('رابط داخلي إلى الصفحة 5 في الملف');
    expect(links[1]!.label).toBe('رابط خارجي: example.org');
  });
});

describe('external links', () => {
  it('only http(s) and mailto open; javascript:, data:, file: never do', () => {
    expect(safeExternalUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeExternalUrl('mailto:owner@example.org')).toBe('mailto:owner@example.org');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<p>x', 'file:///etc/passwd', 'not a url']) expect(safeExternalUrl(bad)).toBeNull();
  });
});
