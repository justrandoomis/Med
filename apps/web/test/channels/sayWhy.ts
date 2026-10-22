// AOS-23.3 «no decorative controls» at the unit level: every disabled control under `root` says why — through
// `aria-describedby` (text on screen) or a `title`. A control that is only busy (`aria-busy`) is acting, not refusing.
import { expect } from 'vitest';

export function expectDisabledSayWhy(root: ParentNode = document.body): void {
  const disabled = Array.from(root.querySelectorAll<HTMLElement>('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]')).filter(
    (el) => el.getAttribute('aria-busy') !== 'true',
  );
  for (const el of disabled) {
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    const why = [...ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? ''), el.getAttribute('title') ?? ''].join(' ').trim();
    expect(why, `«${el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName}» is disabled without saying why`).not.toBe('');
  }
}
