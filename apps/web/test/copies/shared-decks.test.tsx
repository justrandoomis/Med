// AOS-21.27 — «ادرس هذه البطاقات» on a published explanation's page (DeckSection) and the deck choice of «انشر شرحك».
// The start action is shown only where it works: the server says the viewer may study the deck (a member, not the
// author, an active explanation with cards, no copy yet). No cards, an unreadable deck, the author, an existing copy or
// an explanation that may not be copied: no button. A waiting deck version shows its preview with «طبّق التحديث».
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DeckCopyView, PublicationDeckView } from '@medlevo/shared';
import { ToastProvider } from '../../src/design';
import { setFetchImpl } from '../../src/lib/api';
import { DeckSection } from '../../src/features/copies/DeckSection';
import { publishableCardCount } from '../../src/features/lectures/PublishDialog';

const syncNow = vi.fn(async () => undefined);
vi.mock('../../src/lib/sync', async (orig) => ({ ...(await orig<typeof import('../../src/lib/sync')>()), getSyncEngine: () => ({ syncNow }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const HASAN = { id: 'u_h', display_name: 'حسن', avatar_url: null };
const rt = (t: string) => ({ v: 1 as const, paragraphs: [{ dir: 'rtl' as const, runs: [{ t, dir: 'rtl' as const }] }] });

function deckCopy(over: Partial<DeckCopyView> = {}): DeckCopyView {
  return { publication_id: 'PUB1', space_id: 'SPA', title: 'شرح حسن', author: HASAN, applied_version_no: 1, head_version_no: 1, cards: 5, status_note_ar: null, update: null, created_at: 1, ...over };
}

function deck(over: Partial<PublicationDeckView> = {}, viewer: Partial<PublicationDeckView['viewer']> = {}): PublicationDeckView {
  return {
    publication_id: 'PUB1',
    space_id: 'SPA',
    version_no: 1,
    card_count: 5,
    cards: [{ item_id: 'pi_1', kind: 'basic', front: rt('ما الشريان الكلوي؟'), back: rt('فرع من الأبهر'), cloze_index: null }],
    viewer: { is_author: false, can_study: true, copy: null, ...viewer },
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}
function serve(handler: (method: string, path: string, body: unknown) => Response | undefined): Call[] {
  const calls: Call[] = [];
  setFetchImpl(async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, url, body });
    return handler(method, url.split('?')[0]!, body) ?? json({ error: { code: 'NOT_FOUND', message: 'غير موجود' } }, 404);
  });
  return calls;
}

function renderDeck() {
  const loaded = vi.fn();
  render(
    <ToastProvider>
      <MemoryRouter>
        <DeckSection spaceId="SPA" publicationId="PUB1" onLoaded={loaded} />
      </MemoryRouter>
    </ToastProvider>,
  );
  return loaded;
}

afterEach(() => {
  setFetchImpl(null);
  syncNow.mockClear();
});

describe('«ادرس هذه البطاقات»', () => {
  it('a classmate who may study it: the action copies the deck into their review (one call), then says so — no second button', async () => {
    const calls = serve((method, path) => {
      if (method === 'GET' && path === '/api/copies/decks/PUB1') return json(deck());
      if (method === 'POST' && path === '/api/copies/decks') return json({ deck: deckCopy(), created: true, copied: 5 });
      return undefined;
    });
    const loaded = renderDeck();
    const btn = await screen.findByRole('button', { name: 'ادرس هذه البطاقات' });
    expect(calls[0]!.url).toContain('space_id=SPA');
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ card_count: 5 }));
    fireEvent.click(btn);
    await screen.findByText('تدرس 5 بطاقات من هذا الشرح (الإصدار 1).');
    const post = calls.filter((c) => c.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]!.body).toEqual({ space_id: 'SPA', publication_id: 'PUB1' });
    expect(screen.queryByRole('button', { name: 'ادرس هذه البطاقات' })).toBeNull();
    expect(screen.getByRole('link', { name: 'افتح المراجعة' }).getAttribute('href')).toBe('/review');
    await waitFor(() => expect(syncNow).toHaveBeenCalled());
  });

  it('a refusal from the server is said in words and the button stays', async () => {
    serve((method, path) => {
      if (method === 'GET' && path === '/api/copies/decks/PUB1') return json(deck());
      if (method === 'POST' && path === '/api/copies/decks') return json({ error: { code: 'CONFLICT', message: 'لا توجد بطاقات في هذا الشرح لتدرسها.' } }, 409);
      return undefined;
    });
    renderDeck();
    fireEvent.click(await screen.findByRole('button', { name: 'ادرس هذه البطاقات' }));
    expect((await screen.findByText('لا توجد بطاقات في هذا الشرح لتدرسها.')).getAttribute('role')).toBe('alert');
    expect(screen.getByRole('button', { name: 'ادرس هذه البطاقات' })).toBeTruthy();
  });

  it('shown only where it works: not for the author, not when the server says no, not once copied', async () => {
    for (const [d, line] of [
      [deck({}, { is_author: true, can_study: false }), 'نُشرت 5 بطاقات مع هذا الشرح.'],
      [deck({}, { can_study: false }), 'مع هذا الشرح 5 بطاقات كتبها صاحبه.'],
      [deck({}, { can_study: false, copy: deckCopy() }), 'تدرس 5 بطاقات من هذا الشرح (الإصدار 1).'],
    ] as const) {
      serve((method, path) => (method === 'GET' && path === '/api/copies/decks/PUB1' ? json(d) : undefined));
      const view = render(
        <ToastProvider>
          <MemoryRouter>
            <DeckSection spaceId="SPA" publicationId="PUB1" />
          </MemoryRouter>
        </ToastProvider>,
      );
      await screen.findByText(line);
      expect(screen.queryByRole('button', { name: 'ادرس هذه البطاقات' })).toBeNull();
      view.unmount();
    }
  });

  it('an explanation without cards, or a deck the server will not show: no section at all', async () => {
    for (const handler of [(m: string, p: string) => (m === 'GET' && p === '/api/copies/decks/PUB1' ? json(deck({ card_count: 0, cards: [] }, { can_study: false })) : undefined), () => undefined]) {
      serve(handler);
      const loaded = vi.fn();
      const view = render(
        <ToastProvider>
          <MemoryRouter>
            <DeckSection spaceId="SPA" publicationId="PUB1" onLoaded={loaded} />
          </MemoryRouter>
        </ToastProvider>,
      );
      await waitFor(() => expect(loaded).toHaveBeenCalled());
      expect(screen.queryByRole('heading', { name: 'بطاقات الشرح' })).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      view.unmount();
    }
  });

  it('a newer deck version: its preview, then «طبّق التحديث» sends that version', async () => {
    const update = { publication_id: 'PUB1', from_version_no: 1, to_version_no: 2, change_note: null, counts: { added: 1, removed: 1, changed: 2 }, kept_yours: 1, summary_ar: 'أضاف بطاقة واحدة، حذف بطاقة واحدة، عدّل بطاقتين. بطاقة واحدة عدّلتَها بنفسك تبقى كما كتبتها.' };
    const calls = serve((method, path) => {
      if (method === 'GET' && path === '/api/copies/decks/PUB1') return json(deck({ version_no: 2 }, { can_study: false, copy: deckCopy({ head_version_no: 2, update }) }));
      if (method === 'POST' && path === '/api/copies/decks/PUB1/update') return json({ deck: deckCopy({ applied_version_no: 2, head_version_no: 2 }), skipped: false, applied: { added: 1, updated: 1, removed: 1, kept_yours: 1 } });
      return undefined;
    });
    renderDeck();
    expect((await screen.findByText(/تحديث للبطاقات من حسن/)).textContent).toContain('تبقى كما كتبتها');
    fireEvent.click(screen.getByRole('button', { name: 'طبّق التحديث' }));
    await screen.findByText('تدرس 5 بطاقات من هذا الشرح (الإصدار 2).');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ version_no: 2 });
    expect(screen.queryByRole('button', { name: 'طبّق التحديث' })).toBeNull();
  });
});

describe('«انشر شرحك»: which cards ride with the explanation', () => {
  it('own text cards only — not generated, not from mistakes, not copied from a classmate’s deck, not deleted', () => {
    const c = (over: Record<string, unknown>) => ({ kind: 'basic', origin: 'owner', origin_ref: null, deleted_at: null, merged_into_id: null, ...over }) as never;
    expect(
      publishableCardCount([
        c({}),
        c({ kind: 'cloze' }),
        c({ origin: 'from_selection' }),
        c({ origin: 'generated' }),
        c({ origin: 'from_mistake', kind: 'mistake' }),
        c({ kind: 'image_occlusion' }),
        c({ origin_ref: { publication_deck: { publication_id: 'P' } } }),
        c({ deleted_at: 5 }),
      ]),
    ).toBe(3);
  });
});
