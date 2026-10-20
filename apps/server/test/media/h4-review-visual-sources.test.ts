// Round 7 — independent review of track H4 item 9 (§32 allowed visual sources). An entry with an atlas PATH must allow
// only that path: before the fix the prefix was compared as plain text, so «/atlas» also allowed «/atlas-evil/…» and
// «/atlasfake.png», and an encoded slash («/atlas%2F..%2Fprivate/…», decoded to «/atlas/../private/…») passed too.
import { describe, expect, it } from 'vitest';
import { matchAllowedSource, validateImageCandidate } from '../../src/modules/media/validate-image';

const REG = [{ id: 'A', name: 'Atlas (TEST)', domain: 'example.org', path_prefix: '/atlas' }];
const hit = (url: string) => matchAllowedSource(url, REG)?.id ?? null;

describe('review H4 — the atlas path of a registry entry is a path, not a text prefix', () => {
  it('the path itself and what is under it are allowed', () => {
    expect(hit('https://example.org/atlas')).toBe('A');
    expect(hit('https://example.org/atlas/')).toBe('A');
    expect(hit('https://example.org/atlas/case-1/img.png')).toBe('A');
    expect(hit('https://images.example.org/atlas/x.png')).toBe('A');
  });

  it('a neighbouring path, a longer name, or a dot-dot segment (also encoded) is not', () => {
    expect(hit('https://example.org/atlas-evil/x.png')).toBeNull();
    expect(hit('https://example.org/atlasfake.png')).toBeNull();
    expect(hit('https://example.org/atlas%2F..%2Fprivate/x.png')).toBeNull();
    expect(hit('https://example.org/atlas/%2e%2e/private/x.png')).toBeNull();
    expect(hit('https://example.org/atlas/x/..%2F..%2Fprivate')).toBeNull();
  });

  it('a prefix written with its trailing slash behaves the same', () => {
    const reg = [{ id: 'B', name: 'B (TEST)', domain: 'example.org', path_prefix: '/atlas/' }];
    expect(matchAllowedSource('https://example.org/atlas/x.png', reg)?.id).toBe('B');
    expect(matchAllowedSource('https://example.org/atlas-evil/x.png', reg)).toBeNull();
  });

  it('the validator refuses such an external candidate with the reason', () => {
    const request = { modality: 'X-ray', anatomic_region: 'chest', finding_terms: ['pneumothorax'], require_real_example: true };
    const good = { modality: 'x-ray', anatomic_region: 'chest', caption: 'Chest X-ray: right pneumothorax.', origin: 'external' as const };
    expect(validateImageCandidate({ ...good, source_url: 'https://example.org/atlas/x.png' }, request, { allowedSources: REG }).accepted).toBe(true);
    const v = validateImageCandidate({ ...good, source_url: 'https://example.org/atlas-evil/x.png' }, request, { allowedSources: REG });
    expect(v.accepted).toBe(false);
    expect(v.checks.find((c) => c.check === 'allowed_source')).toMatchObject({ passed: false });
  });
});
