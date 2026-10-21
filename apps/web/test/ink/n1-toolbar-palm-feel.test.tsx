// Parity N1 — G66 (the toolbar arranged by the owner: order, hidden tools, dock, the previous-tool slot, per-study-mode
// profiles, the overflow at 390 px), G02 (palm rejection levels, the writing hand's zone, the test pad, the capability
// row) and G01 (pen feel profiles saved in each stroke's style, drawn from the style; latency only as measured here).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INK_SETTINGS, newId, type InkData, type InkSettings } from '@medlevo/shared';
import { buildCapabilityReport, detectApiSupport, EMPTY_OBSERVATIONS, latencyProbe, percentile } from '../../src/features/workspace/ink/capabilities';
import { CLASSIC_FEEL, cappedWidth, feelFor, loadFeelProfile, styleFeel } from '../../src/features/workspace/ink/feel';
import { classifyPointerDown, inPalmZone, palmPolicy, PALM_LEVELS } from '../../src/features/workspace/ink/input';
import { setInkSettingsBackend } from '../../src/features/workspace/ink/inkSettings';
import { makeInkItem } from '../../src/features/workspace/ink/model';
import { drawItem, taperFactor } from '../../src/features/workspace/ink/render';
import { __resetStores } from '../../src/features/workspace/ink/store';
import { fitSlots, layoutPriority, MODE_SUGGESTIONS, suggestedHidden, toolbarLayout } from '../../src/features/workspace/ink/toolbarLayout';
import { installSettings, setupLayer, stroke, stubContext } from './n1-helpers';

// a real layer and toolbar in jsdom: slow on a loaded machine, never hanging
vi.setConfig({ testTimeout: 20_000 });

const withInk = (patch: Partial<InkSettings>): InkSettings => ({ ...DEFAULT_INK_SETTINGS, ...patch });
const withToolbar = (tb: Partial<InkSettings['toolbar']>) => withInk({ toolbar: { ...DEFAULT_INK_SETTINGS.toolbar, ...tb } });
const withPalm = (palm: InkSettings['palm']) => withInk({ palm });

beforeEach(() => {
  __resetStores();
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  setInkSettingsBackend(null);
  __resetStores();
  vi.restoreAllMocks();
  document.querySelectorAll('.wk-modeswitch').forEach((e) => e.remove());
});

const AVAILABLE = ['hand', 'select_text', 'pen', 'highlighter', 'eraser', 'lasso', 'shape', 'text', 'sticky', 'image', 'laser'];

describe('G66 the toolbar layout (pure)', () => {
  it('the owner’s order first, then the rest in the built-in order; unknown and repeated ids are ignored', () => {
    const l = toolbarLayout(AVAILABLE, { ...DEFAULT_INK_SETTINGS.toolbar, order: ['highlighter', 'x:gone', 'pen', 'highlighter'], hidden: ['laser', 'sticky'] }, null, 'pen');
    expect(l.order.slice(0, 3)).toEqual(['highlighter', 'pen', 'hand']);
    expect(l.order).toHaveLength(AVAILABLE.length);
    expect(l.visible).not.toContain('laser');
    expect(l.visible).not.toContain('sticky');
    expect(l.vertical).toBe(false);
  });

  it('the active tool is never hidden; a study mode’s profile replaces the general hidden list; a side dock is vertical', () => {
    const tb = { ...DEFAULT_INK_SETTINGS.toolbar, hidden: ['lasso'], dock: 'end' as const, modes: { exam: { hidden: ['pen', 'highlighter', 'shape'] } } };
    expect(toolbarLayout(AVAILABLE, tb, null, 'lasso').visible).toContain('lasso');
    const exam = toolbarLayout(AVAILABLE, tb, 'exam', 'hand');
    expect(exam.profile).toBe('exam');
    expect(exam.visible).toContain('lasso');
    expect(exam.visible).not.toContain('pen');
    // a mode without a profile uses the general layout
    expect(toolbarLayout(AVAILABLE, tb, 'learn', 'hand').profile).toBeNull();
    expect(exam.vertical).toBe(true);
  });

  it('at 390 px with 44 px targets six controls keep their place (undo always among them), the rest goes to «المزيد»', () => {
    const prio = layoutPriority(['laser', 'pen', 'hand'], ['recent']);
    expect(prio.slice(0, 3)).toEqual(['pen', 'options', 'undo']);
    const fit = fitSlots(layoutPriority(AVAILABLE, []), 390, 44);
    expect(fit.size).toBe(6);
    expect(fit.has('undo')).toBe(true);
    expect(fit.has('pen')).toBe(true);
  });

  it('suggested profiles keep only their tools', () => {
    expect(new Set(AVAILABLE.filter((id) => !suggestedHidden('learn', AVAILABLE).includes(id)))).toEqual(new Set(MODE_SUGGESTIONS.learn!.keep));
    expect(suggestedHidden('exam', AVAILABLE)).not.toContain('lasso');
  });
});

describe('G66 the toolbar on screen', () => {
  it('reordered, with hidden tools gone (not even in «المزيد»), docked on the start side as a vertical toolbar', async () => {
    installSettings(withToolbar({ order: ['highlighter', 'pen'], hidden: ['laser', 'sticky'], dock: 'start' }));
    setupLayer('pen', { toolbar: true });
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(bar.closest('.ml-ink-toolbar')!.getAttribute('data-dock')).toBe('start');
    const names = within(bar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    expect(names.indexOf('قلم التظليل')).toBeLessThan(names.findIndex((n) => n?.startsWith('القلم')));
    expect(names).not.toContain('مؤشر الليزر');
    expect(names).not.toContain('ملاحظة لاصقة');
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /مؤشر الليزر/ })).toBeNull();
  });

  it('the previous-tool slot brings back the tool used before', async () => {
    installSettings(withToolbar({ recent: true }));
    const s = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('pen'));
    fireEvent.click(screen.getByRole('button', { name: 'قلم التظليل' }));
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('highlighter'));
    fireEvent.click(await screen.findByRole('button', { name: 'الأداة السابقة: قلم' }));
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('pen'));
  });

  it('a study mode with its own profile shows its tools (the mode read from the reader’s switch)', async () => {
    const sw = document.createElement('div');
    sw.className = 'wk-modeswitch';
    sw.setAttribute('data-mode', 'learn');
    document.body.appendChild(sw);
    installSettings(withToolbar({ modes: { exam: { hidden: ['pen', 'highlighter', 'shape', 'text', 'sticky', 'image', 'eraser', 'laser', 'select_text'] } } }));
    setupLayer('hand', { toolbar: true });
    const bar = screen.getByRole('toolbar', { name: 'أدوات الكتابة' });
    expect(bar.closest('.ml-ink-toolbar')!.hasAttribute('data-profile')).toBe(false);
    expect(within(bar).getByRole('button', { name: 'قلم التظليل' })).toBeTruthy();
    act(() => sw.setAttribute('data-mode', 'exam'));
    await waitFor(() => expect(bar.closest('.ml-ink-toolbar')!.getAttribute('data-profile')).toBe('exam'));
    expect(within(bar).queryByRole('button', { name: 'قلم التظليل' })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'التحديد الحر (Lasso)' })).toBeTruthy();
  });

  it('«إعدادات الكتابة» → «شريط الأدوات»: move a tool, hide one, dock at the end — the whole `ink` object is saved', async () => {
    const backend = installSettings();
    setupLayer('pen', { toolbar: true });
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /إعدادات الكتابة/ }));
    const dialog = await screen.findByRole('dialog', { name: 'إعدادات الكتابة' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'شريط الأدوات' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'انقل «قلم التظليل» إلى الأمام' }));
    await waitFor(() => expect(backend.updates.length).toBe(1));
    const order = (backend.value as InkSettings).toolbar.order;
    expect(order.indexOf('highlighter')).toBeLessThan(order.indexOf('pen'));
    fireEvent.click(within(dialog).getByRole('switch', { name: 'مؤشر الليزر' }));
    await waitFor(() => expect((backend.value as InkSettings).toolbar.hidden).toEqual(['laser']));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'جانب النهاية' }));
    await waitFor(() => expect((backend.value as InkSettings).toolbar.dock).toBe('end'));
    // every save carries the whole object (colours, gestures, palm and feel untouched)
    const last = backend.updates[backend.updates.length - 1]!;
    expect(Object.keys(last).sort()).toEqual(Object.keys(DEFAULT_INK_SETTINGS).sort());
    expect(last.gestures).toEqual(DEFAULT_INK_SETTINGS.gestures);
  });
});

describe('G02 palm rejection', () => {
  const touch = (over: Partial<Parameters<typeof classifyPointerDown>[0]> = {}) => ({ pointerType: 'touch', button: 0, buttons: 1, width: 10, height: 10, isPrimary: true, clientX: 300, clientY: 400, ...over });

  it('three levels: the contact size and the quiet time after the pen grow with the sensitivity', () => {
    expect(PALM_LEVELS.low.contactPx).toBeGreaterThan(PALM_LEVELS.medium.contactPx);
    expect(PALM_LEVELS.medium.contactPx).toBeGreaterThan(PALM_LEVELS.high.contactPx);
    expect(PALM_LEVELS.high.afterPenMs).toBeGreaterThan(PALM_LEVELS.medium.afterPenMs);
    const ctx = (level: 'low' | 'medium' | 'high', sincePenUp = Infinity) => ({ penOnly: false, strokeActive: false, sincePenUp, palm: palmPolicy(level, 'right'), lastPen: null });
    expect(classifyPointerDown(touch({ width: 50, height: 50 }), ctx('low'))).toBe('write');
    expect(classifyPointerDown(touch({ width: 50, height: 50 }), ctx('medium'))).toBe('ignore_palm');
    expect(classifyPointerDown(touch(), ctx('medium', 500))).toBe('write');
    expect(classifyPointerDown(touch(), ctx('high', 500))).toBe('ignore_palm');
    // without palm settings: the engine as before N1
    expect(classifyPointerDown(touch({ width: 50, height: 50 }), { penOnly: false, strokeActive: false, sincePenUp: Infinity })).toBe('ignore_palm');
  });

  it('the writing hand’s zone: beside and below the pen on the hand’s side, for a while after the pen lifted', () => {
    const pen = { x: 300, y: 300 };
    expect(inPalmZone({ x: 420, y: 380 }, pen, 'right')).toBe(true);
    expect(inPalmZone({ x: 180, y: 380 }, pen, 'right')).toBe(false);
    expect(inPalmZone({ x: 180, y: 380 }, pen, 'left')).toBe(true);
    expect(inPalmZone({ x: 420, y: 200 }, pen, 'right')).toBe(false); // above the pen
    const ctx = { penOnly: false, strokeActive: false, sincePenUp: 800, palm: palmPolicy('medium', 'right'), lastPen: pen };
    expect(classifyPointerDown(touch({ clientX: 420, clientY: 380 }), ctx)).toBe('ignore_palm');
    expect(classifyPointerDown(touch({ clientX: 420, clientY: 380 }), { ...ctx, sincePenUp: 2000 })).toBe('write');
    expect(classifyPointerDown(touch({ clientX: 420, clientY: 380 }), { ...ctx, palm: palmPolicy('low', 'right') })).toBe('write');
  });

  it('on the page: after a pen line, a touch where the right hand rests leaves no mark; a finger elsewhere still writes', async () => {
    installSettings(withPalm({ sensitivity: 'medium', hand: 'right' }));
    let t = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const s = setupLayer('pen');
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('pen'));
    stroke(
      s.root,
      [
        [100, 300],
        [150, 300],
        [200, 300],
      ],
      { pointerType: 'pen' },
    );
    expect(s.store.items(s.key)).toHaveLength(1);
    t += 600; // past the quiet time, inside the hand's zone time
    stroke(s.root, [
      [380, 380],
      [400, 390],
      [420, 400],
    ], { pointerType: 'touch' });
    expect(s.store.items(s.key)).toHaveLength(1);
    // the other side of the pen, above it: a finger writing
    stroke(s.root, [
      [20, 150],
      [60, 150],
      [100, 150],
    ], { pointerType: 'touch' });
    expect(s.store.items(s.key)).toHaveLength(2);
    await s.store.flush();
  });

  it('the test pad counts rejected touches and stray marks; the capability row states the values in force', async () => {
    installSettings(withPalm({ sensitivity: 'high', hand: 'left' }));
    setupLayer('pen', { toolbar: true });
    fireEvent.click(screen.getByRole('button', { name: 'المزيد من أدوات الكتابة' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /إعدادات الكتابة/ }));
    const dialog = await screen.findByRole('dialog', { name: 'إعدادات الكتابة' });
    fireEvent.click(within(dialog).getByRole('tab', { name: 'راحة اليد' }));
    const pad = await within(dialog).findByRole('img', { name: /مساحة اختبار راحة اليد/ });
    fireEvent.pointerDown(pad, { pointerId: 1, pointerType: 'pen', clientX: 100, clientY: 100 });
    fireEvent.pointerUp(pad, { pointerId: 1, pointerType: 'pen', clientX: 100, clientY: 100 });
    fireEvent.pointerDown(pad, { pointerId: 2, pointerType: 'touch', clientX: 60, clientY: 140, width: 10, height: 10, isPrimary: true });
    fireEvent.pointerUp(pad, { pointerId: 2, pointerType: 'touch' });
    expect(within(dialog).getByRole('status').textContent).toMatch(/ضربات القلم: ١ — لمسات رُفضت كراحة يد: ١ — علامات شاردة كانت ستُكتب: ٠/);
    const rows = buildCapabilityReport(detectApiSupport(), EMPTY_OBSERVATIONS, { palm: palmPolicy('high', 'left') });
    const palm = rows.find((r) => r.key === 'palm')!;
    expect(palm.state).toBe('heuristic');
    expect(palm.detail_ar).toContain('حساسية عالية');
    expect(palm.detail_ar).toContain('اليد اليسرى');
    expect(palm.detail_ar).toContain('32 بكسل');
  });
});

describe('G01 pen feel', () => {
  it('a classic stroke stores nothing new (its style is what the engine wrote before N1)', () => {
    expect(styleFeel(CLASSIC_FEEL)).toEqual({});
    expect(styleFeel(feelFor('classic', 'pen', DEFAULT_INK_SETTINGS))).toEqual({});
    expect(styleFeel(feelFor('anatomy', 'pen', DEFAULT_INK_SETTINGS))).toEqual({ smoothing: 6, constant: true });
    // the highlighter keeps its flat drawing: only the steadiness of a profile applies
    expect(styleFeel(feelFor('writing', 'highlighter', DEFAULT_INK_SETTINGS))).toEqual({ smoothing: 1 });
    const own = withInk({ feel: { ...DEFAULT_INK_SETTINGS.feel, fountain: { smoothing: 3, pressure_floor: 0.333, taper: 'sharp', constant: false } } });
    expect(styleFeel(feelFor('custom', 'fountain', own))).toEqual({ smoothing: 3, pressure_floor: 0.33, taper: 'sharp' });
    expect(cappedWidth('anatomy', 0.004)).toBe(0.0016);
    expect(cappedWidth('classic', 0.004)).toBe(0.004);
  });

  it('the profile of this document (this device) is saved in each new stroke’s style', async () => {
    installSettings();
    const docKey = `doc-feel-${newId()}`;
    window.localStorage.setItem(`medlevo.ink.feel.v1:${docKey}`, 'anatomy');
    const s = setupLayer('pen', { docKey });
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('pen'));
    stroke(s.root, [
      [100, 300],
      [150, 310],
      [200, 300],
    ]);
    const st = (s.store.items(s.key)[0]!.data as InkData).style;
    expect(st).toMatchObject({ smoothing: 6, constant: true });
    expect(st.width).toBeLessThanOrEqual(0.0016);
    expect(loadFeelProfile(`other-${newId()}`)).toBe('classic');
    await s.store.flush();
  });

  it('the options popover switches the profile of this document; a classic stroke has no feel fields', async () => {
    installSettings();
    const s = setupLayer('pen', { toolbar: true });
    await waitFor(() => expect(s.root.getAttribute('data-tool')).toBe('pen'));
    stroke(s.root, [
      [100, 200],
      [200, 200],
    ]);
    const classic = (s.store.items(s.key)[0]!.data as InkData).style;
    for (const k of ['smoothing', 'pressure_floor', 'taper', 'constant']) expect(classic).not.toHaveProperty(k);
    fireEvent.click(screen.getByRole('button', { name: /^خيارات قلم/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'كتابة' }));
    expect(loadFeelProfile(s.docKey)).toBe('writing');
    stroke(s.root, [
      [100, 400],
      [200, 400],
    ]);
    const writing = s.store
      .items(s.key)
      .map((i) => (i.data as InkData).style)
      .find((x) => x.taper);
    expect(writing).toMatchObject({ smoothing: 1, pressure_floor: 0.15, taper: 'round' });
    await s.store.flush();
  });

  describe('drawn from the style', () => {
    // jsdom has no Path2D: a stand-in that keeps its points
    class FakePath {
      pts: Array<[number, number]> = [];
      moveTo(x: number, y: number) {
        this.pts.push([x, y]);
      }
      lineTo(x: number, y: number) {
        this.pts.push([x, y]);
      }
      quadraticCurveTo(_cx: number, _cy: number, x: number, y: number) {
        this.pts.push([x, y]);
      }
    }
    beforeEach(() => {
      vi.stubGlobal('Path2D', FakePath);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const env = { W: 600, H: 800, tone: 'light' as const, css: null };
    function widths(style: Partial<InkData['style']>, pressure: boolean): number[] {
      const ctx = stubContext();
      const seen: number[] = [];
      ctx.stroke = ((..._a: unknown[]) => {
        seen.push(ctx.lineWidth);
      }) as never;
      const pts: Array<[number, number, number, number]> = [];
      for (let i = 0; i <= 20; i++) pts.push([0.1 + i * 0.02, 0.3, i * 10, 0.2 + (i % 5) * 0.15]);
      const item = makeInkItem({ id: newId(), anchor: { type: 'page', source_id: 'S', version_id: 'V', page_id: 'P', page_index: 0, space: 'page_norm' }, now: 1, z: 1, style: { tool: 'pen', color: 'ink-black', width: 0.004, ...style }, points: pts, pressureAvailable: pressure, tiltAvailable: false, pointerType: 'pen' });
      drawItem(ctx, item, env);
      return seen;
    }
    it('constant width ignores the pressure; a floor keeps thin parts from vanishing; a taper thins the ends', () => {
      const base = 0.004 * 600;
      expect(widths({}, false)).toEqual([base]); // classic without pressure: one path
      const variable = widths({}, true);
      expect(variable.length).toBeGreaterThan(1);
      expect(widths({ constant: true }, true)).toEqual([base]);
      const floored = widths({ pressure_floor: 0.6 }, true);
      expect(Math.min(...floored)).toBeGreaterThan(Math.min(...variable));
      const sharp = widths({ taper: 'sharp' }, false);
      expect(Math.min(...sharp)).toBeLessThan(base * 0.5);
      expect(Math.max(...sharp)).toBeCloseTo(base, 0);
      expect(taperFactor('round', 0)).toBeCloseTo(0.35, 6);
      expect(taperFactor('sharp', 0)).toBeCloseTo(0.08, 6);
      expect(taperFactor('round', 1)).toBe(1);
      expect(taperFactor(null, 0)).toBe(1);
    });
  });

  it('latency: percentiles of what was measured here; the capability row shows numbers only once measured', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
    latencyProbe.reset();
    const none = buildCapabilityReport(detectApiSupport(), EMPTY_OBSERVATIONS, { latency: latencyProbe.compute() }).find((r) => r.key === 'latency')!;
    expect(none.state).toBe('not_observed');
    expect(none.detail_ar).toContain('لم يُقس بعد');
    for (let i = 0; i < 40; i++) latencyProbe.record('pen', 8 + (i % 10));
    latencyProbe.record('pen', 5000); // a frame that never came: dropped
    const stats = latencyProbe.compute();
    expect(stats).toEqual([{ pointerType: 'pen', samples: 40, p50: 12, p95: 17 }]);
    const row = buildCapabilityReport(detectApiSupport(), EMPTY_OBSERVATIONS, { latency: stats }).find((r) => r.key === 'latency')!;
    expect(row.state).toBe('supported');
    expect(row.detail_ar).toContain('قِيس على هذا الجهاز');
    expect(row.detail_ar).toContain('الوسيط 12');
    // (review) honest about what is measured: until the app draws the sample, not until the screen shows it
    expect(row.label_ar).toContain('حتى يرسمه التطبيق');
    expect(row.detail_ar).toContain('لا يشمل عرض الإطار على الشاشة');
    latencyProbe.reset();
  });

  // (review) a pointermove may carry several coalesced samples: the wait is counted from the OLDEST one (the
  // dispatching event's own time stamp is the newest and would understate the latency)
  it('latency is counted from the oldest coalesced sample a frame draws', async () => {
    latencyProbe.reset();
    installSettings();
    const { root } = setupLayer('pen');
    await waitFor(() => expect(root.getAttribute('data-tool')).toBe('pen'));
    const at = (type: string, x: number, y: number, t?: number) => {
      const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'pen', button: 0, buttons: 1, clientX: x + 10, clientY: y + 20, pressure: 0.5, isPrimary: true });
      if (t !== undefined) Object.defineProperty(e, 'timeStamp', { value: t });
      return e;
    };
    act(() => {
      root.dispatchEvent(at('pointerdown', 100, 100));
    });
    const now = performance.now();
    const move = at('pointermove', 140, 100, now);
    const older = [at('pointermove', 110, 100, now - 40), at('pointermove', 125, 100, now - 20), at('pointermove', 140, 100, now)];
    Object.defineProperty(move, 'getCoalescedEvents', { value: () => older });
    act(() => {
      root.dispatchEvent(move);
    });
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    act(() => {
      root.dispatchEvent(at('pointerup', 140, 100));
    });
    const pen = latencyProbe.compute().find((l) => l.pointerType === 'pen');
    expect(pen, 'a latency sample was recorded').toBeDefined();
    expect(pen!.p95).toBeGreaterThanOrEqual(39);
    latencyProbe.reset();
  });
});
