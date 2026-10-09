import { describe, expect, it } from 'vitest';
import { canShowSpread, canSplit, decidePanels, defaultLeftOpen, effectiveLayout, LEFT_PANEL_WIDTH, MIN_CANVAS_WIDTH } from './layout';

describe('panel layout at breakpoints (§23)', () => {
  it('phone 390: book first; the rail is a bottom sheet; never two sheets', () => {
    const d = decidePanels({ width: 390, railOpen: true, railWidth: 380, leftOpen: false, last: 'rail' });
    expect(d).toMatchObject({ phone: true, rail: 'sheet', left: 'closed', canvasWidth: 390 });
    const both = decidePanels({ width: 390, railOpen: true, railWidth: 380, leftOpen: true, last: 'left' });
    expect(both).toMatchObject({ rail: 'closed', left: 'sheet', closed: 'rail' });
  });

  it('tablet portrait 768: the rail docks narrower so the book keeps ≥ 420px', () => {
    const d = decidePanels({ width: 768, railOpen: true, railWidth: 380, leftOpen: false, last: 'rail' });
    expect(d.phone).toBe(false);
    expect(d.rail).toBe('docked');
    expect(d.railWidth).toBe(768 - MIN_CANVAS_WIDTH);
    expect(d.canvasWidth).toBe(MIN_CANVAS_WIDTH);
  });

  it('never opens both side panels when the screen cannot hold them (keeps the last opened)', () => {
    const d = decidePanels({ width: 900, railOpen: true, railWidth: 380, leftOpen: true, last: 'left' });
    expect(d).toMatchObject({ rail: 'closed', left: 'docked', closed: 'rail' });
    expect(d.canvasWidth).toBe(900 - LEFT_PANEL_WIDTH);
    const r = decidePanels({ width: 900, railOpen: true, railWidth: 380, leftOpen: true, last: 'rail' });
    expect(r).toMatchObject({ rail: 'docked', left: 'closed', closed: 'left' });
  });

  it('desktop 1280: both fit; 1440+: the page panel may start open', () => {
    const d = decidePanels({ width: 1280, railOpen: true, railWidth: 380, leftOpen: true, last: 'rail' });
    expect(d).toMatchObject({ rail: 'docked', left: 'docked', closed: null, railWidth: 380 });
    expect(d.canvasWidth).toBe(1280 - 380 - LEFT_PANEL_WIDTH);
    expect(defaultLeftOpen(1280)).toBe(false);
    expect(defaultLeftOpen(1440)).toBe(true);
  });

  it('clamps the rail width to 280–640', () => {
    expect(decidePanels({ width: 2000, railOpen: true, railWidth: 9999, leftOpen: false, last: 'rail' }).railWidth).toBe(640);
    expect(decidePanels({ width: 2000, railOpen: true, railWidth: 10, leftOpen: false, last: 'rail' }).railWidth).toBe(280);
  });

  it('a two-page spread only when two readable pages fit; split study needs ≥ 1024px', () => {
    expect(canShowSpread(700, false)).toBe(false);
    expect(canShowSpread(900, false)).toBe(true);
    expect(canShowSpread(2000, true)).toBe(false);
    expect(effectiveLayout('double', 600, false)).toBe('single');
    expect(effectiveLayout('double', 1000, false)).toBe('double');
    expect(effectiveLayout('continuous', 300, true)).toBe('continuous');
    expect(canSplit(1023)).toBe(false);
    expect(canSplit(1024)).toBe(true);
  });
});
