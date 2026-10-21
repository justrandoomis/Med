// Parity N1, G03 — colour slots per tool synced through the `ink` settings, each with an optional meaning:
//  * the default token colours keep ≥ 3:1 contrast on the light AND the dark paper (WCAG non-text contrast);
//  * up to 12 slots per tool, reorder / remove / reset in «إعدادات الكتابة», saved as the WHOLE `ink` object;
//  * the slot's meaning is saved on each new stroke (`style.meaning`), read out by the page summary and the selection,
//    drives «اعرض هذا المعنى فقط» through the visibility predicate, and follows a recolour from the lasso menu.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INK_SETTINGS, type InkData, type InkSettings } from '@medlevo/shared';
import { defaultSlots, legendOf, meaningOf, setInkSettingsBackend, slotsFor } from '../../src/features/workspace/ink/inkSettings';
import { PEN_COLORS, HIGHLIGHTER_COLORS } from '../../src/features/workspace/ink/palette';
import { parseCssColor } from '../../src/features/workspace/ink/render';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { cleanMeaning } from '../../src/features/workspace/ink/InkSettingsDialog';
import { installSettings, setupLayer, stroke } from './n1-helpers';

// a real layer and toolbar in jsdom: slow on a loaded machine, never hanging
vi.setConfig({ testTimeout: 20_000 });

function lum(hex: string): number {
  const c = parseCssColor(`rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`)!;
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const LIGHT_PAPER = '#fffdf8';
const DARK_PAPER = '#1d1c1a';

const slotsSettings = (pen: InkSettings['palettes']['pen']): InkSettings => ({ ...DEFAULT_INK_SETTINGS, palettes: { pen } });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  __resetStores();
});

describe('colour tokens on light and dark paper', () => {
  it('every default pen colour keeps at least 3:1 against the light and the dark paper', () => {
    for (const t of PEN_COLORS) {
      expect(contrast(t.light, LIGHT_PAPER), `${t.token} on light paper`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.dark, DARK_PAPER), `${t.token} on dark paper`).toBeGreaterThanOrEqual(3);
    }
  });
  it('highlighter tokens are under the text, not marks of their own: they keep the text over them legible (≥ 4.5:1 with the matching ink)', () => {
    for (const t of HIGHLIGHTER_COLORS) {
      expect(contrast(t.light, PEN_COLORS[0]!.light), `${t.token} under black ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.dark, PEN_COLORS[0]!.dark), `${t.token} under light ink on dark paper`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('slots and meanings (pure)', () => {
  it('a tool without own slots uses the palette; own slots win; unknown colours are dropped', () => {
    expect(slotsFor(DEFAULT_INK_SETTINGS, 'pen')).toEqual(defaultSlots('pen'));
    expect(slotsFor(DEFAULT_INK_SETTINGS, 'highlighter').map((s) => s.color)).toEqual(HIGHLIGHTER_COLORS.map((c) => c.token));
    const s = slotsSettings([{ color: 'ink-red', meaning: 'موانع استعمال' }, { color: 'ink-zzz' }, { color: '#00aa55', meaning: 'دواء' }]);
    expect(slotsFor(s, 'pen')).toEqual([{ color: 'ink-red', meaning: 'موانع استعمال' }, { color: '#00aa55', meaning: 'دواء' }]);
    expect(legendOf(s)).toEqual([
      { tool: 'pen', color: 'ink-red', meaning: 'موانع استعمال' },
      { tool: 'pen', color: '#00aa55', meaning: 'دواء' },
    ]);
  });
  it('the picked slot decides the meaning (two slots of one colour can mean different things)', () => {
    const slots = [{ color: 'ink-blue', meaning: 'آلية' }, { color: 'ink-blue', meaning: 'تشريح' }];
    expect(meaningOf(slots, 'ink-blue', 1)).toBe('تشريح');
    expect(meaningOf(slots, 'ink-blue', null)).toBe('آلية');
    expect(meaningOf(slots, 'ink-red', 0)).toBeUndefined();
  });
  it('a typed meaning is cleaned: one line, trimmed, no bidi controls, at most 60 characters', () => {
    expect(cleanMeaning('  آلية‏  ')).toBe('آلية');
    expect(cleanMeaning('سطر\nثانٍ')).toBe('سطر ثانٍ');
    expect(cleanMeaning('   ')).toBeUndefined();
    expect(cleanMeaning('م'.repeat(80))).toHaveLength(60);
  });
});

describe('meanings in the engine', () => {
  it('a slot picked in the toolbar puts its meaning on each new stroke; the page summary reads it out', async () => {
    installSettings(slotsSettings([{ color: 'ink-black' }, { color: 'ink-red', meaning: 'موانع استعمال' }]));
    const { root, store, key } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
    const group = await screen.findByRole('radiogroup', { name: 'اللون' });
    fireEvent.click(within(group).getByRole('radio', { name: 'أحمر — موانع استعمال' }));
    stroke(root, [
      [100, 100],
      [160, 120],
      [220, 140],
    ]);
    const data = store.items(key)[0]!.data as InkData;
    expect(data.style).toMatchObject({ color: 'ink-red', meaning: 'موانع استعمال' });
    await waitFor(() => expect(root.textContent).toContain('«موانع استعمال» 1'));
    await store.flush();
  });

  it('a custom colour carries no meaning; a slot without one neither', async () => {
    installSettings(slotsSettings([{ color: 'ink-black' }, { color: 'ink-red', meaning: 'موانع استعمال' }]));
    const { root, store, key } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'اللون' })).getByRole('radio', { name: 'أسود' }));
    stroke(root, [
      [100, 300],
      [200, 320],
    ]);
    expect((store.items(key)[0]!.data as InkData).style.meaning).toBeUndefined();
    await store.flush();
  });

  it('«اعرض هذا المعنى فقط» hides the other ink for this session (nothing deleted), and writing in another meaning shows all again', async () => {
    installSettings(slotsSettings([{ color: 'ink-red', meaning: 'موانع استعمال' }, { color: 'ink-blue', meaning: 'آلية' }]));
    const { root, store, key } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    const pick = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
      fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'اللون' })).getByRole('radio', { name }));
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    };
    await pick('أحمر — موانع استعمال');
    stroke(root, [
      [100, 100],
      [200, 100],
    ]);
    await pick('أزرق — آلية');
    stroke(root, [
      [100, 300],
      [200, 300],
    ]);
    const [red, blue] = store.items(key).sort((a, b) => a.z - b.z);
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /دليل الألوان ومعانيها/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'اعرض «آلية» فقط' }));
    expect(store.isVisible(blue!)).toBe(true);
    expect(store.isVisible(red!)).toBe(false);
    expect(store.items(key)).toHaveLength(2); // hidden, not deleted
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    // writing in red (another meaning) brings everything back: the owner always sees what they write
    await pick('أحمر — موانع استعمال');
    stroke(root, [
      [100, 500],
      [200, 500],
    ]);
    expect(store.isVisible(red!)).toBe(true);
    expect(store.viewFilterNames()).toEqual([]);
    await store.flush();
  });

  // (review) on an e-ink screen every pen colour becomes a near-black grey: the picker must SHOW which slot is which
  it('the colour picker carries a visible name for each slot (its meaning, else its colour) — shown on e-ink, where the greys look alike', async () => {
    installSettings(slotsSettings([{ color: 'ink-black' }, { color: 'ink-red', meaning: 'موانع استعمال' }, { color: 'ink-blue', meaning: 'آلية' }]));
    const { root } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
    const group = await screen.findByRole('radiogroup', { name: 'اللون' });
    const names = within(group)
      .getAllByRole('radio')
      .map((r) => r.querySelector('.ml-ink-color__name')?.textContent ?? null);
    expect(names).toEqual(['أسود', 'موانع استعمال', 'آلية']);
    // the visible names do not change what a screen reader hears (the radio's own name)
    expect(within(group).getByRole('radio', { name: 'أحمر — موانع استعمال' }).querySelector('.ml-ink-color__name')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('recolouring a selection to a slot gives the strokes that slot\'s meaning (and removes an old one)', async () => {
    installSettings(slotsSettings([{ color: 'ink-black' }, { color: 'ink-green', meaning: 'دواء' }]));
    const { root, store, key } = setupLayer('pen');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    stroke(root, [
      [100, 100],
      [200, 110],
      [300, 120],
    ]);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyL', key: 'l' });
    });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('lasso'));
    act(() => store.setSelection({ targetKey: key, ids: store.items(key).map((i) => i.id) }));
    fireEvent.click(await screen.findByRole('button', { name: 'تغيير اللون' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /أخضر — دواء/ }));
    expect((store.items(key)[0]!.data as InkData).style).toMatchObject({ color: 'ink-green', meaning: 'دواء' });
    expect(screen.getByRole('group', { name: /المحدد: .*«دواء»/ })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'تغيير اللون' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'أسود' }));
    expect((store.items(key)[0]!.data as InkData).style.meaning).toBeUndefined();
    await store.flush();
  });
});

describe('«الألوان ومعانيها» in «إعدادات الكتابة»', () => {
  it('adds, names, reorders, removes and resets slots; every change sends the whole `ink` object', async () => {
    const backend = installSettings();
    const { root } = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /إعدادات الكتابة/ }));
    const dialog = await screen.findByRole('dialog', { name: 'إعدادات الكتابة' });
    // name the red pen
    const red = within(dialog).getByRole('textbox', { name: 'معنى أحمر' });
    fireEvent.change(red, { target: { value: ' موانع استعمال ' } });
    fireEvent.blur(red);
    await waitFor(() => expect(slotsFor(backend.value as InkSettings, 'pen').find((s) => s.color === 'ink-red')?.meaning).toBe('موانع استعمال'));
    // every update is the WHOLE ink object (the settings store may merge partial objects shallowly)
    expect(backend.updates.at(-1)).toMatchObject({ gestures: DEFAULT_INK_SETTINGS.gestures, palm: DEFAULT_INK_SETTINGS.palm, toolbar: DEFAULT_INK_SETTINGS.toolbar });
    // move red up one place, remove orange
    fireEvent.click(within(dialog).getByRole('button', { name: 'انقل أحمر للأعلى' }));
    await waitFor(() => expect(slotsFor(backend.value as InkSettings, 'pen').map((s) => s.color).slice(0, 3)).toEqual(['ink-black', 'ink-red', 'ink-blue']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'احذف برتقالي' }));
    await waitFor(() => expect(slotsFor(backend.value as InkSettings, 'pen').some((s) => s.color === 'ink-orange')).toBe(false));
    // add a custom colour (≤ 12)
    fireEvent.click(within(dialog).getByRole('button', { name: 'أضف اللون المخصّص' }));
    await waitFor(() => expect(slotsFor(backend.value as InkSettings, 'pen').at(-1)!.color).toBe('#2346c8'));
    // reset
    fireEvent.click(within(dialog).getByRole('button', { name: 'أعد الألوان الافتراضية' }));
    await waitFor(() => expect((backend.value as InkSettings).palettes.pen).toBeUndefined());
  });
});
